import path from "node:path";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DEFAULT_OPTIONS } from "../../src/config.ts";
import type { ContextBridgeOptions } from "../../src/types.ts";

export async function createTempWorkspace(prefix = "ctx-bridge-"): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

export async function removeTempWorkspace(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

export function createPluginInput(directory: string) {
  return {
    client: {},
    project: {},
    directory,
    worktree: directory,
    experimental_workspace: {
      register() {},
    },
    serverUrl: new URL("http://localhost"),
    $: () => {
      throw new Error("Shell is not available in tests.");
    },
  };
}

export function createTestOptions(
  overrides: Partial<ContextBridgeOptions> = {},
): ContextBridgeOptions {
  return {
    ...DEFAULT_OPTIONS,
    stateDir: ".opencode/context-bridge-test",
    autoAgents: false,
    autoDefaultAgent: false,
    globalBootstrap: false,
    globalInstallAgents: false,
    globalSetDefaultAgent: false,
    globalRegisterPlugin: false,
    autoIndex: false,
    ...overrides,
  };
}

export function createToolContext(directory: string) {
  return {
    sessionID: "test-session",
    messageID: "test-message",
    agent: "ctx-orchestrator",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata() {},
    ask() {
      throw new Error("Permission prompts are not expected in tests.");
    },
  };
}

export async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
}

export async function copyFixture(source: string, destination: string): Promise<void> {
  await cp(source, destination, { recursive: true });
}
