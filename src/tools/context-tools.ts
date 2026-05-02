import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { tool } from "@opencode-ai/plugin";
import type { PluginInput, ToolDefinition } from "@opencode-ai/plugin";
import { RootRoleSchema, type ContextBridgeOptions } from "../types.js";
import type { IndexEntry, SearchHit } from "../types.js";
import type { WorkspaceStore } from "../state/workspace-store.js";
import { indexRoot, readEntries, searchIndex } from "../indexer/light-index.js";
import {
  openSQLiteIndexStore,
  type DebugIndexRunRecord,
  type DebugEdgeRecord,
  type DebugNodeRecord,
  type DebugSnapshot,
  type DebugSpanRecord,
  type DebugUnresolvedRecord,
  type StorageDiagnostic,
} from "../indexer/sqlite-store.js";
import { INDEX_SCHEMA_VERSION } from "../indexer/schema.js";
import { createSummarizeTool } from "./ctx-summarize.js";
import { buildPackExtension, writePackMarkdownSibling } from "./ctx-pack-extension.js";
import { buildImpactExtension } from "./ctx-impact-extension.js";

// Use the plugin's own zod instance so schemas are guaranteed compatible with
// the runtime that ultimately consumes tool definitions.
const z = tool.schema;

export function createContextTools(
  _ctx: PluginInput,
  store: WorkspaceStore,
  options: ContextBridgeOptions,
): Record<string, ToolDefinition> {
  void _ctx;
  return {
    ctx_add_dir: tool({
      description:
        "Add an external directory/repository to the Context Bridge workspace manifest. Use before reading or reasoning about files outside the primary OpenCode directory.",
      args: {
        path: z
          .string()
          .min(1)
          .describe(
            "Directory path, absolute or relative to the current OpenCode directory.",
          ),
        name: z
          .string()
          .min(1)
          .optional()
          .describe("Stable root alias, for example backend or shared."),
        access: z
          .enum(["ro", "rw"])
          .optional()
          .describe(
            "Access mode. ro means analysis only; rw allows edits subject to OpenCode permissions.",
          ),
        role: z
          .enum(RootRoleSchema.options)
          .optional()
          .describe(
            "Root role: primary, app, service, library, tooling, docs, unknown.",
          ),
        tags: z.array(z.string()).optional().describe("Optional tags."),
      },
      async execute(args) {
        const root = await store.addRoot(args.path, {
          name: args.name,
          access: args.access ?? options.defaultAccess,
          role: args.role,
          tags: args.tags,
        });
        if (options.autoIndex) await indexRoot(store, root);
        return JSON.stringify(
          { added: root, manifest: store.manifestPath },
          null,
          2,
        );
      },
    }),

    ctx_list_roots: tool({
      description:
        "List active Context Bridge workspace roots, aliases, access mode, index state, and manifest path.",
      args: {},
      async execute() {
        return await store.workspaceSummary();
      },
    }),

    ctx_index: tool({
      description:
        "Build or refresh the lightweight V0.1 evidence index for one root or all roots. Usually optional because autoIndex is enabled by default.",
      args: {
        root: z
          .string()
          .min(1)
          .optional()
          .describe("Root alias to index. If omitted, index all roots."),
      },
      async execute(args) {
        const roots = await store.listRoots();
        const selected = args.root
          ? roots.filter((root) => root.name === args.root)
          : roots;
        const result = [];
        for (const root of selected) {
          const entries = await indexRoot(store, root);
          result.push({ root: root.name, entries: entries.length });
        }
        const sqlite = await readSQLiteToolEvidence(store);
        return JSON.stringify(
          {
            index: store.indexPath,
            result,
            sqlite: sqliteReport(sqlite),
            latestIndexRun: latestIndexRun(sqlite.snapshot) ?? null,
          },
          null,
          2,
        );
      },
    }),

    ctx_search: tool({
      description:
        "Search the Context Bridge multi-root evidence index across root aliases. Use this instead of raw grep when the task may span repositories.",
      args: {
        query: z.string().min(1).describe("Search query."),
        roots: z
          .array(z.string())
          .optional()
          .describe("Optional root aliases to restrict search."),
        limit: z.number().int().positive().optional().describe("Maximum hits."),
      },
      async execute(args) {
        await ensureIndexReady(store, options);
        const sqlite = await readSQLiteToolEvidence(store);
        const sqliteEntries = sqlite.available ? sqliteIndexEntries(sqlite) : [];
        const usingFallback = sqliteEntries.length === 0;
        const hits = sqliteEntries.length
          ? searchEntries(sqliteEntries, args.query, args.roots, args.limit ?? options.maxSearchResults)
          : await searchIndex(
              store,
              args.query,
              args.roots,
              args.limit ?? options.maxSearchResults,
            );
        const rendered = (
          hits
            .map(
              (hit) =>
                `[${hit.kind}] ${hit.ref}${hit.line ? `#L${hit.line}` : ""}\n${hit.text}`,
            )
            .join("\n\n") ||
          "No hits. Try ctx_index first or broaden the query."
        );
        const banner = sqliteSearchBanner(sqlite, usingFallback);
        return banner ? `${banner}\n\n${rendered}` : rendered;
      },
    }),

    ctx_status: tool({
      description:
        "Summarize Context Bridge V0.1 workspace state from the manifest, lightweight index, and recent ledger entries.",
      args: {
        ledgerLimit: z.number().int().positive().optional(),
      },
      async execute(args) {
        const manifest = await store.readManifest();
        const entries = await readEntries(store.indexPath);
        const sqlite = await readSQLiteToolEvidence(store);
        const recent = await store.recentLedger(args.ledgerLimit ?? 8);
        const countsByKind = countBy(entries, (entry) => entry.kind);
        const countsByRoot = countBy(entries, (entry) => entry.root);
        const staleRoots = manifest.roots
          .filter((root) => root.stale || !root.indexedAt)
          .map((root) => root.name);
        const { contractCounts, memoryCounts } = await readRegistryCounts(store);
        return JSON.stringify(
          {
            version: "v0.1",
            manifest: {
              path: store.manifestPath,
              primary: manifest.primary.name,
              roots: manifest.roots.map((root) => ({
                name: root.name,
                path: root.path,
                access: root.access,
                role: root.role ?? "unknown",
                indexedAt: root.indexedAt ?? null,
                stale: !!root.stale,
              })),
            },
            index: {
              path: store.indexPath,
              exists: existsSync(store.indexPath),
              totalEntries: entries.length,
              countsByKind,
              countsByRoot,
              staleRoots,
            },
            sqlite: sqliteStatus(sqlite),
            contracts: contractCounts,
            memory: memoryCounts,
            recentLedger: recent.map(parseLedgerLine),
            notes: [
              sqlite.available
                ? "Status includes SQLite-backed evidence plus the legacy JSONL compatibility index."
                : "SQLite evidence is unavailable; status is degraded to manifest, JSONL index, and recent ledger.",
              "SQLite graph facts are conservative evidence, not semantic memory or complete structural proof.",
            ],
          },
          null,
          2,
        );
      },
    }),

    ctx_symbols: tool({
      description:
        "List lightweight symbol index entries, optionally filtered by query text, root alias, or exact file ref.",
      args: {
        query: z.string().min(1).optional(),
        root: z.string().min(1).optional(),
        ref: z.string().min(1).optional(),
        limit: z.number().int().positive().optional(),
      },
      async execute(args) {
        await ensureIndexReady(store, options);
        const sqlite = await readSQLiteToolEvidence(store);
        const sourceEntries = sqlite.available && sqliteSymbolEntries(sqlite).length > 0
          ? sqliteSymbolEntries(sqlite)
          : (await readEntries(store.indexPath)).filter((entry) => entry.kind === "symbol");
        const entries = sourceEntries
          .filter((entry) => !args.root || entry.root === args.root)
          .filter((entry) => !args.ref || entry.ref === args.ref)
          .filter((entry) => matchesSymbolQuery(entry, args.query))
          .sort((a, b) => {
            const byName = a.name.localeCompare(b.name);
            if (byName !== 0) return byName;
            const byRef = a.ref.localeCompare(b.ref);
            if (byRef !== 0) return byRef;
            return (a.line ?? 0) - (b.line ?? 0);
          })
          .slice(0, args.limit ?? 50)
          .map((entry) => ({
            root: entry.root,
            ref: entry.ref,
            path: entry.path,
            name: entry.name,
            line: entry.line ?? null,
            text: entry.text ?? null,
          }));
        return JSON.stringify(
          {
            version: "v0.1",
            filters: {
              query: args.query ?? null,
              root: args.root ?? null,
              ref: args.ref ?? null,
              limit: args.limit ?? 50,
            },
            count: entries.length,
            symbols: entries,
            sqlite: sqliteReport(sqlite),
            notes: [
              sqlite.available
                ? "Symbols come from SQLite-backed lightweight extraction evidence."
                : "SQLite symbols are unavailable; symbols come from legacy JSONL extraction evidence.",
              "Symbol evidence is lightweight extraction, not LSP graph analysis.",
            ],
          },
          null,
          2,
        );
      },
    }),

    ctx_neighbors: tool({
      description:
        "Find heuristic neighboring evidence for a symbol or root:path ref using same-file, same-name, same-directory, and ref-related matches.",
      args: {
        target: z.string().min(1).describe("Symbol name or root:path ref."),
        limit: z.number().int().positive().optional(),
      },
      async execute(args) {
        await ensureIndexReady(store, options);
        const sqlite = await readSQLiteToolEvidence(store);
        const sqliteEntries = sqlite.available ? sqliteIndexEntries(sqlite) : [];
        const entries = sqliteEntries.length ? sqliteEntries : await readEntries(store.indexPath);
        const analysis = await collectNeighbors(store, entries, args.target, args.limit ?? 20, sqlite);
        return JSON.stringify(analysis, null, 2);
      },
    }),

    ctx_read: tool({
      description:
        "Read a file by root alias reference, for example backend:src/routes/orders.ts. Safer than absolute-path read for multi-root work.",
      args: {
        ref: z
          .string()
          .min(1)
          .describe("Root alias reference: root:path/to/file."),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
      },
      async execute(args) {
        const resolved = await store.resolveRef(args.ref);
        if (!resolved)
          throw new Error(`Unknown or unsafe root reference: ${args.ref}`);
        if (await store.isSecretPath(resolved.absPath))
          throw new Error(
            `Refusing to read protected secret-like file: ${args.ref}`,
          );
        const text = await readFile(resolved.absPath, "utf8");
        const lines = text.split(/\r?\n/);
        const start = Math.max(1, args.startLine ?? 1);
        const end = Math.min(lines.length, args.endLine ?? lines.length);
        const sliced = lines.slice(start - 1, end).join("\n");
        return sliced.length > options.maxReadBytes
          ? `${sliced.slice(0, options.maxReadBytes)}\n...[truncated]`
          : sliced;
      },
    }),

    ctx_pack: tool({
      description:
        "Create a task-specific context pack from the multi-root evidence index. Includes promoted contracts, semantic memory, edit focus, and suggested edit order. Writes a paired Markdown rendering for human review.",
      args: {
        task: z.string().min(1).describe("Natural language task description."),
        roots: z.array(z.string()).optional(),
        limit: z.number().int().positive().optional(),
      },
      async execute(args, context) {
        await ensureIndexReady(store, options);
        const sqlite = await readSQLiteToolEvidence(store);
        const sessionID = readSessionID(context);
        const pack = await createPack(
          store,
          args.task,
          args.roots,
          args.limit ?? 12,
          sqlite,
          sessionID,
        );
        return JSON.stringify(pack, null, 2);
      },
    }),

    ctx_test_plan: tool({
      description:
        "Suggest lightweight test commands from indexed test/package entries and package.json scripts without executing anything.",
      args: {
        target: z.string().min(1).optional().describe("Optional symbol, path fragment, or root:path ref to focus the plan."),
        root: z.string().min(1).optional(),
        ref: z.string().min(1).optional(),
        limit: z.number().int().positive().optional(),
      },
      async execute(args) {
        await ensureIndexReady(store, options);
        const sqlite = await readSQLiteToolEvidence(store);
        const sqliteEntries = sqlite.available ? sqliteIndexEntries(sqlite) : [];
        const entries = sqliteEntries.length ? sqliteEntries : await readEntries(store.indexPath);
        const plan = await buildTestPlan(store, entries, args, sqlite);
        return JSON.stringify(plan, null, 2);
      },
    }),

    ctx_refresh_memory: tool({
      description:
        "Compatibility/status tool for V0.1 memory refresh requests. Reports current limits and can optionally reindex roots or refresh a context pack.",
      args: {
        reindex: z.boolean().optional(),
        root: z.string().min(1).optional(),
        task: z.string().min(1).optional().describe("Optional task description to refresh a context pack."),
        limit: z.number().int().positive().optional(),
      },
      async execute(args) {
        const actions: Record<string, unknown> = {
          durableSemanticMemory: false,
          reindexRequested: !!args.reindex,
          packRefreshRequested: !!args.task,
        };

        if (args.reindex) {
          const roots = await store.listRoots();
          const selected = args.root
            ? roots.filter((root) => root.name === args.root)
            : roots;
          actions.reindexed = [];
          for (const root of selected) {
            const refreshed = await indexRoot(store, root);
            (actions.reindexed as Array<Record<string, unknown>>).push({
              root: root.name,
              entries: refreshed.length,
            });
          }
        }

        let refreshedPack: Record<string, unknown> | undefined;
        if (args.task) {
          await ensureIndexReady(store, options);
          const sqlite = await readSQLiteToolEvidence(store);
          refreshedPack = await createPack(
            store,
            args.task,
            args.root ? [args.root] : undefined,
            args.limit ?? 12,
            sqlite,
          );
          actions.pack = {
            task: args.task,
            evidence: Array.isArray(refreshedPack.evidence)
              ? refreshedPack.evidence.length
              : 0,
          };
        }

        return JSON.stringify(
          {
            version: "v0.1",
            status: "No durable semantic memory is available in V0.1.",
            actions,
            recommendations: [
              "Use ctx_index or reindex=true to refresh lightweight index evidence.",
              args.task
                ? "A fresh context pack was generated from current index evidence."
                : "Use ctx_pack or task=... here to refresh task-specific evidence.",
            ],
            notes: [
              "This tool is a compatibility shim for agents expecting memory refresh behavior.",
              "It reports index and pack refresh status, not semantic embeddings or graph memory.",
            ],
            pack: refreshedPack ?? null,
          },
          null,
          2,
        );
      },
    }),

    ctx_summarize: createSummarizeTool(store),

    ctx_impact: tool({
      description:
        "Impact analysis for a root:path, symbol, DTO, API, or contract id. Produces evidence-backed candidate impacts, contract membership, and required validation gates. Appends a row to state/impact_ledger.jsonl.",
      args: {
        target: z
          .string()
          .min(1)
          .describe(
            "Target ref or phrase, for example shared:src/types/order.ts or OrderDto.",
          ),
        limit: z.number().int().positive().optional(),
      },
      async execute(args, context) {
        await ensureIndexReady(store, options);
        const sqlite = await readSQLiteToolEvidence(store);
        const sqliteEntries = sqlite.available ? sqliteIndexEntries(sqlite) : [];
        const hits = sqliteEntries.length
          ? searchEntries(sqliteEntries, args.target, undefined, args.limit ?? 30)
          : await searchIndex(
              store,
              args.target,
              undefined,
              args.limit ?? 30,
            );
        const graphImpact = graphImpactForTarget(sqlite, args.target, args.limit ?? 30);
        const risks = inferRisks(
          args.target,
          hits.map((hit) => hit.path),
        );
        const roots = Array.from(new Set(hits.map((hit) => hit.root)));
        const sessionID = readSessionID(context);
        const evidenceCounts = {
          direct: graphImpact.directEvidence.length,
          crossRoot: graphImpact.crossRootEvidence.length,
          unknown: graphImpact.unknownEvidence.length,
        };
        const extension = await buildImpactExtension(store, {
          target: args.target,
          sessionID,
          evidenceCounts,
        });
        await store.appendLedger({
          type: "impact.analysis",
          target: args.target,
          hits: hits.length,
          roots,
          risks,
          contractIds: extension.contractIds,
        });
        return JSON.stringify(
          {
            target: args.target,
            roots,
            directEvidence: hits,
            graphDirectEvidence: graphImpact.directEvidence,
            crossRootEvidence: graphImpact.crossRootEvidence,
            unknownEvidence: graphImpact.unknownEvidence,
            testCandidateEvidence: graphImpact.testCandidateEvidence,
            graphWarnings: graphImpact.warnings,
            sqlite: sqliteReport(sqlite),
            risks,
            contractIds: extension.contractIds,
            requiredGates: extension.requiredGates,
            pendingGates: extension.pendingGates,
            unknowns: dedupeStrings([
              "Required gates marked 'review' indicate v0.2 has no structural OpenAPI/proto parser; verify manually.",
              "Low or missing evidence should be confirmed with ctx_read and targeted search.",
              ...graphImpact.unknowns,
            ]),
            suggestedNext: [
              "Create a ctx_pack for the concrete task.",
              "Delegate to ctx-impact-analyst for edit order.",
              "Delegate to ctx-builder only after impact gates are clear.",
              "Delegate to ctx-test-router for a validation plan and ctx-validation-runner to execute it.",
            ],
          },
          null,
          2,
        );
      },
    }),
  };
}

