import { tool } from "@opencode-ai/plugin";
import type { ToolDefinition } from "@opencode-ai/plugin";
import { existsSync } from "node:fs";
import type { WorkspaceStore } from "../state/workspace-store.js";
import { openSQLiteIndexStore, type SQLiteIndexStore } from "../indexer/sqlite-store.js";
import { MemoryWriter, type WriteMemoryResult } from "../indexer/memory/writer.js";
import { TemplateSummarizer } from "../indexer/memory/summarizer-template.js";
import type { MemoryEvidenceRef, MemoryTargetContext } from "../indexer/memory/summarizer-iface.js";

const z = tool.schema;

export function createSummarizeTool(store: WorkspaceStore): ToolDefinition {
  const summarizer = new TemplateSummarizer();
  const writer = new MemoryWriter(summarizer, {
    contractsDir: store.memoryContractsDir,
    symbolsDir: store.memorySymbolsDir,
    rootsDir: store.memoryRootsDir,
  });

  return tool({
    description:
      "Generate or refresh semantic memory entries for contracts, symbols, or roots. Memory bodies are deterministic templates anchored to evidence in the SQLite graph; LLM-backed summarizers are pluggable.",
    args: {
      target: z.string().min(1).optional().describe("Target id (contract id, node id) or root name. If omitted, refresh all stale summaries."),
      kind: z.enum(["CONTRACT", "SYMBOL", "ROOT"]).optional(),
      refreshStale: z.boolean().optional().describe("When true, regenerate every summary marked stale, ignoring target."),
      limit: z.number().int().positive().optional(),
    },
    async execute(args) {
      const sqlitePath = store.sqlitePath;
      if (!existsSync(sqlitePath)) {
        return JSON.stringify({
          version: "v0.2",
          status: "sqlite_missing",
          message: "SQLite index is missing; run ctx_index first.",
          memoryDir: store.memoryDir,
        }, null, 2);
      }

      const opened = await openSQLiteIndexStore(sqlitePath);
      if (!opened.ok) {
        return JSON.stringify({
          version: "v0.2",
          status: "sqlite_unavailable",
          diagnostics: opened.diagnostics,
        }, null, 2);
      }

      const sqlite = opened.value;
      try {
        const fileHashes = sqlite.readFileHashes();
        if (!fileHashes.ok) {
          return JSON.stringify({ version: "v0.2", status: "sqlite_read_failed", diagnostics: fileHashes.diagnostics }, null, 2);
        }
        const limit = args.limit ?? 50;
        const refreshStale = args.refreshStale ?? !args.target;
        const targets = collectTargets(sqlite, { target: args.target, kind: args.kind, refreshStale, limit });
        const written: WriteMemoryResult[] = [];
        for (const target of targets) {
          const evidenceRefs = evidenceRefsFor(target);
          const result = await writer.write(sqlite, {
            target,
            evidenceRefs,
            fileHashes: fileHashes.value,
          });
          written.push(result);
        }
        return JSON.stringify({
          version: "v0.2",
          summarizer: summarizer.name,
          requested: { target: args.target ?? null, kind: args.kind ?? null, refreshStale, limit },
          generated: written.map((entry) => ({
            targetId: entry.targetId,
            targetKind: entry.targetKind,
            summaryPath: entry.summaryPath,
            evidenceHash: entry.evidenceHash,
            rewritten: entry.rewritten,
          })),
          generatedCount: written.length,
        }, null, 2);
      } finally {
        sqlite.close();
      }
    },
  });
}

interface CollectTargetsOptions {
  target?: string;
  kind?: "CONTRACT" | "SYMBOL" | "ROOT";
  refreshStale: boolean;
  limit: number;
}

