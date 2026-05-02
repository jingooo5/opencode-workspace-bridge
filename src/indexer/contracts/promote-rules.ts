import { createHash } from "node:crypto";
import type { DebugEdgeRecord, DebugNodeRecord } from "../sqlite-store.js";

export type ContractKind = "HTTP_ROUTE" | "DTO" | "PACKAGE" | "CONTRACT_FILE";

export interface PromotedContract {
  id: string;
  kind: ContractKind;
  name: string;
  rootId: string;
  rootName: string;
  fileId?: string;
  relPath?: string;
  sourceNodeId?: string;
  signatureHash: string;
  confidence: number;
  attrs: Record<string, unknown>;
  consumers: PromotedConsumer[];
  related: PromotedRelated[];
}

export interface PromotedConsumer {
  consumerNodeId: string;
  consumerRootId: string;
  evidenceEdgeId?: string;
  confidence: number;
  attrs: Record<string, unknown>;
}

export interface PromotedRelated {
  nodeId: string;
  relation: "internal_dto" | "schema_ref" | "adjacent_dto" | "exposes_dto";
  confidence: number;
  attrs: Record<string, unknown>;
}

export interface PromotionInput {
  nodes: DebugNodeRecord[];
  edges: DebugEdgeRecord[];
  contractGlobMatcher: (relPath: string) => boolean;
  fileHashes: Map<string, string>;
}

