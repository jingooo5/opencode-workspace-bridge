import type { PluginInput, ToolDefinition } from "@opencode-ai/plugin";
import type { ContextBridgeOptions } from "./types.js";
import type { Managers } from "./create-managers.js";
import { createContextTools } from "./tools/index.js";

export function createTools(
  ctx: PluginInput,
  options: ContextBridgeOptions,
  managers: Managers,
): Record<string, ToolDefinition> {
  return createContextTools(ctx, managers.store, options);
}
