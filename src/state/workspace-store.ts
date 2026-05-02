import path from "node:path";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { PluginInput } from "@opencode-ai/plugin";
import { openSQLiteIndexStore } from "../indexer/sqlite-store.js";
import { fileIdOf } from "../indexer/scanner.js";
import {
  WorkspaceManifestSchema,
  type AccessMode,
  type ContextBridgeOptions,
  type RootSpec,
  type WorkspaceManifest,
} from "../types.js";
import { globishMatch, isInside, parseRef, refOf, slugify, toAbs, toRelOrAbs } from "../shared/path.js";

interface ReindexQueueEntry {
  dedupeKey: string;
  path: string;
  reason: string;
  ref: string;
  root: string;
  timestamp: string;
  eventType?: string;
  sessionID?: string;
  tool?: string;
}

interface LedgerEntry {
  at?: string;
  command?: string;
  eventType?: string;
  path?: string;
  ref?: string;
  refs?: string[];
  root?: string;
  sessionID?: string;
  tool?: string;
  type?: string;
  validationKind?: string;
}

interface IndexRunEntry {
  diagnostics?: unknown[];
  finishedAt?: string;
  id?: string;
  reason?: string;
  roots?: string[];
  startedAt?: string;
  stats?: Record<string, unknown>;
}

interface CompactionContextInput {
  sessionID?: string;
  touchedRefs: string[];
}

export class WorkspaceStore {
  readonly ctx: PluginInput;
  readonly options: ContextBridgeOptions;
  readonly stateDirAbs: string;
  readonly manifestPath: string;
  readonly indexPath: string;
  readonly ledgerPath: string;
  readonly sqlitePath: string;
  readonly evidenceDir: string;
  readonly evidenceNodesPath: string;
  readonly evidenceEdgesPath: string;
  readonly evidenceSpansPath: string;
  readonly diagnosticsDir: string;
  readonly indexerDiagnosticsPath: string;
  readonly logsDir: string;
  readonly indexRunsLogPath: string;
  readonly queueDir: string;
  readonly reindexQueuePath: string;
  readonly memoryDir: string;
  readonly memoryRootsDir: string;
  readonly memoryContractsDir: string;
  readonly memorySymbolsDir: string;
  readonly packsDir: string;
  readonly contractsDir: string;
  readonly contractsGeneratedDir: string;
  readonly stateFilesDir: string;
  readonly touchedNodesPath: string;
  readonly pendingValidationsPath: string;
  readonly staleSummariesPath: string;
  readonly impactLedgerPath: string;

  constructor(ctx: PluginInput, options: ContextBridgeOptions) {
    this.ctx = ctx;
    this.options = options;
    this.stateDirAbs = toAbs(ctx.directory, options.stateDir);
    this.manifestPath = path.join(this.stateDirAbs, "workspace.json");
    this.indexPath = path.join(this.stateDirAbs, "index.jsonl");
    this.ledgerPath = path.join(this.stateDirAbs, "task-history.jsonl");
    this.sqlitePath = path.join(this.stateDirAbs, "index.sqlite");
    this.evidenceDir = path.join(this.stateDirAbs, "evidence");
    this.evidenceNodesPath = path.join(this.evidenceDir, "nodes.jsonl");
    this.evidenceEdgesPath = path.join(this.evidenceDir, "edges.jsonl");
    this.evidenceSpansPath = path.join(this.evidenceDir, "spans.jsonl");
    this.diagnosticsDir = path.join(this.stateDirAbs, "diagnostics");
    this.indexerDiagnosticsPath = path.join(this.diagnosticsDir, "indexer.jsonl");
    this.logsDir = path.join(this.stateDirAbs, "logs");
    this.indexRunsLogPath = path.join(this.logsDir, "index-runs.jsonl");
    this.queueDir = path.join(this.stateDirAbs, "queue");
    this.reindexQueuePath = path.join(this.queueDir, "reindex.jsonl");
    this.memoryDir = path.join(this.stateDirAbs, "memory");
    this.memoryRootsDir = path.join(this.memoryDir, "roots");
    this.memoryContractsDir = path.join(this.memoryDir, "contracts");
    this.memorySymbolsDir = path.join(this.memoryDir, "symbols");
    this.packsDir = path.join(this.stateDirAbs, "packs");
    this.contractsDir = path.join(this.stateDirAbs, "contracts");
    this.contractsGeneratedDir = path.join(this.contractsDir, "generated");
    this.stateFilesDir = path.join(this.stateDirAbs, "state");
    this.touchedNodesPath = path.join(this.stateFilesDir, "touched_nodes.json");
    this.pendingValidationsPath = path.join(this.stateFilesDir, "pending_validations.jsonl");
    this.staleSummariesPath = path.join(this.stateFilesDir, "stale_summaries.json");
    this.impactLedgerPath = path.join(this.stateFilesDir, "impact_ledger.jsonl");
  }

