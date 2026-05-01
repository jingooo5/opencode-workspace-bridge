#!/usr/bin/env node
import { installGlobalConfig } from "./install/global-config.js";

async function main(argv: string[]) {
  const cmd = argv[2] ?? "help";
  if (cmd === "install") {
    const noDefault = argv.includes("--no-default-agent");
    const keepExistingDefault = argv.includes("--keep-default-agent");
    const result = await installGlobalConfig({
      setDefaultAgent: !noDefault,
      forceDefaultAgent: !keepExistingDefault,
    });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    console.log("Restart opencode to load Context Bridge agents and hooks.");
    return;
  }

  if (cmd === "doctor") {
    const result = await installGlobalConfig({ setDefaultAgent: false, forceDefaultAgent: false });
    console.log(JSON.stringify({ ok: true, configPath: result.configPath, pluginRegistered: true }, null, 2));
    return;
  }

  console.log(`Usage:
  context-bridge install [--keep-default-agent|--no-default-agent]
  context-bridge doctor

install modifies ~/.config/opencode/opencode.json by registering the plugin and setting default_agent to ctx-orchestrator by default.
`);
}

main(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
