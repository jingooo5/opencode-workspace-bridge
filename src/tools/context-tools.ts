import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { tool } from "@opencode-ai/plugin";
import type { PluginInput, ToolDefinition } from "@opencode-ai/plugin";
import { RootRoleSchema, type ContextBridgeOptions } from "../types.js";
import type { WorkspaceStore } from "../state/workspace-store.js";
import { ensureGlobalBootstrap } from "../bootstrap/global-bootstrap.js";
import { indexRoot, searchIndex } from "../indexer/light-index.js";

// Use the plugin's own zod instance so schemas are guaranteed compatible with
// the runtime that ultimately consumes tool definitions.
const z = tool.schema;

export function createContextTools(
  ctx: PluginInput,
  store: WorkspaceStore,
  options: ContextBridgeOptions,
): Record<string, ToolDefinition> {
  return {
    ctx_install_agents: tool({
      description: "Repair/re-run Context Bridge global bootstrap. This is not required normally; the plugin runs it automatically on startup.",
      args: {},
      async execute() {
        const result = await ensureGlobalBootstrap(ctx, { ...options, globalBootstrap: true });
        return JSON.stringify({ note: "Global bootstrap completed. Restart OpenCode if you want newly written global agent files to be picked up by a fresh process.", ...result }, null, 2);
      },
    }),

    ctx_add_dir: tool({
      description: "Add an external directory/repository to the Context Bridge workspace manifest. Use before reading or reasoning about files outside the primary OpenCode directory.",
      args: {
        path: z.string().min(1).describe("Directory path, absolute or relative to the current OpenCode directory."),
        name: z.string().min(1).optional().describe("Stable root alias, for example backend or shared."),
        access: z.enum(["ro", "rw"]).optional().describe("Access mode. ro means analysis only; rw allows edits subject to OpenCode permissions."),
        role: z.enum(RootRoleSchema.options).optional().describe("Root role: primary, app, service, library, tooling, docs, unknown."),
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
        return JSON.stringify({ added: root, manifest: store.manifestPath }, null, 2);
      },
    }),

    ctx_list_roots: tool({
      description: "List active Context Bridge workspace roots, aliases, access mode, index state, and manifest path.",
      args: {},
      async execute() {
        return await store.workspaceSummary();
      },
    }),

    ctx_index: tool({
      description: "Build or refresh the lightweight V0.1 evidence index for one root or all roots. Usually optional because autoIndex is enabled by default.",
      args: {
        root: z.string().min(1).optional().describe("Root alias to index. If omitted, index all roots."),
      },
      async execute(args) {
        const roots = await store.listRoots();
        const selected = args.root ? roots.filter((root) => root.name === args.root) : roots;
        const result = [];
        for (const root of selected) {
          const entries = await indexRoot(store, root);
          result.push({ root: root.name, entries: entries.length });
        }
        return JSON.stringify({ index: store.indexPath, result }, null, 2);
      },
    }),

    ctx_search: tool({
      description: "Search the Context Bridge multi-root evidence index across root aliases. Use this instead of raw grep when the task may span repositories.",
      args: {
        query: z.string().min(1).describe("Search query."),
        roots: z.array(z.string()).optional().describe("Optional root aliases to restrict search."),
        limit: z.number().int().positive().optional().describe("Maximum hits."),
      },
      async execute(args) {
        await ensureIndexReady(store, options);
        const hits = await searchIndex(store, args.query, args.roots, args.limit ?? options.maxSearchResults);
        return hits
          .map((hit) => `[${hit.kind}] ${hit.ref}${hit.line ? `#L${hit.line}` : ""}\n${hit.text}`)
          .join("\n\n") || "No hits. Try ctx_index first or broaden the query.";
      },
    }),

    ctx_read: tool({
      description: "Read a file by root alias reference, for example backend:src/routes/orders.ts. Safer than absolute-path read for multi-root work.",
      args: {
        ref: z.string().min(1).describe("Root alias reference: root:path/to/file."),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
      },
      async execute(args) {
        const resolved = await store.resolveRef(args.ref);
        if (!resolved) throw new Error(`Unknown or unsafe root reference: ${args.ref}`);
        if (await store.isSecretPath(resolved.absPath)) throw new Error(`Refusing to read protected secret-like file: ${args.ref}`);
        const text = await readFile(resolved.absPath, "utf8");
        const lines = text.split(/\r?\n/);
        const start = Math.max(1, args.startLine ?? 1);
        const end = Math.min(lines.length, args.endLine ?? lines.length);
        const sliced = lines.slice(start - 1, end).join("\n");
        return sliced.length > options.maxReadBytes ? `${sliced.slice(0, options.maxReadBytes)}\n...[truncated]` : sliced;
      },
    }),

    ctx_pack: tool({
      description: "Create a task-specific context pack from the multi-root evidence index. Use before cross-repo edits, DTO/API changes, or debugging distributed flows.",
      args: {
        task: z.string().min(1).describe("Natural language task description."),
        roots: z.array(z.string()).optional(),
        limit: z.number().int().positive().optional(),
      },
      async execute(args) {
        await ensureIndexReady(store, options);
        const hits = await searchIndex(store, args.task, args.roots, args.limit ?? 12);
        const summary = await store.workspaceSummary();
        const riskHints = inferRisks(args.task, hits.map((hit) => hit.path));
        const pack = {
          task: args.task,
          workspace: summary,
          evidence: hits,
          risks: riskHints,
          suggestedNext: [
            "Inspect the top evidence refs with ctx_read.",
            "If editing contract/DTO/schema files, run impact analysis or ask ctx-impact-analyst first.",
            "After edits, ask ctx-test-router for targeted validation.",
          ],
          generatedAt: new Date().toISOString(),
        };
        const safeName = args.task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "pack";
        await mkdir(path.join(store.stateDirAbs, "packs"), { recursive: true });
        await Bun.write(path.join(store.stateDirAbs, "packs", `${Date.now()}-${safeName}.json`), JSON.stringify(pack, null, 2));
        await store.appendLedger({ type: "context.pack", task: args.task, hits: hits.length, risks: riskHints });
        return JSON.stringify(pack, null, 2);
      },
    }),

    ctx_impact: tool({
      description: "V0.1 lightweight impact analysis for a root:path, symbol, DTO, API, or search phrase. Produces evidence-backed candidate impacts.",
      args: {
        target: z.string().min(1).describe("Target ref or phrase, for example shared:src/types/order.ts or OrderDto."),
        limit: z.number().int().positive().optional(),
      },
      async execute(args) {
        await ensureIndexReady(store, options);
        const hits = await searchIndex(store, args.target, undefined, args.limit ?? 30);
        const risks = inferRisks(args.target, hits.map((hit) => hit.path));
        const roots = Array.from(new Set(hits.map((hit) => hit.root)));
        await store.appendLedger({ type: "impact.analysis", target: args.target, hits: hits.length, roots, risks });
        return JSON.stringify({
          target: args.target,
          roots,
          directEvidence: hits,
          risks,
          unknowns: [
            "V0.1 uses lightweight text/symbol evidence; REST/OpenAPI/proto structural matching arrives in v0.2+.",
            "Low or missing evidence should be confirmed with ctx_read and targeted search.",
          ],
          suggestedNext: ["Create a ctx_pack for the concrete task.", "Delegate to ctx-impact-analyst for edit order.", "Delegate to ctx-test-router after edits."],
        }, null, 2);
      },
    }),
  };
}

async function ensureIndexReady(store: WorkspaceStore, options: ContextBridgeOptions): Promise<void> {
  if (!options.autoIndex) return;
  const roots = await store.listRoots();
  const indexMissing = !existsSync(store.indexPath);
  for (const root of roots) {
    if (indexMissing || root.stale || !root.indexedAt) await indexRoot(store, root);
  }
}

function inferRisks(task: string, paths: string[]): string[] {
  const lower = task.toLowerCase();
  const risks = new Set<string>();
  if (/dto|payload|request|response|schema|type/.test(lower)) risks.add("shared DTO/schema change; check all consumers");
  if (/api|endpoint|route|openapi|grpc|proto|graphql/.test(lower)) risks.add("public network contract change; check provider and consumers");
  if (/cache|redis|ttl|invalidation/.test(lower)) risks.add("cache key or invalidation risk");
  if (/db|database|migration|table|column/.test(lower)) risks.add("database migration/backward compatibility risk");
  if (paths.some((p) => /openapi|\.proto|schema\.graphql|schema\.prisma|migrations\//.test(p))) risks.add("contract file appears in evidence");
  return Array.from(risks);
}
