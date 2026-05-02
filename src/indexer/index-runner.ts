import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import {
  openSQLiteIndexStore,
  type DebugEdgeRecord,
  type DebugIndexRunRecord,
  type DebugNodeRecord,
  type DebugSnapshot,
  type DebugSpanRecord,
  type SQLiteIndexStore,
  type StorageDiagnostic,
} from "./sqlite-store.js";
import { scanRoot, rootIdOf, type ScannedFile } from "./scanner.js";
import type { WorkspaceStore } from "../state/workspace-store.js";
import type { RootSpec } from "../types.js";
import { extractTsJsFacts, mergeFacts } from "./extractors/ts-js.js";
import { extractPackageFacts } from "./extractors/package.js";
import { extractPythonFacts } from "./extractors/python.js";

export type IndexTarget =
  | { type: "workspace"; maxFiles?: number; reason?: string }
  | { type: "full"; maxFiles?: number; reason?: string }
  | { type: "root"; root: string | RootSpec; maxFiles?: number; reason?: string }
  | { type: "file-list"; root: string | RootSpec; files: string[]; reason?: string }
  | { type: "reason"; reason: string; roots?: string[]; maxFiles?: number };

export interface IndexRunStats {
  [key: string]: unknown;
  rootsIndexed: number;
  filesScanned: number;
  filesIndexed: number;
  filesSkipped: number;
  elapsedMs: number;
  degraded: boolean;
  diagnostics: { info: number; warn: number; error: number };
}

export interface IndexRunReport {
  runId?: string;
  reason: string;
  roots: string[];
  startedAt: string;
  finishedAt: string;
  stats: IndexRunStats;
  diagnostics: StorageDiagnostic[];
  files: ScannedFile[];
}

