import { afterAll, expect, test } from "bun:test";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { Database } from "bun:sqlite";
import type { PluginInput } from "@opencode-ai/plugin";
import { DEFAULT_OPTIONS } from "../src/config.ts";
import { indexRoot, indexStaleRoots, ensureIndexReady, readEntries, searchIndex } from "../src/indexer/light-index.ts";
import { WorkspaceStore } from "../src/state/workspace-store.ts";
import { createContextTools } from "../src/tools/context-tools.ts";

const FIXTURE_PARENT = "/tmp/opencode/context-bridge-indexer-fixtures";
const cleanupPaths = new Set<string>();

afterAll(async () => {
  await Promise.all(
    Array.from(cleanupPaths, (target) => rm(target, { recursive: true, force: true })),
  );
});

test("light-index exports stay compatible with legacy callers", async () => {
  const fixture = await setupWorkspace("exports");
  const { store, tools, roots } = fixture;

  expect(typeof indexRoot).toBe("function");
  expect(typeof searchIndex).toBe("function");
  expect(typeof readEntries).toBe("function");
  expect(typeof indexStaleRoots).toBe("function");
  expect(typeof ensureIndexReady).toBe("function");

  const backendIndexRaw = await executeTool(tools, "ctx_index", { root: "backend" });
  const backendIndex = parseJson<Record<string, unknown>>(backendIndexRaw);
  expect(Array.isArray(backendIndex.result)).toBe(true);

  const entries = await readEntries(store.indexPath);
  expect(entries.length).toBeGreaterThan(0);
  expect(entries.some((entry) => hasKeys(entry, ["root", "ref", "path", "kind", "name", "updatedAt"]))).toBe(true);

  const hits = await searchIndex(store, "OrderDto", ["shared", "backend", "frontend"], 10);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.some((hit) => hasKeys(hit, ["root", "ref", "path", "kind", "score", "text"]))).toBe(true);

  await store.markStaleByAbsPath(path.join(fixture.workspaceDir, "shared/src/order.ts"));
  const staleRuns = await indexStaleRoots(store);
  expect(staleRuns.some((item) => item.root === "shared" && item.entries > 0)).toBe(true);

  await store.markStaleByAbsPath(path.join(fixture.workspaceDir, "frontend/src/api/orders.ts"));
  await ensureIndexReady(store);
  const refreshedEntries = await readEntries(store.indexPath);
  expect(refreshedEntries.length).toBeGreaterThan(0);
  expect(roots.some((root) => root.name === "backend")).toBe(true);
});

