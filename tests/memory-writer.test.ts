import { afterAll, expect, test } from "bun:test";
import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { PluginInput } from "@opencode-ai/plugin";
import { DEFAULT_OPTIONS } from "../src/config.ts";
import { WorkspaceStore } from "../src/state/workspace-store.ts";
import { indexRoot } from "../src/indexer/light-index.ts";
import { openSQLiteIndexStore } from "../src/indexer/sqlite-store.ts";
import { MemoryWriter, computeEvidenceHash } from "../src/indexer/memory/writer.ts";
import { TemplateSummarizer } from "../src/indexer/memory/summarizer-template.ts";

const FIXTURE_PARENT = "/tmp/opencode/context-bridge-memory";
const cleanupPaths = new Set<string>();

afterAll(async () => {
  await Promise.all(Array.from(cleanupPaths, (target) => rm(target, { recursive: true, force: true })));
});

test("memory writer skips rewrite when evidence hash is stable", async () => {
  const fixture = await setupFixture("stable");
  const { store } = fixture;
  await runIndex(fixture);

  const opened = await openSQLiteIndexStore(store.sqlitePath);
  expect(opened.ok).toBe(true);
  if (!opened.ok) return;
  const sqlite = opened.value;
  try {
    const fileHashes = sqlite.readFileHashes();
    expect(fileHashes.ok).toBe(true);
    if (!fileHashes.ok) return;

    const contracts = sqlite.readContracts();
    expect(contracts.ok).toBe(true);
    if (!contracts.ok) return;
    const route = contracts.value.find((entry) => entry.kind === "HTTP_ROUTE");
    expect(route).toBeDefined();
    if (!route) return;

    const writer = new MemoryWriter(new TemplateSummarizer(), {
      contractsDir: store.memoryContractsDir,
      symbolsDir: store.memorySymbolsDir,
      rootsDir: store.memoryRootsDir,
    });

    const evidence = [{ kind: route.kind, ref: `${route.rootName}:${route.relPath}` }];
    const first = await writer.write(sqlite, {
      target: { kind: "CONTRACT", contract: route },
      evidenceRefs: evidence,
      fileHashes: fileHashes.value,
      generatedAt: "2026-05-01T00:00:00Z",
    });
    expect(first.rewritten).toBe(true);

    const second = await writer.write(sqlite, {
      target: { kind: "CONTRACT", contract: route },
      evidenceRefs: evidence,
      fileHashes: fileHashes.value,
      generatedAt: "2026-05-01T00:00:00Z",
    });
    expect(second.rewritten).toBe(false);
    expect(second.evidenceHash).toBe(first.evidenceHash);

    const body = await readFile(first.summaryPath, "utf8");
    expect(body).toContain("evidence_hash:");
    expect(body).toContain("target_id:");
    expect(body).toContain("HTTP_ROUTE");
  } finally {
    sqlite.close();
  }
});

test("evidence hash changes when underlying file hash changes", async () => {
  const fixture = await setupFixture("filehash");
  const { store, workspaceDir } = fixture;
  await runIndex(fixture);

  const opened = await openSQLiteIndexStore(store.sqlitePath);
  expect(opened.ok).toBe(true);
  if (!opened.ok) return;
  const sqlite = opened.value;
  try {
    const beforeHashes = sqlite.readFileHashes();
    expect(beforeHashes.ok).toBe(true);
    if (!beforeHashes.ok) return;

    const ref = [{ kind: "DTO", ref: "shared:src/order.ts" }];
    const beforeHash = computeEvidenceHash("contract:dto:test", ref, beforeHashes.value);

    await writeFile(
      path.join(workspaceDir, "shared/src/order.ts"),
      'export interface OrderDto { id: string; status: "draft"|"submitted"; total: number }\n',
      "utf8",
    );
    const sharedRoot = fixture.roots.find((root) => root.name === "shared");
    if (!sharedRoot) throw new Error("shared root missing");
    sqlite.close();
    await indexRoot(store, sharedRoot);

    const reopened = await openSQLiteIndexStore(store.sqlitePath);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    const sqlite2 = reopened.value;
    try {
      const afterHashes = sqlite2.readFileHashes();
      expect(afterHashes.ok).toBe(true);
      if (!afterHashes.ok) return;
      const afterHash = computeEvidenceHash("contract:dto:test", ref, afterHashes.value);
      expect(afterHash).not.toBe(beforeHash);
    } finally {
      sqlite2.close();
    }
  } catch (error) {
    sqlite.close();
    throw error;
  }
});

interface Fixture {
  workspaceDir: string;
  store: WorkspaceStore;
  roots: Awaited<ReturnType<WorkspaceStore["listRoots"]>>;
}

async function runIndex(fixture: Fixture): Promise<void> {
  for (const root of fixture.roots) await indexRoot(fixture.store, root);
}

async function setupFixture(label: string): Promise<Fixture> {
  const fixtureRoot = path.join(FIXTURE_PARENT, `${label}-${Date.now()}-${crypto.randomUUID()}`);
  if (!fixtureRoot.startsWith(FIXTURE_PARENT)) throw new Error(`fixture path escaped: ${fixtureRoot}`);
  cleanupPaths.add(fixtureRoot);
  await mkdir(FIXTURE_PARENT, { recursive: true });
  const primaryDir = path.join(fixtureRoot, "primary");
  const rootsDir = path.join(fixtureRoot, "roots");
  await mkdir(primaryDir, { recursive: true });
  await writeFixtureFiles(rootsDir);

  const options = { ...DEFAULT_OPTIONS, autoIndex: false };
  const input = ({
    directory: primaryDir,
    worktree: primaryDir,
    sessionID: `memory-${label}`,
  } as unknown) as PluginInput;
  const store = new WorkspaceStore(input, options);
  await store.init();
  await store.addRoot(path.join(rootsDir, "backend"), { name: "backend", access: "rw", role: "service" });
  await store.addRoot(path.join(rootsDir, "frontend"), { name: "frontend", access: "rw", role: "app" });
  await store.addRoot(path.join(rootsDir, "shared"), { name: "shared", access: "ro", role: "library" });
  const roots = (await store.listRoots()).filter((root) => root.name !== "primary");
  return { workspaceDir: rootsDir, store, roots };
}

async function writeFixtureFiles(rootsDir: string): Promise<void> {
  const files: Record<string, string> = {
    "backend/package.json": JSON.stringify({ name: "backend", main: "src/index.ts" }, null, 2) + "\n",
    "backend/src/orders.ts": 'import type { OrderDto } from "../../shared/src/order";\nexport function createOrder(input: OrderDto) { return input; }\n',
    "backend/src/routes.ts": 'import { createOrder } from "./orders";\ndeclare const app: any;\napp.post("/orders", (req: any) => createOrder(req.body));\n',
    "frontend/package.json": JSON.stringify({ name: "frontend" }, null, 2) + "\n",
    "frontend/src/api/orders.ts": 'import axios from "axios";\nimport type { OrderDto } from "../../../shared/src/order";\nexport async function createOrder(p: OrderDto) { return axios.post("/orders", p); }\n',
    "shared/package.json": JSON.stringify({ name: "shared" }, null, 2) + "\n",
    "shared/src/order.ts": 'export interface OrderDto { id: string; status: "draft"|"submitted" }\n',
  };
  for (const [relPath, contents] of Object.entries(files)) {
    const absPath = path.join(rootsDir, relPath);
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, contents, "utf8");
  }
}
