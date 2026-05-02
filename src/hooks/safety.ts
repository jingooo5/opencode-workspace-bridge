import type { Hooks } from "@opencode-ai/plugin";
import type { WorkspaceStore } from "../state/workspace-store.js";
import type { SessionState } from "../state/session-state.js";
import { createContractGateHooks } from "./contract-gate.js";

export function createSafetyHooks(
  store: WorkspaceStore,
  sessions: SessionState,
): Pick<Hooks, "tool.execute.before" | "tool.execute.after"> {
  return createContractGateHooks(store, sessions);
}
