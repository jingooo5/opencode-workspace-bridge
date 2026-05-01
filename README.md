# opencode-context-bridge v0.1.1 draft

A draft OpenCode plugin that adds multi-root workspace context orchestration.

## Automatic behavior

Users do **not** normally need to run `ctx_install_agents`, `ctx_index`, or `ctx_list_roots` manually.

- Agents are generated dynamically through the OpenCode config hook.
- `ctx-orchestrator` is injected as a primary agent and set as `default_agent` by default.
- Hidden subagents are injected automatically: `ctx-workspace-architect`, `ctx-context-curator`, `ctx-impact-analyst`, `ctx-test-router`.
- The plugin also runs a safe global bootstrap by default, writing global agent markdown files under `~/.config/opencode/agents` and patching `~/.config/opencode/opencode.jsonc` with `default_agent: "ctx-orchestrator"`.
- The lightweight evidence index is refreshed on startup and lazily before `ctx_search`, `ctx_pack`, and `ctx_impact`.

The manual tools still exist as repair/diagnostic tools:

- `ctx_install_agents`: re-run global bootstrap if the config was damaged or disabled.
- `ctx_index`: force-refresh the evidence index.
- `ctx_list_roots`: inspect active roots and stale/read-only status.

## Configuration options

```jsonc
{
  "plugin": [
    ["opencode-context-bridge", {
      "autoAgents": true,
      "autoDefaultAgent": true,
      "globalBootstrap": true,
      "globalInstallAgents": true,
      "globalSetDefaultAgent": true,
      "globalRegisterPlugin": false,
      "defaultAgentName": "ctx-orchestrator",
      "autoIndex": true
    }]
  ]
}
```

Set `globalBootstrap: false` to avoid any writes to `~/.config/opencode`. The runtime config hook still injects agents for the current process when `autoAgents` is enabled.

## Core tools

- `ctx_add_dir`
- `ctx_list_roots`
- `ctx_index`
- `ctx_search`
- `ctx_read`
- `ctx_pack`
- `ctx_impact`
- `ctx_install_agents` repair-only

## CLI usage

The package ships a `context-bridge` CLI (mapped from `dist/cli.js`) for one-shot global setup. The package is private (`name: "opencode-context-bridge"`), so `bunx context-bridge` will fail with `could not determine executable to run for package context-bridge` — `bunx` resolves the package **name** from the registry, not a local bin alias. Use one of the local invocations below instead.

### Run from a clone

```sh
bun install
bun run build

# Run the built CLI directly.
bun run dist/cli.js install
bun run dist/cli.js install --keep-default-agent
bun run dist/cli.js install --no-default-agent
bun run dist/cli.js doctor

# Or run the TypeScript source without building.
bun run src/cli.ts install
```

### Expose `context-bridge` on PATH

```sh
# Inside the repo: register the local package globally.
bun install
bun run build
bun link

# In any other directory: link the package into the current project,
# which puts the bin on PATH for that project.
bun link opencode-context-bridge

context-bridge install
context-bridge doctor
```

### Commands

```text
context-bridge install                          # register plugin + set default_agent=ctx-orchestrator (backs up existing config)
context-bridge install --keep-default-agent     # do not overwrite an existing default_agent
context-bridge install --no-default-agent       # register plugin only; never touch default_agent
context-bridge doctor                           # idempotent check; prints resolved config path
```

Notes:

- The CLI writes to `$OPENCODE_CONFIG_DIR` if set, otherwise `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode` (`%APPDATA%/opencode` on Windows).
- It picks the first existing `opencode.jsonc` / `opencode.json` / `config.json` in that directory, or creates `opencode.json` if none exist.
- A minimal `ctx-orchestrator` agent stub is written so `default_agent` resolves before the plugin's runtime config hook expands it on the next opencode start. **Restart opencode after running `install`.**
- The same setup also runs automatically on plugin startup via the global bootstrap, so the CLI is mainly for first-time install or repair.

This is a V0.1 scaffold. It intentionally uses a lightweight file scanner/indexer instead of tree-sitter so the plugin/hook/agent loop can be tested early.