export async function runIndex(store: WorkspaceStore, target: IndexTarget): Promise<IndexRunReport> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const reason = reasonOf(target);
  const selectedRoots = await selectRoots(store, target);
  const rootNames = selectedRoots.map((root) => root.name).sort((a, b) => a.localeCompare(b));
  const diagnostics: StorageDiagnostic[] = [...optionalToolDiagnostics()];
  const allFiles: ScannedFile[] = [];
  let filesSkipped = 0;
  let runId: string | undefined;
  let degraded = false;
  let sqliteStore: SQLiteIndexStore | undefined;
  let sqliteWritable = false;

  const sqlite = await openSQLiteIndexStore(store.sqlitePath);
  if (!sqlite.ok) {
    diagnostics.push(...sqlite.diagnostics);
    degraded = true;
  } else {
    sqliteStore = sqlite.value;
    sqliteWritable = true;
    diagnostics.push(...sqlite.diagnostics);
    const start = sqlite.value.startIndexRun({ reason, roots: rootNames, startedAt, stats: baseStats(startedMs, false, 0, 0, 0) });
    if (start.ok) runId = start.value.runId;
    else {
      diagnostics.push(...start.diagnostics);
      degraded = true;
      sqliteWritable = false;
    }
  }

  for (const root of selectedRoots.sort((a, b) => a.name.localeCompare(b.name))) {
    const scan = await scanRoot(root, {
      files: target.type === "file-list" ? target.files : undefined,
      maxFiles: "maxFiles" in target ? target.maxFiles : undefined,
      indexedAt: startedAt,
    });
    filesSkipped += scan.skipped;
    diagnostics.push(...scan.diagnostics.map(scanDiagnosticToStorage));
    allFiles.push(...scan.files);

    if (sqliteStore && sqliteWritable) {
      const persisted = sqliteStore.persistRootScan({
        root: {
          id: rootIdOf(root.name),
          name: root.name,
          absPath: root.absPath,
          relPath: root.path,
          role: root.role ?? "unknown",
          access: root.access,
          languages: sortedUnique(scan.files.map((file) => file.language).filter((item): item is string => !!item)),
          tags: root.tags ?? [],
          status: "indexed",
          lastIndexedAt: startedAt,
          updatedAt: startedAt,
        },
        files: scan.files.map((file) => ({
          id: file.id,
          rootId: file.rootId,
          relPath: file.relPath,
          absPath: file.absPath,
          language: file.language,
          hash: file.hash,
          sizeBytes: file.sizeBytes,
          isGenerated: file.isGenerated,
          indexedAt: file.indexedAt,
          mtimeMs: file.mtimeMs,
          updatedAt: startedAt,
        })),
        pruneMissing: target.type !== "file-list",
      });
      if (!persisted.ok) {
        diagnostics.push(...persisted.diagnostics);
        degraded = true;
        sqliteWritable = false;
        diagnostics.push(writeSkipDiagnostic("persistRootScan", store.sqlitePath));
        continue;
      }

      if (target.type === "file-list") {
        const missingRelPaths = missingFileListTargets(root, target.files, scan.files);
        if (missingRelPaths.length > 0) {
          const pruned = sqliteStore.pruneFileTargets({ rootId: rootIdOf(root.name), relPaths: missingRelPaths });
          if (!pruned.ok) {
            diagnostics.push(...pruned.diagnostics);
            degraded = true;
            sqliteWritable = false;
            diagnostics.push(writeSkipDiagnostic("pruneFileTargets", store.sqlitePath));
            continue;
          }
        }
      }

      const extraction = await extractFactsForScannedFiles(root, scan.files, startedAt);
      diagnostics.push(...extraction.diagnostics.map(extractionDiagnosticToStorage));
      if (extraction.diagnostics.length > 0) degraded = true;
      const factsPersisted = sqliteStore.persistExtractedFacts({
        fileIds: scan.files.map((file) => file.id),
        facts: extraction,
        updatedAt: startedAt,
      });
      if (!factsPersisted.ok) {
        diagnostics.push(...factsPersisted.diagnostics);
        degraded = true;
        sqliteWritable = false;
        diagnostics.push(writeSkipDiagnostic("persistExtractedFacts", store.sqlitePath));
      }
    }
  }

  if (sqliteStore && sqliteWritable) {
    const resolved = sqliteStore.recomputeResolverFacts(startedAt);
    if (!resolved.ok) {
      diagnostics.push(...resolved.diagnostics);
      degraded = true;
      sqliteWritable = false;
      diagnostics.push(writeSkipDiagnostic("recomputeResolverFacts", store.sqlitePath));
    }
  }

  const finishedAt = new Date().toISOString();
  const stats = buildStats(startedMs, degraded, selectedRoots.length, allFiles.length, filesSkipped, diagnostics);
  if (sqliteStore) {
    if (runId && sqliteWritable) {
      const finish = sqliteStore.finishIndexRun({
        runId,
        status: diagnostics.some((item) => item.level === "error") ? "failed" : "completed",
        finishedAt,
        filesSeen: allFiles.length,
        stats,
        diagnostics,
      });
      if (!finish.ok) {
        diagnostics.push(...finish.diagnostics);
        degraded = true;
      }
    }

    const debugSnapshot = sqliteStore.readDebugSnapshot();
    if (!debugSnapshot.ok) {
      diagnostics.push(...debugSnapshot.diagnostics);
      degraded = true;
    } else {
      try {
        await writeDebugArtifacts(store, debugSnapshot.value, { reason, roots: rootNames, diagnostics });
      } catch (error) {
        diagnostics.push({
          level: "error",
          code: "indexer.debug_export_failed",
          message: "Failed to write JSONL debug exports.",
          path: store.stateDirAbs,
          cause: error instanceof Error ? error.message : String(error),
        });
        degraded = true;
      }
    }

    const close = sqliteStore.close();
    if (!close.ok) diagnostics.push(...close.diagnostics);
  }

  return {
    runId,
    reason,
    roots: rootNames,
    startedAt,
    finishedAt,
    stats: buildStats(startedMs, degraded, selectedRoots.length, allFiles.length, filesSkipped, diagnostics),
    diagnostics,
    files: allFiles.sort((a, b) => `${a.root.name}/${a.relPath}`.localeCompare(`${b.root.name}/${b.relPath}`)),
  };
}

function reasonOf(target: IndexTarget): string {
  if (target.type === "reason") return target.reason;
  return target.reason ?? target.type;
}

async function selectRoots(store: WorkspaceStore, target: IndexTarget): Promise<RootSpec[]> {
  const roots = await store.listRoots();
  if (target.type === "workspace" || target.type === "full") return roots;
  if (target.type === "reason") {
    const allowed = new Set(target.roots ?? roots.map((root) => root.name));
    return roots.filter((root) => allowed.has(root.name));
  }
  const rootName = typeof target.root === "string" ? target.root : target.root.name;
  return roots.filter((root) => root.name === rootName);
}

