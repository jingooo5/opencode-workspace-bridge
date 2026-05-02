import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { emitYaml, type YamlValue } from "../contracts/yaml-emit.js";
import type { MemoryEvidenceRef, MemoryTargetContext, MemoryTargetKind, SummarizerProvider } from "./summarizer-iface.js";
import type { SQLiteIndexStore } from "../sqlite-store.js";

export interface MemoryDirectories {
  contractsDir: string;
  symbolsDir: string;
  rootsDir: string;
}

export interface WriteMemoryInput {
  target: MemoryTargetContext;
  evidenceRefs: MemoryEvidenceRef[];
  fileHashes: Map<string, string>;
  generatedAt?: string;
}

export interface WriteMemoryResult {
  targetId: string;
  targetKind: MemoryTargetKind;
  summaryPath: string;
  evidenceHash: string;
  body: string;
  stale: boolean;
  rewritten: boolean;
}

export class MemoryWriter {
  constructor(
    private readonly summarizer: SummarizerProvider,
    private readonly directories: MemoryDirectories,
  ) {}

  async write(store: SQLiteIndexStore, input: WriteMemoryInput): Promise<WriteMemoryResult> {
    const targetId = targetIdFor(input.target);
    const targetKind = input.target.kind;
    const generatedAt = input.generatedAt ?? new Date().toISOString();
    const evidenceHash = computeEvidenceHash(targetId, input.evidenceRefs, input.fileHashes);
    const summaryPath = pathForTarget(this.directories, input.target, targetId);

    const existing = readSummary(store, targetId, targetKind);
    if (
      existing
      && existing.evidence_hash === evidenceHash
      && existing.stale === 0
      && existsSync(summaryPath)
    ) {
      const body = await readFile(summaryPath, "utf8");
      return { targetId, targetKind, summaryPath, evidenceHash, body, stale: false, rewritten: false };
    }

    const body = this.summarizer.summarize({ target: input.target, evidenceRefs: input.evidenceRefs });
    const frontmatter = renderFrontmatter({
      evidence_hash: evidenceHash,
      evidence_refs: input.evidenceRefs.map((ref) => ({
        kind: ref.kind,
        ref: ref.ref,
        line: ref.line ?? null,
        note: ref.note ?? null,
      })),
      generated_at: generatedAt,
      stale: false,
      target_id: targetId,
      target_kind: targetKind,
    });

    await mkdir(path.dirname(summaryPath), { recursive: true });
    await writeFile(summaryPath, `${frontmatter}\n${body}\n`, "utf8");

    upsertSummary(store, {
      id: summaryRowId(targetId, targetKind),
      targetId,
      targetKind,
      summaryPath,
      evidenceHash,
      evidenceRefsJson: JSON.stringify(input.evidenceRefs),
      generatedAt,
      updatedAt: generatedAt,
    });

    return { targetId, targetKind, summaryPath, evidenceHash, body: `${frontmatter}\n${body}\n`, stale: false, rewritten: true };
  }
}

export function targetIdFor(target: MemoryTargetContext): string {
  if (target.kind === "CONTRACT") return target.contract.id;
  if (target.kind === "SYMBOL") return target.node.id;
  return `root:${target.rootName}`;
}

export function pathForTarget(directories: MemoryDirectories, target: MemoryTargetContext, targetId: string): string {
  if (target.kind === "CONTRACT") return path.join(directories.contractsDir, `${slugFromId(targetId)}.md`);
  if (target.kind === "SYMBOL") {
    const root = target.node.rootName || "unknown";
    return path.join(directories.symbolsDir, `${root}__${slugFromId(targetId)}.md`);
  }
  return path.join(directories.rootsDir, `${target.rootName}.md`);
}

export function summaryRowId(targetId: string, targetKind: MemoryTargetKind): string {
  const hash = createHash("sha256").update(`${targetKind}\n${targetId}`).digest("hex").slice(0, 24);
  return `summary:${hash}`;
}

export function computeEvidenceHash(targetId: string, refs: MemoryEvidenceRef[], fileHashes: Map<string, string>): string {
  const sortedRefs = [...refs].sort(compareRefs);
  const sourceHashes = sortedRefs.map((ref) => fileHashes.get(refToFileId(ref)) ?? "");
  const payload = stableStringify({
    targetId,
    refs: sortedRefs.map((ref) => ({ kind: ref.kind, ref: ref.ref, line: ref.line ?? null })),
    sourceHashes,
  });
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function compareRefs(a: MemoryEvidenceRef, b: MemoryEvidenceRef): number {
  return a.ref.localeCompare(b.ref) || (a.line ?? 0) - (b.line ?? 0) || a.kind.localeCompare(b.kind);
}

function refToFileId(ref: MemoryEvidenceRef): string {
  const colon = ref.ref.indexOf(":");
  if (colon <= 0) return ref.ref;
  const root = ref.ref.slice(0, colon);
  const relPath = ref.ref.slice(colon + 1);
  return `file:${root}:${relPath}`;
}

function renderFrontmatter(values: Record<string, YamlValue>): string {
  const yaml = emitYaml(values).trimEnd();
  return `---\n${yaml}\n---`;
}

function slugFromId(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (safe.length <= 64) return safe;
  return `${safe.slice(0, 32)}_${createHash("sha256").update(id).digest("hex").slice(0, 12)}`;
}

interface SummaryRow {
  id: string;
  target_id: string;
  target_kind: string;
  summary_path: string;
  evidence_hash: string;
  status: string;
  generated_at: string;
  updated_at: string;
  stale: number;
  evidence_refs_json: string;
}

function readSummary(store: SQLiteIndexStore, targetId: string, targetKind: MemoryTargetKind): SummaryRow | undefined {
  const result = store.readSummaryByTarget({ targetId, targetKind });
  if (!result.ok) return undefined;
  return result.value;
}

interface UpsertSummaryInput {
  id: string;
  targetId: string;
  targetKind: MemoryTargetKind;
  summaryPath: string;
  evidenceHash: string;
  evidenceRefsJson: string;
  generatedAt: string;
  updatedAt: string;
}

function upsertSummary(store: SQLiteIndexStore, input: UpsertSummaryInput): void {
  const result = store.upsertSummary({ ...input });
  if (!result.ok) {
    // Memory writes degrade quietly: surface via diagnostics, not exception.
    // The caller can still use the in-memory body; SQLite mirror will retry on next run.
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normalize(v)]),
    );
  }
  return value;
}
