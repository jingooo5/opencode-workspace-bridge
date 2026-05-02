import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { WorkspaceStore } from "../state/workspace-store.js";
import type { SQLiteIndexStore } from "../indexer/sqlite-store.js";
import { openSQLiteIndexStore } from "../indexer/sqlite-store.js";

export interface PackExtensionInput {
  task: string;
  roots: string[] | undefined;
  limit: number;
  sessionID?: string;
  hits: Array<{ root: string; path: string; ref: string; text?: string }>;
}

export interface PackContractEntry {
  id: string;
  kind: string;
  name: string;
  rootName: string;
  relPath?: string;
  generatedYamlPath?: string;
  consumers: number;
  related: number;
}

export interface PackMemoryEntry {
  targetId: string;
  targetKind: string;
  summaryPath: string;
  body: string;
  stale: boolean;
}

export interface PackEditFocus {
  sessionID?: string;
  refs: Array<{ ref: string; lastTouchAt: string; tools: string[] }>;
}

export interface PackExtensionResult {
  contracts: PackContractEntry[];
  memory: PackMemoryEntry[];
  editFocus: PackEditFocus;
  suggestedEditOrder: string[];
}

export async function buildPackExtension(
  store: WorkspaceStore,
  input: PackExtensionInput,
): Promise<PackExtensionResult> {
  if (!existsSync(store.sqlitePath)) {
    return emptyResult(input.sessionID);
  }
  const opened = await openSQLiteIndexStore(store.sqlitePath, { readonly: true, skipMigrations: true });
  if (!opened.ok) return emptyResult(input.sessionID);
  const sqlite = opened.value;
  try {
    const contracts = collectContracts(sqlite, input);
    const memory = await collectMemory(store, contracts);
    const editFocus = await collectEditFocus(store, input.sessionID);
    const suggestedEditOrder = await computeSuggestedEditOrder(store, contracts);
    return { contracts, memory, editFocus, suggestedEditOrder };
  } finally {
    sqlite.close();
  }
}

export async function writePackMarkdownSibling(
  store: WorkspaceStore,
  jsonPath: string,
  data: { task: string; result: PackExtensionResult; evidence: Array<{ ref: string; line?: number; text?: string }> },
): Promise<string> {
  const mdPath = jsonPath.replace(/\.json$/i, ".md");
  const lines: string[] = [];
  lines.push(`# Context Pack: ${data.task}`);
  lines.push("");
  lines.push("## Active contracts");
  lines.push("");
  if (data.result.contracts.length === 0) lines.push("- (none matched)");
  for (const contract of data.result.contracts) {
    const where = contract.relPath ? `${contract.rootName}:${contract.relPath}` : contract.rootName;
    lines.push(`- ${contract.kind} \`${contract.name}\` at ${where} (consumers: ${contract.consumers})`);
  }
  lines.push("");
  lines.push("## Memory");
  lines.push("");
  if (data.result.memory.length === 0) lines.push("_No semantic memory entries; run ctx_summarize to generate._");
  for (const entry of data.result.memory) {
    lines.push(`### ${entry.targetKind} ${entry.targetId}${entry.stale ? " (stale)" : ""}`);
    lines.push("");
    lines.push(entry.body.trim());
    lines.push("");
  }
  lines.push("## Suggested edit order");
  lines.push("");
  for (const step of data.result.suggestedEditOrder) lines.push(`- ${step}`);
  lines.push("");
  lines.push("## Evidence anchors");
  lines.push("");
  for (const ref of data.evidence.slice(0, 12)) {
    const refLine = ref.line ? `${ref.ref}#L${ref.line}` : ref.ref;
    lines.push(`- ${refLine}${ref.text ? ` — ${truncate(ref.text, 80)}` : ""}`);
  }
  lines.push("");

  const text = lines.join("\n");
  void store;
  await writeFile(mdPath, `${text}\n`, "utf8");
  return mdPath;
}

function emptyResult(sessionID?: string): PackExtensionResult {
  return {
    contracts: [],
    memory: [],
    editFocus: { sessionID, refs: [] },
    suggestedEditOrder: defaultEditOrder([]),
  };
}

