import { afterAll, expect, test } from "bun:test";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { PluginInput } from "@opencode-ai/plugin";
import { DEFAULT_OPTIONS } from "../src/config.ts";
import { WorkspaceStore } from "../src/state/workspace-store.ts";
import { indexRoot } from "../src/indexer/light-index.ts";
import { createContextTools } from "../src/tools/context-tools.ts";

const FIXTURE_PARENT = "/tmp/opencode/context-bridge-pack-impact";
const cleanupPaths = new Set<string>();

afterAll(async () => {
  await Promise.all(Array.from(cleanupPaths, (target) => rm(target, { recursive: true, force: true })));
});

test("ctx_pack output includes contracts, memory, editFocus, suggestedEditOrder, and writes a markdown sibling", async () => {
  const fixture = await setupFixture("pack");
  const { store, roots, tools } = fixture;
  for (const root of roots) await indexRoot(store, root);

  await tools.ctx_summarize.execute({}, { sessionID: "s-pack" });

  const result = await tools.ctx_pack.execute({ task: "POST /orders contract update", roots: ["backend", "frontend"] }, { sessionID: "s-pack" });
  expect(typeof result).toBe("string");
  const json = JSON.parse(result as string) as Record<string, unknown>;
  expect(Array.isArray(json.contracts)).toBe(true);
  expect((json.contracts as unknown[]).length).toBeGreaterThan(0);
  expect(Array.isArray(json.memory)).toBe(true);
  expect((json.memory as unknown[]).length).toBeGreaterThan(0);
  expect(typeof json.editFocus).toBe("object");
  expect(Array.isArray(json.suggestedEditOrder)).toBe(true);
  expect((json.suggestedEditOrder as string[]).length).toBeGreaterThan(0);

  // Confirm the .md sibling exists.
  const packsDir = store.packsDir;
  const files = await readdirSafe(packsDir);
  expect(files.some((file) => file.endsWith(".md"))).toBe(true);
  const mdFile = files.find((file) => file.endsWith(".md"));
  if (mdFile) {
    const mdContent = await readFile(path.join(packsDir, mdFile), "utf8");
    expect(mdContent).toContain("Context Pack");
    expect(mdContent).toContain("Active contracts");
  }
});

test("ctx_impact emits requiredGates, contractIds, and appends to impact_ledger.jsonl", async () => {
  const fixture = await setupFixture("impact");
  const { store, roots, tools } = fixture;
  for (const root of roots) await indexRoot(store, root);

  const result = await tools.ctx_impact.execute({ target: "POST /orders" }, { sessionID: "s-impact" });
  const json = JSON.parse(result as string) as Record<string, unknown>;
  expect(Array.isArray(json.requiredGates)).toBe(true);
  expect((json.requiredGates as unknown[]).length).toBeGreaterThan(0);
  expect(Array.isArray(json.contractIds)).toBe(true);
  expect((json.contractIds as string[]).length).toBeGreaterThan(0);
  expect(Array.isArray(json.pendingGates)).toBe(true);

  expect(existsSync(store.impactLedgerPath)).toBe(true);
  const ledgerText = await readFile(store.impactLedgerPath, "utf8");
  const lines = ledgerText.trim().split("\n").filter(Boolean);
  expect(lines.length).toBeGreaterThan(0);
  const last = JSON.parse(lines[lines.length - 1]);
  expect(last.target).toBe("POST /orders");
  expect(Array.isArray(last.contractIds)).toBe(true);
});

interface Fixture {
  workspaceDir: string;
  store: WorkspaceStore;
  roots: Awaited<ReturnType<WorkspaceStore["listRoots"]>>;
  tools: Record<string, { execute(args: Record<string, unknown>, context?: unknown): Promise<unknown> }>;
}

async function setupFixture(label: string): Promise<Fixture> {
  const fixtureRoot = path.join(FIXTURE_PARENT, `${label}-${Date.now()}-${crypto.randomUUID()}`);
  if (!fixtureRoot.startsWith(FIXTURE_PARENT)) throw new Error(`fixture path escaped: ${fixtureRoot}`);
  cleanupPaths.add(fixtureRoot);
  await mkdir(FIXTURE_PARENT, { recursive: true });
  const primaryDir = path.join(fixtureRoot, "primary");
  const rootsDir = path.join(fixtureRoot, "roots");
  await mkdir(primaryDir, { recursive: true });
  await writeFixture(rootsDir);

  const options = { ...DEFAULT_OPTIONS, autoIndex: false };
  const input = ({
    directory: primaryDir,
    worktree: primaryDir,
    sessionID: `pack-${label}`,
  } as unknown) as PluginInput;
  const store = new WorkspaceStore(input, options);
  await store.init();
  await store.addRoot(path.join(rootsDir, "backend"), { name: "backend", access: "rw", role: "service" });
  await store.addRoot(path.join(rootsDir, "frontend"), { name: "frontend", access: "rw", role: "app" });
  await store.addRoot(path.join(rootsDir, "shared"), { name: "shared", access: "ro", role: "library" });
  const roots = (await store.listRoots()).filter((root) => root.name !== "primary");
  const tools = createContextTools(input, store, options) as unknown as Fixture["tools"];
  return { workspaceDir: rootsDir, store, roots, tools };
}

async function writeFixture(rootsDir: string): Promise<void> {
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

async function readdirSafe(dir: string): Promise<string[]> {
  const fs = await import("node:fs/promises");
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}