export function promoteContracts(input: PromotionInput): PromotedContract[] {
  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  const fileNodesByFileId = new Map<string, DebugNodeRecord>();
  for (const node of input.nodes) {
    if (node.kind === "FILE" && node.fileId) fileNodesByFileId.set(node.fileId, node);
  }

  const contracts = new Map<string, PromotedContract>();

  for (const node of input.nodes) {
    if (node.kind === "HTTP_ROUTE_CANDIDATE") {
      const contract = promoteHttpRoute(node);
      contracts.set(contract.id, contract);
    }
  }

  for (const node of input.nodes) {
    if (node.kind === "PACKAGE" && shouldPromotePackage(node)) {
      const contract = promotePackage(node);
      contracts.set(contract.id, contract);
    }
  }

  for (const node of input.nodes) {
    if (node.kind === "DTO_CANDIDATE") {
      const promotion = classifyDto(node, input.nodes);
      if (promotion === "promote") {
        const contract = promoteDto(node);
        contracts.set(contract.id, contract);
      }
    }
  }

  for (const fileNode of fileNodesByFileId.values()) {
    if (!fileNode.relPath) continue;
    if (!input.contractGlobMatcher(fileNode.relPath)) continue;
    const fileHash = (fileNode.fileId && input.fileHashes.get(fileNode.fileId)) ?? "";
    const contract = promoteContractFile(fileNode, fileHash);
    if (!contracts.has(contract.id)) contracts.set(contract.id, contract);
  }

  for (const contract of contracts.values()) {
    attachConsumers(contract, input.edges, nodesById);
    attachRelated(contract, input.nodes, input.edges, nodesById);
  }

  return [...contracts.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function promoteHttpRoute(node: DebugNodeRecord): PromotedContract {
  const method = stringAttr(node.attrs, "method") ?? node.name.split(/\s+/)[0] ?? "GET";
  const path = stringAttr(node.attrs, "path") ?? node.name.replace(/^\S+\s+/, "") ?? "/";
  const sigInput = `HTTP_ROUTE\n${method.toUpperCase()}\n${path}\n${node.relPath ?? ""}`;
  const signatureHash = sha256(sigInput);
  return {
    id: `contract:http_route:${signatureHash.slice(0, 24)}`,
    kind: "HTTP_ROUTE",
    name: `${method.toUpperCase()} ${path}`,
    rootId: node.rootId,
    rootName: node.rootName,
    fileId: node.fileId,
    relPath: node.relPath,
    sourceNodeId: node.id,
    signatureHash,
    confidence: node.confidence,
    attrs: stableAttrs({
      method: method.toUpperCase(),
      path,
      startLine: node.startLine,
      endLine: node.endLine,
      promotedFrom: "HTTP_ROUTE_CANDIDATE",
    }),
    consumers: [],
    related: [],
  };
}

function promotePackage(node: DebugNodeRecord): PromotedContract {
  const sigInput = `PACKAGE\n${node.rootName}\n${node.name}\n${node.relPath ?? ""}\n${stringAttr(node.attrs, "main") ?? ""}`;
  const signatureHash = sha256(sigInput);
  const dependencies = stringArrayAttr(node.attrs, "dependencies");
  const scripts = stringArrayAttr(node.attrs, "scripts");
  return {
    id: `contract:package:${signatureHash.slice(0, 24)}`,
    kind: "PACKAGE",
    name: node.name,
    rootId: node.rootId,
    rootName: node.rootName,
    fileId: node.fileId,
    relPath: node.relPath,
    sourceNodeId: node.id,
    signatureHash,
    confidence: node.confidence,
    attrs: stableAttrs({
      dependencies,
      scripts,
      main: stringAttr(node.attrs, "main"),
      exports: stringAttr(node.attrs, "exports"),
      bin: stringAttr(node.attrs, "bin"),
      promotedFrom: "PACKAGE",
    }),
    consumers: [],
    related: [],
  };
}

function promoteDto(node: DebugNodeRecord): PromotedContract {
  const sigInput = `DTO\n${node.rootName}\n${node.name}\n${node.relPath ?? ""}\n${node.startLine}`;
  const signatureHash = sha256(sigInput);
  return {
    id: `contract:dto:${signatureHash.slice(0, 24)}`,
    kind: "DTO",
    name: node.name,
    rootId: node.rootId,
    rootName: node.rootName,
    fileId: node.fileId,
    relPath: node.relPath,
    sourceNodeId: node.id,
    signatureHash,
    confidence: node.confidence,
    attrs: stableAttrs({
      startLine: node.startLine,
      endLine: node.endLine,
      sourceKind: stringAttr(node.attrs, "sourceKind"),
      reason: stringAttr(node.attrs, "reason"),
      exported: boolAttr(node.attrs, "exported"),
      promotedFrom: "DTO_CANDIDATE",
    }),
    consumers: [],
    related: [],
  };
}

function promoteContractFile(fileNode: DebugNodeRecord, fileHash: string): PromotedContract {
  const sigInput = `CONTRACT_FILE\n${fileNode.rootName}\n${fileNode.relPath ?? ""}\n${fileHash}`;
  const signatureHash = sha256(sigInput);
  return {
    id: `contract:file:${signatureHash.slice(0, 24)}`,
    kind: "CONTRACT_FILE",
    name: fileNode.relPath ? fileNode.relPath.split("/").slice(-1)[0] : fileNode.name,
    rootId: fileNode.rootId,
    rootName: fileNode.rootName,
    fileId: fileNode.fileId,
    relPath: fileNode.relPath,
    sourceNodeId: fileNode.id,
    signatureHash,
    confidence: 0.6,
    attrs: stableAttrs({
      source: "contract_glob",
      fileHash,
      note: "contract glob match; structural parse not performed in v0.2",
    }),
    consumers: [],
    related: [],
  };
}

function shouldPromotePackage(node: DebugNodeRecord): boolean {
  if (boolAttr(node.attrs, "exported")) return true;
  return ["main", "exports", "bin"].some((key) => stringAttr(node.attrs, key));
}

function classifyDto(node: DebugNodeRecord, allNodes: DebugNodeRecord[]): "promote" | "internal" {
  const exported = boolAttr(node.attrs, "exported");
  if (exported) return "promote";
  const sameFileRoute = allNodes.some(
    (candidate) => candidate.kind === "HTTP_ROUTE_CANDIDATE" && candidate.fileId === node.fileId && node.fileId !== undefined,
  );
  return sameFileRoute ? "promote" : "internal";
}

function attachConsumers(
  contract: PromotedContract,
  edges: DebugEdgeRecord[],
  nodesById: Map<string, DebugNodeRecord>,
): void {
  if (!contract.sourceNodeId && !contract.fileId) return;
  const seen = new Set<string>();
  for (const edge of edges) {
    if (!isConsumerEdge(edge)) continue;
    const targetsContract =
      (contract.sourceNodeId && edge.toId === contract.sourceNodeId) ||
      (contract.fileId && edge.fileId === contract.fileId && edge.toId === `node:${contract.fileId}`);
    if (!targetsContract) continue;
    const fromId = edge.fromId;
    if (!fromId || seen.has(fromId)) continue;
    seen.add(fromId);
    const fromNode = nodesById.get(fromId);
    if (!fromNode) continue;
    if (fromNode.id === contract.sourceNodeId) continue;
    contract.consumers.push({
      consumerNodeId: fromNode.id,
      consumerRootId: fromNode.rootId,
      evidenceEdgeId: edge.id,
      confidence: edge.confidence,
      attrs: stableAttrs({
        edgeKind: edge.kind,
        consumerKind: fromNode.kind,
        consumerRoot: fromNode.rootName,
        consumerPath: fromNode.relPath,
      }),
    });
  }
  contract.consumers.sort((a, b) => a.consumerNodeId.localeCompare(b.consumerNodeId));
}

function attachRelated(
  contract: PromotedContract,
  nodes: DebugNodeRecord[],
  edges: DebugEdgeRecord[],
  nodesById: Map<string, DebugNodeRecord>,
): void {
  if (contract.kind !== "HTTP_ROUTE") return;
  if (!contract.fileId) return;
  for (const node of nodes) {
    if (node.kind !== "DTO_CANDIDATE") continue;
    if (node.fileId !== contract.fileId) continue;
    contract.related.push({
      nodeId: node.id,
      relation: "adjacent_dto",
      confidence: node.confidence,
      attrs: stableAttrs({ name: node.name, path: node.relPath, line: node.startLine }),
    });
  }
  for (const edge of edges) {
    if (edge.kind !== "USES_SCHEMA" && edge.kind !== "DOCUMENTED_BY") continue;
    if (edge.fromId !== contract.sourceNodeId) continue;
    const target = edge.toId ? nodesById.get(edge.toId) : undefined;
    if (!target) continue;
    contract.related.push({
      nodeId: target.id,
      relation: edge.kind === "USES_SCHEMA" ? "schema_ref" : "internal_dto",
      confidence: edge.confidence,
      attrs: stableAttrs({ edgeKind: edge.kind, name: target.name, path: target.relPath }),
    });
  }
  contract.related.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
}

function isConsumerEdge(edge: DebugEdgeRecord): boolean {
  return ["IMPORTS", "CALLS_ENDPOINT_CANDIDATE", "DEPENDS_ON_PACKAGE", "TESTS"].includes(edge.kind);
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function stringAttr(attrs: Record<string, unknown>, key: string): string | undefined {
  const value = attrs[key];
  return typeof value === "string" ? value : undefined;
}

function boolAttr(attrs: Record<string, unknown>, key: string): boolean {
  return attrs[key] === true;
}

function stringArrayAttr(attrs: Record<string, unknown>, key: string): string[] {
  const value = attrs[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stableAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(attrs)
      .filter(([, value]) => value !== undefined && value !== null && (typeof value !== "string" || value.length > 0))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}
