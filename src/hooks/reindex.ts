import path from "node:path";
import type { WorkspaceStore } from "../state/workspace-store.js";
import { log } from "../shared/log.js";

export interface ReindexHookMeta {
  eventType?: string;
  sessionID?: string;
  sourceTool?: string;
}

export async function markStaleAndQueuePath(
  store: WorkspaceStore,
  candidatePath: string,
  reason: string,
  meta: ReindexHookMeta = {},
): Promise<void> {
  const absPath = path.isAbsolute(candidatePath)
    ? candidatePath
    : path.resolve(store.ctx.directory, candidatePath);
  const found = await store.findRootByPath(absPath);
  if (!found) return;

  await store.markStaleByAbsPath(absPath);
  await store.markSummariesStaleByAbsPath(absPath);

  const queued = await store.appendReindexQueueByAbsPath(absPath, reason, meta);
  if (!queued.ok && "skipped" in queued) return;
  if (!queued.ok) {
    try {
      await store.appendLedger({
        type: "reindex.queue.error",
        reason,
        root: found.root.name,
        ref: store.refOf(found.root, found.relPath),
        path: found.relPath,
        error: queued.error,
        eventType: meta.eventType,
        sessionID: meta.sessionID,
        tool: meta.sourceTool,
      });
    } catch {
      // Queue failures must remain non-fatal even if ledger persistence also fails.
    }
    await log(store.ctx, "warn", "Context Bridge failed to append reindex queue entry", {
      reason,
      root: found.root.name,
      ref: store.refOf(found.root, found.relPath),
      path: found.relPath,
      error: queued.error,
      eventType: meta.eventType,
      sessionID: meta.sessionID,
      tool: meta.sourceTool,
      queuePath: store.reindexQueuePath,
    });
    return;
  }

  await store.appendLedger({
    type: "reindex.queued",
    reason,
    root: queued.entry.root,
    ref: queued.entry.ref,
    path: queued.entry.path,
    dedupeKey: queued.entry.dedupeKey,
    eventType: meta.eventType,
    sessionID: meta.sessionID,
    tool: meta.sourceTool,
  });
}

export function extractPath(properties: unknown): string | undefined {
  if (typeof properties !== "object" || properties === null) return undefined;
  const record = properties as Record<string, unknown>;
  for (const key of ["path", "file", "filePath", "filename"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return undefined;
}

export function extractValidationCommand(tool: string, value: unknown): {
  command: string;
  kind: "test" | "typecheck" | "build";
} | undefined {
  if (tool !== "bash") return undefined;
  const command = findCommandString(value)?.trim();
  if (!command) return undefined;

  if (/(^|\s)(bun\s+test|npm\s+test|pnpm\s+test|yarn\s+test|vitest|jest|pytest)(\s|$)/.test(command)) {
    return { command, kind: "test" };
  }
  if (/(^|\s)(bun\s+run\s+typecheck|tsc\s+--noEmit|tsc\s+-p\b.*--noEmit)(\s|$)/.test(command)) {
    return { command, kind: "typecheck" };
  }
  if (/(^|\s)(bun\s+run\s+build|bun\s+build|npm\s+run\s+build|pnpm\s+build|yarn\s+build|vite\s+build|next\s+build|tsc\s+-p\b)(\s|$)/.test(command)) {
    return { command, kind: "build" };
  }
  return undefined;
}

function findCommandString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findCommandString(item);
      if (nested) return nested;
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of ["command", "cmd", "script"]) {
      if (typeof record[key] === "string") return record[key] as string;
    }
    for (const nested of Object.values(record)) {
      const value = findCommandString(nested);
      if (value) return value;
    }
  }
  return undefined;
}
