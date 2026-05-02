import path from "node:path";
import { readFile, writeFile, open, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { IndexEntrySchema, type IndexEntry, type RootSpec, type SearchHit } from "../types.js";
import { refOf } from "../shared/path.js";
import type { WorkspaceStore } from "../state/workspace-store.js";
import { runIndex } from "./index-runner.js";
import type { ScannedFile } from "./scanner.js";
import { extractTsJsFacts } from "./extractors/ts-js.js";
import { extractPackageFacts } from "./extractors/package.js";
import { extractPythonFacts, isPythonMetadataFile } from "./extractors/python.js";

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".txt", ".md", ".py", ".go", ".rs", ".java", ".kt", ".proto", ".graphql", ".sql", ".prisma",
]);

const INDEX_LOCK_WAIT_MS = 1_500;
const INDEX_LOCK_POLL_MS = 75;
const INDEX_LOCK_STALE_MS = 30_000;

// Compatibility boundary: these exports remain the legacy caller surface while
// Task 2 keeps JSONL as the guaranteed fallback. Future SQLite-first work can
// replace the helpers below, but must preserve the exported names/signatures and
// the public IndexEntry/SearchHit shapes expected by existing tools.

export async function indexRoot(store: WorkspaceStore, root: RootSpec, maxFiles = 2500): Promise<IndexEntry[]> {
  return await withIndexLock(store, { root: root.name, reason: "root.index" }, async () => {
    const report = await runIndex(store, { type: "root", root, maxFiles, reason: "root.index" });
    const files = report.files.filter((file) => file.root.name === root.name);
    const entries = await legacyEntriesForScannedFiles(root, files, report.startedAt);

    await appendEntries(store.indexPath, root.name, entries);
    await store.markIndexed(root.name);
    await store.appendLedger({ type: "root.indexed", root: root.name, entries: entries.length });
    return entries;
  }, async () => (await readEntries(store.indexPath)).filter((entry) => entry.root === root.name));
}

export async function indexWorkspace(store: WorkspaceStore, reason = "workspace.index"): Promise<Array<{ root: string; entries: number }>> {
  return await withIndexLock(store, { reason }, async () => {
    const report = await runIndex(store, { type: "workspace", reason });
    const grouped = groupFilesByRoot(report.files);
    const out: Array<{ root: string; entries: number }> = [];
    for (const root of await store.listRoots()) {
      const files = grouped.get(root.name) ?? [];
      const entries = await legacyEntriesForScannedFiles(root, files, report.startedAt);
      await appendEntries(store.indexPath, root.name, entries);
      await store.markIndexed(root.name);
      await store.appendLedger({ type: "root.indexed", root: root.name, entries: entries.length });
      out.push({ root: root.name, entries: entries.length });
    }
    return out;
  }, async () => {
    const entries = await readEntries(store.indexPath);
    const counts = countEntriesByRoot(entries);
    return Array.from(counts.entries()).map(([root, count]) => ({ root, entries: count }));
  });
}

