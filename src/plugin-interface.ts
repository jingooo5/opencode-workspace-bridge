import type { Config, Hooks, PluginInput } from "@opencode-ai/plugin";
import type { ContextBridgeOptions } from "./types.js";
import type { Managers } from "./create-managers.js";
import { injectContextBridgeAgents } from "./agents/agent-install.js";
import { injectContextBridgeCommands } from "./commands/command-configs.js";

export function createPluginInterface(args: {
  ctx: PluginInput;
  options: ContextBridgeOptions;
  managers: Managers;
  tools: NonNullable<Hooks["tool"]>;
  hooks: Partial<Hooks>;
}): Hooks {
  const { options, tools, hooks } = args;
  return {
    config: async (config: Config) => {
      if (options.autoAgents) {
        injectContextBridgeAgents(config, {
          autoDefaultAgent: options.autoDefaultAgent,
          defaultAgentName: options.defaultAgentName,
        });
        injectContextBridgeCommands(config, {
          defaultAgentName: options.defaultAgentName,
        });
      }
    },
    tool: tools,
    event: hooks.event,
    "chat.message": hooks["chat.message"],
    "experimental.chat.system.transform": hooks["experimental.chat.system.transform"],
    "tool.execute.before": hooks["tool.execute.before"],
    "tool.execute.after": hooks["tool.execute.after"],
    "shell.env": hooks["shell.env"],
    "experimental.session.compacting": hooks["experimental.session.compacting"],
  };
}
