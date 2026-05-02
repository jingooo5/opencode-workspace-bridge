import path from "node:path";
import { mkdir, rm, readdir, writeFile } from "node:fs/promises";
import type { SQLiteIndexStore, StorageResult } from "../sqlite-store.js";
import { promoteContracts, type PromotedContract } from "./promote-rules.js";
import { emitYaml, type YamlValue } from "./yaml-emit.js";

export interface BuildContractRegistryInput {
  updatedAt: string;
  contractsGeneratedDir: string;
  contractGlobMatcher: (relPath: string) => boolean;
}

export interface BuildContractRegistryResult {
  contractsPersisted: number;
  yamlFilesWritten: number;
  contracts: PromotedContract[];
}

export async function buildAndPersistContracts(
  store: SQLiteIndexStore,
  input: BuildContractRegistryInput,
): Promise<StorageResult<BuildContractRegistryResult>> {
  const snapshot = store.readDebugSnapshot();
  if (!snapshot.ok) return snapshot;

  const fileHashes = store.readFileHashes();
  if (!fileHashes.ok) return fileHashes;

  const contracts = promoteContracts({
    nodes: snapshot.value.nodes,
    edges: snapshot.value.edges,
    contractGlobMatcher: input.contractGlobMatcher,
    fileHashes: fileHashes.value,
  });

  const yamlPaths = await writeContractYamlFiles(input.contractsGeneratedDir, contracts);

  const persisted = store.persistContracts({
    contracts: contracts.map((contract, index) => ({
      ...contract,
      generatedYamlPath: yamlPaths[index] ?? null,
    })),
    updatedAt: input.updatedAt,
  });
  if (!persisted.ok) return persisted;

  return {
    ok: true,
    value: {
      contractsPersisted: contracts.length,
      yamlFilesWritten: yamlPaths.filter(Boolean).length,
      contracts,
    },
    diagnostics: [],
  };
}

export async function writeContractYamlFiles(
  contractsGeneratedDir: string,
  contracts: PromotedContract[],
): Promise<Array<string | null>> {
  await mkdir(contractsGeneratedDir, { recursive: true });
  const writtenFiles = new Set<string>();
  const paths: Array<string | null> = [];

  for (const contract of contracts) {
    const yaml = emitYaml(contractToYaml(contract));
    const fileName = `${slugContract(contract)}.yaml`;
    const targetPath = path.join(contractsGeneratedDir, fileName);
    await writeFile(targetPath, yaml, "utf8");
    writtenFiles.add(fileName);
    paths.push(targetPath);
  }

  await pruneStaleYamlFiles(contractsGeneratedDir, writtenFiles);
  return paths;
}

async function pruneStaleYamlFiles(contractsGeneratedDir: string, keep: Set<string>): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await readdir(contractsGeneratedDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".yaml")) continue;
    if (keep.has(entry)) continue;
    await rm(path.join(contractsGeneratedDir, entry), { force: true });
  }
}

function contractToYaml(contract: PromotedContract): YamlValue {
  return {
    id: contract.id,
    kind: contract.kind,
    name: contract.name,
    root: contract.rootName,
    file: contract.relPath ?? null,
    source_node: contract.sourceNodeId ?? null,
    signature_hash: contract.signatureHash,
    confidence: roundConfidence(contract.confidence),
    attrs: contract.attrs as YamlValue,
    consumers: contract.consumers.map((consumer) => ({
      consumer_node_id: consumer.consumerNodeId,
      consumer_root_id: consumer.consumerRootId,
      evidence_edge_id: consumer.evidenceEdgeId ?? null,
      confidence: roundConfidence(consumer.confidence),
      attrs: consumer.attrs as YamlValue,
    })),
    related_nodes: contract.related.map((related) => ({
      node_id: related.nodeId,
      relation: related.relation,
      confidence: roundConfidence(related.confidence),
      attrs: related.attrs as YamlValue,
    })),
  };
}

function slugContract(contract: PromotedContract): string {
  const base = contract.id.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return base.length ? base : `contract_${contract.signatureHash.slice(0, 12)}`;
}

function roundConfidence(value: number): number {
  return Math.round(value * 1000) / 1000;
}
