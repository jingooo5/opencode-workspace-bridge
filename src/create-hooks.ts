import type { Hooks } from "@opencode-ai/plugin";
import type { Managers } from "./create-managers.js";
import { createAutoRouterHooks, createCompactionHook, createEventHook, createSafetyHooks, createShellEnvHook } from "./hooks/index.js";

export function createHooks(managers: Managers): Partial<Hooks> {
  return {
    ...createEventHook(managers.store),
    ...createShellEnvHook(managers.store),
    ...createAutoRouterHooks(managers.store, managers.sessions),
    ...createSafetyHooks(managers.store, managers.sessions),
    ...createCompactionHook(managers.store, managers.sessions),
  };
}
