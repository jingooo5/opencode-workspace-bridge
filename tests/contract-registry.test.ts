import { afterAll, expect, test } from "bun:test";
import path from "node:path";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { Database } from "bun:sqlite";
import type { PluginInput } from "@opencode-ai/plugin";
import { DEFAULT_OPTIONS } from "../src/config.ts";
import { WorkspaceStore } from "../src/state/workspace-store.ts";
import { indexRoot } from "../src/indexer/light-index.ts";

const FIXTURE_PARENT = "/tmp/opencode/context-bridge-contracts-fixtures";
const cleanupPaths = new Set<string>();

afterAll(async () => {
  await Promise.all(
    Array.from(cleanupPaths, (target) => rm(target, { recursive: true, force: true })),
  );
});

test("contract registry promotes routes, exposed DTOs, and contract glob files", async () => {
  const fixture = await setupFixture("registry");
  const { store, roots } = fixture;

  for (const root of roots) await indexRoot(store, root);

  const summary = readSqliteContracts(store.sqlitePath);
  expect(summary.contracts.length).toBeGreaterThan(0);

  const routeContract = summary.contracts.find((row) => row.kind === "HTTP_ROUTE" && row.name.includes("POST /orders"));
  expect(routeContract).toBeDefined();
  expect(routeContract?.signature_hash.length).toBeGreaterThan(0);
  expect(routeContract?.generated_yaml_path).toBeTruthy();

  const dtoContract = summary.contracts.find((row) => row.kind === "DTO" && row.name === "OrderDto");
  expect(dtoContract).toBeDefined();
  expect(dtoContract?.signature_hash.length).toBeGreaterThan(0);

  const contractFile = summary.contracts.find((row) => row.kind === "CONTRACT_FILE" && row.name === "openapi.yaml");
  expect(contractFile).toBeDefined();

  expect(summary.consumers.some((row) => row.contract_id === routeContract?.id)).toBe(true);

  const yamlFiles = await readdir(store.contractsGeneratedDir);
  expect(yamlFiles.length).toBeGreaterThan(0);
  expect(yamlFiles.every((file) => file.endsWith(".yaml"))).toBe(true);
  if (routeContract?.generated_yaml_path) {
    const yamlText = await readFile(routeContract.generated_yaml_path, "utf8");
    expect(yamlText).toContain("kind: HTTP_ROUTE");
    expect(yamlText).toContain("POST /orders");
    expect(yamlText).toContain("signature_hash:");
    expect(yamlText).toContain("consumers:");
  }
});

test("contract registry rebuild is deterministic and prunes removed contracts", async () => {
  const fixture = await setupFixture("rebuild");
  const { store, roots, workspaceDir } = fixture;
  for (const root of roots) await indexRoot(store, root);

  const firstYaml = await readdir(store.contractsGeneratedDir);
  const firstSummary = readSqliteContracts(store.sqlitePath);

  // Re-index without modification — counts and signature hashes must be stable.
  for (const root of roots) await indexRoot(store, root);
  const secondSummary = readSqliteContracts(store.sqlitePath);
  const secondYaml = await readdir(store.contractsGeneratedDir);

  expect(secondYaml.sort()).toEqual(firstYaml.sort());
  expect(secondSummary.contracts.map((row) => row.id).sort()).toEqual(firstSummary.contracts.map((row) => row.id).sort());
  for (const contract of secondSummary.contracts) {
    const previous = firstSummary.contracts.find((row) => row.id === contract.id);
    expect(previous?.signature_hash).toBe(contract.signature_hash);
  }

  // Remove the route file and re-index its root — the route contract should disappear.
  const backendRoot = roots.find((root) => root.name === "backend");
  if (!backendRoot) throw new Error("backend root missing");
  await rm(path.join(workspaceDir, "backend/src/routes.ts"), { force: true });
  await indexRoot(store, backendRoot);

  const finalSummary = readSqliteContracts(store.sqlitePath);
  const removedRouteStillPresent = finalSummary.contracts.some(
    (row) => row.kind === "HTTP_ROUTE" && row.name.includes("POST /orders"),
  );
  expect(removedRouteStillPresent).toBe(false);
});