function collectTargets(sqlite: SQLiteIndexStore, options: CollectTargetsOptions): MemoryTargetContext[] {
  const out: MemoryTargetContext[] = [];

  if (options.target && options.kind === "CONTRACT") {
    const contract = findContract(sqlite, options.target);
    if (contract) out.push({ kind: "CONTRACT", contract });
  } else if (options.target && options.kind === "SYMBOL") {
    const node = findNode(sqlite, options.target);
    if (node) out.push({ kind: "SYMBOL", node });
  } else if (options.target && options.kind === "ROOT") {
    out.push({ kind: "ROOT", rootName: options.target, access: rootAccess(sqlite, options.target) });
  } else if (options.target) {
    const contract = findContract(sqlite, options.target);
    if (contract) out.push({ kind: "CONTRACT", contract });
    else {
      const node = findNode(sqlite, options.target);
      if (node) out.push({ kind: "SYMBOL", node });
    }
  } else {
    const stale = options.refreshStale ? readStaleTargets(sqlite, options.limit) : [];
    if (stale.length > 0) out.push(...stale);
    else out.push(...readAllContracts(sqlite, options.limit));
  }

  return out.slice(0, options.limit);
}

function findContract(sqlite: SQLiteIndexStore, target: string): import("../indexer/sqlite-store.js").DebugContractRecord | undefined {
  const all = sqlite.readContracts();
  if (!all.ok) return undefined;
  return all.value.find((contract) => contract.id === target || contract.name === target);
}

function findNode(sqlite: SQLiteIndexStore, target: string): import("../indexer/sqlite-store.js").DebugNodeRecord | undefined {
  const snapshot = sqlite.readDebugSnapshot();
  if (!snapshot.ok) return undefined;
  return snapshot.value.nodes.find((node) => node.id === target || node.name === target);
}

function rootAccess(sqlite: SQLiteIndexStore, rootName: string): string {
  const snapshot = sqlite.readDebugSnapshot();
  if (!snapshot.ok) return "unknown";
  const root = snapshot.value.nodes.find((node) => node.kind === "FILE" && node.rootName === rootName);
  return root ? "rw" : "unknown";
}

function readStaleTargets(sqlite: SQLiteIndexStore, limit: number): MemoryTargetContext[] {
  const stale = sqlite.readStaleSummaries();
  if (!stale.ok) return [];
  const out: MemoryTargetContext[] = [];
  const contracts = sqlite.readContracts();
  const snapshot = sqlite.readDebugSnapshot();
  const contractMap = new Map((contracts.ok ? contracts.value : []).map((c) => [c.id, c]));
  const nodeMap = new Map((snapshot.ok ? snapshot.value.nodes : []).map((n) => [n.id, n]));
  for (const row of stale.value.slice(0, limit)) {
    if (row.target_kind === "CONTRACT") {
      const contract = contractMap.get(row.target_id);
      if (contract) out.push({ kind: "CONTRACT", contract });
    } else if (row.target_kind === "SYMBOL") {
      const node = nodeMap.get(row.target_id);
      if (node) out.push({ kind: "SYMBOL", node });
    } else if (row.target_kind === "ROOT") {
      const rootName = row.target_id.replace(/^root:/, "");
      out.push({ kind: "ROOT", rootName, access: rootAccess(sqlite, rootName) });
    }
  }
  return out;
}

function readAllContracts(sqlite: SQLiteIndexStore, limit: number): MemoryTargetContext[] {
  const contracts = sqlite.readContracts();
  if (!contracts.ok) return [];
  return contracts.value.slice(0, limit).map((contract) => ({ kind: "CONTRACT", contract }));
}

function evidenceRefsFor(target: MemoryTargetContext): MemoryEvidenceRef[] {
  const refs: MemoryEvidenceRef[] = [];
  if (target.kind === "CONTRACT") {
    const c = target.contract;
    if (c.relPath) refs.push({ kind: c.kind, ref: `${c.rootName}:${c.relPath}`, line: c.attrs && typeof c.attrs.startLine === "number" ? c.attrs.startLine : undefined, note: c.kind });
    for (const consumer of c.consumers) {
      refs.push({ kind: "CONSUMER", ref: consumer.consumerNodeId });
    }
    for (const related of c.related) {
      refs.push({ kind: related.relation.toUpperCase(), ref: related.nodeId });
    }
  } else if (target.kind === "SYMBOL") {
    const node = target.node;
    if (node.relPath) refs.push({ kind: node.kind, ref: `${node.rootName}:${node.relPath}`, line: node.startLine });
  } else {
    refs.push({ kind: "ROOT", ref: target.rootName });
  }
  return refs;
}
