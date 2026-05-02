import path from "node:path";
import { describe, expect, test } from "bun:test";
import { WorkspaceStore } from "../src/state/workspace-store.ts";
import { readEntries } from "../src/indexer/light-index.ts";
import { getContextBridgeAgentSpecs } from "../src/agents/agent-configs.ts";
import { createContextTools } from "../src/tools/context-tools.ts";
import {
  createPluginInput,
  createTempWorkspace,
  createTestOptions,
  createToolContext,
  removeTempWorkspace,
  writeText,
} from "./utils/plugin-test-utils.ts";

describe("ctx_* tool scenario", () => {
  test("adds a service root, auto-indexes it, searches evidence, reads refs, and suggests tests", async () => {
    const primaryDir = await createTempWorkspace("ctx-tools-primary-");
    const backendDir = await createTempWorkspace("ctx-tools-backend-");

    try {
      await writeText(
        path.join(backendDir, "package.json"),
        JSON.stringify({ name: "@fixture/backend", scripts: { test: "bun test" } }, null, 2),
      );
      await writeText(
        path.join(backendDir, "src/routes/orders.ts"),
        [
          "export interface OrderDto { id: string; total: number }",
          "export function createOrder(body: OrderDto) { return body; }",
          "router.post(\"/orders\", createOrder);",
          "",
        ].join("\n"),
      );
      await writeText(
        path.join(backendDir, "tests/orders.test.ts"),
        "import { test } from 'bun:test';\ntest('orders', () => {});\n",
      );

      const options = createTestOptions({ autoIndex: true });
      const input = createPluginInput(primaryDir);
      const store = new WorkspaceStore(input, options);
      await store.init();

      const tools = createContextTools(input, store, options);
      const toolContext = createToolContext(primaryDir);
      const addedRaw = await tools.ctx_add_dir.execute(
        {
          path: backendDir,
          name: "backend",
          access: "rw",
          role: "service",
          tags: ["api"],
        },
        toolContext,
      );
      const added = JSON.parse(String(addedRaw));
      expect(added.added.name).toBe("backend");

      const entries = await readEntries(store.indexPath);
      expect(entries.some((entry) => entry.root === "backend" && entry.kind === "package")).toBe(true);
      expect(entries.some((entry) => entry.kind === "symbol" && entry.name === "OrderDto")).toBe(true);
      expect(entries.some((entry) => entry.kind === "route" && entry.name === "POST /orders")).toBe(true);
      expect(entries.some((entry) => entry.kind === "test" && entry.path === "tests/orders.test.ts")).toBe(true);

      const searchRaw = await tools.ctx_search.execute({ query: "OrderDto", roots: ["backend"], limit: 5 }, toolContext);
      expect(String(searchRaw)).toContain("backend:src/routes/orders.ts");

      const readRaw = await tools.ctx_read.execute(
        { ref: "backend:src/routes/orders.ts", startLine: 1, endLine: 2 },
        toolContext,
      );
      expect(String(readRaw)).toContain("OrderDto");
      expect(String(readRaw)).not.toContain("router.post");

      const planRaw = await tools.ctx_test_plan.execute({ target: "orders", root: "backend" }, toolContext);
      const plan = JSON.parse(String(planRaw));
      expect(plan.suggestedCommands).toContain("bun test tests/orders.test.ts");

      const validationRunner = getContextBridgeAgentSpecs().find(
        (agent) => agent.name === "ctx-validation-runner",
      );
      const bashPermission = validationRunner?.permission.bash;
      expect(bashPermission).toMatchObject({
        "bun test*": "allow",
        "bun run test*": "allow",
        "bun --cwd * run test*": "allow",
      });
    } finally {
      await removeTempWorkspace(primaryDir);
      await removeTempWorkspace(backendDir);
    }
  });
});