async function setupFixture(label: string): Promise<{
  workspaceDir: string;
  store: WorkspaceStore;
  roots: Awaited<ReturnType<WorkspaceStore["listRoots"]>>;
}> {
  const fixtureRoot = path.join(FIXTURE_PARENT, `${label}-${Date.now()}-${crypto.randomUUID()}`);
  if (!fixtureRoot.startsWith(FIXTURE_PARENT)) throw new Error(`fixture path escaped: ${fixtureRoot}`);
  cleanupPaths.add(fixtureRoot);
  await mkdir(FIXTURE_PARENT, { recursive: true });
  // Keep the OpenCode primary directory separate from the sub-roots to avoid
  // double-indexing the same files (which would make the resolver flag every
  // route ↔ client match as ambiguous).
  const primaryDir = path.join(fixtureRoot, "primary");
  const rootsDir = path.join(fixtureRoot, "roots");
  await mkdir(primaryDir, { recursive: true });
  await writeFixture(rootsDir);

  const options = { ...DEFAULT_OPTIONS, autoIndex: false };
  const input = ({
    directory: primaryDir,
    worktree: primaryDir,
    sessionID: `contract-${label}`,
  } as unknown) as PluginInput;
  const store = new WorkspaceStore(input, options);
  await store.init();
  await store.addRoot(path.join(rootsDir, "backend"), { name: "backend", access: "rw", role: "service", tags: ["api"] });
  await store.addRoot(path.join(rootsDir, "frontend"), { name: "frontend", access: "rw", role: "app", tags: ["web"] });
  await store.addRoot(path.join(rootsDir, "shared"), { name: "shared", access: "ro", role: "library", tags: ["types"] });
  const roots = (await store.listRoots()).filter((root) => root.name !== "primary");
  return { workspaceDir: rootsDir, store, roots };
}

async function writeFixture(workspaceDir: string): Promise<void> {
  const files: Record<string, string> = {
    "backend/package.json": JSON.stringify({
      name: "backend",
      private: true,
      main: "src/index.ts",
      scripts: { test: "bun test" },
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
    "backend/openapi.yaml": [
      "openapi: 3.0.0",
      "paths:",
      "  /orders:",
      "    post:",
      "      summary: Create order",
      "",
    ].join("\n"),
    "shared/package.json": JSON.stringify({
      name: "shared",
      private: true,
    }, null, 2) + "\n",
    "shared/src/order.ts": [
      "export interface OrderDto {",
      "  id: string;",
      "  status: \"draft\" | \"submitted\";",
      "}",
      "",
    ].join("\n"),
    "frontend/package.json": JSON.stringify({
      name: "frontend",
      private: true,
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
  };

  for (const [relPath, contents] of Object.entries(files)) {
    const absPath = path.join(workspaceDir, relPath);
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, contents, "utf8");
  }
}

function readSqliteContracts(sqlitePath: string): {
  contracts: Array<{
    id: string;
    kind: string;
    name: string;
    signature_hash: string;
    generated_yaml_path: string | null;
  }>;
  consumers: Array<{ contract_id: string; consumer_node_id: string }>;
} {
  const db = new Database(sqlitePath, { readonly: true, strict: true });
  try {
    const contracts = db.query("SELECT id, kind, name, signature_hash, generated_yaml_path FROM contracts").all() as Array<{
      id: string;
      kind: string;
      name: string;
      signature_hash: string;
      generated_yaml_path: string | null;
    }>;
    const consumers = db.query("SELECT contract_id, consumer_node_id FROM contract_consumers").all() as Array<{
      contract_id: string;
      consumer_node_id: string;
    }>;
    return { contracts, consumers };
  } finally {
    db.close();
  }
}