async function createPack(
  store: WorkspaceStore,
  task: string,
  roots: string[] | undefined,
  limit: number,
  sqlite?: SQLiteToolEvidence,
  sessionID?: string,
): Promise<Record<string, unknown>> {
  const sqliteEvidence = sqlite ?? await readSQLiteToolEvidence(store);
  const sqliteEntries = sqliteEvidence.available ? sqliteIndexEntries(sqliteEvidence) : [];
  const hits = sqliteEntries.length
    ? searchEntries(sqliteEntries, task, roots, limit)
    : await searchIndex(store, task, roots, limit);
  const summary = await store.workspaceSummary();
  const riskHints = inferRisks(
    task,
    hits.map((hit) => hit.path),
  );
  const graph = graphPackEvidence(sqliteEvidence, task, roots, limit, hits);
  const extension = await buildPackExtension(store, {
    task,
    roots,
    limit,
    sessionID,
    hits: hits.map((hit) => ({ root: hit.root, path: hit.path, ref: hit.ref, text: hit.text })),
  });
  const pack = {
    task,
    workspace: summary,
    evidence: hits,
    graph,
    evidenceAnchors: graph.evidenceAnchors,
    unknowns: graph.unknowns,
    warnings: graph.warnings,
    risks: riskHints,
    contracts: extension.contracts,
    memory: extension.memory,
    editFocus: extension.editFocus,
    suggestedEditOrder: extension.suggestedEditOrder,
    suggestedNext: [
      "Inspect the top evidence refs with ctx_read.",
      "If editing contract/DTO/schema files, run ctx_impact or ask ctx-impact-analyst first.",
      "When context and impact are approved, hand implementation to ctx-builder.",
      "Use ctx-test-router to plan targeted validation and ctx-validation-runner to execute an approved plan.",
    ],
    generatedAt: new Date().toISOString(),
  };
  const safeName =
    task
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "pack";
  await mkdir(path.join(store.stateDirAbs, "packs"), { recursive: true });
  const jsonPath = path.join(store.stateDirAbs, "packs", `${Date.now()}-${safeName}.json`);
  await Bun.write(jsonPath, JSON.stringify(pack, null, 2));
  await writePackMarkdownSibling(store, jsonPath, {
    task,
    result: extension,
    evidence: hits.map((hit) => ({ ref: hit.ref, line: hit.line, text: hit.text })),
  });
  await store.appendLedger({
    type: "context.pack",
    task,
    hits: hits.length,
    risks: riskHints,
  });
  return pack;
}

