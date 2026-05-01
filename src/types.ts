import { z } from "zod";

export const AccessModeSchema = z.enum(["ro", "rw"]);
export type AccessMode = z.infer<typeof AccessModeSchema>;

export const RootRoleSchema = z.enum([
  "primary",
  "app",
  "service",
  "library",
  "tooling",
  "docs",
  "unknown",
]);
export type RootRole = z.infer<typeof RootRoleSchema>;

export const RootSpecSchema = z.object({
  name: z.string(),
  path: z.string(),
  absPath: z.string(),
  access: AccessModeSchema,
  role: RootRoleSchema.optional(),
  tags: z.array(z.string()).optional(),
  indexedAt: z.string().optional(),
  stale: z.boolean().optional(),
});
export type RootSpec = z.infer<typeof RootSpecSchema>;

export const WorkspacePoliciesSchema = z.object({
  secretGlobs: z.array(z.string()),
  contractGlobs: z.array(z.string()),
  enforceImpactBeforeContractEdit: z.boolean(),
});
export type WorkspacePolicies = z.infer<typeof WorkspacePoliciesSchema>;

export const WorkspaceManifestSchema = z.object({
  version: z.literal(1),
  primary: RootSpecSchema,
  roots: z.array(RootSpecSchema),
  policies: WorkspacePoliciesSchema,
});
export type WorkspaceManifest = z.infer<typeof WorkspaceManifestSchema>;

export const RootInputSchema = z.object({
  name: z.string().optional(),
  path: z.string(),
  access: AccessModeSchema.optional(),
  role: RootRoleSchema.optional(),
  tags: z.array(z.string()).optional(),
});
export type RootInput = z.infer<typeof RootInputSchema>;

export const ContextBridgeOptionsSchema = z.object({
  stateDir: z.string(),
  defaultAccess: AccessModeSchema,

  /** Dynamically inject Context Bridge agents into the current OpenCode config. */
  autoAgents: z.boolean(),

  /** Make ctx-orchestrator the default primary agent in the current runtime config. */
  autoDefaultAgent: z.boolean(),

  /** Run safe global bootstrap on plugin startup. */
  globalBootstrap: z.boolean(),

  /** Write global markdown agent files under ~/.config/opencode/agents. */
  globalInstallAgents: z.boolean(),

  /** Patch ~/.config/opencode/opencode.jsonc with default_agent. */
  globalSetDefaultAgent: z.boolean(),

  /** Optionally also add this package to the global plugin array. Disabled by default. */
  globalRegisterPlugin: z.boolean(),

  /** Package name to add if globalRegisterPlugin is enabled. */
  globalPluginName: z.string(),

  /** Name of the primary default agent to install/use. */
  defaultAgentName: z.string(),

  autoIndex: z.boolean(),
  commandPrefix: z.string(),
  maxSearchResults: z.number().refine(Number.isFinite, "must be finite"),
  maxReadBytes: z.number().refine(Number.isFinite, "must be finite"),
  secretGlobs: z.array(z.string()),
  contractGlobs: z.array(z.string()),
  enforceImpactBeforeContractEdit: z.boolean(),
  roots: z.array(RootInputSchema),
});
export type ContextBridgeOptions = z.infer<typeof ContextBridgeOptionsSchema>;

export const IndexEntrySchema = z.object({
  root: z.string(),
  ref: z.string(),
  path: z.string(),
  kind: z.enum(["file", "package", "symbol", "route", "contract", "test"]),
  name: z.string(),
  line: z.number().optional(),
  text: z.string().optional(),
  updatedAt: z.string(),
});
export type IndexEntry = z.infer<typeof IndexEntrySchema>;

export const SearchHitSchema = z.object({
  root: z.string(),
  ref: z.string(),
  path: z.string(),
  line: z.number().optional(),
  kind: z.string(),
  score: z.number(),
  text: z.string(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const RouteHintSchema = z.object({
  agents: z.array(z.string()),
  reason: z.string(),
  taskShape: z.enum(["workspace", "impact", "contract", "test", "debug", "general"]),
  createdAt: z.string(),
});
export type RouteHint = z.infer<typeof RouteHintSchema>;
