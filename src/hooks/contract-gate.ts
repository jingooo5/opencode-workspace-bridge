import path from "node:path";
import type { Hooks } from "@opencode-ai/plugin";
import type { WorkspaceStore } from "../state/workspace-store.js";
import type { SessionState } from "../state/session-state.js";
import { ContractCache } from "../state/contract-cache.js";
import {
  appendImpactLedger,
  hasRecentImpact,
  recordEdit,
  recordPendingValidation,
  recordValidationSatisfaction,
  syncStaleSummaries,
} from "../state/edit-state.js";
import { extractValidationCommand, markStaleAndQueuePath } from "./reindex.js";

const EDIT_TOOLS = new Set(["write", "edit", "apply_patch"]);
const READ_TOOLS = new Set(["read"]);
const RECENT_IMPACT_WINDOW_SECONDS = 600;

export function createContractGateHooks(
  store: WorkspaceStore,
  sessions: SessionState,
): Pick<Hooks, "tool.execute.before" | "tool.execute.after"> {
  const cache = new ContractCache(store);

  return {
    "tool.execute.before": async (input, output) => {
      const paths = extractCandidatePaths(output.args);
      if (!paths.length) return;

      for (const candidate of paths) {
        const abs = path.isAbsolute(candidate) ? candidate : path.resolve(store.ctx.directory, candidate);
        const found = await store.findRootByPath(abs);
        if (!found) continue;

        // Step 1: secret enforcement (read + edit).
        if ((READ_TOOLS.has(input.tool) || EDIT_TOOLS.has(input.tool)) && (await store.isSecretPath(abs))) {
          throw new Error(`Context Bridge blocked ${input.tool}: protected secret-like path in ${found.root.name}:${found.relPath}`);
        }

        if (READ_TOOLS.has(input.tool)) continue;
        if (!EDIT_TOOLS.has(input.tool)) continue;

        // Step 2: read-only root.
        if (found.root.access === "ro") {
          throw new Error(`Context Bridge blocked edit: root '${found.root.name}' is read-only. Use ctx_add_dir with access=rw only if this root should be editable.`);
        }

        // Step 3: contract boundary detection — glob OR registry membership.
        const cacheEntries = await cache.contractsForAbsPath(abs);
        const isGlobContract = await store.isContractPath(abs);
        const contractIds = uniqueStrings([
          ...cacheEntries.map((entry) => entry.contractId),
          ...(isGlobContract ? [`glob:${found.root.name}:${found.relPath}`] : []),
        ]);
        if (contractIds.length === 0) continue;

        const manifest = await store.readManifest();
        const enforce = manifest.policies.enforceImpactBeforeContractEdit;

        // Step 4: recent impact analysis.
        const recent = await hasRecentImpact(store, {
          sessionID: input.sessionID,
          contractIds,
          withinSeconds: RECENT_IMPACT_WINDOW_SECONDS,
        });

        if (!recent) {
          if (enforce) {
            throw new Error(
              `Context Bridge blocked contract edit: ${found.root.name}:${found.relPath}. Run ctx_impact for ${contractIds.join(", ")} before editing, or set enforceImpactBeforeContractEdit=false.`,
            );
          }
          await store.appendLedger({
            type: "contract.edit.warning",
            sessionID: input.sessionID,
            tool: input.tool,
            ref: `${found.root.name}:${found.relPath}`,
            contractIds,
          });
          continue;
        }

        // Step 5: impact analysis present — allow + ledger trace.
        await store.appendLedger({
          type: "contract.edit.cleared",
          sessionID: input.sessionID,
          tool: input.tool,
          ref: `${found.root.name}:${found.relPath}`,
          contractIds,
        });
      }
    },

    "tool.execute.after": async (input) => {
      if (input.tool === "ctx_impact") {
        await store.appendLedger({ type: "impact.analysis.requested", sessionID: input.sessionID, tool: input.tool });
      }

      const validation = extractValidationCommand(input.tool, input.args);
      if (validation) {
        await store.appendLedger({
          type: "validation.command",
          sessionID: input.sessionID,
          tool: input.tool,
          validationKind: validation.kind,
          command: validation.command,
        });
        await recordValidationSatisfaction(store, {
          sessionID: input.sessionID,
          tool: input.tool,
          command: validation.command,
          kind: validation.kind,
        });
      }

      if (!EDIT_TOOLS.has(input.tool)) return;
      const paths = extractCandidatePaths(input.args);
      for (const candidate of paths) {
        const abs = path.isAbsolute(candidate) ? candidate : path.resolve(store.ctx.directory, candidate);
        const found = await store.findRootByPath(abs);
        if (!found) continue;
        sessions.touch(input.sessionID, `${found.root.name}:${found.relPath}`);
        await markStaleAndQueuePath(store, abs, "tool_edited", {
          eventType: "tool.execute.after",
          sessionID: input.sessionID,
          sourceTool: input.tool,
        });
        await store.appendLedger({ type: "file.touched", sessionID: input.sessionID, tool: input.tool, ref: `${found.root.name}:${found.relPath}` });
        await recordEdit({ store, sessionID: input.sessionID, tool: input.tool, absPath: abs });

        const contracts = await cache.contractsForAbsPath(abs);
        for (const contract of contracts) {
          await recordPendingValidation(store, {
            at: new Date().toISOString(),
            sessionID: input.sessionID,
            ref: `${found.root.name}:${found.relPath}`,
            kind: contract.kind === "PACKAGE" ? "build" : "test",
            reason: `contract_edited:${contract.contractId}`,
          });
        }
      }

      await syncStaleSummaries(store);
      cache.invalidate();
    },
  };
}

export async function recordImpactAnalysis(
  store: WorkspaceStore,
  entry: Parameters<typeof appendImpactLedger>[1],
): Promise<void> {
  await appendImpactLedger(store, entry);
}

function extractCandidatePaths(value: unknown): string[] {
  const out = new Set<string>();
  function visit(v: unknown): void {
    if (typeof v === "string") {
      if (looksLikePath(v)) out.add(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (typeof v === "object" && v !== null) {
      for (const [key, nested] of Object.entries(v as Record<string, unknown>)) {
        if (/path|file|filename|filepath/i.test(key) && typeof nested === "string") out.add(nested);
        else visit(nested);
      }
    }
  }
  visit(value);
  return Array.from(out);
}

function looksLikePath(value: string): boolean {
  if (value.length > 300) return false;
  return value.includes("/") || value.includes("\\") || /\.[a-z0-9]{1,8}$/i.test(value);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