async function ensureIndexReady(
  store: WorkspaceStore,
  options: ContextBridgeOptions,
): Promise<void> {
  if (!options.autoIndex) return;
  const roots = await store.listRoots();
  const indexMissing = !existsSync(store.indexPath);
  for (const root of roots) {
    if (indexMissing || root.stale || !root.indexedAt)
      await indexRoot(store, root);
  }
}

interface SQLiteToolEvidence {
  available: boolean;
  path: string;
  schemaVersion: number;
  degraded: boolean;
  diagnostics: StorageDiagnostic[];
  snapshot?: DebugSnapshot;
  reason?: string;
}

async function readSQLiteToolEvidence(store: WorkspaceStore): Promise<SQLiteToolEvidence> {
  const lockDiagnostic = activeIndexLockDiagnostic(store.sqlitePath);
  if (!existsSync(store.sqlitePath)) {
    return {
      available: false,
      path: store.sqlitePath,
      schemaVersion: INDEX_SCHEMA_VERSION,
      degraded: true,
      diagnostics: [
        ...(lockDiagnostic ? [lockDiagnostic] : []),
        {
          level: "warn",
          code: "sqlite.missing",
          message: "SQLite index is missing; using legacy JSONL fallback where available.",
          path: store.sqlitePath,
        },
      ],
      reason: "missing",
    };
  }

  const opened = await openSQLiteIndexStore(store.sqlitePath, { readonly: true, skipMigrations: true });
  if (!opened.ok) {
    return {
      available: false,
      path: store.sqlitePath,
      schemaVersion: INDEX_SCHEMA_VERSION,
      degraded: true,
      diagnostics: [...(lockDiagnostic ? [lockDiagnostic] : []), ...opened.diagnostics],
      reason: "open_failed",
    };
  }

  const snapshot = opened.value.readDebugSnapshot();
  const close = opened.value.close();
  const diagnostics = [
    ...(lockDiagnostic ? [lockDiagnostic] : []),
    ...opened.diagnostics,
    ...snapshot.diagnostics,
    ...close.diagnostics,
  ];
  if (!snapshot.ok) {
    return {
      available: false,
      path: store.sqlitePath,
      schemaVersion: INDEX_SCHEMA_VERSION,
      degraded: true,
      diagnostics,
      reason: "snapshot_failed",
    };
  }

  return {
    available: true,
    path: store.sqlitePath,
    schemaVersion: INDEX_SCHEMA_VERSION,
    degraded: !!opened.degraded || diagnostics.some((item) => item.level !== "info"),
    diagnostics,
    snapshot: snapshot.value,
  };
}