  async init(): Promise<void> {
    await mkdir(this.stateDirAbs, { recursive: true });
    await mkdir(this.evidenceDir, { recursive: true });
    await mkdir(this.diagnosticsDir, { recursive: true });
    await mkdir(this.logsDir, { recursive: true });
    await mkdir(this.queueDir, { recursive: true });
    await mkdir(this.memoryRootsDir, { recursive: true });
    await mkdir(this.memoryContractsDir, { recursive: true });
    await mkdir(this.memorySymbolsDir, { recursive: true });
    await mkdir(this.packsDir, { recursive: true });
    await mkdir(this.contractsGeneratedDir, { recursive: true });
    await mkdir(this.stateFilesDir, { recursive: true });
    if (!existsSync(this.manifestPath)) {
      const primary: RootSpec = {
        name: "primary",
        path: ".",
        absPath: this.ctx.worktree || this.ctx.directory,
        access: "rw",
        role: "primary",
        tags: ["primary"],
      };
      const manifest: WorkspaceManifest = {
        version: 1,
        primary,
        roots: [primary],
        policies: {
          secretGlobs: this.options.secretGlobs,
          contractGlobs: this.options.contractGlobs,
          enforceImpactBeforeContractEdit: this.options.enforceImpactBeforeContractEdit,
        },
      };
      await this.writeManifest(manifest);
    }
    for (const root of this.options.roots) {
      await this.addRoot(root.path, {
        name: root.name,
        access: root.access ?? this.options.defaultAccess,
        role: root.role,
        tags: root.tags,
      });
    }
  }