export async function searchIndex(store: WorkspaceStore, query: string, roots?: string[], limit = 30): Promise<SearchHit[]> {
  const q = query.toLowerCase();
  const entries = await readSearchEntries(store);
  const allowed = new Set(roots ?? []);
  const hits: SearchHit[] = [];

  for (const entry of entries) {
    if (allowed.size && !allowed.has(entry.root)) continue;
    const haystack = `${entry.name}\n${entry.path}\n${entry.text ?? ""}`.toLowerCase();
    if (!haystack.includes(q)) continue;
    const score = entry.name.toLowerCase() === q ? 10 : entry.name.toLowerCase().includes(q) ? 6 : entry.path.toLowerCase().includes(q) ? 4 : 1;
    hits.push(toSearchHit(entry, score));
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

async function safeRead(file: string): Promise<string | undefined> {
  try {
    const text = await readFile(file, "utf8");
    if (text.includes("\u0000")) return undefined;
    return text.slice(0, 500_000);
  } catch {
    return undefined;
  }
}

async function legacyEntriesForScannedFiles(root: RootSpec, files: ScannedFile[], now: string): Promise<IndexEntry[]> {
  const entries: IndexEntry[] = [];
  for (const file of files.sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    const relPath = file.relPath;
    const ext = path.extname(relPath).toLowerCase();
    const ref = refOf(root.name, relPath);
    entries.push({ root: root.name, ref, path: relPath, kind: "file", name: path.basename(relPath), updatedAt: now });

    if (!TEXT_EXTENSIONS.has(ext) && !isPythonMetadataFile(relPath)) continue;
    const text = await safeRead(file.absPath);
    if (!text) continue;
    entries.push(...extractTsJsFacts(root, file, text, now).legacyEntries);
    entries.push(...extractPackageFacts(root, file, text, now).legacyEntries);
    entries.push(...extractPythonFacts(root, file, text, now).legacyEntries);
    if (isContractFile(relPath)) {
      entries.push({ root: root.name, ref, path: relPath, kind: "contract", name: path.basename(relPath), updatedAt: now });
    }
    if (/\b(test|spec)\b/i.test(relPath)) {
      entries.push({ root: root.name, ref, path: relPath, kind: "test", name: path.basename(relPath), updatedAt: now });
    }
  }
  return entries;
}

function groupFilesByRoot(files: ScannedFile[]): Map<string, ScannedFile[]> {
  const grouped = new Map<string, ScannedFile[]>();
  for (const file of files) {
    const existing = grouped.get(file.root.name) ?? [];
    existing.push(file);
    grouped.set(file.root.name, existing);
  }
  return grouped;
}

function isContractFile(relPath: string): boolean {
  return /(^|\/)(openapi|schema)\.(ya?ml|json|graphql|prisma)$/.test(relPath) || /\.proto$/.test(relPath) || /migrations\//.test(relPath);
}

async function appendEntries(indexPath: string, rootName: string, entries: IndexEntry[]): Promise<void> {
  const existing = await readEntries(indexPath);
  const retained = existing.filter((entry) => entry.root !== rootName);
  const all = [...retained, ...entries];
  await writeFile(indexPath, all.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

export async function readEntries(indexPath: string): Promise<IndexEntry[]> {
  return readLegacyJsonlEntries(indexPath);
}

async function readSearchEntries(store: WorkspaceStore): Promise<IndexEntry[]> {
  // Compatibility boundary: search must keep working from the current JSONL
  // index when SQLite is unavailable or not yet adopted by callers.
  return readEntries(store.indexPath);
}

function toSearchHit(entry: IndexEntry, score: number): SearchHit {
  return {
    root: entry.root,
    ref: entry.ref,
    path: entry.path,
    line: entry.line,
    kind: entry.kind,
    score,
    text: entry.text ?? entry.name,
  };
}

async function readLegacyJsonlEntries(indexPath: string): Promise<IndexEntry[]> {
  if (!existsSync(indexPath)) return [];
  const text = await readFile(indexPath, "utf8").catch(() => "");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = IndexEntrySchema.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
}

export async function indexStaleRoots(store: WorkspaceStore): Promise<Array<{ root: string; entries: number }>> {
  const roots = await store.listRoots();
  const out: Array<{ root: string; entries: number }> = [];
  for (const root of roots) {
    if (root.indexedAt && !root.stale) continue;
    const entries = await indexRoot(store, root);
    out.push({ root: root.name, entries: entries.length });
  }
  return out;
}

export async function ensureIndexReady(store: WorkspaceStore): Promise<void> {
  const roots = await store.listRoots();
  if (!existsSync(store.indexPath) || roots.some((root) => !root.indexedAt || root.stale)) {
    await indexStaleRoots(store);
  }
}

async function withIndexLock<T>(
  store: WorkspaceStore,
  detail: { root?: string; reason: string },
  work: () => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  const release = await acquireIndexLock(store, detail);
  if (!release) {
    await store.appendLedger({
      type: "index.skipped",
      root: detail.root,
      reason: "concurrent_index_in_progress",
      lockPath: indexLockPath(store),
    });
    return await fallback();
  }

  try {
    return await work();
  } finally {
    await release();
  }
}

async function acquireIndexLock(
  store: WorkspaceStore,
  detail: { root?: string; reason: string },
): Promise<undefined | (() => Promise<void>)> {
  const lockPath = indexLockPath(store);
  const started = Date.now();

  while (Date.now() - started <= INDEX_LOCK_WAIT_MS) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify({
        pid: process.pid,
        root: detail.root ?? null,
        reason: detail.reason,
        startedAt: new Date().toISOString(),
      })}\n`, "utf8");
      return async () => {
        try {
          await handle.close();
        } finally {
          await rm(lockPath, { force: true });
        }
      };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
      if (code !== "EEXIST") return undefined;
      await removeStaleIndexLock(lockPath);
      await sleep(INDEX_LOCK_POLL_MS);
    }
  }

  return undefined;
}

async function removeStaleIndexLock(lockPath: string): Promise<void> {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs > INDEX_LOCK_STALE_MS) await rm(lockPath, { force: true });
  } catch {
    // Best-effort stale lock cleanup only.
  }
}

function indexLockPath(store: WorkspaceStore): string {
  return `${store.sqlitePath}.lock`;
}

function countEntriesByRoot(entries: IndexEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.root, (counts.get(entry.root) ?? 0) + 1);
  return counts;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
