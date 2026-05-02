import { afterAll, expect, test } from "bun:test";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { PluginInput } from "@opencode-ai/plugin";
import { DEFAULT_OPTIONS } from "../src/config.ts";
import { WorkspaceStore } from "../src/state/workspace-store.ts";
import { indexRoot } from "../src/indexer/light-index.ts";
import {
  appendImpactLedger,
  hasRecentImpact,
  recordEdit,
  recordPendingValidation,
  recordValidationSatisfaction,
  syncStaleSummaries,
  type ImpactLedgerEntry,
  type TouchedNodesFile,
} from "../src/state/edit-state.ts";

const FIXTURE_PARENT = "/tmp/opencode/context-bridge-edit-state";
const cleanupPaths = new Set<string>();

afterAll(async () => {
  await Promise.all(Array.from(cleanupPaths, (target) => rm(target, { recursive: true, force: true })));
});

test("recordEdit upserts touched_nodes.json atomically", async () => {
  const fixture = await setupFixture("touched");
  const { store, workspaceDir, roots } = fixture;
  for (const root of roots) await indexRoot(store, root);

  const file = path.join(workspaceDir, "shared/src/order.ts");
  await recordEdit({ store, sessionID: "abc", tool: "edit", absPath: file });
  await recordEdit({ store, sessionID: "abc", tool: "write", absPath: file });

  expect(existsSync(store.touchedNodesPath)).toBe(true);
  const text = await readFile(store.touchedNodesPath, "utf8");
  const parsed = JSON.parse(text) as TouchedNodesFile;
  expect(parsed.sessions.abc).toBeDefined();
  const refs = parsed.sessions.abc.refs;
  expect(refs.length).toBe(1);
  expect(refs[0].ref).toBe("shared:src/order.ts");
  expect(refs[0].tools.sort()).toEqual(["edit", "write"]);
  expect(refs[0].nodeIds.length).toBeGreaterThan(0);
});

test("pending validations append in order and satisfaction rows are recorded", async () => {
  const fixture = await setupFixture("pending");
  const { store } = fixture;

  await recordPendingValidation(store, {
    at: "2026-05-01T00:00:00Z",
    sessionID: "s1",
    ref: "backend:src/orders.ts",
    kind: "test",
    reason: "contract_edited:contract:http_route:abc",
  });
  await recordValidationSatisfaction(store, {
    sessionID: "s1",
    tool: "bash",
    command: "bun test",
    kind: "test",
  });

  const text = await readFile(store.pendingValidationsPath, "utf8");
  const lines = text.trim().split("\n").filter(Boolean);
  expect(lines.length).toBe(2);
  const first = JSON.parse(lines[0]);
  const second = JSON.parse(lines[1]);
  expect(first.kind).toBe("test");
  expect(first.reason).toContain("contract_edited");
  expect(second.satisfiedBy).toBe("bun test");
});

test("hasRecentImpact respects window and contract id filters", async () => {
  const fixture = await setupFixture("impact");
  const { store } = fixture;
  const now = new Date();

  const entry: ImpactLedgerEntry = {
    at: now.toISOString(),
    sessionID: "session-1",
    target: "OrderDto",
    contractIds: ["contract:dto:abc"],
    requiredGates: [{ kind: "test" }],
    evidenceCounts: { direct: 2, crossRoot: 1, unknown: 0 },
  };
  await appendImpactLedger(store, entry);

  expect(await hasRecentImpact(store, { sessionID: "session-1", contractIds: ["contract:dto:abc"], withinSeconds: 600 })).toBe(true);
  expect(await hasRecentImpact(store, { sessionID: "session-2", contractIds: ["contract:dto:abc"], withinSeconds: 600 })).toBe(false);
  expect(await hasRecentImpact(store, { sessionID: "session-1", contractIds: ["contract:dto:other"], withinSeconds: 600 })).toBe(false);

  const old: ImpactLedgerEntry = {
    ...entry,
    at: new Date(Date.now() - 700 * 1000).toISOString(),
    contractIds: ["contract:dto:old"],
  };
  await appendImpactLedger(store, old);
  expect(await hasRecentImpact(store, { sessionID: "session-1", contractIds: ["contract:dto:old"], withinSeconds: 600 })).toBe(false);
});

test("syncStaleSummaries mirrors SQLite stale state into stale_summaries.json", async () => {
  const fixture = await setupFixture("stale");
  const { store, roots, workspaceDir } = fixture;
  for (const root of roots) await indexRoot(store, root);

  // Mark a shared file's summaries stale via the workspace API.
  const sharedFile = path.join(workspaceDir, "shared/src/order.ts");
  await store.markSummariesStaleByAbsPath(sharedFile);
  await syncStaleSummaries(store);

  expect(existsSync(store.staleSummariesPath)).toBe(true);
  const parsed = JSON.parse(await readFile(store.staleSummariesPath, "utf8")) as { entries: unknown[] };
  expect(Array.isArray(parsed.entries)).toBe(true);
});

interface Fixture {
  workspaceDir: string;
  store: WorkspaceStore;
  roots: Awaited<ReturnType<WorkspaceStore["listRoots"]>>;
}

async function setupFixture(label: string): Promise<Fixture> {
  const fixtureRoot = path.join(FIXTURE_PARENT, `${label}-${Date.now()}-${crypto.randomUUID()}`);
  if (!fixtureRoot.startsWith(FIXTURE_PARENT)) throw new Error(`fixture path escaped: ${fixtureRoot}`);
  cleanupPaths.add(fixtureRoot);
  await mkdir(FIXTURE_PARENT, { recursive: true });
  const primaryDir = path.join(fixtureRoot, "primary");
  const rootsDir = path.join(fixtureRoot, "roots");
  await mkdir(primaryDir, { recursive: true });
  await writeMinimalFixture(rootsDir);

  const options = { ...DEFAULT_OPTIONS, autoIndex: false };
  const input = ({
    directory: primaryDir,
    worktree: primaryDir,
    sessionID: `edit-${label}`,
  } as unknown) as PluginInput;
  const store = new WorkspaceStore(input, options);
  await store.init();
  await store.addRoot(path.join(rootsDir, "backend"), { name: "backend", access: "rw", role: "service" });
  await store.addRoot(path.join(rootsDir, "shared"), { name: "shared", access: "ro", role: "library" });
  const roots = (await store.listRoots()).filter((root) => root.name !== "primary");
  return { workspaceDir: rootsDir, store, roots };
}

async function writeMinimalFixture(rootsDir: string): Promise<void> {
  const files: Record<string, string> = {
    "backend/package.json": JSON.stringify({ name: "backend", main: "src/index.ts" }, null, 2) + "\n",
    "backend/src/orders.ts": 'export function createOrder(){ return 1; }\n',
    "shared/package.json": JSON.stringify({ name: "shared" }, null, 2) + "\n",
    "shared/src/order.ts": 'export interface OrderDto { id: string }\n',
  };
  for (const [relPath, contents] of Object.entries(files)) {
    const absPath = path.join(rootsDir, relPath);
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, contents, "utf8");
  }
}