  async readManifest(): Promise<WorkspaceManifest> {
    const text = await readFile(this.manifestPath, "utf8");
    const parsed = WorkspaceManifestSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new Error(
        `Invalid workspace manifest at ${this.manifestPath}: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }

  async writeManifest(manifest: WorkspaceManifest): Promise<void> {
    const validated = WorkspaceManifestSchema.parse(manifest);
    await mkdir(path.dirname(this.manifestPath), { recursive: true });
    await writeFile(this.manifestPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  }

  async addRoot(
    rootPath: string,
    opts: { name?: string; access?: AccessMode; role?: RootSpec["role"]; tags?: string[] } = {},
  ): Promise<RootSpec> {
    const manifest = await this.readManifest();
    const absPath = toAbs(this.ctx.directory, rootPath);
    const fallbackName = slugify(path.basename(absPath));
    let name = slugify(opts.name ?? fallbackName);
    let suffix = 2;
    while (manifest.roots.some((root) => root.name === name && root.absPath !== absPath)) {
      name = `${slugify(opts.name ?? fallbackName)}-${suffix++}`;
    }

    const existing = manifest.roots.find((root) => root.absPath === absPath || root.name === name);
    const root: RootSpec = {
      name,
      path: toRelOrAbs(this.ctx.directory, absPath),
      absPath,
      access: opts.access ?? this.options.defaultAccess,
      role: opts.role ?? "unknown",
      tags: opts.tags ?? [],
      stale: true,
    };

    if (existing) Object.assign(existing, root);
    else manifest.roots.push(root);

    await this.writeManifest(manifest);
    await this.appendLedger({ type: "root.added", root });
    return root;
  }

  async listRoots(): Promise<RootSpec[]> {
    return (await this.readManifest()).roots;
  }

  async resolveRef(ref: string): Promise<{ root: RootSpec; absPath: string; relPath: string } | undefined> {
    const parsed = parseRef(ref);
    if (!parsed) return undefined;
    const manifest = await this.readManifest();
    const root = manifest.roots.find((candidate) => candidate.name === parsed.root);
    if (!root) return undefined;
    const absPath = path.resolve(root.absPath, parsed.relPath);
    if (!isInside(root.absPath, absPath)) return undefined;
    return { root, absPath, relPath: parsed.relPath };
  }

  async findRootByPath(absPath: string): Promise<{ root: RootSpec; relPath: string } | undefined> {
    const manifest = await this.readManifest();
    const normalized = path.normalize(absPath);
    const matches = manifest.roots
      .filter((root) => isInside(root.absPath, normalized))
      .sort((a, b) => b.absPath.length - a.absPath.length);
    const root = matches[0];
    if (!root) return undefined;
    return { root, relPath: path.relative(root.absPath, normalized).replaceAll(path.sep, "/") || "." };
  }

  async markStaleByAbsPath(absPath: string): Promise<void> {
    const found = await this.findRootByPath(absPath);
    if (!found) return;
    const manifest = await this.readManifest();
    const root = manifest.roots.find((candidate) => candidate.name === found.root.name);
    if (!root) return;
    root.stale = true;
    await this.writeManifest(manifest);
  }

  async markIndexed(rootName: string): Promise<void> {
    const manifest = await this.readManifest();
    const root = manifest.roots.find((candidate) => candidate.name === rootName);
    if (!root) return;
    root.indexedAt = new Date().toISOString();
    root.stale = false;
    await this.writeManifest(manifest);
  }

  async isSecretPath(absPath: string): Promise<boolean> {
    const found = await this.findRootByPath(absPath);
    if (!found) return false;
    const manifest = await this.readManifest();
    return manifest.policies.secretGlobs.some((pattern) => globishMatch(pattern, found.relPath));
  }

  async isContractPath(absPath: string): Promise<boolean> {
    const found = await this.findRootByPath(absPath);
    if (!found) return false;
    const manifest = await this.readManifest();
    return manifest.policies.contractGlobs.some((pattern) => globishMatch(pattern, found.relPath));
  }

  async contractGlobMatcher(): Promise<(relPath: string) => boolean> {
    const manifest = await this.readManifest();
    const globs = manifest.policies.contractGlobs;
    return (relPath: string) => globs.some((pattern) => globishMatch(pattern, relPath));
  }

  async contractIdsForAbsPath(absPath: string): Promise<string[]> {
    if (!existsSync(this.sqlitePath)) return [];
    const opened = await openSQLiteIndexStore(this.sqlitePath, { readonly: true, skipMigrations: true });
    if (!opened.ok) return [];
    try {
      const contracts = opened.value.readContracts();
      const files = opened.value.readFilesAbs();
      if (!contracts.ok || !files.ok) return [];
      const absIndex = new Map<string, string>();
      for (const file of files.value) absIndex.set(`${file.rootName}:${file.relPath}`, file.absPath);
      const matches: string[] = [];
      for (const contract of contracts.value) {
        if (!contract.relPath) continue;
        const abs = absIndex.get(`${contract.rootName}:${contract.relPath}`);
        if (abs && abs === absPath) matches.push(contract.id);
      }
      return matches;
    } finally {
      opened.value.close();
    }
  }

  async appendLedger(entry: Record<string, unknown>): Promise<void> {
    await this.appendJsonl(this.ledgerPath, { at: new Date().toISOString(), ...entry });
  }

  async recentLedger(limit = 30): Promise<string[]> {
    if (!existsSync(this.ledgerPath)) return [];
    const text = await readFile(this.ledgerPath, "utf8");
    return text.trim().split("\n").filter(Boolean).slice(-limit);
  }

  async workspaceSummary(): Promise<string> {
    const manifest = await this.readManifest();
    const lines = manifest.roots.map((root) => {
      const state = root.stale ? "stale" : root.indexedAt ? `indexed ${root.indexedAt}` : "not-indexed";
      return `- ${root.name}: ${root.path} (${root.access}, ${root.role ?? "unknown"}, ${state})`;
    });
    return [`Manifest: ${this.manifestPath}`, "Roots:", ...lines].join("\n");
  }

  refOf(root: RootSpec, relPath: string): string {
    return refOf(root.name, relPath);
  }

  async appendReindexQueueByAbsPath(
    absPath: string,
    reason: string,
    meta: { eventType?: string; sessionID?: string; sourceTool?: string } = {},
  ): Promise<{ ok: true; entry: ReindexQueueEntry } | { ok: false; error: string } | { ok: false; skipped: true }> {
    const found = await this.findRootByPath(absPath);
    if (!found) return { ok: false, skipped: true };

    const entry: ReindexQueueEntry = {
      timestamp: new Date().toISOString(),
      root: found.root.name,
      ref: this.refOf(found.root, found.relPath),
      path: found.relPath,
      reason,
      dedupeKey: `${found.root.name}:${found.relPath}:${reason}`,
      eventType: meta.eventType,
      sessionID: meta.sessionID,
      tool: meta.sourceTool,
    };

    try {
      await this.appendJsonl(this.reindexQueuePath, entry);
      return { ok: true, entry };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async markSummariesStaleByAbsPath(absPath: string): Promise<void> {
    if (!existsSync(this.sqlitePath)) return;
    const found = await this.findRootByPath(absPath);
    if (!found) return;

    const opened = await openSQLiteIndexStore(this.sqlitePath);
    if (!opened.ok) return;

    try {
      opened.value.markSummariesStaleForFile({
        fileId: fileIdOf(found.root.name, found.relPath),
      });
    } finally {
      opened.value.close();
    }
  }

  async compactionContext(input: CompactionContextInput): Promise<string> {
    const manifest = await this.readManifest();
    const activeRoots = manifest.roots.length
      ? manifest.roots
          .map((root) => {
            const status = root.stale ? "stale" : root.indexedAt ? `indexed ${root.indexedAt}` : "missing index";
            return `- ${root.name}: ${root.path} (${root.access}, ${root.role ?? "unknown"}, ${status})`;
          })
          .join("\n")
      : "- none";

    const lastIndexRun = await this.lastIndexRunSummary();
    const staleWarnings = manifest.roots.filter((root) => root.stale || !root.indexedAt);
    const staleWarningLines = staleWarnings.length
      ? staleWarnings
          .map((root) => `- ${root.name}: ${root.stale ? "stale" : "missing indexedAt"}`)
          .join("\n")
      : "- none";

    const queueSummary = await this.pendingQueueSummary();
    const gates = await this.pendingGateSummary(input);

    return [
      "Active roots:",
      activeRoots,
      "",
      "Last index run:",
      lastIndexRun,
      "",
      "Stale index warnings:",
      staleWarningLines,
      "",
      "Pending reindex queue:",
      queueSummary,
      "",
      "Pending validation and impact gates:",
      gates,
    ].join("\n");
  }

  private async appendJsonl(filePath: string, entry: object): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${stableStringify(entry)}\n`, {
      flag: "a",
      encoding: "utf8",
    });
  }

