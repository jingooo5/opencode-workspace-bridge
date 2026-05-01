import { z } from "zod";
import type { PluginOptions } from "@opencode-ai/plugin";
import {
  AccessModeSchema,
  ContextBridgeOptionsSchema,
  RootInputSchema,
  type ContextBridgeOptions,
} from "./types.js";

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

export const DEFAULT_OPTIONS: ContextBridgeOptions = ContextBridgeOptionsSchema.parse({
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
});

const finiteNumber = z.number().refine(Number.isFinite, "must be finite");

const optional = <T extends z.ZodTypeAny>(schema: T) =>
  schema.optional().catch(undefined);

const RawOptionsSchema = z
  .object({
    stateDir: optional(z.string()),
    defaultAccess: optional(AccessModeSchema),
    autoAgents: optional(z.boolean()),
    autoDefaultAgent: optional(z.boolean()),
    globalBootstrap: optional(z.boolean()),
    globalInstallAgents: optional(z.boolean()),
    globalSetDefaultAgent: optional(z.boolean()),
    globalRegisterPlugin: optional(z.boolean()),
    globalPluginName: optional(z.string()),
    defaultAgentName: optional(z.string()),
    autoIndex: optional(z.boolean()),
    commandPrefix: optional(z.string()),
    maxSearchResults: optional(finiteNumber),
    maxReadBytes: optional(finiteNumber),
    secretGlobs: optional(z.array(z.string())),
    contractGlobs: optional(z.array(z.string())),
    enforceImpactBeforeContractEdit: optional(z.boolean()),
    roots: optional(z.array(z.unknown())),
  })
  .catch({});

export function normalizeOptions(options?: PluginOptions): ContextBridgeOptions {
  const raw = RawOptionsSchema.parse(options ?? {});

  const roots = (raw.roots ?? []).flatMap((item) => {
    const parsed = RootInputSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });

  return ContextBridgeOptionsSchema.parse({
    ...DEFAULT_OPTIONS,
    ...definedOnly(raw),
    roots,
  });
}

function definedOnly<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, val] of Object.entries(value)) {
    if (val !== undefined) (out as Record<string, unknown>)[key] = val;
  }
  return out;
}
