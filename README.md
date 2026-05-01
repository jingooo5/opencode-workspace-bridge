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

This is a V0.1 scaffold. It intentionally uses a lightweight file scanner/indexer instead of tree-sitter so the plugin/hook/agent loop can be tested early.
