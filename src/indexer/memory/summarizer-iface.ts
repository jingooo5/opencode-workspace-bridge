import type { DebugContractRecord, DebugNodeRecord } from "../sqlite-store.js";

export type MemoryTargetKind = "CONTRACT" | "SYMBOL" | "ROOT";

export interface MemoryEvidenceRef {
  kind: string;
  ref: string;
  line?: number;
  note?: string;
}

export interface MemoryRootContext {
  rootName: string;
  rolePath?: string;
  access: string;
  filesIndexed?: number;
}

export interface MemoryContractContext {
  contract: DebugContractRecord;
}

export interface MemorySymbolContext {
  node: DebugNodeRecord;
}

export type MemoryTargetContext =
  | ({ kind: "CONTRACT" } & MemoryContractContext)
  | ({ kind: "SYMBOL" } & MemorySymbolContext)
  | ({ kind: "ROOT" } & MemoryRootContext);

export interface SummarizeRequest {
  target: MemoryTargetContext;
  evidenceRefs: MemoryEvidenceRef[];
}

/**
 * SummarizerProvider produces the markdown body for a memory entry.
 *
 * Default implementation in V0.2 is a deterministic template (see
 * summarizer-template.ts). LLM-backed providers can be plugged in via the
 * same interface in v0.3+ without changing the writer pipeline.
 */
export interface SummarizerProvider {
  readonly name: string;
  summarize(request: SummarizeRequest): string;
}
