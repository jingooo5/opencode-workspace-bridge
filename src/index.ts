import type { Plugin, PluginInput, PluginModule, PluginOptions } from "@opencode-ai/plugin";
import { normalizeOptions } from "./config.js";
import { ensureGlobalBootstrap } from "./bootstrap/global-bootstrap.js";
import { createManagers } from "./create-managers.js";
import { createTools } from "./create-tools.js";
import { createHooks } from "./create-hooks.js";
import { createPluginInterface } from "./plugin-interface.js";
import { log } from "./shared/log.js";

export const serverPlugin: Plugin = async (input: PluginInput, rawOptions?: PluginOptions) => {
  const options = normalizeOptions(rawOptions);

  // Safe, idempotent bootstrap:
  // - writes global agent markdown files so they are available without ctx_install_agents
  // - optionally sets default_agent to ctx-orchestrator in ~/.config/opencode/opencode.jsonc
  // - never deletes built-in OpenCode agents
  if (options.globalBootstrap) {
    await ensureGlobalBootstrap(input, options).catch((error) =>
      log(input, "warn", "Context Bridge global bootstrap failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  const managers = await createManagers(input, options);
  const tools = createTools(input, options, managers);
  const hooks = createHooks(managers);

  await log(input, "info", "Context Bridge loaded", {
    directory: input.directory,
    worktree: input.worktree,
    stateDir: options.stateDir,
    autoAgents: options.autoAgents,
    autoDefaultAgent: options.autoDefaultAgent,
    defaultAgentName: options.defaultAgentName,
    globalBootstrap: options.globalBootstrap,
    autoIndex: options.autoIndex,
  });

  return createPluginInterface({ ctx: input, options, managers, tools, hooks });
};

const pluginModule: PluginModule = {
  id: "opencode-context-bridge",
  server: serverPlugin,
};

export default pluginModule;