function collectContracts(sqlite: SQLiteIndexStore, input: PackExtensionInput): PackContractEntry[] {
  const all = sqlite.readContracts();
  if (!all.ok) return [];
  const allowedRoots = new Set(input.roots ?? []);
  const tokens = tokenize(input.task);
  const hitPaths = new Set(input.hits.map((hit) => hit.path));
  const matches: PackContractEntry[] = [];
  for (const contract of all.value) {
    if (allowedRoots.size && !allowedRoots.has(contract.rootName)) continue;
    const haystack = `${contract.name}\n${contract.relPath ?? ""}\n${contract.kind}`.toLowerCase();
    const matchesTask = tokens.some((token) => haystack.includes(token));
    const matchesPath = contract.relPath ? hitPaths.has(contract.relPath) : false;
    if (!matchesTask && !matchesPath) continue;
    matches.push({
      id: contract.id,
      kind: contract.kind,
      name: contract.name,
      rootName: contract.rootName,
      relPath: contract.relPath,
      generatedYamlPath: contract.generatedYamlPath,
      consumers: contract.consumers.length,
      related: contract.related.length,
    });
  }
  return matches.slice(0, input.limit);
}

function tokenize(task: string): string[] {
  return task
    .toLowerCase()
    .split(/[^a-z0-9./_-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

async function collectMemory(store: WorkspaceStore, contracts: PackContractEntry[]): Promise<PackMemoryEntry[]> {
  const out: PackMemoryEntry[] = [];
  if (!existsSync(store.sqlitePath)) return out;
  const opened = await openSQLiteIndexStore(store.sqlitePath, { readonly: true, skipMigrations: true });
  if (!opened.ok) return out;
  const sqlite = opened.value;
  try {
    for (const contract of contracts) {
      const summary = sqlite.readSummaryByTarget({ targetId: contract.id, targetKind: "CONTRACT" });
      if (!summary.ok || !summary.value) continue;
      const row = summary.value;
      const body = (await readFile(row.summary_path, "utf8").catch(() => "")) || "";
      out.push({
        targetId: row.target_id,
        targetKind: row.target_kind,
        summaryPath: row.summary_path,
        body,
        stale: row.stale === 1 || row.status === "stale",
      });
    }
  } finally {
    sqlite.close();
  }
  return out;
}

async function collectEditFocus(store: WorkspaceStore, sessionID?: string): Promise<PackEditFocus> {
  if (!sessionID || !existsSync(store.touchedNodesPath)) return { sessionID, refs: [] };
  const text = await readFile(store.touchedNodesPath, "utf8").catch(() => "");
  if (!text.trim()) return { sessionID, refs: [] };
  try {
    const parsed = JSON.parse(text) as { sessions?: Record<string, { refs?: Array<{ ref: string; lastTouchAt: string; tools: string[] }> }> };
    const session = parsed.sessions?.[sessionID];
    return {
      sessionID,
      refs: (session?.refs ?? []).map((entry) => ({ ref: entry.ref, lastTouchAt: entry.lastTouchAt, tools: entry.tools })),
    };
  } catch {
    return { sessionID, refs: [] };
  }
}

async function computeSuggestedEditOrder(store: WorkspaceStore, contracts: PackContractEntry[]): Promise<string[]> {
  const manifest = await store.readManifest().catch(() => undefined);
  const roRoots = new Set((manifest?.roots ?? []).filter((root) => root.access === "ro").map((root) => root.name));
  return defaultEditOrder(contracts, roRoots);
}

function defaultEditOrder(contracts: PackContractEntry[], roRoots: Set<string> = new Set()): string[] {
  const steps: string[] = [];
  const dtoContracts = contracts.filter((c) => c.kind === "DTO");
  const routeContracts = contracts.filter((c) => c.kind === "HTTP_ROUTE");
  const fileContracts = contracts.filter((c) => c.kind === "CONTRACT_FILE");
  const packageContracts = contracts.filter((c) => c.kind === "PACKAGE");

  for (const dto of dtoContracts) {
    if (roRoots.has(dto.rootName)) {
      steps.push(`Approve write access for ro root '${dto.rootName}' before editing ${dto.name}, or produce a patch suggestion only.`);
    }
  }
  if (dtoContracts.length > 0) steps.push(`Update DTO definitions: ${dtoContracts.map((c) => c.name).join(", ")}.`);
  if (fileContracts.length > 0) steps.push(`Synchronize contract documents: ${fileContracts.map((c) => c.name).join(", ")}.`);
  if (routeContracts.length > 0) steps.push(`Adjust route handlers and validators: ${routeContracts.map((c) => c.name).join(", ")}.`);
  if (packageContracts.length > 0) steps.push(`Bump or rebuild package contracts: ${packageContracts.map((c) => c.name).join(", ")}.`);
  steps.push("Run targeted tests for affected consumers; capture in pending_validations.jsonl.");
  return steps;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

void path;