function sqliteReport(sqlite: SQLiteToolEvidence): Record<string, unknown> {
  return {
    path: sqlite.path,
    available: sqlite.available,
    degraded: sqlite.degraded,
    schemaVersion: sqlite.schemaVersion,
    reason: sqlite.reason ?? null,
    diagnostics: diagnosticCounts(sqlite.diagnostics),
    diagnosticDetails: sqlite.diagnostics,
    counts: sqlite.snapshot ? sqliteSnapshotCounts(sqlite.snapshot) : null,
  };
}

function sqliteStatus(sqlite: SQLiteToolEvidence): Record<string, unknown> {
  return {
    ...sqliteReport(sqlite),
    latestIndexRun: latestIndexRun(sqlite.snapshot) ?? null,
  };
}

function sqliteSearchBanner(sqlite: SQLiteToolEvidence, usingFallback: boolean): string | undefined {
  const codes = dedupeStrings(sqlite.diagnostics.filter((item) => item.level !== "info").map((item) => item.code));
  const detail = codes.join(", ") || sqlite.reason || "unknown";
  if (!sqlite.available) {
    return `SQLite unavailable (${detail}); using legacy JSONL fallback.`;
  }
  if (usingFallback) {
    return `SQLite search evidence is empty or incomplete; using legacy JSONL fallback${codes.length ? ` (${detail})` : ""}.`;
  }
  if (sqlite.degraded) {
    return `SQLite opened with diagnostics (${detail}); results may be incomplete.`;
  }
  return undefined;
}

function activeIndexLockDiagnostic(sqlitePath: string): StorageDiagnostic | undefined {
  const lockPath = `${sqlitePath}.lock`;
  if (!existsSync(lockPath)) return undefined;
  return {
    level: "warn",
    code: "sqlite.index_in_progress",
    message: "An index writer is currently active; reads may use the last readable snapshot or fallback output.",
    path: lockPath,
  };
}

function sqliteSnapshotCounts(snapshot: DebugSnapshot): Record<string, unknown> {
  return {
    nodes: snapshot.nodes.length,
    edges: snapshot.edges.length,
    spans: snapshot.spans.length,
    unresolved: snapshot.unresolved.length,
    indexRuns: snapshot.indexRuns.length,
    nodesByKind: countBy(snapshot.nodes, (node) => node.kind),
    nodesByRoot: countBy(snapshot.nodes, (node) => node.rootName),
  };
}

function latestIndexRun(snapshot?: DebugSnapshot): DebugIndexRunRecord | undefined {
  return snapshot?.indexRuns
    .slice()
    .sort((left, right) => (left.finishedAt ?? left.startedAt).localeCompare(right.finishedAt ?? right.startedAt))
    .at(-1);
}

function diagnosticCounts(diagnostics: StorageDiagnostic[]): Record<string, number> {
  return {
    info: diagnostics.filter((item) => item.level === "info").length,
    warn: diagnostics.filter((item) => item.level === "warn").length,
    error: diagnostics.filter((item) => item.level === "error").length,
  };
}

function sqliteIndexEntries(sqlite: SQLiteToolEvidence): IndexEntry[] {
  const snapshot = sqlite.snapshot;
  if (!snapshot) return [];
  const spans = spansByFileKindLine(snapshot.spans);
  const updatedAt = latestIndexRun(snapshot)?.finishedAt ?? latestIndexRun(snapshot)?.startedAt ?? "sqlite";
  const entries = new Map<string, IndexEntry>();

  for (const node of snapshot.nodes) {
    const entry = sqliteNodeToIndexEntry(node, spans, updatedAt);
    if (!entry) continue;
    const key = `${entry.kind}:${entry.ref}:${entry.line ?? 0}:${entry.name}`;
    entries.set(key, entry);
  }

  return Array.from(entries.values()).sort((left, right) =>
    `${left.root}:${left.path}:${left.kind}:${left.name}:${left.line ?? 0}`.localeCompare(
      `${right.root}:${right.path}:${right.kind}:${right.name}:${right.line ?? 0}`,
    ),
  );
}

function sqliteSymbolEntries(sqlite: SQLiteToolEvidence): IndexEntry[] {
  return sqliteIndexEntries(sqlite).filter((entry) => entry.kind === "symbol");
}

function spansByFileKindLine(spans: DebugSpanRecord[]): Map<string, DebugSpanRecord> {
  const out = new Map<string, DebugSpanRecord>();
  for (const span of spans) {
    if (!span.fileId || !span.kind) continue;
    out.set(sqliteSpanKey(span.fileId, span.kind, span.startLine), span);
  }
  return out;
}

function sqliteNodeToIndexEntry(
  node: DebugNodeRecord,
  spans: Map<string, DebugSpanRecord>,
  updatedAt: string,
): IndexEntry | undefined {
  const pathValue = node.relPath ?? stringAttr(node.attrs, "relPath");
  if (!pathValue || !node.rootName) return undefined;
  const kind = sqliteNodeKindToIndexKind(node.kind, pathValue);
  const span = node.fileId ? spans.get(sqliteSpanKey(node.fileId, node.kind, node.startLine)) : undefined;
  return {
    root: node.rootName,
    ref: `${node.rootName}:${pathValue}`,
    path: pathValue,
    kind,
    name: node.name,
    line: kind === "file" ? undefined : node.startLine,
    text: span?.text,
    updatedAt,
  };
}

function sqliteNodeKindToIndexKind(kind: string, relPath: string): IndexEntry["kind"] {
  if (kind === "FILE") return isContractRelPath(relPath) ? "contract" : "file";
  if (kind === "PACKAGE") return "package";
  if (kind === "HTTP_ROUTE_CANDIDATE") return "route";
  if (kind === "TEST_CANDIDATE") return "test";
  return "symbol";
}

function sqliteSpanKey(fileId: string, kind: string, startLine: number): string {
  return `${fileId}:${kind}:${startLine}`;
}

function stringAttr(attrs: Record<string, unknown>, key: string): string | undefined {
  const value = attrs[key];
  return typeof value === "string" ? value : undefined;
}

function isContractRelPath(relPath: string): boolean {
  return /(^|\/)(openapi|schema)\.(ya?ml|json|graphql|prisma)$/.test(relPath) || /\.proto$/.test(relPath) || /migrations\//.test(relPath);
}

function searchEntries(entries: IndexEntry[], query: string, roots: string[] | undefined, limit: number): SearchHit[] {
  const q = query.toLowerCase();
  const allowed = new Set(roots ?? []);
  const hits: SearchHit[] = [];
  for (const entry of entries) {
    if (allowed.size && !allowed.has(entry.root)) continue;
    const haystack = `${entry.name}\n${entry.path}\n${entry.text ?? ""}`.toLowerCase();
    if (!haystack.includes(q)) continue;
    const name = entry.name.toLowerCase();
    const score = name === q ? 10 : name.includes(q) ? 6 : entry.path.toLowerCase().includes(q) ? 4 : 1;
    hits.push({
      root: entry.root,
      ref: entry.ref,
      path: entry.path,
      line: entry.line,
      kind: entry.kind,
      score,
      text: entry.text ?? entry.name,
    });
  }
  return hits.sort((left, right) => bScore(left, right)).slice(0, limit);
}

function bScore(left: SearchHit, right: SearchHit): number {
  return right.score - left.score || left.ref.localeCompare(right.ref) || (left.line ?? 0) - (right.line ?? 0);
}

