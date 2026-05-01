import type { RouteHint } from "../types.js";

export class SessionState {
  private readonly hints = new Map<string, RouteHint>();
  private readonly touchedFiles = new Map<string, Set<string>>();

  setHint(sessionID: string, hint: RouteHint): void {
    this.hints.set(sessionID, hint);
  }

  getHint(sessionID: string | undefined): RouteHint | undefined {
    return sessionID ? this.hints.get(sessionID) : undefined;
  }

  touch(sessionID: string, ref: string): void {
    const set = this.touchedFiles.get(sessionID) ?? new Set<string>();
    set.add(ref);
    this.touchedFiles.set(sessionID, set);
  }

  touched(sessionID: string | undefined): string[] {
    if (!sessionID) return [];
    return Array.from(this.touchedFiles.get(sessionID) ?? []);
  }
}