  private async lastIndexRunSummary(): Promise<string> {
    const runs = await this.readRecentJsonlEntries<IndexRunEntry>(this.indexRunsLogPath, 40);
    const last = runs.at(-1);
    if (!last) {
      return existsSync(this.indexRunsLogPath)
        ? `- ${this.indexRunsLogPath} has no completed runs yet`
        : `- missing index run log at ${this.indexRunsLogPath}`;
    }
    const roots = Array.isArray(last.roots) && last.roots.length ? last.roots.join(", ") : "unknown roots";
    const finished = last.finishedAt ?? last.startedAt ?? "unknown time";
    return `- ${finished} (${last.reason ?? "unknown reason"}; roots: ${roots})`;
  }

  private async pendingQueueSummary(): Promise<string> {
    const entries = await this.readRecentJsonlEntries<ReindexQueueEntry>(this.reindexQueuePath, 50);
    if (!entries.length) {
      return existsSync(this.reindexQueuePath)
        ? "- queue empty"
        : `- missing reindex queue at ${this.reindexQueuePath}`;
    }

    const recent = entries.slice(-5).map((entry) => `- ${entry.ref} (${entry.reason}, dedupe=${entry.dedupeKey})`);
    return [`- ${entries.length} recent queued item(s) sampled from ${this.reindexQueuePath}`, ...recent].join("\n");
  }