function inferRisks(task: string, paths: string[]): string[] {
  const lower = task.toLowerCase();
  const risks = new Set<string>();
  if (/dto|payload|request|response|schema|type/.test(lower))
    risks.add("shared DTO/schema change; check all consumers");
  if (/api|endpoint|route|openapi|grpc|proto|graphql/.test(lower))
    risks.add("public network contract change; check provider and consumers");
  if (/cache|redis|ttl|invalidation/.test(lower))
    risks.add("cache key or invalidation risk");
  if (/db|database|migration|table|column/.test(lower))
    risks.add("database migration/backward compatibility risk");
  if (
    paths.some((p) =>
      /openapi|\.proto|schema\.graphql|schema\.prisma|migrations\//.test(p),
    )
  )
    risks.add("contract file appears in evidence");
  return Array.from(risks);
}

function countBy<T>(items: T[], select: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = select(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function parseLedgerLine(line: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : { raw: line };
  } catch {
    return { raw: line };
  }
}

function matchesSymbolQuery(entry: IndexEntry, query?: string): boolean {
  if (!query) return true;
  const lower = query.toLowerCase();
  return `${entry.name}\n${entry.path}\n${entry.text ?? ""}`.toLowerCase().includes(lower);
}

async function collectNeighbors(
  store: WorkspaceStore,
  entries: IndexEntry[],
  target: string,
  limit: number,
  sqlite?: SQLiteToolEvidence,
): Promise<Record<string, unknown>> {
  const resolved = await store.resolveRef(target);
  const direct = entries.filter(
    (entry) => entry.ref === target || (!resolved && entry.name === target),
  );
  const targetNames = new Set(direct.map((entry) => entry.name));
  if (!resolved && targetNames.size === 0) targetNames.add(target);
  const targetRefs = new Set<string>();
  const targetDirs = new Set<string>();

  if (resolved) {
    targetRefs.add(target);
    targetDirs.add(path.posix.dirname(resolved.relPath));
  }
  for (const entry of direct) {
    targetRefs.add(entry.ref);
    targetDirs.add(path.posix.dirname(entry.path));
  }

  const scored = new Map<string, { entry: IndexEntry; score: number; reasons: string[] }>();
  for (const entry of entries) {
    let score = 0;
    const reasons: string[] = [];
    if (targetRefs.has(entry.ref)) {
      score += 5;
      reasons.push("same-file");
    }
    if (targetNames.has(entry.name)) {
      score += 4;
      reasons.push("same-name");
    }
    if (targetDirs.has(path.posix.dirname(entry.path))) {
      score += 2;
      reasons.push("same-directory");
    }
    if (entry.ref.includes(target) || target.includes(entry.path) || entry.path.includes(target)) {
      score += 1;
      reasons.push("ref-related");
    }
    if (score <= 0) continue;
    const key = `${entry.kind}:${entry.ref}:${entry.line ?? 0}:${entry.name}`;
    scored.set(key, { entry, score, reasons: Array.from(new Set(reasons)) });
  }

  const neighbors = Array.from(scored.values())
    .sort((a, b) => b.score - a.score || a.entry.ref.localeCompare(b.entry.ref) || (a.entry.line ?? 0) - (b.entry.line ?? 0))
    .slice(0, limit)
    .map(({ entry, score, reasons }) => ({
      root: entry.root,
      ref: entry.ref,
      path: entry.path,
      kind: entry.kind,
      name: entry.name,
      line: entry.line ?? null,
      text: entry.text ?? null,
      score,
      reasons,
    }));

  const graph = graphNeighborsForTarget(sqlite, target, limit);
  return {
    version: "v0.1",
    target,
    heuristic: true,
    disclaimer:
      sqlite?.available
        ? "Neighbors include graph-backed SQLite edges plus legacy same-file, same-name, same-directory, and ref-related heuristic matches."
        : "Neighbors are heuristic only: same-file, same-name, same-directory, and ref-related matches from the lightweight index. SQLite graph evidence is unavailable.",
    directEvidence: direct.map((entry) => ({
      root: entry.root,
      ref: entry.ref,
      path: entry.path,
      kind: entry.kind,
      name: entry.name,
      line: entry.line ?? null,
      text: entry.text ?? null,
    })),
    neighbors,
    graphDirectEvidence: graph.directEvidence,
    graphNeighbors: graph.neighbors,
    graphUnknowns: graph.unknowns,
    graphWarnings: graph.warnings,
    sqlite: sqlite ? sqliteReport(sqlite) : null,
    unknowns: dedupeStrings([
      sqlite?.available
        ? "Graph relationships are conservative SQLite evidence and may still be incomplete."
        : "Import/call relationships require SQLite graph evidence and are unavailable in this degraded response.",
      "Low-confidence neighbors should be confirmed with ctx_read or ctx_search.",
      ...graph.unknowns,
    ]),
  };
}

interface GraphAnchor {
  id: string;
  kind: string;
  name: string;
  root: string;
  ref: string | null;
  path: string | null;
  line: number | null;
  confidence: number;
}

interface GraphEdgeEvidence {
  id: string;
  kind: string;
  from: GraphAnchor | null;
  to: GraphAnchor | null;
  source: GraphAnchor | null;
  confidence: number;
  attrs: Record<string, unknown>;
}

function graphNeighborsForTarget(sqlite: SQLiteToolEvidence | undefined, target: string, limit: number): {
  directEvidence: GraphAnchor[];
  neighbors: GraphEdgeEvidence[];
  unknowns: string[];
  warnings: string[];
} {
  const empty = emptyGraphResult(sqlite, "SQLite graph evidence is unavailable; using legacy heuristic neighbors only.");
  const snapshot = sqlite?.snapshot;
  if (!sqlite?.available || !snapshot) return empty;
  const graph = graphMaps(snapshot);
  const matched = matchingNodes(snapshot.nodes, target);
  const matchedIds = new Set(matched.map((node) => node.id));
  const fileIds = new Set(matched.flatMap((node) => (node.fileId ? [node.fileId] : [])));
  const relPaths = new Set(matched.flatMap((node) => (node.relPath ? [node.relPath] : [])));
  const edges = snapshot.edges
    .filter((edge) => edgeMatchesTarget(edge, matchedIds, fileIds, relPaths, target))
    .slice(0, limit);
  const unknownRecords = snapshot.unresolved.filter((item) => unresolvedMatches(item, matchedIds, fileIds, relPaths, target)).slice(0, limit);
  const warnings = graphWarnings(sqlite, matched.length, edges.length, unknownRecords.length);
  return {
    directEvidence: matched.slice(0, limit).map(nodeToAnchor),
    neighbors: edges.map((edge) => edgeToEvidence(edge, graph)),
    unknowns: unknownRecords.map(unresolvedMessage),
    warnings,
  };
}

function graphPackEvidence(sqlite: SQLiteToolEvidence, task: string, roots: string[] | undefined, limit: number, hits: SearchHit[]): Record<string, unknown> {
  const snapshot = sqlite.snapshot;
  const allowedRoots = new Set(roots ?? []);
  const hitRefs = new Set(hits.map((hit) => hit.ref));
  if (!sqlite.available || !snapshot) {
    return {
      sqlite: sqliteReport(sqlite),
      evidenceAnchors: hits.map(hitToAnchor),
      graphNeighbors: [],
      packages: [],
      testCandidates: [],
      unresolved: [],
      unknowns: ["SQLite graph evidence is unavailable; pack evidence is degraded to legacy index hits."],
      warnings: graphWarnings(sqlite, hits.length, 0, 0),
    };
  }
  const graph = graphMaps(snapshot);
  const taskMatches = matchingNodes(snapshot.nodes, task).filter((node) => !allowedRoots.size || allowedRoots.has(node.rootName));
  const matchedIds = new Set(taskMatches.map((node) => node.id));
  const hitPaths = new Set(hits.map((hit) => hit.path));
  const relatedEdges = snapshot.edges
    .filter((edge) => edgeMatchesPack(edge, matchedIds, hitPaths, hitRefs, allowedRoots, graph))
    .slice(0, limit);
  const unresolved = snapshot.unresolved
    .filter((item) => (!allowedRoots.size || allowedRoots.has(item.rootName)) && (matchesText(`${item.name}\n${item.reason}\n${item.relPath ?? ""}`, task) || (item.relPath ? hitPaths.has(item.relPath) : false)))
    .slice(0, limit);
  const packages = snapshot.nodes
    .filter((node) => node.kind === "PACKAGE" && (!allowedRoots.size || allowedRoots.has(node.rootName)))
    .slice(0, limit)
    .map(packageNodeSummary);
  const testCandidates = snapshot.nodes
    .filter((node) => node.kind === "TEST_CANDIDATE" && (!allowedRoots.size || allowedRoots.has(node.rootName)))
    .filter((node) => taskMatches.length === 0 || relatedEdges.some((edge) => edge.fromId === node.id || edge.toId === node.id || edge.fileId === node.fileId))
    .slice(0, limit)
    .map(nodeToAnchor);
  const warnings = graphWarnings(sqlite, taskMatches.length + hits.length, relatedEdges.length, unresolved.length);
  return {
    sqlite: sqliteReport(sqlite),
    evidenceAnchors: dedupeAnchors([...hits.map(hitToAnchor), ...taskMatches.map(nodeToAnchor)]).slice(0, limit),
    graphNeighbors: relatedEdges.map((edge) => edgeToEvidence(edge, graph)),
    packages,
    testCandidates,
    unresolved: unresolved.map(unresolvedSummary),
    unknowns: dedupeStrings([
      ...unresolved.map(unresolvedMessage),
      ...(relatedEdges.length === 0 ? ["No graph edges matched the task evidence; inspect refs before assuming cross-root impact."] : []),
    ]),
    warnings,
  };
}

function graphImpactForTarget(sqlite: SQLiteToolEvidence, target: string, limit: number): {
  directEvidence: GraphAnchor[];
  crossRootEvidence: GraphEdgeEvidence[];
  unknownEvidence: Array<Record<string, unknown>>;
  testCandidateEvidence: GraphEdgeEvidence[];
  unknowns: string[];
  warnings: string[];
} {
  const snapshot = sqlite.snapshot;
  if (!sqlite.available || !snapshot) {
    return {
      directEvidence: [],
      crossRootEvidence: [],
      unknownEvidence: [],
      testCandidateEvidence: [],
      unknowns: ["SQLite graph evidence is unavailable; impact analysis is degraded to legacy search hits."],
      warnings: graphWarnings(sqlite, 0, 0, 0),
    };
  }
  const graph = graphMaps(snapshot);
  const matched = matchingNodes(snapshot.nodes, target);
  const matchedIds = new Set(matched.map((node) => node.id));
  const fileIds = new Set(matched.flatMap((node) => (node.fileId ? [node.fileId] : [])));
  const relPaths = new Set(matched.flatMap((node) => (node.relPath ? [node.relPath] : [])));
  const edges = snapshot.edges.filter((edge) => edgeMatchesTarget(edge, matchedIds, fileIds, relPaths, target));
  const crossRoot = edges.filter((edge) => {
    const fromRoot = edge.fromId ? graph.nodes.get(edge.fromId)?.rootName : undefined;
    const toRoot = edge.toId ? graph.nodes.get(edge.toId)?.rootName : undefined;
    return !!fromRoot && !!toRoot && fromRoot !== toRoot;
  });
  const testEdges = edges.filter((edge) => edge.kind === "TESTS" || (edge.fromId ? graph.nodes.get(edge.fromId)?.kind === "TEST_CANDIDATE" : false));
  const unresolved = snapshot.unresolved.filter((item) => unresolvedMatches(item, matchedIds, fileIds, relPaths, target)).slice(0, limit);
  return {
    directEvidence: matched.slice(0, limit).map(nodeToAnchor),
    crossRootEvidence: crossRoot.slice(0, limit).map((edge) => edgeToEvidence(edge, graph)),
    unknownEvidence: unresolved.map(unresolvedSummary),
    testCandidateEvidence: testEdges.slice(0, limit).map((edge) => edgeToEvidence(edge, graph)),
    unknowns: unresolved.map(unresolvedMessage),
    warnings: graphWarnings(sqlite, matched.length, edges.length, unresolved.length),
  };
}

function graphTestPlanEvidence(sqlite: SQLiteToolEvidence | undefined, args: { target?: string; root?: string; ref?: string }, limit: number): {
  testAnchors: GraphAnchor[];
  testEdges: GraphEdgeEvidence[];
  packages: Array<Record<string, unknown>>;
  unknowns: string[];
  warnings: string[];
} {
  const snapshot = sqlite?.snapshot;
  if (!sqlite?.available || !snapshot) {
    return {
      testAnchors: [],
      testEdges: [],
      packages: [],
      unknowns: ["SQLite graph evidence is unavailable; test plan uses legacy indexed test/package entries."],
      warnings: graphWarnings(sqlite, 0, 0, 0),
    };
  }
  const graph = graphMaps(snapshot);
  const focus = args.ref ?? args.target ?? "";
  const allowedRoot = args.root;
  const matched = focus ? matchingNodes(snapshot.nodes, focus) : [];
  const matchedIds = new Set(matched.map((node) => node.id));
  const matchedFiles = new Set(matched.flatMap((node) => (node.fileId ? [node.fileId] : [])));
  const testEdges = snapshot.edges
    .filter((edge) => edge.kind === "TESTS")
    .filter((edge) => !allowedRoot || edge.rootName === allowedRoot)
    .filter((edge) => matchedIds.size === 0 || (edge.toId ? matchedIds.has(edge.toId) : false) || (edge.fileId ? matchedFiles.has(edge.fileId) : false))
    .slice(0, limit);
  const edgeTestIds = new Set(testEdges.flatMap((edge) => (edge.fromId ? [edge.fromId] : [])));
  const directTests = snapshot.nodes
    .filter((node) => node.kind === "TEST_CANDIDATE")
    .filter((node) => !allowedRoot || node.rootName === allowedRoot)
    .filter((node) => edgeTestIds.has(node.id) || !focus || matchesText(`${node.name}\n${node.relPath ?? ""}`, focus))
    .slice(0, limit);
  const packageNodes = snapshot.nodes
    .filter((node) => node.kind === "PACKAGE")
    .filter((node) => !allowedRoot || node.rootName === allowedRoot)
    .slice(0, limit);
  const unresolved = snapshot.unresolved
    .filter((item) => item.kind === "TEST_SOURCE" || item.reason.includes("test"))
    .filter((item) => !allowedRoot || item.rootName === allowedRoot)
    .slice(0, limit);
  return {
    testAnchors: dedupeAnchors([...directTests.map(nodeToAnchor), ...testEdges.flatMap((edge) => edge.fromId ? [anchorForNodeId(graph, edge.fromId)].filter((anchor): anchor is GraphAnchor => anchor !== null) : [])]),
    testEdges: testEdges.map((edge) => edgeToEvidence(edge, graph)),
    packages: packageNodes.map(packageNodeSummary),
    unknowns: unresolved.map(unresolvedMessage),
    warnings: graphWarnings(sqlite, directTests.length, testEdges.length, unresolved.length),
  };
}

function emptyGraphResult(sqlite: SQLiteToolEvidence | undefined, message: string): {
  directEvidence: GraphAnchor[];
  neighbors: GraphEdgeEvidence[];
  unknowns: string[];
  warnings: string[];
} {
  return { directEvidence: [], neighbors: [], unknowns: [message], warnings: graphWarnings(sqlite, 0, 0, 0) };
}

function graphMaps(snapshot: DebugSnapshot): { nodes: Map<string, DebugNodeRecord> } {
  return { nodes: new Map(snapshot.nodes.map((node) => [node.id, node])) };
}

function matchingNodes(nodes: DebugNodeRecord[], target: string): DebugNodeRecord[] {
  const normalized = target.toLowerCase();
  return nodes.filter((node) => {
    const ref = node.relPath && node.rootName ? `${node.rootName}:${node.relPath}` : "";
    return node.id === target || ref === target || node.name === target || matchesText(`${node.name}\n${ref}\n${node.relPath ?? ""}`, normalized);
  });
}

function edgeMatchesTarget(edge: DebugEdgeRecord, nodeIds: Set<string>, fileIds: Set<string>, relPaths: Set<string>, target: string): boolean {
  return (edge.fromId ? nodeIds.has(edge.fromId) : false)
    || (edge.toId ? nodeIds.has(edge.toId) : false)
    || (edge.fileId ? fileIds.has(edge.fileId) : false)
    || (edge.relPath ? relPaths.has(edge.relPath) || matchesText(edge.relPath, target) : false);
}

function edgeMatchesPack(edge: DebugEdgeRecord, nodeIds: Set<string>, hitPaths: Set<string>, hitRefs: Set<string>, roots: Set<string>, graph: { nodes: Map<string, DebugNodeRecord> }): boolean {
  if (roots.size && edge.rootName && !roots.has(edge.rootName)) return false;
  const from = edge.fromId ? graph.nodes.get(edge.fromId) : undefined;
  const to = edge.toId ? graph.nodes.get(edge.toId) : undefined;
  return (edge.fromId ? nodeIds.has(edge.fromId) : false)
    || (edge.toId ? nodeIds.has(edge.toId) : false)
    || (edge.relPath ? hitPaths.has(edge.relPath) || (edge.rootName ? hitRefs.has(`${edge.rootName}:${edge.relPath}`) : false) : false)
    || (from?.relPath ? hitPaths.has(from.relPath) : false)
    || (to?.relPath ? hitPaths.has(to.relPath) : false);
}

function unresolvedMatches(item: DebugUnresolvedRecord, nodeIds: Set<string>, fileIds: Set<string>, relPaths: Set<string>, target: string): boolean {
  const sourceId = stringAttr(item.attrs, "nodeId") ?? stringAttr(item.attrs, "sourceUnresolvedId");
  return (sourceId ? nodeIds.has(sourceId) : false)
    || (item.fileId ? fileIds.has(item.fileId) : false)
    || (item.relPath ? relPaths.has(item.relPath) || matchesText(item.relPath, target) : false)
    || matchesText(`${item.name}\n${item.reason}`, target);
}

function nodeToAnchor(node: DebugNodeRecord): GraphAnchor {
  const pathValue = node.relPath ?? stringAttr(node.attrs, "relPath");
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    root: node.rootName,
    ref: pathValue && node.rootName ? `${node.rootName}:${pathValue}` : null,
    path: pathValue ?? null,
    line: node.startLine || null,
    confidence: node.confidence,
  };
}