test("smoke harness covers sqlite evidence, reruns, incremental updates, malformed diagnostics, and tool contracts", async () => {
  const fixture = await setupWorkspace("smoke");
  const { workspaceDir, store, tools, roots } = fixture;
  const backendRoot = getRoot(roots, "backend");
  const frontendRoot = getRoot(roots, "frontend");

  const firstIndex = parseJson<Record<string, unknown>>(await executeTool(tools, "ctx_index", {}));
  expect(Array.isArray(firstIndex.result)).toBe(true);
  expect((firstIndex.result as Array<unknown>).length).toBeGreaterThanOrEqual(4);
  expect(hasKeys(firstIndex.sqlite, ["path", "available", "degraded", "schemaVersion", "diagnostics", "counts"])).toBe(true);
  expect(hasKeys(firstIndex.latestIndexRun, ["id", "reason", "startedAt", "roots", "stats", "diagnostics"])).toBe(true);

  const requiredTables = [
    "roots",
    "files",
    "nodes",
    "edges",
    "spans",
    "unresolved",
    "index_runs",
    "schema_meta",
  ];
  const sqliteSummary = readSQLiteSummary(store.sqlitePath);
  for (const table of requiredTables) {
    expect(sqliteSummary.tables).toContain(table);
    expect(sqliteSummary.counts[table]).toBeGreaterThan(0);
  }

  const firstStableCounts = pickStableCounts(sqliteSummary.counts);
  const firstEntries = await readEntries(store.indexPath);
  expect(firstEntries.length).toBeGreaterThan(0);

  const secondIndex = parseJson<Record<string, unknown>>(await executeTool(tools, "ctx_index", {}));
  expect(Array.isArray(secondIndex.result)).toBe(true);
  const secondSummary = readSQLiteSummary(store.sqlitePath);
  expect(pickStableCounts(secondSummary.counts)).toEqual(firstStableCounts);
  expect(secondSummary.counts.index_runs).toBeGreaterThan(sqliteSummary.counts.index_runs);
  expect((await readEntries(store.indexPath)).length).toBe(firstEntries.length);

  const backendOnlyIndex = parseJson<Record<string, unknown>>(await executeTool(tools, "ctx_index", { root: "backend" }));
  expect(hasKeys(backendOnlyIndex.latestIndexRun, ["id", "reason", "startedAt", "roots", "stats", "diagnostics"])).toBe(true);
  expect(((backendOnlyIndex.latestIndexRun as { stats?: { degraded?: boolean } }).stats?.degraded)).toBe(true);

  const diagnosticsText = await readFile(store.indexerDiagnosticsPath, "utf8");
  expect(diagnosticsText).toContain("tsjs.malformed_brace_balance");
  const degradedRuns = countJsonlMatches(diagnosticsText, "tsjs.malformed_brace_balance");
  expect(degradedRuns).toBeGreaterThan(0);
  expect(countDegradedIndexRuns(store.sqlitePath)).toBeGreaterThan(0);

  const status = parseJson<Record<string, unknown>>(await executeTool(tools, "ctx_status", { ledgerLimit: 5 }));
  expect(status.version).toBe("v0.1");
  expect(hasKeys(status.manifest, ["path", "primary", "roots"])).toBe(true);
  expect(hasKeys(status.index, ["path", "exists", "totalEntries", "countsByKind", "countsByRoot", "staleRoots"])).toBe(true);
  expect(hasKeys(status.sqlite, ["path", "available", "degraded", "schemaVersion", "diagnostics", "counts", "latestIndexRun"])).toBe(true);
  expect(Array.isArray(status.recentLedger)).toBe(true);
  expect(Array.isArray(status.notes)).toBe(true);

  const searchText = await executeTool(tools, "ctx_search", { query: "OrderDto", roots: ["shared", "backend", "frontend"], limit: 8 });
  expect(searchText).toContain("OrderDto");
  expect(searchText).toContain("[symbol]");

  const symbols = parseJson<Record<string, unknown>>(await executeTool(tools, "ctx_symbols", { query: "Order", limit: 8 }));
  expect(symbols.version).toBe("v0.1");
  expect(hasKeys(symbols.filters, ["query", "root", "ref", "limit"])).toBe(true);
  expect(Array.isArray(symbols.symbols)).toBe(true);
  expect(hasKeys(symbols.sqlite, ["path", "available", "degraded", "schemaVersion", "diagnostics", "counts"])).toBe(true);

  const neighbors = parseJson<Record<string, unknown>>(await executeTool(tools, "ctx_neighbors", { target: "frontend:src/api/orders.ts", limit: 8 }));
  expect(neighbors.version).toBe("v0.1");
  expect(neighbors.target).toBe("frontend:src/api/orders.ts");
  expect(Array.isArray(neighbors.directEvidence)).toBe(true);
  expect(Array.isArray(neighbors.neighbors)).toBe(true);
  expect(Array.isArray(neighbors.graphDirectEvidence)).toBe(true);
  expect(Array.isArray(neighbors.graphNeighbors)).toBe(true);
  expect(Array.isArray(neighbors.unknowns)).toBe(true);
  expect(hasKeys(neighbors.sqlite, ["path", "available", "degraded", "schemaVersion", "diagnostics", "counts"])).toBe(true);

  const pack = parseJson<Record<string, unknown>>(await executeTool(tools, "ctx_pack", { task: "Update OrderDto and POST /orders", roots: ["shared", "backend", "frontend"], limit: 8 }));
  expect(pack.task).toBe("Update OrderDto and POST /orders");
  expect(typeof pack.workspace).toBe("string");
  expect(Array.isArray(pack.evidence)).toBe(true);
  expect(typeof pack.graph).toBe("object");
  expect(Array.isArray(pack.evidenceAnchors)).toBe(true);
  expect(Array.isArray(pack.unknowns)).toBe(true);
  expect(Array.isArray(pack.warnings)).toBe(true);
  expect(Array.isArray(pack.risks)).toBe(true);
  expect(Array.isArray(pack.suggestedNext)).toBe(true);
  expect(typeof pack.generatedAt).toBe("string");

  const impact = parseJson<Record<string, unknown>>(await executeTool(tools, "ctx_impact", { target: "OrderDto", limit: 8 }));
  expect(impact.target).toBe("OrderDto");
  expect(Array.isArray(impact.roots)).toBe(true);
  expect(Array.isArray(impact.directEvidence)).toBe(true);
  expect(Array.isArray(impact.graphDirectEvidence)).toBe(true);
  expect(Array.isArray(impact.crossRootEvidence)).toBe(true);
  expect(Array.isArray(impact.unknownEvidence)).toBe(true);
  expect(Array.isArray(impact.testCandidateEvidence)).toBe(true);
  expect(Array.isArray(impact.graphWarnings)).toBe(true);
  expect(Array.isArray(impact.risks)).toBe(true);
  expect(Array.isArray(impact.unknowns)).toBe(true);
  expect(Array.isArray(impact.suggestedNext)).toBe(true);

  const testPlan = parseJson<Record<string, unknown>>(await executeTool(tools, "ctx_test_plan", { target: "OrderDto", limit: 8 }));
  expect(testPlan.version).toBe("v0.1");
  expect(typeof testPlan.disclaimer).toBe("string");
  expect(Array.isArray(testPlan.matchingTests)).toBe(true);
  expect(Array.isArray(testPlan.graphMatchingTests)).toBe(true);
  expect(Array.isArray(testPlan.graphTestEdges)).toBe(true);
  expect(Array.isArray(testPlan.graphUnknowns)).toBe(true);
  expect(Array.isArray(testPlan.graphWarnings)).toBe(true);
  expect(Array.isArray(testPlan.packages)).toBe(true);
  expect(Array.isArray(testPlan.graphPackages)).toBe(true);
  expect(Array.isArray(testPlan.suggestedCommands)).toBe(true);
  expect((testPlan.suggestedCommands as Array<unknown>).some((item) => typeof item === "string" && item.includes("bun"))).toBe(true);

  const refreshMemory = parseJson<Record<string, unknown>>(await executeTool(tools, "ctx_refresh_memory", { task: "Refresh OrderDto evidence", root: "backend", limit: 5 }));
  expect(refreshMemory.version).toBe("v0.1");
  expect(typeof refreshMemory.status).toBe("string");
  expect(typeof refreshMemory.actions).toBe("object");
  expect(Array.isArray(refreshMemory.recommendations)).toBe(true);
  expect(Array.isArray(refreshMemory.notes)).toBe(true);
  expect(refreshMemory.pack).not.toBeNull();

  const readText = await executeTool(tools, "ctx_read", { ref: "shared:src/order.ts", startLine: 1, endLine: 4 });
  expect(readText).toContain("OrderDto");
  expect(readText).toContain("export interface OrderDto");

  const frontendBefore = readFileHash(store.sqlitePath, frontendRoot.name, "src/api/orders.ts");
  const backendBefore = readFileHash(store.sqlitePath, backendRoot.name, "src/orders.ts");
  const frontendFile = path.join(workspaceDir, "frontend/src/api/orders.ts");
  await writeFile(
    frontendFile,
    [
      'import axios from "axios";',
      'import type { OrderDto } from "../../../shared/src/order";',
      "",
      "export async function createOrder(payload: OrderDto) {",
      '  return axios.post("/orders", payload);',
      "}",
      "",
      "export function createOrderPreview(payload: OrderDto) {",
      "  return payload.id;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  const frontendEntries = await indexRoot(store, frontendRoot);
  expect(frontendEntries.length).toBeGreaterThan(0);

  const frontendAfter = readFileHash(store.sqlitePath, frontendRoot.name, "src/api/orders.ts");
  const backendAfter = readFileHash(store.sqlitePath, backendRoot.name, "src/orders.ts");
  expect(frontendAfter).not.toBe(frontendBefore);
  expect(backendAfter).toBe(backendBefore);

  const previewHits = await searchIndex(store, "createOrderPreview", ["frontend"], 5);
  expect(previewHits.some((hit) => hit.text.includes("createOrderPreview") || hit.path === "src/api/orders.ts")).toBe(true);

  const sharedAfterIncremental = await executeTool(tools, "ctx_read", { ref: "shared:src/order.ts", startLine: 1, endLine: 3 });
  expect(sharedAfterIncremental).toContain("OrderDto");

  const scratchDir = path.join(workspaceDir, "scratch");
  await mkdir(scratchDir, { recursive: true });
  const scratchFile = path.join(scratchDir, "a.ts");
  await writeFile(scratchFile, 'export const scratchOnly = "scratchOnly";\n', "utf8");
  const scratchRoot = await store.addRoot("scratch", { name: "scratch", access: "rw", role: "library", tags: ["scratch"] });

  const scratchInitialEntries = await indexRoot(store, scratchRoot);
  expect(scratchInitialEntries.length).toBeGreaterThan(0);
  expect((await readEntries(store.indexPath)).some((entry) => entry.root === scratchRoot.name && entry.path === "a.ts")).toBe(true);
  expect((await searchIndex(store, "a.ts", [scratchRoot.name], 5)).length).toBeGreaterThan(0);

  await rm(scratchFile, { force: true });
  const scratchReplacementEntries = await indexRoot(store, scratchRoot);
  expect(scratchReplacementEntries).toEqual([]);
  expect((await readEntries(store.indexPath)).filter((entry) => entry.root === scratchRoot.name)).toEqual([]);
  expect(await searchIndex(store, "a.ts", [scratchRoot.name], 5)).toEqual([]);

  const staleSharedPath = path.join(workspaceDir, "shared/src/order.ts");
  await store.markStaleByAbsPath(staleSharedPath);
  const staleResult = await indexStaleRoots(store);
  expect(staleResult.some((item) => item.root === "shared" && item.entries > 0)).toBe(true);

  await store.markStaleByAbsPath(frontendFile);
  await ensureIndexReady(store);
  expect(existsSync(store.indexPath)).toBe(true);
});

async function setupWorkspace(label: string): Promise<{
  workspaceDir: string;
  store: WorkspaceStore;
  tools: Record<string, { execute(args: Record<string, unknown>, context?: unknown): Promise<unknown> }>;
  roots: Awaited<ReturnType<WorkspaceStore["listRoots"]>>;
}> {
  const workspaceDir = path.join(FIXTURE_PARENT, `${label}-${Date.now()}-${crypto.randomUUID()}`);
  if (!workspaceDir.startsWith(FIXTURE_PARENT)) {
    throw new Error(`Fixture path escaped required parent: ${workspaceDir}`);
  }
  cleanupPaths.add(workspaceDir);
  await mkdir(FIXTURE_PARENT, { recursive: true });
  await createFixtureFiles(workspaceDir);

  const options = { ...DEFAULT_OPTIONS, autoIndex: false };
  const input = ({
    directory: workspaceDir,
    worktree: workspaceDir,
    sessionID: `task-12-${label}`,
  } as unknown) as PluginInput;
  const store = new WorkspaceStore(input, options);
  await store.init();
  await store.addRoot("backend", { name: "backend", access: "rw", role: "service", tags: ["api"] });
  await store.addRoot("frontend", { name: "frontend", access: "rw", role: "app", tags: ["web"] });
  await store.addRoot("shared", { name: "shared", access: "ro", role: "library", tags: ["types"] });

  const tools = createContextTools(input, store, options) as unknown as Record<string, { execute(args: Record<string, unknown>, context?: unknown): Promise<unknown> }>;
  const roots = await store.listRoots();
  return { workspaceDir, store, tools, roots };
}

async function createFixtureFiles(workspaceDir: string): Promise<void> {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "task-12-workspace",
      private: true,
      scripts: {
        test: "bun test",
        build: "bun run build",
      },
    }, null, 2) + "\n",
    "shared/package.json": JSON.stringify({
      name: "shared",
      private: true,
      scripts: {
        test: "bun test",
      },
    }, null, 2) + "\n",
    "shared/src/order.ts": [
      "export interface OrderDto {",
      "  id: string;",
      "  status: \"draft\" | \"submitted\";",
      "}",
      "",
      "export type OrderEnvelope = { order: OrderDto };",
      "",
    ].join("\n"),
    "backend/package.json": JSON.stringify({
      name: "backend",
      private: true,
      scripts: {
        test: "bun test src/orders.test.ts",
        build: "bun build ./src/orders.ts",
      },
    }, null, 2) + "\n",
    "backend/src/orders.ts": [
      'import type { OrderDto } from "../../shared/src/order";',
      "",
      "export function createOrder(input: OrderDto) {",
      '  return { ...input, status: input.status ?? "draft" };',
      "}",
      "",
    ].join("\n"),
    "backend/src/routes.ts": [
      'import { createOrder } from "./orders";',
      "",
      "declare const app: { post(path: string, handler: (req: { body: unknown }) => unknown): void };",
      'app.post("/orders", (req: { body: unknown }) => createOrder(req.body as never));',
      "",
    ].join("\n"),
    "backend/src/orders.test.ts": [
      'import { describe, expect, test } from "bun:test";',
      'import { createOrder } from "./orders";',
      "",
      'describe("createOrder", () => {',
      '  test("keeps ids", () => {',
      '    expect(createOrder({ id: "1", status: "draft" }).id).toBe("1");',
      "  });",
      "});",
      "",
    ].join("\n"),
    "backend/src/bad.ts": [
      "export function brokenThing() {",
      "  if (true) {",
      "    return { ok: true };",
      "",
    ].join("\n"),
    "frontend/package.json": JSON.stringify({
      name: "frontend",
      private: true,
      scripts: {
        test: "bun test src/api/orders.test.ts",
      },
    }, null, 2) + "\n",
    "frontend/src/api/orders.ts": [
      'import axios from "axios";',
      'import type { OrderDto } from "../../../shared/src/order";',
      "",
      "export async function createOrder(payload: OrderDto) {",
      '  return axios.post("/orders", payload);',
      "}",
      "",
    ].join("\n"),
    "frontend/src/api/orders.test.ts": [
      'import { expect, test } from "bun:test";',
      "",
      'test("placeholder", () => {',
      '  expect(true).toBe(true);',
      "});",
      "",
    ].join("\n"),
  };

  for (const [relPath, contents] of Object.entries(files)) {
    const absPath = path.join(workspaceDir, relPath);
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, contents, "utf8");
  }
}

