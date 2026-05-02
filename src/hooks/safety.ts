import path from "node:path";
import type { Hooks } from "@opencode-ai/plugin";
import type { WorkspaceStore } from "../state/workspace-store.js";
import type { SessionState } from "../state/session-state.js";
import { extractValidationCommand, markStaleAndQueuePath } from "./reindex.js";

const EDIT_TOOLS = new Set(["write", "edit", "apply_patch"]);
const READ_TOOLS = new Set(["read"]);

export function createSafetyHooks(store: WorkspaceStore, sessions: SessionState): Pick<Hooks, "tool.execute.before" | "tool.execute.after"> {
  return {
    "tool.execute.before": async (input, output) => {
      const paths = extractCandidatePaths(output.args);
      if (!paths.length) return;

      for (const candidate of paths) {
        const abs = path.isAbsolute(candidate) ? candidate : path.resolve(store.ctx.directory, candidate);
        const found = await store.findRootByPath(abs);
        if (!found) continue;

        if ((READ_TOOLS.has(input.tool) || EDIT_TOOLS.has(input.tool)) && (await store.isSecretPath(abs))) {
          throw new Error(`Context Bridge blocked ${input.tool}: protected secret-like path in ${found.root.name}:${found.relPath}`);
        }

        if (EDIT_TOOLS.has(input.tool) && found.root.access === "ro") {
          throw new Error(`Context Bridge blocked edit: root '${found.root.name}' is read-only. Use ctx_add_dir with access=rw only if this root should be editable.`);
        }

        if (EDIT_TOOLS.has(input.tool) && (await store.isContractPath(abs))) {
          const manifest = await store.readManifest();
          if (manifest.policies.enforceImpactBeforeContractEdit) {
            throw new Error(`Context Bridge blocked contract edit: ${found.root.name}:${found.relPath}. Run ctx_pack and ctx-impact-analyst first, or disable enforceImpactBeforeContractEdit.`);
          }
          await store.appendLedger({ type: "contract.edit.warning", sessionID: input.sessionID, tool: input.tool, ref: `${found.root.name}:${found.relPath}` });
        }
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
      }
    },
  };
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
