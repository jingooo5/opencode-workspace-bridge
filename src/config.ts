import type { PluginOptions } from "@opencode-ai/plugin";
import type { AccessMode, ContextBridgeOptions, RootRole } from "./types.js";

const DEFAULT_SECRET_GLOBS = [".env", ".env.*", "**/secrets/**", "**/*.pem", "**/*.key"];
const DEFAULT_CONTRACT_GLOBS = [
  "**/openapi*.yaml",
  "**/openapi*.yml",
  "**/openapi*.json",
  "**/*.proto",
  "**/schema.graphql",
  "**/*.graphql",
  "**/schema.prisma",
  "**/migrations/**",
];

export const DEFAULT_OPTIONS: ContextBridgeOptions = {
  stateDir: ".opencode/context-bridge",
  defaultAccess: "ro",
  autoAgents: true,
  autoDefaultAgent: true,
  globalBootstrap: false,
  globalInstallAgents: false,
  globalSetDefaultAgent: false,
  globalRegisterPlugin: false,
  globalPluginName: "opencode-context-bridge",
  defaultAgentName: "ctx-orchestrator",
  autoIndex: true,
  commandPrefix: "ctx",
  maxSearchResults: 30,
  maxReadBytes: 80_000,
  secretGlobs: DEFAULT_SECRET_GLOBS,
  contractGlobs: DEFAULT_CONTRACT_GLOBS,
  enforceImpactBeforeContractEdit: false,
  roots: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function asAccess(value: unknown): AccessMode | undefined {
  return value === "ro" || value === "rw" ? value : undefined;
}

function asRole(value: unknown): RootRole | undefined {
  if (typeof value !== "string") return undefined;
  if (["primary", "app", "service", "library", "tooling", "docs", "unknown"].includes(value)) {
    return value as RootRole;
  }
  return undefined;
}

export function normalizeOptions(options?: PluginOptions): ContextBridgeOptions {
  if (!isRecord(options)) return { ...DEFAULT_OPTIONS };

  const roots = Array.isArray(options.roots)
    ? options.roots.flatMap((item) => {
        if (!isRecord(item)) return [];
        const path = asString(item.path);
        if (!path) return [];
        return [
          {
            path,
            name: asString(item.name),
            access: asAccess(item.access),
            role: asRole(item.role),
            tags: asStringArray(item.tags),
          },
        ];
      })
    : [];

  return {
    ...DEFAULT_OPTIONS,
    stateDir: asString(options.stateDir) ?? DEFAULT_OPTIONS.stateDir,
    defaultAccess: asAccess(options.defaultAccess) ?? DEFAULT_OPTIONS.defaultAccess,
    autoAgents: asBoolean(options.autoAgents) ?? DEFAULT_OPTIONS.autoAgents,
    autoDefaultAgent: asBoolean(options.autoDefaultAgent) ?? DEFAULT_OPTIONS.autoDefaultAgent,
    globalBootstrap: asBoolean(options.globalBootstrap) ?? DEFAULT_OPTIONS.globalBootstrap,
    globalInstallAgents: asBoolean(options.globalInstallAgents) ?? DEFAULT_OPTIONS.globalInstallAgents,
    globalSetDefaultAgent: asBoolean(options.globalSetDefaultAgent) ?? DEFAULT_OPTIONS.globalSetDefaultAgent,
    globalRegisterPlugin: asBoolean(options.globalRegisterPlugin) ?? DEFAULT_OPTIONS.globalRegisterPlugin,
    globalPluginName: asString(options.globalPluginName) ?? DEFAULT_OPTIONS.globalPluginName,
    defaultAgentName: asString(options.defaultAgentName) ?? DEFAULT_OPTIONS.defaultAgentName,
    autoIndex: asBoolean(options.autoIndex) ?? DEFAULT_OPTIONS.autoIndex,
    commandPrefix: asString(options.commandPrefix) ?? DEFAULT_OPTIONS.commandPrefix,
    maxSearchResults: asNumber(options.maxSearchResults) ?? DEFAULT_OPTIONS.maxSearchResults,
    maxReadBytes: asNumber(options.maxReadBytes) ?? DEFAULT_OPTIONS.maxReadBytes,
    secretGlobs: asStringArray(options.secretGlobs) ?? DEFAULT_OPTIONS.secretGlobs,
    contractGlobs: asStringArray(options.contractGlobs) ?? DEFAULT_OPTIONS.contractGlobs,
    enforceImpactBeforeContractEdit:
      asBoolean(options.enforceImpactBeforeContractEdit) ?? DEFAULT_OPTIONS.enforceImpactBeforeContractEdit,
    roots,
  };
}
