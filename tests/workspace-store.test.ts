import path from "node:path";
import { describe, expect, test } from "bun:test";
import { WorkspaceStore } from "../src/state/workspace-store.ts";
import {
  createPluginInput,
  createTempWorkspace,
  createTestOptions,
  removeTempWorkspace,
  writeText,
} from "./utils/plugin-test-utils.ts";

describe("WorkspaceStore scenario", () => {
  test("tracks roots, root refs, policies, indexing state, and ledger entries", async () => {
    const primaryDir = await createTempWorkspace("ctx-store-primary-");
    const sharedDir = await createTempWorkspace("ctx-store-shared-");

    try {
      await writeText(
        path.join(sharedDir, "src/types/order.ts"),
        "export interface OrderDto { id: string; total: number }\n",
      );
      await writeText(path.join(sharedDir, ".env"), "TOKEN=secret\n");

      const options = createTestOptions({
        contractGlobs: ["src/types/*", "schema.prisma"],
      });
      const store = new WorkspaceStore(createPluginInput(primaryDir), options);
      await store.init();

      const shared = await store.addRoot(sharedDir, {
        name: "shared",
        access: "ro",
        role: "library",
        tags: ["types"],
      });

      const manifest = await store.readManifest();
      expect(manifest.primary.name).toBe("primary");
      expect(manifest.roots.map((root) => root.name)).toContain("shared");
      expect(shared.access).toBe("ro");
      expect(shared.stale).toBe(true);

      const resolved = await store.resolveRef("shared:src/types/order.ts");
      expect(resolved?.absPath).toBe(path.join(sharedDir, "src/types/order.ts"));
      expect(await store.resolveRef("shared:../outside.ts")).toBeUndefined();

      expect(await store.isSecretPath(path.join(sharedDir, ".env"))).toBe(true);
      expect(await store.isContractPath(path.join(sharedDir, "src/types/order.ts"))).toBe(true);

      await store.markIndexed("shared");
      const indexed = (await store.readManifest()).roots.find((root) => root.name === "shared");
      expect(indexed?.stale).toBe(false);
      expect(indexed?.indexedAt).toBeString();

      const summary = await store.workspaceSummary();
      expect(summary).toContain("shared:");
      expect(summary).toContain("indexed");

      const ledger = await store.recentLedger();
      expect(ledger.some((line) => line.includes('"type":"root.added"'))).toBe(true);
    } finally {
      await removeTempWorkspace(primaryDir);
      await removeTempWorkspace(sharedDir);
    }
  });
});
