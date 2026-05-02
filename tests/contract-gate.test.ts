import { afterAll, expect, test } from "bun:test";
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import type { PluginInput } from "@opencode-ai/plugin";
import { DEFAULT_OPTIONS } from "../src/config.ts";
import { WorkspaceStore } from "../src/state/workspace-store.ts";
import { SessionState } from "../src/state/session-state.ts";
import { indexRoot } from "../src/indexer/light-index.ts";
import { createContractGateHooks } from "../src/hooks/contract-gate.ts";
import { appendImpactLedger } from "../src/state/edit-state.ts";

const FIXTURE_PARENT = "/tmp/opencode/context-bridge-contract-gate";
const cleanupPaths = new Set<string>();

afterAll(async () => {
  await Promise.all(Array.from(cleanupPaths, (target) => rm(target, { recursive: true, force: true })));
});

test("read-only root edit is blocked first", async () => {
  const fixture = await setupFixture("ro");
  const { store, sessions, workspaceDir, roots } = fixture;
  for (const root of roots) await indexRoot(store, root);

  const hooks = createContractGateHooks(store, sessions);
  const before = hooks["tool.execute.before"];
  if (!before) throw new Error("missing before hook");

  const target = path.join(workspaceDir, "shared/src/order.ts");
  await expect(
    invokeBefore(before, "edit", { sessionID: "s1" }, { filePath: target }),
  ).rejects.toThrow(/read-only/);
});

test("contract edit blocks without recent impact analysis when enforcement is on", async () => {
  const fixture = await setupFixture("enforce", { enforceImpactBeforeContractEdit: true });
  const { store, sessions, workspaceDir, roots } = fixture;
  for (const root of roots) await indexRoot(store, root);

  const hooks = createContractGateHooks(store, sessions);
  const before = hooks["tool.execute.before"];
  if (!before) throw new Error("missing before hook");

  const routesFile = path.join(workspaceDir, "backend/src/routes.ts");
  await expect(
    invokeBefore(before, "edit", { sessionID: "s2" }, { filePath: routesFile }),
  ).rejects.toThrow(/contract edit/);
});

test("contract edit allowed after a recent impact ledger entry covering its contract", async () => {
  const fixture = await setupFixture("allow", { enforceImpactBeforeContractEdit: true });
  const { store, sessions, workspaceDir, roots } = fixture;
  for (const root of roots) await indexRoot(store, root);

  const contractIds = await store.contractIdsForAbsPath(path.join(workspaceDir, "backend/src/routes.ts"));
  expect(contractIds.length).toBeGreaterThan(0);

  await appendImpactLedger(store, {
    at: new Date().toISOString(),
    sessionID: "s3",
    target: "POST /orders",
    contractIds,
    requiredGates: [{ kind: "test" }],
    evidenceCounts: { direct: 1, crossRoot: 0, unknown: 0 },
  });

  const hooks = createContractGateHooks(store, sessions);
  const before = hooks["tool.execute.before"];
  if (!before) throw new Error("missing before hook");

  const routesFile = path.join(workspaceDir, "backend/src/routes.ts");
  await invokeBefore(before, "edit", { sessionID: "s3" }, { filePath: routesFile });
});

interface Fixture {
  workspaceDir: string;
  store: WorkspaceStore;
  sessions: SessionState;
  roots: Awaited<ReturnType<WorkspaceStore["listRoots"]>>;
}

async function setupFixture(label: string, optionOverrides: Partial<typeof DEFAULT_OPTIONS> = {}): Promise<Fixture> {
  const fixtureRoot = path.join(FIXTURE_PARENT, `${label}-${Date.now()}-${crypto.randomUUID()}`);
  if (!fixtureRoot.startsWith(FIXTURE_PARENT)) throw new Error(`fixture path escaped: ${fixtureRoot}`);
  cleanupPaths.add(fixtureRoot);
  await mkdir(FIXTURE_PARENT, { recursive: true });
  const primaryDir = path.join(fixtureRoot, "primary");
  const rootsDir = path.join(fixtureRoot, "roots");
  await mkdir(primaryDir, { recursive: true });
  await writeFixture(rootsDir);

  const options = { ...DEFAULT_OPTIONS, autoIndex: false, ...optionOverrides };
  const input = ({
    directory: primaryDir,
    worktree: primaryDir,
    sessionID: `gate-${label}`,
  } as unknown) as PluginInput;
  const store = new WorkspaceStore(input, options);
  await store.init();
  await store.addRoot(path.join(rootsDir, "backend"), { name: "backend", access: "rw", role: "service" });
  await store.addRoot(path.join(rootsDir, "shared"), { name: "shared", access: "ro", role: "library" });
  const roots = (await store.listRoots()).filter((root) => root.name !== "primary");
  const sessions = new SessionState();
  return { workspaceDir: rootsDir, store, sessions, roots };
}

async function writeFixture(rootsDir: string): Promise<void> {
  const files: Record<string, string> = {
    "backend/package.json": JSON.stringify({ name: "backend", main: "src/index.ts" }, null, 2) + "\n",
    "backend/src/orders.ts": 'import type { OrderDto } from "../../shared/src/order";\nexport function createOrder(input: OrderDto) { return input; }\n',
    "backend/src/routes.ts": 'import { createOrder } from "./orders";\ndeclare const app: any;\napp.post("/orders", (req: any) => createOrder(req.body));\n',
    "shared/package.json": JSON.stringify({ name: "shared" }, null, 2) + "\n",
    "shared/src/order.ts": 'export interface OrderDto { id: string }\n',
  };
  for (const [relPath, contents] of Object.entries(files)) {
    const absPath = path.join(rootsDir, relPath);
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, contents, "utf8");
  }
}

type BeforeHook = NonNullable<ReturnType<typeof createContractGateHooks>["tool.execute.before"]>;

async function invokeBefore(
  hook: BeforeHook,
  tool: string,
  meta: { sessionID: string },
  args: Record<string, unknown>,
): Promise<void> {
  await hook(
    { tool, sessionID: meta.sessionID, args } as unknown as Parameters<BeforeHook>[0],
    { args } as unknown as Parameters<BeforeHook>[1],
  );
}