function hitToAnchor(hit: SearchHit): GraphAnchor {
  return {
    id: `${hit.kind}:${hit.ref}:${hit.line ?? 0}:${hit.text}`,
    kind: hit.kind,
    name: hit.text,
    root: hit.root,
    ref: hit.ref,
    path: hit.path,
    line: hit.line ?? null,
    confidence: Math.min(1, Math.max(0.1, hit.score / 10)),
  };
}

function edgeToEvidence(edge: DebugEdgeRecord, graph: { nodes: Map<string, DebugNodeRecord> }): GraphEdgeEvidence {
  const sourceNode = edge.fileId ? graph.nodes.get(`node:${edge.fileId}`) : undefined;
  return {
    id: edge.id,
    kind: edge.kind,
    from: edge.fromId ? anchorForNodeId(graph, edge.fromId) : null,
    to: edge.toId ? anchorForNodeId(graph, edge.toId) : null,
    source: sourceNode ? nodeToAnchor(sourceNode) : edge.relPath && edge.rootName ? {
      id: edge.fileId ?? edge.id,
      kind: "FILE",
      name: path.posix.basename(edge.relPath),
      root: edge.rootName,
      ref: `${edge.rootName}:${edge.relPath}`,
      path: edge.relPath,
      line: edge.startLine ?? null,
      confidence: edge.confidence,
    } : null,
    confidence: edge.confidence,
    attrs: edge.attrs,
  };
}

