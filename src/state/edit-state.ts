import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { openSQLiteIndexStore } from "../indexer/sqlite-store.js";
import type { WorkspaceStore } from "./workspace-store.js";

export interface TouchedRefRecord {
  ref: string;
  root: string;
  path: string;
  fileId: string;
  lastTouchAt: string;
  tools: string[];
  nodeIds: string[];
}

export interface TouchedNodesFile {
  updatedAt: string;
  sessions: Record<string, { refs: TouchedRefRecord[] }>;
}

export interface PendingValidationEntry {
  at: string;
  sessionID?: string;
  ref: string;
  kind: "test" | "typecheck" | "build";
  reason: string;
  satisfiedAt?: string;
  satisfiedBy?: string;
}

export interface ImpactLedgerEntry {
  at: string;
  sessionID?: string;
  target: string;
  contractIds: string[];
  requiredGates: Array<{ kind: string; reason?: string; scope?: string }>;
  evidenceCounts: { direct: number; crossRoot: number; unknown: number };
}

export interface RecordEditInput {
  store: WorkspaceStore;
  sessionID?: string;
  tool: string;
  absPath: string;
}

export async function recordEdit(input: RecordEditInput): Promise<void> {
  const found = await input.store.findRootByPath(input.absPath);
  if (!found) return;
  const ref = input.store.refOf(found.root, found.relPath);
  const fileId = `file:${found.root.name}:${found.relPath}`;
  const nodeIds = await readNodeIdsForFile(input.store, fileId);
  const sessionID = input.sessionID ?? "_unknown";

  await mutateTouchedNodes(input.store, (current) => {
    const session = current.sessions[sessionID] ?? { refs: [] };
    const existing = session.refs.find((entry) => entry.ref === ref);
    const lastTouchAt = new Date().toISOString();
    if (existing) {
      existing.lastTouchAt = lastTouchAt;
      if (!existing.tools.includes(input.tool)) existing.tools.push(input.tool);
      existing.tools.sort();
      existing.nodeIds = uniqueSorted([...existing.nodeIds, ...nodeIds]);
    } else {
      session.refs.push({
        ref,
        root: found.root.name,
        path: found.relPath,
        fileId,
        lastTouchAt,
        tools: [input.tool],
        nodeIds,
      });
    }
    session.refs.sort((a, b) => a.ref.localeCompare(b.ref));
    current.sessions[sessionID] = session;
    return current;
  });
}

export async function recordPendingValidation(
  store: WorkspaceStore,
  entry: PendingValidationEntry,
): Promise<void> {
  await ensureDir(store.stateFilesDir);
  const line = JSON.stringify(entry);
  await writeFile(store.pendingValidationsPath, `${line}\n`, { flag: "a", encoding: "utf8" });
}

export async function recordValidationSatisfaction(
  store: WorkspaceStore,
  input: { sessionID?: string; tool: string; command: string; kind: PendingValidationEntry["kind"] },
): Promise<void> {
  await recordPendingValidation(store, {
    at: new Date().toISOString(),
    sessionID: input.sessionID,
    ref: "*",
    kind: input.kind,
    reason: `validation_command:${input.tool}`,
    satisfiedAt: new Date().toISOString(),
    satisfiedBy: input.command,
  });
}

export async function appendImpactLedger(
  store: WorkspaceStore,
  entry: ImpactLedgerEntry,
): Promise<void> {
  await ensureDir(store.stateFilesDir);
  await writeFile(store.impactLedgerPath, `${JSON.stringify(entry)}\n`, { flag: "a", encoding: "utf8" });
}

export async function readImpactLedgerTail(store: WorkspaceStore, limit = 200): Promise<ImpactLedgerEntry[]> {
  if (!existsSync(store.impactLedgerPath)) return [];
  const text = await readFile(store.impactLedgerPath, "utf8").catch(() => "");
  const lines = text.split("\n").filter(Boolean).slice(-limit);
  const out: ImpactLedgerEntry[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as ImpactLedgerEntry);
    } catch {
      // ignore malformed line
    }
  }
  return out;
}

export interface HasRecentImpactInput {
  sessionID?: string;
  contractIds: string[];
  withinSeconds: number;
}

export async function hasRecentImpact(
  store: WorkspaceStore,
  input: HasRecentImpactInput,
): Promise<boolean> {
  const ledger = await readImpactLedgerTail(store, 500);
  const now = Date.now();
  const targetIds = new Set(input.contractIds);
  return ledger.some((entry) => {
    if (input.sessionID && entry.sessionID && entry.sessionID !== input.sessionID) return false;
    const entryTime = Date.parse(entry.at);
    if (Number.isNaN(entryTime)) return false;
    if (now - entryTime > input.withinSeconds * 1000) return false;
    if (targetIds.size === 0) return true;
    return entry.contractIds.some((id) => targetIds.has(id));
  });
}

export async function syncStaleSummaries(store: WorkspaceStore): Promise<void> {
  if (!existsSync(store.sqlitePath)) {
    await writeJsonAtomic(store.staleSummariesPath, { updatedAt: new Date().toISOString(), entries: [] });
    return;
  }
  const opened = await openSQLiteIndexStore(store.sqlitePath, { readonly: true, skipMigrations: true });
  if (!opened.ok) {
    await writeJsonAtomic(store.staleSummariesPath, { updatedAt: new Date().toISOString(), entries: [], degraded: true });
    return;
  }
  const sqlite = opened.value;
  try {
    const rows = sqlite.readStaleSummaries();
    const entries = rows.ok
      ? rows.value.map((row) => ({
          id: row.id,
          targetId: row.target_id,
          targetKind: row.target_kind,
          summaryPath: row.summary_path,
          evidenceHash: row.evidence_hash,
          status: row.status,
          stale: !!row.stale,
          updatedAt: row.updated_at,
        }))
      : [];
    await writeJsonAtomic(store.staleSummariesPath, { updatedAt: new Date().toISOString(), entries });
  } finally {
    sqlite.close();
  }
}

async function readNodeIdsForFile(store: WorkspaceStore, fileId: string): Promise<string[]> {
  if (!existsSync(store.sqlitePath)) return [];
  const opened = await openSQLiteIndexStore(store.sqlitePath, { readonly: true, skipMigrations: true });
  if (!opened.ok) return [];
  try {
    const snapshot = opened.value.readDebugSnapshot();
    if (!snapshot.ok) return [];
    return snapshot.value.nodes.filter((node) => node.fileId === fileId).map((node) => node.id).sort();
  } finally {
    opened.value.close();
  }
}

async function mutateTouchedNodes(
  store: WorkspaceStore,
  mutator: (current: TouchedNodesFile) => TouchedNodesFile,
): Promise<void> {
  await ensureDir(store.stateFilesDir);
  let current: TouchedNodesFile = { updatedAt: new Date().toISOString(), sessions: {} };
  if (existsSync(store.touchedNodesPath)) {
    const text = await readFile(store.touchedNodesPath, "utf8").catch(() => "");
    if (text.trim().length > 0) {
      try {
        const parsed = JSON.parse(text) as TouchedNodesFile;
        if (parsed && typeof parsed === "object" && parsed.sessions) current = parsed;
      } catch {
        // start over with a fresh snapshot if the prior file is corrupt.
      }
    }
  }
  const next = mutator(current);
  next.updatedAt = new Date().toISOString();
  await writeJsonAtomic(store.touchedNodesPath, next);
}

async function writeJsonAtomic(targetPath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(targetPath));
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmpPath, targetPath);
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