  private async pendingGateSummary(input: CompactionContextInput): Promise<string> {
    const ledger = await this.readRecentJsonlEntries<LedgerEntry>(this.ledgerPath, 200);
    const sessionLedger = input.sessionID
      ? ledger.filter((entry) => entry.sessionID === input.sessionID)
      : ledger;
    const latestTouchAt = this.latestAt(
      sessionLedger.filter((entry) => entry.type === "file.touched" || entry.type === "file.edited.event" || entry.type === "file.watcher.updated.event"),
    );
    const latestValidationAt = this.latestAt(sessionLedger.filter((entry) => entry.type === "validation.command"));
    const latestImpactAt = this.latestAt(sessionLedger.filter((entry) => entry.type === "impact.analysis.requested"));

    const contractWarnings = sessionLedger
      .filter((entry) => entry.type === "contract.edit.warning" && typeof entry.ref === "string")
      .map((entry) => entry.ref as string);
    const uniqueContractWarnings = Array.from(new Set(contractWarnings)).sort((a, b) => a.localeCompare(b));

    const lines: string[] = [];
    if (input.touchedRefs.length && (!latestValidationAt || (latestTouchAt && latestValidationAt < latestTouchAt))) {
      lines.push(`- validation pending for touched refs (${input.touchedRefs.length}) in this session; last validation ${latestValidationAt ?? "not recorded"}`);
    } else {
      lines.push(`- validation gate clear or not required for this session; last validation ${latestValidationAt ?? "not recorded"}`);
    }

    if (uniqueContractWarnings.length && (!latestImpactAt || (latestTouchAt && latestImpactAt < latestTouchAt))) {
      lines.push(`- impact review pending in this session for contract refs: ${uniqueContractWarnings.join(", ")}`);
    } else {
      lines.push(`- impact gate clear or not required for this session; last impact analysis ${latestImpactAt ?? "not recorded"}`);
    }

    return lines.join("\n");
  }

  private latestAt(entries: Array<{ at?: string }>): string | undefined {
    return entries
      .map((entry) => entry.at)
      .filter((value): value is string => typeof value === "string")
      .sort((left, right) => left.localeCompare(right))
      .at(-1);
  }

  private async readRecentJsonlEntries<T>(filePath: string, limit: number): Promise<T[]> {
    if (!existsSync(filePath) || limit <= 0) return [];
    const text = await this.readTailText(filePath, 128 * 1024);
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as T];
        } catch {
          return [];
        }
      })
      .slice(-limit);
  }

  private async readTailText(filePath: string, maxBytes: number): Promise<string> {
    const handle = await open(filePath, "r");
    try {
      const stats = await handle.stat();
      if (stats.size <= 0) return "";
      const bytesToRead = Math.min(stats.size, maxBytes);
      const start = Math.max(0, stats.size - bytesToRead);
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, start);
      let text = buffer.subarray(0, bytesRead).toString("utf8");
      if (start > 0) {
        const newlineIndex = text.indexOf("\n");
        text = newlineIndex >= 0 ? text.slice(newlineIndex + 1) : "";
      }
      return text;
    } finally {
      await handle.close();
    }
  }
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