function anchorForNodeId(graph: { nodes: Map<string, DebugNodeRecord> }, id: string): GraphAnchor | null {
  const node = graph.nodes.get(id);
  return node ? nodeToAnchor(node) : null;
}

function unresolvedSummary(item: DebugUnresolvedRecord): Record<string, unknown> {
  return {
    id: item.id,
    kind: item.kind,
    name: item.name,
    root: item.rootName,
    ref: item.relPath && item.rootName ? `${item.rootName}:${item.relPath}` : null,
    path: item.relPath ?? null,
    reason: item.reason,
    attrs: item.attrs,
  };
}

function unresolvedMessage(item: DebugUnresolvedRecord): string {
  const ref = item.relPath && item.rootName ? `${item.rootName}:${item.relPath}` : item.rootName;
  return `${item.kind} ${item.name} unresolved at ${ref}: ${item.reason}`;
}

function packageNodeSummary(node: DebugNodeRecord): Record<string, unknown> {
  return {
    ...nodeToAnchor(node),
    scripts: stringArrayAttr(node.attrs, "scripts"),
    testScripts: stringArrayAttr(node.attrs, "testScripts"),
    testCommands: recordAttr(node.attrs, "testCommands"),
    dependencies: stringArrayAttr(node.attrs, "dependencies"),
  };
}

function graphPackageCommands(packages: Array<Record<string, unknown>>): string[] {
  return packages.flatMap((pkg) => {
    const pathValue = typeof pkg.path === "string" ? pkg.path : undefined;
    const testCommands = isStringRecord(pkg.testCommands) ? Object.keys(pkg.testCommands) : [];
    const dir = pathValue ? path.posix.dirname(pathValue) : ".";
    return testCommands.map((script) => dir === "." ? `bun run ${script}` : `bun --cwd ${JSON.stringify(dir)} run ${script}`);
  });
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((item) => typeof item === "string");
}

function graphWarnings(sqlite: SQLiteToolEvidence | undefined, directCount: number, edgeCount: number, unknownCount: number): string[] {
  const warnings: string[] = [];
  if (!sqlite?.available) warnings.push("SQLite graph evidence unavailable; degraded fallback is in use.");
  else if (sqlite.degraded) warnings.push("SQLite graph evidence opened with diagnostics; treat graph links as potentially incomplete.");
  if (sqlite?.snapshot && latestIndexRun(sqlite.snapshot) === undefined) warnings.push("No completed SQLite index run was found; graph evidence may be stale.");
  if (directCount === 0) warnings.push("No direct graph evidence matched the request.");
  if (edgeCount === 0) warnings.push("No graph edges matched the request; cross-root links may be unknown or stale.");
  if (unknownCount > 0) warnings.push("Unresolved graph records are present; do not treat missing links as proof of no impact.");
  return dedupeStrings(warnings);
}

