export type AccessMode = "ro" | "rw";

export type RootRole =
  | "primary"
  | "app"
  | "service"
  | "library"
  | "tooling"
  | "docs"
  | "unknown";

export interface RootSpec {
  name: string;
  path: string;
  absPath: string;
  access: AccessMode;
  role?: RootRole;
  tags?: string[];
  indexedAt?: string;
  stale?: boolean;
}

export interface WorkspaceManifest {
  version: 1;
  primary: RootSpec;
  roots: RootSpec[];
  policies: {
    secretGlobs: string[];
    contractGlobs: string[];
    enforceImpactBeforeContractEdit: boolean;
  };
}

export interface ContextBridgeOptions {
  stateDir: string;
  defaultAccess: AccessMode;

  /** Dynamically inject Context Bridge agents into the current OpenCode config. */
  autoAgents: boolean;

  /** Make ctx-orchestrator the default primary agent in the current runtime config. */
  autoDefaultAgent: boolean;

  /** Run safe global bootstrap on plugin startup. */
  globalBootstrap: boolean;

  /** Write global markdown agent files under ~/.config/opencode/agents. */
  globalInstallAgents: boolean;

  /** Patch ~/.config/opencode/opencode.jsonc with default_agent. */
  globalSetDefaultAgent: boolean;

  /** Optionally also add this package to the global plugin array. Disabled by default. */
  globalRegisterPlugin: boolean;

  /** Package name to add if globalRegisterPlugin is enabled. */
  globalPluginName: string;

  /** Name of the primary default agent to install/use. */
  defaultAgentName: string;

  autoIndex: boolean;
  commandPrefix: string;
  maxSearchResults: number;
  maxReadBytes: number;
  secretGlobs: string[];
  contractGlobs: string[];
  enforceImpactBeforeContractEdit: boolean;
  roots: Array<{
    name?: string;
    path: string;
    access?: AccessMode;
    role?: RootRole;
    tags?: string[];
  }>;
}

export interface IndexEntry {
  root: string;
  ref: string;
  path: string;
  kind: "file" | "package" | "symbol" | "route" | "contract" | "test";
  name: string;
  line?: number;
  text?: string;
  updatedAt: string;
}

export interface SearchHit {
  root: string;
  ref: string;
  path: string;
  line?: number;
  kind: string;
  score: number;
  text: string;
}

export interface RouteHint {
  agents: string[];
  reason: string;
  taskShape: "workspace" | "impact" | "contract" | "test" | "debug" | "general";
  createdAt: string;
}
