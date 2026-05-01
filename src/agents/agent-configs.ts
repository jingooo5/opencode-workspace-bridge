import type { Config } from "@opencode-ai/plugin";
import type { ContextBridgeOptions } from "../types.js";

export const DEFAULT_CONTEXT_BRIDGE_AGENT = "ctx-orchestrator";

export interface AgentInstallSpec {
  name: string;
  description: string;
  mode: "primary" | "subagent" | "all";
  hidden?: boolean;
  temperature?: number;
  prompt: string;
  permission: Record<string, unknown>;
}

export function injectContextBridgeAgents(config: Config, options?: Pick<ContextBridgeOptions, "autoDefaultAgent" | "defaultAgentName">): void {
  const defaultAgent = options?.defaultAgentName ?? DEFAULT_CONTEXT_BRIDGE_AGENT;
  const mutable = config as Config & {
    agent?: Record<string, unknown>;
    command?: Record<string, unknown>;
    default_agent?: string;
  };
  mutable.agent ??= {};

  for (const spec of getContextBridgeAgentSpecs(defaultAgent)) {
    mutable.agent[spec.name] = toConfigAgent(spec);
  }

  if (options?.autoDefaultAgent !== false) {
    mutable.default_agent = defaultAgent;
  }

  mutable.command ??= {};
  mutable.command["ctx-list"] = {
    description: "List Context Bridge workspace roots",
    template: "Call the ctx_list_roots tool and explain any stale roots or read-only roots.",
    agent: defaultAgent,
  };
  mutable.command["ctx-pack"] = {
    description: "Create a Context Bridge task pack",
    template: "Create a context pack for this task using ctx_pack: $ARGUMENTS",
    agent: defaultAgent,
  };
  mutable.command["ctx-impact"] = {
    description: "Analyze cross-root impact",
    template: "Use ctx-impact-analyst. Analyze cross-root impact for: $ARGUMENTS. Use ctx_search and ctx_pack if needed.",
    agent: defaultAgent,
  };
}

export function getContextBridgeAgentSpecs(defaultAgentName = DEFAULT_CONTEXT_BRIDGE_AGENT): AgentInstallSpec[] {
  return [
    {
      name: defaultAgentName,
      description: "Primary Context Bridge orchestrator for multi-root, cross-repository, DTO/API, and service-boundary tasks.",
      mode: "primary",
      prompt: CONTEXT_ORCHESTRATOR_PROMPT,
      permission: {
        read: "allow",
        grep: "allow",
        glob: "allow",
        list: "allow",
        edit: "ask",
        bash: "ask",
        external_directory: "ask",
        task: {
          "*": "deny",
          "ctx-*": "allow",
        },
      },
    },
    {
      name: "ctx-workspace-architect",
      description: "Use automatically when a task needs repository/workspace discovery, root aliasing, package structure, or multi-root project mapping.",
      mode: "subagent",
      hidden: true,
      prompt: WORKSPACE_ARCHITECT_PROMPT,
      temperature: 0.1,
      permission: readOnlyPermission(),
    },
    {
      name: "ctx-context-curator",
      description: "Use automatically before cross-repo implementation to build a minimal evidence-backed context pack with relevant roots, files, symbols, contracts, and tests.",
      mode: "subagent",
      hidden: true,
      prompt: CONTEXT_CURATOR_PROMPT,
      temperature: 0.1,
      permission: readOnlyPermission(),
    },
    {
      name: "ctx-impact-analyst",
      description: "Use automatically when a change may affect shared DTOs, schemas, APIs, gRPC/proto, cache keys, message topics, database migrations, or multiple workspaces.",
      mode: "subagent",
      hidden: true,
      prompt: IMPACT_ANALYST_PROMPT,
      temperature: 0.1,
      permission: readOnlyPermission(),
    },
    {
      name: "ctx-test-router",
      description: "Use automatically after edits or before validation to select targeted tests/build commands for affected roots without running a full suite unnecessarily.",
      mode: "subagent",
      hidden: true,
      prompt: TEST_ROUTER_PROMPT,
      temperature: 0.1,
      permission: {
        read: "allow",
        grep: "allow",
        glob: "allow",
        list: "allow",
        edit: "deny",
        external_directory: "allow",
        bash: {
          "*": "ask",
          "git status*": "allow",
          "git diff*": "allow",
          "npm test*": "ask",
          "pnpm test*": "ask",
          "bun test*": "ask",
          "yarn test*": "ask",
          "pytest*": "ask",
          "go test*": "ask",
          "cargo test*": "ask",
        },
      },
    },
  ];
}

