import type { Hooks } from "@opencode-ai/plugin";
import type { WorkspaceStore } from "../state/workspace-store.js";
import type { SessionState } from "../state/session-state.js";

export function createCompactionHook(store: WorkspaceStore, sessions: SessionState): Pick<Hooks, "experimental.session.compacting"> {
  return {
    "experimental.session.compacting": async (input, output) => {
      const workspace = await store.workspaceSummary().catch(() => "Context Bridge manifest unavailable.");
      const touched = sessions.touched(input.sessionID);
      const ledger = await store.recentLedger(12);
      const compactionContext = await store.compactionContext({
        sessionID: input.sessionID,
        touchedRefs: touched,
      });
      output.context.push(`
## Context Bridge durable state
${workspace}

${compactionContext}

Touched refs in this session:
${touched.length ? touched.map((ref) => `- ${ref}`).join("\n") : "- none recorded"}

Recent Context Bridge ledger entries:
${ledger.length ? ledger.map((line) => `- ${line}`).join("\n") : "- none"}

Resume rule:
For cross-root work, reopen the manifest by path, call ctx_list_roots, and rebuild or refresh ctx_pack before editing stale roots.
`);
    },
  };
}