function baseStats(startedMs: number, degraded: boolean, rootsIndexed: number, filesIndexed: number, filesSkipped: number): IndexRunStats {
  return {
    rootsIndexed,
    filesScanned: filesIndexed,
    filesIndexed,
    filesSkipped,
    elapsedMs: Math.max(0, Date.now() - startedMs),
    degraded,
    diagnostics: { info: 0, warn: 0, error: 0 },
  };
}

function buildStats(
  startedMs: number,
  degraded: boolean,
  rootsIndexed: number,
  filesIndexed: number,
  filesSkipped: number,
  diagnostics: StorageDiagnostic[],
): IndexRunStats {
  const counts = { info: 0, warn: 0, error: 0 };
  for (const diagnostic of diagnostics) counts[diagnostic.level]++;
  return { ...baseStats(startedMs, degraded, rootsIndexed, filesIndexed, filesSkipped), diagnostics: counts };
}

function scanDiagnosticToStorage(diagnostic: { level: "warn" | "error"; code: string; message: string; path?: string }): StorageDiagnostic {
  return { ...diagnostic };
}

function extractionDiagnosticToStorage(diagnostic: { level: "warn" | "error"; code: string; message: string; path?: string }): StorageDiagnostic {
  return { ...diagnostic };
}

async function extractFactsForScannedFiles(root: RootSpec, files: ScannedFile[], updatedAt: string) {
  const facts = [];
  for (const file of files.sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    const text = await safeReadText(file.absPath);
    if (text === undefined) continue;
    facts.push(extractTsJsFacts(root, file, text, updatedAt));
    facts.push(extractPackageFacts(root, file, text, updatedAt));
    facts.push(extractPythonFacts(root, file, text, updatedAt));
  }
  return mergeFacts(facts);
}

async function safeReadText(file: string): Promise<string | undefined> {
  try {
    const text = await readFile(file, "utf8");
    if (text.includes("\u0000")) return undefined;
    return text.slice(0, 500_000);
  } catch {
    return undefined;
  }
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function missingFileListTargets(root: RootSpec, requestedFiles: string[], scannedFiles: ScannedFile[]): string[] {
  const scanned = new Set(scannedFiles.map((file) => file.relPath));
  return requestedFiles
    .map((file) => {
      const absPath = path.isAbsolute(file) ? path.normalize(file) : path.resolve(root.absPath, file);
      const relPath = path.relative(root.absPath, absPath).replaceAll(path.sep, "/");
      return relPath && relPath !== "." && !relPath.startsWith("../") && relPath !== ".." ? relPath : undefined;
    })
    .filter((relPath): relPath is string => !!relPath && !scanned.has(relPath))
    .sort((left, right) => left.localeCompare(right));
}

function optionalToolDiagnostics(): StorageDiagnostic[] {
  const unavailable: string[] = [];
  if (!Bun.which("rg")) unavailable.push("ripgrep");
  if (!Bun.which("ast-grep") && !Bun.which("sg")) unavailable.push("ast-grep");
  unavailable.push("LSP");
  return unavailable.length > 0
    ? [{
        level: "info",
        code: "indexer.optional_tools_unavailable",
        message: `Optional helpers unavailable (${unavailable.join(", ")}); indexing continues with deterministic built-in scanner/extractors and does not require them for correctness.`,
      }]
    : [];
}

function writeSkipDiagnostic(stage: string, dbPath: string): StorageDiagnostic {
  return {
    level: "warn",
    code: "sqlite.write_skipped_after_failure",
    message: `SQLite writes were skipped after ${stage} failed; legacy JSONL compatibility and safe degraded output remain available.`,
    path: dbPath,
  };
}

async function writeDebugArtifacts(
  store: WorkspaceStore,
  snapshot: DebugSnapshot,
  run: { reason: string; roots: string[]; diagnostics: StorageDiagnostic[] },
): Promise<void> {
  await writeJsonl(
    store.evidenceNodesPath,
    snapshot.nodes
      .map(toDebugNodeLine)
      .sort(compareByStableKeys((item) => [item.id, item.root, item.path ?? "", numberKey(item.startLine), numberKey(item.endLine)])),
  );
  await writeJsonl(
    store.evidenceEdgesPath,
    snapshot.edges
      .map(toDebugEdgeLine)
      .sort(compareByStableKeys((item) => [item.id, item.root ?? "", item.path ?? "", numberKey(item.startLine), numberKey(item.endLine)])),
  );
  await writeJsonl(
    store.evidenceSpansPath,
    snapshot.spans
      .map(toDebugSpanLine)
      .sort(compareByStableKeys((item) => [item.id, item.root, item.path ?? "", numberKey(item.startLine), numberKey(item.endLine)])),
  );
  await writeJsonl(
    store.indexerDiagnosticsPath,
    run.diagnostics
      .map((diagnostic) => ({
        stage: diagnosticStage(diagnostic.code),
        level: diagnostic.level,
        code: diagnostic.code,
        message: diagnostic.message,
        path: diagnostic.path,
        cause: diagnostic.cause,
        roots: run.roots,
        reason: run.reason,
      }))
      .sort(compareByStableKeys((item) => [item.stage, item.level, item.code, item.path ?? "", item.message, item.cause ?? ""])),
  );
  await writeJsonl(
    store.indexRunsLogPath,
    snapshot.indexRuns
      .map(toDebugIndexRunLine)
      .sort(compareByStableKeys((item) => [item.startedAt, item.id])),
  );
}

function toDebugNodeLine(node: DebugNodeRecord) {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    rootId: node.rootId,
    root: node.rootName,
    fileId: node.fileId,
    path: node.relPath,
    startLine: node.startLine,
    endLine: node.endLine,
    confidence: node.confidence,
    attrs: node.attrs,
  };
}