function matchesText(value: string, query: string): boolean {
  return value.toLowerCase().includes(query.toLowerCase());
}

function stringArrayAttr(attrs: Record<string, unknown>, key: string): string[] {
  const value = attrs[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function recordAttr(attrs: Record<string, unknown>, key: string): Record<string, string> {
  const value = attrs[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function dedupeAnchors(anchors: GraphAnchor[]): GraphAnchor[] {
  const seen = new Set<string>();
  return anchors.filter((anchor) => {
    const key = anchor.ref ? `${anchor.ref}:${anchor.kind}:${anchor.line ?? 0}:${anchor.name}` : anchor.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function buildTestPlan(
  store: WorkspaceStore,
  entries: IndexEntry[],
  args: { target?: string; root?: string; ref?: string; limit?: number },
  sqlite?: SQLiteToolEvidence,
): Promise<Record<string, unknown>> {
  const filtered = entries.filter((entry) => !args.root || entry.root === args.root);
  const tests = filtered.filter((entry) => entry.kind === "test");
  const packages = filtered.filter((entry) => entry.kind === "package");
  const focus = args.ref ?? args.target;
  const graphPlan = graphTestPlanEvidence(sqlite, args, args.limit ?? 20);
  const graphTestRefs = new Set(graphPlan.testAnchors.flatMap((anchor) => (anchor.ref ? [anchor.ref] : [])));
  const candidateTests = tests
    .filter((entry) => graphTestRefs.has(entry.ref) || matchesTestFocus(entry, focus, args.ref))
    .slice(0, args.limit ?? 20);

  const packagePlans: Array<{
    root: string;
    ref: string;
    packageName: string;
    commands: string[];
    scripts: string[];
  }> = [];
  for (const entry of packages) {
    const pkgPlan = await readPackagePlan(store, entry, candidateTests);
    if (pkgPlan) packagePlans.push(pkgPlan);
  }

  const packageCommands = [...packagePlans.flatMap((pkg) => pkg.commands), ...graphPackageCommands(graphPlan.packages)];
  const commands = dedupeStrings([
    ...candidateTests.map((entry) => `bun test ${entry.path}`),
    ...packageCommands,
  ]);

  return {
    version: "v0.1",
    target: args.target ?? null,
    root: args.root ?? null,
    ref: args.ref ?? null,
    heuristic: true,
    disclaimer:
      "Test planning uses indexed test/package entries and package.json scripts only. It does not execute or validate the commands.",
    matchingTests: candidateTests.map((entry) => ({
      root: entry.root,
      ref: entry.ref,
      path: entry.path,
      name: entry.name,
    })),
    graphMatchingTests: graphPlan.testAnchors,
    graphTestEdges: graphPlan.testEdges,
    graphUnknowns: graphPlan.unknowns,
    graphWarnings: graphPlan.warnings,
    sqlite: sqlite ? sqliteReport(sqlite) : null,
    packages: packagePlans,
    graphPackages: graphPlan.packages,
    suggestedCommands: commands,
    notes: [
      candidateTests.length > 0
        ? "Prefer the narrower file-level commands first, then broader package scripts if needed."
        : "No strongly targeted test files were found in the index; only package-level indexed test scripts are suggested when available.",
    ],
  };
}

function matchesTestFocus(entry: IndexEntry, focus?: string, ref?: string): boolean {
  if (!focus && !ref) return true;
  if (ref) return entry.ref === ref || entry.path === ref || entry.path.startsWith(ref.replace(/^[^:]+:/, ""));
  if (!focus) return true;
  const lower = focus.toLowerCase();
  return `${entry.name}\n${entry.path}\n${entry.ref}`.toLowerCase().includes(lower);
}

async function readPackagePlan(
  store: WorkspaceStore,
  entry: IndexEntry,
  candidateTests: IndexEntry[],
): Promise<{ root: string; ref: string; packageName: string; commands: string[]; scripts: string[] } | undefined> {
  const resolved = await store.resolveRef(entry.ref);
  if (!resolved) return undefined;
  const pkg = await readJsonFile(resolved.absPath);
  const scripts = pkg?.scripts;
  if (!scripts || typeof scripts !== "object") return undefined;
  const scriptEntries = Object.entries(scripts).filter(
    ([, value]) => typeof value === "string",
  ) as Array<[string, string]>;
  const packageDir = path.posix.dirname(entry.path);
  const localTests = candidateTests.filter((test) => test.root === entry.root && test.path.startsWith(packageDir === "." ? "" : `${packageDir}/`));
  const commands = scriptEntries
    .filter(([name]) => /(^test$|test|spec|integration|e2e)/i.test(name))
    .map(([name]) => formatRunScriptCommand(entry.ref, name));
  if (commands.length === 0 && localTests.length > 0) {
    commands.push(packageDir === "." ? "bun test" : `bun test ${packageDir}`);
  }
  if (commands.length === 0) return undefined;
  return {
    root: entry.root,
    ref: entry.ref,
    packageName: entry.name,
    commands: dedupeStrings(commands),
    scripts: scriptEntries.map(([name]) => name),
  };
}

function formatRunScriptCommand(ref: string, scriptName: string): string {
  const relPath = ref.replace(/^[^:]+:/, "");
  const dir = path.posix.dirname(relPath);
  return dir === "."
    ? `bun run ${scriptName}`
    : `bun --cwd ${JSON.stringify(dir)} run ${scriptName}`;
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | undefined> {
  const text = await readFile(filePath, "utf8").catch(() => undefined);
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

async function readRegistryCounts(store: WorkspaceStore): Promise<{
  contractCounts: { available: boolean; total: number; byKind: Record<string, number> };
  memoryCounts: { available: boolean; total: number; stale: number };
}> {
  const empty = {
    contractCounts: { available: false, total: 0, byKind: {} },
    memoryCounts: { available: false, total: 0, stale: 0 },
  };
  if (!existsSync(store.sqlitePath)) return empty;
  const opened = await openSQLiteIndexStore(store.sqlitePath, { readonly: true, skipMigrations: true });
  if (!opened.ok) return empty;
  try {
    const contracts = opened.value.readContracts();
    const stale = opened.value.readStaleSummaries();
    const byKind: Record<string, number> = {};
    let contractTotal = 0;
    if (contracts.ok) {
      for (const contract of contracts.value) {
        byKind[contract.kind] = (byKind[contract.kind] ?? 0) + 1;
        contractTotal += 1;
      }
    }
    const staleCount = stale.ok ? stale.value.length : 0;
    const totalSummaries = countTotalSummaries(opened.value);
    return {
      contractCounts: { available: true, total: contractTotal, byKind },
      memoryCounts: { available: true, total: totalSummaries, stale: staleCount },
    };
  } finally {
    opened.value.close();
  }
}

function countTotalSummaries(sqlite: import("../indexer/sqlite-store.js").SQLiteIndexStore): number {
  // Reuse readStaleSummaries against a flag-free filter via direct readContract to keep typing strict.
  // We piggy-back on readContracts only for total contracts; summaries total comes from a small inline query.
  const result = sqlite.readSummariesTotal?.();
  if (result?.ok) return result.value;
  return 0;
}

function readSessionID(context: unknown): string | undefined {
  if (!context || typeof context !== "object") return undefined;
  const record = context as Record<string, unknown>;
  if (typeof record.sessionID === "string") return record.sessionID;
  if (typeof record.sessionId === "string") return record.sessionId;
  return undefined;
}
