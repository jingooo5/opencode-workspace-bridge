import type { Config } from "@opencode-ai/plugin";
import { DEFAULT_CONTEXT_BRIDGE_AGENT } from "../agents/agent-configs.js";

export interface CommandInstallSpec {
  name: string;
  description: string;
  template: string;
  agent: string;
  subtask: boolean;
}

interface CommandConfigEntry {
  template: string;
  description?: string;
  agent?: string;
  model?: string;
  subtask?: boolean;
}

export interface CommandInjectionOptions {
  defaultAgentName?: string;
}

export function injectContextBridgeCommands(
  config: Config,
  options?: CommandInjectionOptions,
): void {
  const defaultAgent = options?.defaultAgentName ?? DEFAULT_CONTEXT_BRIDGE_AGENT;
  const mutable = config as Config & {
    command?: Record<string, CommandConfigEntry>;
  };
  mutable.command ??= {};

  for (const spec of getContextBridgeCommandSpecs(defaultAgent)) {
    mutable.command[spec.name] = toConfigCommand(spec);
  }
}

export function getContextBridgeCommandSpecs(
  defaultAgentName = DEFAULT_CONTEXT_BRIDGE_AGENT,
): CommandInstallSpec[] {
  return [
    {
      name: "ctx-add-dir",
      description:
        "Add an external repository or workspace root to the context bridge",
      template:
        "Add an external workspace root using the context bridge.\n\nUser arguments:\n$ARGUMENTS\n\nRequired behavior:\n1. Parse the path, optional name, access mode, role, and tags from the arguments.\n2. Call `ctx_add_dir`.\n3. If indexing is enabled or not specified, call `ctx_index` for the new root.\n4. Call `ctx_list_roots` and summarize the resulting workspace state.\n5. Do not edit project code.\n6. If OpenCode external directory permission may block built-in read/edit tools, explain the minimal config change needed.",
      agent: defaultAgentName,
      subtask: false,
    },
    {
      name: "ctx-index",
      description: "Reindex one or more context bridge roots",
      template:
        "Reindex the workspace roots requested by the user.\n\nArguments:\n$ARGUMENTS\n\nSteps:\n1. Call `ctx_index` with the requested roots. Use incremental indexing unless the user says full.\n2. Report indexed files, skipped files, extracted nodes, extracted edges, unresolved references, and diagnostics.\n3. If important summaries became stale, recommend `/ctx-pack` or `ctx_refresh_memory`.",
      agent: defaultAgentName,
      subtask: false,
    },
    {
      name: "ctx-pack",
      description: "Build a task-specific context pack from indexed evidence",
      template:
        "Create a context pack for this task:\n\n$ARGUMENTS\n\nUse `ctx_pack` first. Then inspect only the most relevant evidence with `ctx_read` or `ctx_neighbors` if needed.\n\nReturn:\n- pack path\n- relevant roots\n- relevant files and symbols\n- contracts or endpoints\n- risks\n- missing evidence\n- suggested next agent, if any",
      agent: "ctx-context-curator",
      subtask: true,
    },
    {
      name: "ctx-impact",
      description: "Analyze cross-root impact",
      template:
        "Analyze impact for:\n\n$ARGUMENTS\n\nUse:\n1. `ctx_impact`\n2. `ctx_neighbors` if impact graph is incomplete\n3. `ctx_test_plan` for affected tests\n\nReturn direct impact, indirect impact, contract impact, affected roots, affected tests, unknowns, and recommended edit order.",
      agent: "ctx-impact-analyst",
      subtask: true,
    },
  ];
}

function toConfigCommand(spec: CommandInstallSpec): CommandConfigEntry {
  return {
    description: spec.description,
    template: spec.template,
    agent: spec.agent,
    subtask: spec.subtask,
  };
}
