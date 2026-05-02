import type { Hooks } from "@opencode-ai/plugin";
import type { WorkspaceStore } from "../state/workspace-store.js";
import { log } from "../shared/log.js";
import { extractPath, markStaleAndQueuePath } from "./reindex.js";

export function createEventHook(store: WorkspaceStore): Pick<Hooks, "event"> {
  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        await store.appendLedger({
          type: "session.created",
          event: event.properties ?? null,
        });
        await log(store.ctx, "info", "Context Bridge session created", {
          manifest: store.manifestPath,
        });
      }

      if (event.type === "file.edited") {
        const file = extractPath(event.properties);
        if (file) {
          await markStaleAndQueuePath(store, file, "file_edited", {
            eventType: event.type,
          });
          await store.appendLedger({ type: "file.edited.event", file });
        }
      }

      if (event.type === "file.watcher.updated") {
        const file = extractPath(event.properties);
        if (file) {
          await markStaleAndQueuePath(store, file, "file_watcher_updated", {
            eventType: event.type,
          });
          await store.appendLedger({ type: "file.watcher.updated.event", file });
        }
      }

      if (event.type === "session.diff") {
        await store.appendLedger({
          type: "session.diff",
          event: event.properties ?? null,
        });
      }

      if (event.type === "session.idle") {
        await store.appendLedger({
          type: "session.idle",
          event: event.properties ?? null,
        });
      }
    },
  };
}