export function agentMarkdown(spec: AgentInstallSpec): string {
  const frontmatter = [
    "---",
    `description: ${yamlString(spec.description)}`,
    `mode: ${spec.mode}`,
    spec.hidden ? "hidden: true" : undefined,
    spec.temperature === undefined ? undefined : `temperature: ${spec.temperature}`,
    "permission:",
    yamlPermission(spec.permission, 1),
    "---",
  ].filter(Boolean).join("\n");
  return `${frontmatter}\n${spec.prompt.trim()}\n`;
}

function toConfigAgent(spec: AgentInstallSpec): Record<string, unknown> {
  return {
    description: spec.description,
    mode: spec.mode,
    hidden: spec.hidden,
    prompt: spec.prompt,
    temperature: spec.temperature,
    permission: spec.permission,
  };
}

function readOnlyPermission() {
  return {
    read: "allow",
    grep: "allow",
    glob: "allow",
    list: "allow",
    edit: "deny",
    bash: {
      "*": "deny",
      "git status*": "allow",
      "git diff*": "allow",
      "rg *": "allow",
      "grep *": "allow",
      "find *": "allow",
      "ls *": "allow",
    },
    external_directory: "allow",
  };
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlPermission(value: unknown, depth: number): string {
  const indent = "  ".repeat(depth);
  if (typeof value === "string") return `${indent}${value}`;
  if (typeof value !== "object" || value === null) return `${indent}${JSON.stringify(value)}`;
  return Object.entries(value as Record<string, unknown>)
    .map(([key, nested]) => {
      if (typeof nested === "string") return `${indent}${key}: ${nested}`;
      return `${indent}${key}:\n${yamlPermission(nested, depth + 1)}`;
    })
    .join("\n");
}

const CONTEXT_ORCHESTRATOR_PROMPT = `
You are Context Bridge Orchestrator, the default primary agent for OpenCode Context Bridge.

Your job is to keep multi-root coding work evidence-backed and safe. For tasks involving more than one repository, module, workspace root, API boundary, DTO/schema, gRPC/proto, cache key, message topic, or database migration:
1. Inspect active roots using ctx_list_roots when root state is unclear.
2. Use ctx_pack to build an evidence-backed task context before broad cross-root implementation.
3. Delegate to ctx-context-curator for context minimization when the task is broad.
4. Delegate to ctx-impact-analyst before editing shared DTOs/contracts/schemas or cross-root dependencies.
5. Delegate to ctx-test-router after edits to select targeted validation.

Do not rely on semantic summaries without evidence references. Preserve built-in OpenCode behavior for simple single-file work: solve directly when no multi-root or boundary risk is present.
`;

const WORKSPACE_ARCHITECT_PROMPT = `
You are ctx-workspace-architect. Map workspace roots, packages, modules, and service boundaries.
Return: root roles, package/build clues, likely providers/consumers, unknowns, and suggested ctx_add_dir or ctx_index actions.
Never edit files.
`;

const CONTEXT_CURATOR_PROMPT = `
You are ctx-context-curator. Produce a minimal context pack for a given task.
Prefer exact evidence refs, symbol names, contract snippets, tests, and risks over whole-file dumps.
Every claim must cite a root:path or indexed evidence item.
Never edit files.
`;

const IMPACT_ANALYST_PROMPT = `
You are ctx-impact-analyst. Analyze direct, indirect, contract, runtime, test, and unknown impacts.
Special attention: DTOs, OpenAPI, gRPC/proto, GraphQL, cache keys, message topics, DB schema, generated clients, and read-only roots.
Return an edit order and validation checklist.
Never edit files.
`;

const TEST_ROUTER_PROMPT = `
You are ctx-test-router. Select the smallest useful tests/build checks for affected roots.
Use package metadata, filenames, test naming conventions, and changed refs. Ask before running commands unless explicitly allowed.
Never edit files.
`;