function toDebugEdgeLine(edge: DebugEdgeRecord) {
  return {
    id: edge.id,
    kind: edge.kind,
    fromId: edge.fromId,
    toId: edge.toId,
    rootId: edge.rootId,
    root: edge.rootName,
    fileId: edge.fileId,
    path: edge.relPath,
    startLine: edge.startLine,
    endLine: edge.endLine,
    confidence: edge.confidence,
    attrs: edge.attrs,
  };
}

function toDebugSpanLine(span: DebugSpanRecord) {
  return {
    id: span.id,
    kind: span.kind,
    rootId: span.rootId,
    root: span.rootName,
    fileId: span.fileId,
    path: span.relPath,
    startLine: span.startLine,
    endLine: span.endLine,
    text: span.text,
  };
}

function toDebugIndexRunLine(run: DebugIndexRunRecord) {
  return {
    id: run.id,
    reason: run.reason,
    roots: [...run.roots].sort((a, b) => a.localeCompare(b)),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    stats: run.stats,
    diagnostics: run.diagnostics,
  };
}

async function writeJsonl(filePath: string, entries: unknown[]): Promise<void> {
  const text = entries.map((entry) => stableStringify(entry)).join("\n");
  await writeFile(filePath, text ? `${text}\n` : "", "utf8");
}

function compareByStableKeys<T>(toKeys: (value: T) => Array<number | string>) {
  return (left: T, right: T) => {
    const leftKeys = toKeys(left);
    const rightKeys = toKeys(right);
    const length = Math.max(leftKeys.length, rightKeys.length);
    for (let index = 0; index < length; index++) {
      const comparison = compareKey(leftKeys[index] ?? "", rightKeys[index] ?? "");
      if (comparison !== 0) return comparison;
    }
    return 0;
  };
}

function compareKey(left: number | string, right: number | string): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
}

function numberKey(value: number | undefined): number {
  return value ?? Number.MAX_SAFE_INTEGER;
}

function diagnosticStage(code: string): string {
  if (code.startsWith("sqlite.") || code.startsWith("schema.")) return "storage";
  if (code.startsWith("scan.")) return "scanning";
  if (code.startsWith("python.") || code.startsWith("ts_js.") || code.startsWith("tsjs.") || code.startsWith("package.")) return "extraction";
  return "indexer";
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeJsonValue(value));
}

function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeJsonValue(item));
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeJsonValue(item)]);
    return Object.fromEntries(entries);
  }
  return value;
}
