import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { WorkspaceStore } from "../src/state/workspace-store.ts";
import { SessionState } from "../src/state/session-state.ts";
import { createSafetyHooks } from "../src/hooks/safety.ts";
import { createContextTools } from "../src/tools/context-tools.ts";
import {
  copyFixture,
  createPluginInput,
  createTempWorkspace,
  createTestOptions,
  createToolContext,
  removeTempWorkspace,
  writeText,
} from "./utils/plugin-test-utils.ts";

describe("shared interface impact scenario", () => {
  test("collects evidence and gates edits across external roots for OrderDto", async () => {
    const primaryDir = await createTempWorkspace("ctx-impact-primary-");
    const externalFixtureDir = await createTempWorkspace("ctx-impact-fixtures-");
    const fixtureSource = path.resolve(import.meta.dir, "../fixtures/ts-shared-dto");
    const fixtureCopy = path.join(externalFixtureDir, "ts-shared-dto");

    try {
      await copyFixture(fixtureSource, fixtureCopy);
      const options = createTestOptions({ autoIndex: true });
      const input = createPluginInput(primaryDir);
      const store = new WorkspaceStore(input, options);
      await store.init();

      const tools = createContextTools(input, store, options);
      const toolContext = createToolContext(primaryDir);
      const roots = [
        { name: "shared", role: "library", access: "ro", tags: ["types"] },
        { name: "backend", role: "service", access: "rw", tags: ["api"] },
        { name: "frontend", role: "app", access: "rw", tags: ["ui"] },
      ] as const;
      for (const root of roots) {
        await tools.ctx_add_dir.execute(
          {
            path: path.join(fixtureCopy, root.name),
            name: root.name,
            access: root.access,
            role: root.role,
            tags: [...root.tags],
          },
          toolContext,
        );
      }

      const sharedOrderPath = path.join(fixtureCopy, "shared/src/types/order.ts");
      const safety = createSafetyHooks(store, new SessionState());
      await expect(
        safety["tool.execute.before"]!(
          { tool: "edit", sessionID: "test-session", callID: "edit-shared-order" },
          { args: { filePath: sharedOrderPath } },
        ),
      ).rejects.toThrow("read-only");

      await writeText(
        sharedOrderPath,
        `${await readFile(sharedOrderPath, "utf8")}\nexport interface OrderPatch {\n  billingAddress?: string;\n}\n`,
      );
      await store.markStaleByAbsPath(sharedOrderPath);
      const staleShared = (await store.readManifest()).roots.find((root) => root.name === "shared");
      expect(staleShared?.stale).toBe(true);

      const impactRaw = await tools.ctx_impact.execute({ target: "OrderDto", limit: 20 }, toolContext);
      const impact = JSON.parse(String(impactRaw));
      expect(impact.roots).toContain("shared");
      expect(impact.roots).toContain("backend");
      expect(impact.roots).toContain("frontend");
      expect(impact.risks).toContain("shared DTO/schema change; check all consumers");
      expect(
        impact.directEvidence.some(
          (hit: { ref: string }) => hit.ref === "shared:src/types/order.ts",
        ),
      ).toBe(true);
      const refreshedShared = (await store.readManifest()).roots.find((root) => root.name === "shared");
      expect(refreshedShared?.stale).toBe(false);

      const changedShared = await tools.ctx_read.execute(
        { ref: "shared:src/types/order.ts", startLine: 1, endLine: 20 },
        toolContext,
      );
      expect(String(changedShared)).toContain("OrderPatch");
      expect(String(changedShared)).toContain("billingAddress");

      const packRaw = await tools.ctx_pack.execute(
        { task: "OrderDto", roots: ["shared", "backend", "frontend"], limit: 20 },
        toolContext,
      );
      const pack = JSON.parse(String(packRaw));
      expect(pack.evidence.length).toBeGreaterThanOrEqual(3);
      expect(pack.workspace).toContain("shared:");
      expect(pack.workspace).toContain("backend:");
      expect(pack.workspace).toContain("frontend:");

      const packDir = path.join(primaryDir, ".opencode/context-bridge-test/packs");
      const packFiles = await readdir(packDir);
      expect(packFiles.some((file) => file.endsWith("-orderdto.json"))).toBe(true);
    } finally {
      await removeTempWorkspace(primaryDir);
      await removeTempWorkspace(externalFixtureDir);
    }
  });
});
