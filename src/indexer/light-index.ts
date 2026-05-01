import path from "node:path";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { IndexEntrySchema, type IndexEntry, type RootSpec, type SearchHit } from "../types.js";
import { refOf } from "../shared/path.js";
import type { WorkspaceStore } from "../state/workspace-store.js";

const EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", "target", "vendor"]);
const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".yaml", ".yml", ".md", ".py", ".go", ".rs", ".java", ".kt", ".proto", ".graphql", ".sql", ".prisma",
]);

export async function indexRoot(store: WorkspaceStore, root: RootSpec, maxFiles = 2500): Promise<IndexEntry[]> {
  const files = await listFiles(root.absPath, maxFiles);
  const entries: IndexEntry[] = [];
  const now = new Date().toISOString();

  for (const absPath of files) {
    const relPath = path.relative(root.absPath, absPath).replaceAll(path.sep, "/");
    const ext = path.extname(relPath).toLowerCase();
    const ref = refOf(root.name, relPath);
    entries.push({ root: root.name, ref, path: relPath, kind: "file", name: path.basename(relPath), updatedAt: now });

    if (path.basename(relPath) === "package.json") {
      const pkg = await readJson(absPath);
      if (pkg && typeof pkg.name === "string") {
        entries.push({ root: root.name, ref, path: relPath, kind: "package", name: pkg.name, updatedAt: now });
      }
    }

    if (!TEXT_EXTENSIONS.has(ext)) continue;
    const text = await safeRead(absPath);
    if (!text) continue;

    for (const hit of extractSymbols(text)) {
      entries.push({ root: root.name, ref, path: relPath, kind: "symbol", name: hit.name, line: hit.line, text: hit.text, updatedAt: now });
    }
    for (const hit of extractRoutes(text)) {
      entries.push({ root: root.name, ref, path: relPath, kind: "route", name: hit.name, line: hit.line, text: hit.text, updatedAt: now });
    }
    if (isContractFile(relPath)) {
      entries.push({ root: root.name, ref, path: relPath, kind: "contract", name: path.basename(relPath), updatedAt: now });
    }
    if (/\b(test|spec)\b/i.test(relPath)) {
      entries.push({ root: root.name, ref, path: relPath, kind: "test", name: path.basename(relPath), updatedAt: now });
    }
  }

  await appendEntries(store.indexPath, entries);
  await store.markIndexed(root.name);
  await store.appendLedger({ type: "root.indexed", root: root.name, entries: entries.length });
  return entries;
}

export async function searchIndex(store: WorkspaceStore, query: string, roots?: string[], limit = 30): Promise<SearchHit[]> {
  const q = query.toLowerCase();
  const entries = await readEntries(store.indexPath);
  const allowed = new Set(roots ?? []);
  const hits: SearchHit[] = [];

  for (const entry of entries) {
    if (allowed.size && !allowed.has(entry.root)) continue;
    const haystack = `${entry.name}\n${entry.path}\n${entry.text ?? ""}`.toLowerCase();
    if (!haystack.includes(q)) continue;
    const score = entry.name.toLowerCase() === q ? 10 : entry.name.toLowerCase().includes(q) ? 6 : entry.path.toLowerCase().includes(q) ? 4 : 1;
    hits.push({ root: entry.root, ref: entry.ref, path: entry.path, line: entry.line, kind: entry.kind, score, text: entry.text ?? entry.name });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

async function listFiles(rootAbs: string, maxFiles: number): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (out.length >= maxFiles) return;
    const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      if (out.length >= maxFiles) break;
      if (item.name.startsWith(".") && item.name !== ".opencode") {
        if (item.name !== ".env" && item.name !== ".env.example") continue;
      }
      const abs = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (!EXCLUDED_DIRS.has(item.name)) await walk(abs);
      } else if (item.isFile()) {
        out.push(abs);
      }
    }
  }
  await walk(rootAbs);
  return out;
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

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  const text = await safeRead(file);
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function extractSymbols(text: string): Array<{ name: string; line: number; text: string }> {
  const hits: Array<{ name: string; line: number; text: string }> = [];
  const patterns = [
    /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    /\bclass\s+([A-Za-z_$][\w$]*)/,
    /\binterface\s+([A-Za-z_$][\w$]*)/,
    /\btype\s+([A-Za-z_$][\w$]*)\s*=/,
  ];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match?.[1]) {
        hits.push({ name: match[1], line: index + 1, text: line.trim().slice(0, 240) });
        break;
      }
    }
  });
  return hits;
}

function extractRoutes(text: string): Array<{ name: string; line: number; text: string }> {
  const hits: Array<{ name: string; line: number; text: string }> = [];
  const routePatterns = [
    /\b(?:router|app)\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/i,
    /@(Get|Post|Put|Patch|Delete)\s*\(\s*["'`]?([^"'`)]*)["'`]?\s*\)/,
    /\b(fetch)\s*\(\s*["'`]([^"'`]+)["'`]/i,
    /\baxios\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/i,
  ];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const pattern of routePatterns) {
      const match = line.match(pattern);
      if (match?.[1] && match?.[2]) {
        hits.push({ name: `${match[1].toUpperCase()} ${match[2] || "/"}`, line: index + 1, text: line.trim().slice(0, 240) });
        break;
      }
    }
  });
  return hits;
}

function isContractFile(relPath: string): boolean {
  return /(^|\/)(openapi|schema)\.(ya?ml|json|graphql|prisma)$/.test(relPath) || /\.proto$/.test(relPath) || /migrations\//.test(relPath);
}

async function appendEntries(indexPath: string, entries: IndexEntry[]): Promise<void> {
  const existing = await readEntries(indexPath);
  const roots = new Set(entries.map((entry) => entry.root));
  const retained = existing.filter((entry) => !roots.has(entry.root));
  const all = [...retained, ...entries];
  await writeFile(indexPath, all.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

async function readEntries(indexPath: string): Promise<IndexEntry[]> {
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
