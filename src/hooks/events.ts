import path from "node:path";
import type { Hooks } from "@opencode-ai/plugin";
import type { WorkspaceStore } from "../state/workspace-store.js";
import { log } from "../shared/log.js";

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
          const abs = path.isAbsolute(file)
            ? file
            : path.resolve(store.ctx.directory, file);
          await store.markStaleByAbsPath(abs);
          await store.appendLedger({ type: "file.edited.event", file });
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

function extractPath(properties: unknown): string | undefined {
  if (typeof properties !== "object" || properties === null) return undefined;
  const record = properties as Record<string, unknown>;
  for (const key of ["path", "file", "filePath", "filename"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return undefined;
}
