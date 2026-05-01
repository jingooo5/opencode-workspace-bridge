import type { Hooks } from "@opencode-ai/plugin";
import type { WorkspaceStore } from "../state/workspace-store.js";

export function createShellEnvHook(store: WorkspaceStore): Pick<Hooks, "shell.env"> {
  return {
    "shell.env": async (_input, output) => {
      output.env.CTX_BRIDGE_STATE_DIR = store.stateDirAbs;
      output.env.CTX_BRIDGE_MANIFEST = store.manifestPath;
      output.env.CTX_BRIDGE_INDEX = store.indexPath;
    },
  };
}
