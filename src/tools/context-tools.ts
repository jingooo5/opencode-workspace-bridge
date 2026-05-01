import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { tool } from "@opencode-ai/plugin";
import type { PluginInput, ToolDefinition } from "@opencode-ai/plugin";
import { RootRoleSchema, type ContextBridgeOptions } from "../types.js";
import type { IndexEntry } from "../types.js";
import type { WorkspaceStore } from "../state/workspace-store.js";
import { indexRoot, readEntries, searchIndex } from "../indexer/light-index.js";

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
        return JSON.stringify({ index: store.indexPath, result }, null, 2);
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
        const hits = await searchIndex(
          store,
          args.query,
          args.roots,
          args.limit ?? options.maxSearchResults,
        );
        return (
          hits
            .map(
              (hit) =>
                `[${hit.kind}] ${hit.ref}${hit.line ? `#L${hit.line}` : ""}\n${hit.text}`,
            )
            .join("\n\n") ||
          "No hits. Try ctx_index first or broaden the query."
        );
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
        const recent = await store.recentLedger(args.ledgerLimit ?? 8);
        const countsByKind = countBy(entries, (entry) => entry.kind);
        const countsByRoot = countBy(entries, (entry) => entry.root);
        const staleRoots = manifest.roots
          .filter((root) => root.stale || !root.indexedAt)
          .map((root) => root.name);
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
            recentLedger: recent.map(parseLedgerLine),
            notes: [
              "Status uses only the current manifest, JSONL index, and recent ledger.",
              "V0.1 does not track import graphs, semantic memory, or structural dependencies.",
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
        const entries = (await readEntries(store.indexPath))
          .filter((entry) => entry.kind === "symbol")
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
            notes: [
              "Symbols come from lightweight text extraction, not AST or LSP graph analysis.",
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
        const entries = await readEntries(store.indexPath);
        const analysis = await collectNeighbors(store, entries, args.target, args.limit ?? 20);
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
        "Create a task-specific context pack from the multi-root evidence index. Use before cross-repo edits, DTO/API changes, or debugging distributed flows.",
      args: {
        task: z.string().min(1).describe("Natural language task description."),
        roots: z.array(z.string()).optional(),
        limit: z.number().int().positive().optional(),
      },
      async execute(args) {
        await ensureIndexReady(store, options);
        const pack = await createPack(
          store,
          args.task,
          args.roots,
          args.limit ?? 12,
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
        const entries = await readEntries(store.indexPath);
        const plan = await buildTestPlan(store, entries, args);
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
          refreshedPack = await createPack(
            store,
            args.task,
            args.root ? [args.root] : undefined,
            args.limit ?? 12,
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

    ctx_impact: tool({
      description:
        "V0.1 lightweight impact analysis for a root:path, symbol, DTO, API, or search phrase. Produces evidence-backed candidate impacts.",
      args: {
        target: z
          .string()
          .min(1)
          .describe(
            "Target ref or phrase, for example shared:src/types/order.ts or OrderDto.",
          ),
        limit: z.number().int().positive().optional(),
      },
      async execute(args) {
        await ensureIndexReady(store, options);
        const hits = await searchIndex(
          store,
          args.target,
          undefined,
          args.limit ?? 30,
        );
        const risks = inferRisks(
          args.target,
          hits.map((hit) => hit.path),
        );
        const roots = Array.from(new Set(hits.map((hit) => hit.root)));
        await store.appendLedger({
          type: "impact.analysis",
          target: args.target,
          hits: hits.length,
          roots,
          risks,
        });
        return JSON.stringify(
          {
            target: args.target,
            roots,
            directEvidence: hits,
            risks,
            unknowns: [
              "V0.1 uses lightweight text/symbol evidence; REST/OpenAPI/proto structural matching arrives in v0.2+.",
              "Low or missing evidence should be confirmed with ctx_read and targeted search.",
            ],
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
): Promise<Record<string, unknown>> {
  const hits = await searchIndex(store, task, roots, limit);
  const summary = await store.workspaceSummary();
  const riskHints = inferRisks(
    task,
    hits.map((hit) => hit.path),
  );
  const pack = {
    task,
    workspace: summary,
    evidence: hits,
    risks: riskHints,
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
  await Bun.write(
    path.join(
      store.stateDirAbs,
      "packs",
      `${Date.now()}-${safeName}.json`,
    ),
    JSON.stringify(pack, null, 2),
  );
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

  return {
    version: "v0.1",
    target,
    heuristic: true,
    disclaimer:
      "Neighbors are heuristic only: same-file, same-name, same-directory, and ref-related matches from the lightweight index. No structural graph proof is available in V0.1.",
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
    unknowns: [
      "Import/call relationships are not tracked in the V0.1 index.",
      "Low-confidence neighbors should be confirmed with ctx_read or ctx_search.",
    ],
  };
}

async function buildTestPlan(
  store: WorkspaceStore,
  entries: IndexEntry[],
  args: { target?: string; root?: string; ref?: string; limit?: number },
): Promise<Record<string, unknown>> {
  const filtered = entries.filter((entry) => !args.root || entry.root === args.root);
  const tests = filtered.filter((entry) => entry.kind === "test");
  const packages = filtered.filter((entry) => entry.kind === "package");
  const focus = args.ref ?? args.target;
  const candidateTests = tests
    .filter((entry) => matchesTestFocus(entry, focus, args.ref))
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

  const commands = dedupeStrings([
    ...candidateTests.map((entry) => `bun test ${entry.path}`),
    ...packagePlans.flatMap((pkg) => pkg.commands),
    ...(candidateTests.length > 0 ? [] : ["bun test"]),
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
    packages: packagePlans,
    suggestedCommands: commands,
    notes: [
      candidateTests.length > 0
        ? "Prefer the narrower file-level commands first, then broader package scripts if needed."
        : "No strongly targeted test files were found in the index; broader package-level suggestions are provided when available.",
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
