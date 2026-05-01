import type { PluginInput } from "@opencode-ai/plugin";
import type { ContextBridgeOptions } from "./types.js";
import { WorkspaceStore } from "./state/workspace-store.js";
import { SessionState } from "./state/session-state.js";
import { indexRoot } from "./indexer/light-index.js";
import { log } from "./shared/log.js";

export interface Managers {
  store: WorkspaceStore;
  sessions: SessionState;
}

export async function createManagers(ctx: PluginInput, options: ContextBridgeOptions): Promise<Managers> {
  const store = new WorkspaceStore(ctx, options);
  await store.init();

  if (options.autoIndex) {
    const roots = await store.listRoots();
    for (const root of roots.filter((item) => item.stale || !item.indexedAt)) {
      try {
        await indexRoot(store, root);
      } catch (error) {
        await log(ctx, "warn", "Context Bridge startup indexing failed for root", {
          root: root.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    store,
    sessions: new SessionState(),
  };
}
