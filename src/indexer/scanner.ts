import path from "node:path";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import type { RootSpec } from "../types.js";

export const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".opencode",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  "target",
  "__pycache__",
  ".venv",
  "venv",
]);

export interface ScannedFile {
  root: RootSpec;
  rootId: string;
  id: string;
  absPath: string;
  relPath: string;
  hash: string;
  sizeBytes: number;
  language?: string;
  isGenerated: boolean;
  indexedAt: string;
  mtimeMs?: number;
}

export interface ScanRootOptions {
  files?: string[];
  maxFiles?: number;
  indexedAt?: string;
}

export interface ScanRootReport {
  root: RootSpec;
  files: ScannedFile[];
  scanned: number;
  skipped: number;
  diagnostics: Array<{ level: "warn" | "error"; code: string; message: string; path?: string }>;
}

export async function scanRoot(root: RootSpec, options: ScanRootOptions = {}): Promise<ScanRootReport> {
  const indexedAt = options.indexedAt ?? new Date().toISOString();
  const diagnostics: ScanRootReport["diagnostics"] = [];
  const candidates = options.files
    ? normalizeFileTargets(root, options.files)
    : await listCandidateFiles(root.absPath, options.maxFiles ?? 2500, diagnostics);
  const files: ScannedFile[] = [];
  let skipped = 0;

  for (const target of candidates) {
    if (isIgnoredRelativePath(target.relPath)) {
      skipped++;
      continue;
    }
    try {
      const info = await stat(target.absPath);
      if (!info.isFile()) {
        skipped++;
        continue;
      }
      const content = await readFile(target.absPath);
      files.push({
        root,
        rootId: rootIdOf(root.name),
        id: fileIdOf(root.name, target.relPath),
        absPath: target.absPath,
        relPath: target.relPath,
        hash: createHash("sha256").update(content).digest("hex"),
        sizeBytes: info.size,
        language: detectLanguage(target.relPath),
        isGenerated: isGeneratedFile(target.relPath),
        indexedAt,
        mtimeMs: Math.trunc(info.mtimeMs),
      });
    } catch (error) {
      skipped++;
      diagnostics.push({
        level: "warn",
        code: "scanner.file_unreadable",
        message: error instanceof Error ? error.message : String(error),
        path: target.absPath,
      });
    }
  }

  return {
    root,
    files: files.sort((a, b) => a.relPath.localeCompare(b.relPath)),
    scanned: files.length,
    skipped,
    diagnostics,
  };
}

export function rootIdOf(rootName: string): string {
  return `root:${rootName}`;
}

export function fileIdOf(rootName: string, relPath: string): string {
  return `file:${rootName}:${toPosixPath(relPath)}`;
}

export function toPosixPath(value: string): string {
  return value.replaceAll(path.sep, "/").replaceAll("\\", "/");
}

function normalizeFileTargets(root: RootSpec, files: string[]): Array<{ absPath: string; relPath: string }> {
  return files
    .map((file) => {
      const absPath = path.isAbsolute(file) ? path.normalize(file) : path.resolve(root.absPath, file);
      return { absPath, relPath: toPosixPath(path.relative(root.absPath, absPath)) };
    })
    .filter((item) => item.relPath && item.relPath !== "." && !item.relPath.startsWith("../") && item.relPath !== "..")
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
}

async function listCandidateFiles(
  rootAbs: string,
  maxFiles: number,
  diagnostics: ScanRootReport["diagnostics"],
): Promise<Array<{ absPath: string; relPath: string }>> {
  const out: Array<{ absPath: string; relPath: string }> = [];
  async function walk(dir: string): Promise<void> {
    if (out.length >= maxFiles) return;
    const items = (await readdir(dir, { withFileTypes: true }).catch((error) => {
      diagnostics.push({
        level: "warn",
        code: "scanner.directory_unreadable",
        message: error instanceof Error ? error.message : String(error),
        path: dir,
      });
      return [];
    })).sort((a, b) => a.name.localeCompare(b.name));

    for (const item of items) {
      if (out.length >= maxFiles) break;
      const absPath = path.join(dir, item.name);
      const relPath = toPosixPath(path.relative(rootAbs, absPath));
      if (item.isDirectory()) {
        if (!DEFAULT_IGNORED_DIRECTORIES.has(item.name)) await walk(absPath);
      } else if (item.isFile()) {
        out.push({ absPath, relPath });
      }
    }
  }
  await walk(rootAbs);
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function isIgnoredRelativePath(relPath: string): boolean {
  return relPath.split("/").some((part) => DEFAULT_IGNORED_DIRECTORIES.has(part));
}

function detectLanguage(relPath: string): string | undefined {
  const ext = path.extname(relPath).toLowerCase();
  const byExtension: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "jsx",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".md": "markdown",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".kt": "kotlin",
    ".proto": "protobuf",
    ".graphql": "graphql",
    ".sql": "sql",
    ".prisma": "prisma",
  };
  return byExtension[ext];
}

function isGeneratedFile(relPath: string): boolean {
  return /(^|\/)(generated|\.cache)\//i.test(relPath)
    || /(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i.test(relPath)
    || /\.min\.(js|css)$/i.test(relPath);
}
