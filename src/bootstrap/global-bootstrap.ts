import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { z } from "zod";
import type { PluginInput } from "@opencode-ai/plugin";
import type { ContextBridgeOptions } from "../types.js";
import { agentMarkdown, getContextBridgeAgentSpecs } from "../agents/agent-configs.js";
import { log } from "../shared/log.js";

export const BootstrapResultSchema = z.object({
  configPath: z.string().optional(),
  agentDir: z.string().optional(),
  wroteAgents: z.array(z.string()),
  wroteConfig: z.boolean(),
  skipped: z.array(z.string()),
});
export type BootstrapResult = z.infer<typeof BootstrapResultSchema>;

export async function ensureGlobalBootstrap(ctx: PluginInput, options: ContextBridgeOptions): Promise<BootstrapResult> {
  const result: BootstrapResult = { wroteAgents: [], wroteConfig: false, skipped: [] };
  if (!options.globalBootstrap) {
    result.skipped.push("globalBootstrap=false");
    return result;
  }

  const home = os.homedir();
  if (!home) {
    result.skipped.push("home directory not available");
    return result;
  }

  const configDir = process.env.OPENCODE_CONFIG_DIR || path.join(home, ".config", "opencode");
  const agentDir = path.join(configDir, "agents");
  result.agentDir = agentDir;

  if (options.globalInstallAgents) {
    await mkdir(agentDir, { recursive: true });
    for (const spec of getContextBridgeAgentSpecs(options.defaultAgentName)) {
      const file = path.join(agentDir, `${spec.name}.md`);
      await writeFile(file, agentMarkdown(spec), "utf8");
      result.wroteAgents.push(file);
    }
  }

  if (options.globalSetDefaultAgent || options.globalRegisterPlugin) {
    const configPath = await findOrCreateGlobalConfigPath(configDir);
    result.configPath = configPath;
    const patched = await patchGlobalConfig(configPath, options);
    result.wroteConfig = patched;
  }

  await log(ctx, "info", "Context Bridge global bootstrap complete", result);
  return result;
}

async function findOrCreateGlobalConfigPath(configDir: string): Promise<string> {
  await mkdir(configDir, { recursive: true });
  const candidates = [
    path.join(configDir, "opencode.jsonc"),
    path.join(configDir, "opencode.json"),
  ];
  const existing = candidates.find((candidate) => existsSync(candidate));
  if (existing) return existing;
  const created = candidates[0];
  await writeFile(created, JSON.stringify({ "$schema": "https://opencode.ai/config.json" }, null, 2) + "\n", "utf8");
  return created;
}

async function patchGlobalConfig(configPath: string, options: ContextBridgeOptions): Promise<boolean> {
  const original = await readFile(configPath, "utf8").catch(() => "{}");
  const parsed = parseJsoncObject(original);
  if (!parsed) {
    const fallback = `${configPath}.context-bridge.example.jsonc`;
    await writeFile(
      fallback,
      JSON.stringify(buildConfigPatch({}, options), null, 2) + "\n",
      "utf8",
    );
    return false;
  }

  const before = JSON.stringify(parsed);
  const patched = buildConfigPatch(parsed, options);
  const after = JSON.stringify(patched);
  if (before === after) return false;

  const backup = `${configPath}.context-bridge.bak`;
  if (!existsSync(backup)) await writeFile(backup, original, "utf8");
  await writeFile(configPath, JSON.stringify(patched, null, 2) + "\n", "utf8");
  return true;
}

function buildConfigPatch(config: Record<string, unknown>, options: ContextBridgeOptions): Record<string, unknown> {
  const next: Record<string, unknown> = { ...config };
  next["$schema"] ??= "https://opencode.ai/config.json";

  if (options.globalSetDefaultAgent) {
    const previous = typeof next.default_agent === "string" ? next.default_agent : undefined;
    next.default_agent = options.defaultAgentName;
  }

  if (options.globalRegisterPlugin) {
    const current = Array.isArray(next.plugin) ? next.plugin.filter((item): item is string => typeof item === "string") : [];
    if (!current.includes(options.globalPluginName)) current.push(options.globalPluginName);
    next.plugin = current;
  }

  return next;
}

function parseJsoncObject(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(stripJsonc(text)) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch === "'" ? '"' : ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
