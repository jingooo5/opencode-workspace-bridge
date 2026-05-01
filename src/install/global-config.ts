import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { applyEdits, modify, parse } from "jsonc-parser";
import { z } from "zod";

export const InstallOptionsSchema = z.object({
  pluginName: z.string().optional(),
  defaultAgent: z.string().optional(),
  setDefaultAgent: z.boolean().optional(),
  forceDefaultAgent: z.boolean().optional(),
  configDir: z.string().optional(),
});
export type InstallOptions = z.infer<typeof InstallOptionsSchema>;

export const InstallResultSchema = z.object({
  configPath: z.string(),
  backupPath: z.string().optional(),
  pluginRegistered: z.boolean(),
  defaultAgentSet: z.boolean(),
  previousDefaultAgent: z.string().optional(),
});
export type InstallResult = z.infer<typeof InstallResultSchema>;

const SCHEMA = "https://opencode.ai/config.json";

export function defaultOpencodeConfigDir(): string {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR;
  if (process.platform === "win32" && process.env.APPDATA) return path.join(process.env.APPDATA, "opencode");
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "opencode");
}

export async function installGlobalConfig(options: InstallOptions = {}): Promise<InstallResult> {
  const validated = InstallOptionsSchema.parse(options);
  const pluginName = validated.pluginName ?? "opencode-context-bridge";
  const defaultAgent = validated.defaultAgent ?? "ctx-orchestrator";
  const setDefaultAgent = validated.setDefaultAgent ?? true;
  const forceDefaultAgent = validated.forceDefaultAgent ?? true;
  const configDir = validated.configDir ?? defaultOpencodeConfigDir();

  await mkdir(configDir, { recursive: true });
  const configPath = await chooseConfigPath(configDir);
  const existed = existsSync(configPath);
  const before = existed ? await readFile(configPath, "utf8") : `{"$schema":"${SCHEMA}"}\n`;
  const parsed = parse(before) as Record<string, unknown> | undefined;
  const current = parsed && typeof parsed === "object" ? parsed : {};
  const previousDefaultAgent = typeof current.default_agent === "string" ? current.default_agent : undefined;

  let next = before.trim() ? before : `{"$schema":"${SCHEMA}"}\n`;
  let pluginRegistered = false;
  let defaultAgentSet = false;

  if (!current.$schema) {
    next = applyEdits(next, modify(next, ["$schema"], SCHEMA, jsoncFormat()));
  }

  const plugins = Array.isArray(current.plugin) ? current.plugin.filter((v): v is string => typeof v === "string") : [];
  if (!plugins.includes(pluginName)) {
    pluginRegistered = true;
    next = applyEdits(next, modify(next, ["plugin"], [...plugins, pluginName], jsoncFormat()));
  }

  if (setDefaultAgent && (forceDefaultAgent || !previousDefaultAgent)) {
    defaultAgentSet = previousDefaultAgent !== defaultAgent;
    next = applyEdits(next, modify(next, ["default_agent"], defaultAgent, jsoncFormat()));
  }

  // A tiny stub makes default_agent resolvable even before the plugin config hook
  // injects the full dynamic prompt/permissions. The runtime hook replaces/extends
  // this with the complete generated agent definition.
  const agent = (current.agent && typeof current.agent === "object" ? current.agent : {}) as Record<string, unknown>;
  if (!agent[defaultAgent]) {
    next = applyEdits(next, modify(next, ["agent", defaultAgent], {
      description: "Context Bridge primary orchestrator. Dynamically expanded by the opencode-context-bridge plugin.",
      mode: "primary",
      permission: {
        edit: "ask",
        bash: "ask",
        external_directory: "ask",
      },
    }, jsoncFormat()));
  }

  let backupPath: string | undefined;
  if (existed && next !== before) {
    backupPath = `${configPath}.context-bridge.bak-${Date.now()}`;
    await copyFile(configPath, backupPath);
  }
  if (!existed || next !== before) {
    await writeFile(configPath, `${next.trimEnd()}\n`, "utf8");
  }

  return { configPath, backupPath, pluginRegistered, defaultAgentSet, previousDefaultAgent };
}

async function chooseConfigPath(configDir: string): Promise<string> {
  for (const name of ["opencode.jsonc", "opencode.json", "config.json"]) {
    const candidate = path.join(configDir, name);
    if (existsSync(candidate)) return candidate;
  }
  return path.join(configDir, "opencode.json");
}

function jsoncFormat() {
  return { formattingOptions: { insertSpaces: true, tabSize: 2 } };
}
