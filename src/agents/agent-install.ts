import type { Config } from "@opencode-ai/plugin";
import { DEFAULT_CONTEXT_BRIDGE_AGENT, getContextBridgeAgentSpecs } from "./agent-configs.js";

export interface AgentInjectionOptions {
  autoDefaultAgent?: boolean;
  defaultAgentName?: string;
}

// This layer only adapts spec data into OpenCode's mutable runtime config shape.
export function injectContextBridgeAgents(
  config: Config,
  options?: AgentInjectionOptions,
): void {
  const defaultAgent = options?.defaultAgentName ?? DEFAULT_CONTEXT_BRIDGE_AGENT;
  // The plugin type is read-only from the caller's perspective, so we narrow it
  // locally to patch the agent map and default agent field in place.
  const mutable = config as Config & {
    agent?: Record<string, unknown>;
    default_agent?: string;
  };
  mutable.agent ??= {};

  // Copy the spec payloads verbatim so install/runtime stay in sync with the
  // single spec source of truth.
  for (const spec of getContextBridgeAgentSpecs(defaultAgent)) {
    mutable.agent[spec.name] = {
      description: spec.description,
      mode: spec.mode,
      hidden: spec.hidden,
      prompt: spec.prompt,
      temperature: spec.temperature,
      permission: spec.permission,
    };
  }

  // Preserve the default agent unless the caller explicitly opts out.
  if (options?.autoDefaultAgent !== false) {
    mutable.default_agent = defaultAgent;
  }
}
