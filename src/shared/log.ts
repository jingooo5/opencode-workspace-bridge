import type { PluginInput } from "@opencode-ai/plugin";

export async function log(ctx: PluginInput, level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) {
  try {
    await ctx.client.app.log({
      body: {
        service: "opencode-context-bridge",
        level,
        message,
        extra: extra ?? {},
      },
    });
  } catch {
    // Logging must never break a plugin hook.
  }
}