async function executeTool(
  tools: Record<string, { execute(args: Record<string, unknown>, context?: unknown): Promise<unknown> }>,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const tool = tools[name];
  if (!tool) throw new Error(`Missing tool: ${name}`);
  const result = await tool.execute(args, {});
  if (typeof result !== "string") throw new Error(`Expected string result from ${name}`);
  return result;
}

function parseJson<T>(value: unknown): T {
  if (typeof value !== "string") throw new Error(`Expected JSON string, got ${typeof value}`);
  return JSON.parse(value) as T;
}

function hasKeys(value: unknown, keys: string[]): boolean {
  return typeof value === "object" && value !== null && keys.every((key) => key in (value as Record<string, unknown>));
}

function readSQLiteSummary(sqlitePath: string): { tables: string[]; counts: Record<string, number> } {
  const db = new Database(sqlitePath, { readonly: true, strict: true });
  try {
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
    const counts = Object.fromEntries(
      tables.map((table) => {
        const row = db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
        return [table, row.count];
      }),
    );
    return { tables, counts };
  } finally {
    db.close();
  }
}

function pickStableCounts(counts: Record<string, number>): Record<string, number> {
  const { index_runs: _ignored, ...stable } = counts;
  return stable;
}

function countDegradedIndexRuns(sqlitePath: string): number {
  const db = new Database(sqlitePath, { readonly: true, strict: true });
  try {
    const row = db.query("SELECT COUNT(*) AS count FROM index_runs WHERE stats_json LIKE '%\"degraded\":true%'").get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

function readFileHash(sqlitePath: string, rootName: string, relPath: string): string {
  const db = new Database(sqlitePath, { readonly: true, strict: true });
  try {
    const row = db.query(
      `SELECT f.hash AS hash
       FROM files f
       JOIN roots r ON r.id = f.root_id
       WHERE r.name = $rootName AND f.rel_path = $relPath`,
    ).get({ rootName, relPath }) as { hash: string } | null;
    if (!row) throw new Error(`Missing file hash for ${rootName}:${relPath}`);
    return row.hash;
  } finally {
    db.close();
  }
}

function getRoot<T extends { name: string }>(roots: T[], name: string): T {
  const root = roots.find((candidate) => candidate.name === name);
  if (!root) throw new Error(`Missing root ${name}`);
  return root;
}

function countJsonlMatches(text: string, needle: string): number {
  return text.split("\n").filter((line) => line.includes(needle)).length;
}
