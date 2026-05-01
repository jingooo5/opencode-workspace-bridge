import type { Hooks } from "@opencode-ai/plugin";
import type { WorkspaceStore } from "../state/workspace-store.js";
import type { SessionState } from "../state/session-state.js";
import type { RouteHint } from "../types.js";

export function createAutoRouterHooks(store: WorkspaceStore, sessions: SessionState): Pick<Hooks, "chat.message" | "experimental.chat.system.transform"> {
  return {
    "chat.message": async (input, output) => {
      const text = extractUserText(output.parts);
      if (!text) return;
      const hint = classify(text);
      if (!hint) return;
      sessions.setHint(input.sessionID, hint);
      await store.appendLedger({ type: "route.hint", sessionID: input.sessionID, hint });
    },

    "experimental.chat.system.transform": async (input, output) => {
      const manifest = await store.readManifest().catch(() => undefined);
      const hint = sessions.getHint(input.sessionID);
      const roots = manifest?.roots.map((root) => `${root.name}(${root.access}, ${root.role ?? "unknown"}${root.stale ? ", stale" : ""})`).join(", ") ?? "not initialized";

      output.system.push(`
## Context Bridge auto-routing policy
Active roots: ${roots}
Manifest path: ${store.manifestPath}

When the user task mentions cross-repository work, external directories, modules outside the primary root, shared types, DTOs, API contracts, network boundaries, gRPC/proto, GraphQL, cache keys, message topics, DB migrations, or targeted tests, you should use Context Bridge tools and hidden subagents without waiting for the user to @mention them.

Available hidden subagents through the Task tool:
- ctx-workspace-architect: workspace/root discovery and multi-root map
- ctx-context-curator: evidence-backed minimal context pack
- ctx-impact-analyst: DTO/API/schema/cache/topic/DB cross-root impact analysis
- ctx-test-router: affected test/build selection

Routing hint for this session:
${hint ? `- taskShape: ${hint.taskShape}\n- suggested agents: ${hint.agents.join(", ")}\n- reason: ${hint.reason}` : "- none yet"}

Default sequence for risky cross-root changes:
ctx_list_roots → ctx_pack → Task(ctx-impact-analyst) → edit only approved rw roots → Task(ctx-test-router).
`);
    },
  };
}

function classify(text: string): RouteHint | undefined {
  const lower = text.toLowerCase();
  const agents = new Set<string>();
  let taskShape: RouteHint["taskShape"] = "general";
  const reasons: string[] = [];

  if (/repo|repository|workspace|작업영역|레포|모듈|module|service|서비스|external|add-dir/.test(lower)) {
    agents.add("ctx-workspace-architect");
    agents.add("ctx-context-curator");
    taskShape = "workspace";
    reasons.push("workspace/repository/module language detected");
  }
  if (/dto|schema|payload|request|response|openapi|api|endpoint|grpc|proto|graphql|interface|인터페이스|스키마/.test(lower)) {
    agents.add("ctx-impact-analyst");
    agents.add("ctx-context-curator");
    taskShape = "contract";
    reasons.push("contract/interface/schema language detected");
  }
  if (/cache|redis|ttl|invalidation|kafka|topic|queue|pubsub|db|database|migration|table|column/.test(lower)) {
    agents.add("ctx-impact-analyst");
    taskShape = "impact";
    reasons.push("runtime boundary or data boundary language detected");
  }
  if (/test|검증|validate|build|lint|failure|bug|debug|오류|실패/.test(lower)) {
    agents.add("ctx-test-router");
    if (taskShape === "general") taskShape = /bug|debug|오류|실패/.test(lower) ? "debug" : "test";
    reasons.push("debug/test/validation language detected");
  }

  if (!agents.size) return undefined;
  return {
    agents: Array.from(agents),
    reason: reasons.join("; "),
    taskShape,
    createdAt: new Date().toISOString(),
  };
}

function extractUserText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part !== "object" || part === null) return "";
      const maybe = part as { type?: unknown; text?: unknown; content?: unknown };
      if (typeof maybe.text === "string") return maybe.text;
      if (typeof maybe.content === "string") return maybe.content;
      return "";
    })
    .join("\n");
}
