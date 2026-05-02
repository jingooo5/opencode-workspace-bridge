import type { SummarizerProvider, SummarizeRequest } from "./summarizer-iface.js";

export class TemplateSummarizer implements SummarizerProvider {
  readonly name = "template@v0.2";

  summarize(request: SummarizeRequest): string {
    if (request.target.kind === "CONTRACT") return summarizeContract(request);
    if (request.target.kind === "SYMBOL") return summarizeSymbol(request);
    return summarizeRoot(request);
  }
}

function summarizeContract(request: SummarizeRequest): string {
  if (request.target.kind !== "CONTRACT") return "";
  const contract = request.target.contract;
  const lines: string[] = [];
  lines.push(`# ${contract.kind}: ${contract.name}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(contractSummaryLine(contract));
  lines.push("");
  lines.push("## Evidence");
  lines.push("");
  for (const ref of request.evidenceRefs) lines.push(`- ${ref.kind} ${ref.ref}${ref.line ? `#L${ref.line}` : ""}${ref.note ? ` — ${ref.note}` : ""}`);
  lines.push("");
  if (contract.consumers.length > 0) {
    lines.push("## Consumers");
    lines.push("");
    for (const consumer of contract.consumers) lines.push(`- ${consumer.consumerNodeId} (root: ${consumer.consumerRootId})`);
    lines.push("");
  }
  if (contract.related.length > 0) {
    lines.push("## Related nodes");
    lines.push("");
    for (const related of contract.related) lines.push(`- ${related.relation}: ${related.nodeId}`);
    lines.push("");
  }
  lines.push("## Change policy");
  lines.push("");
  lines.push("- Treat this contract as a stable boundary: run ctx_impact and consumer checks before editing.");
  lines.push("- Memory body is generated from deterministic graph evidence; refresh via ctx_summarize when stale.");
  return lines.join("\n");
}

function contractSummaryLine(contract: { kind: string; name: string; rootName: string; relPath?: string }): string {
  const where = contract.relPath ? `${contract.rootName}:${contract.relPath}` : contract.rootName;
  switch (contract.kind) {
    case "HTTP_ROUTE":
      return `${contract.name} is an HTTP endpoint exposed by ${where}.`;
    case "DTO":
      return `${contract.name} is an exposed data transfer object defined in ${where}.`;
    case "PACKAGE":
      return `${contract.name} is a package contract whose metadata is at ${where}.`;
    case "CONTRACT_FILE":
      return `${contract.name} is a contract boundary file at ${where}; structural parsing is deferred to v0.3+.`;
    default:
      return `${contract.kind} ${contract.name} originates at ${where}.`;
  }
}

function summarizeSymbol(request: SummarizeRequest): string {
  if (request.target.kind !== "SYMBOL") return "";
  const node = request.target.node;
  const lines: string[] = [];
  lines.push(`# ${node.kind}: ${node.name}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  const where = node.relPath ? `${node.rootName}:${node.relPath}` : node.rootName;
  lines.push(`${node.name} is a ${node.kind.toLowerCase()} symbol at ${where}#L${node.startLine}.`);
  lines.push("");
  lines.push("## Evidence");
  lines.push("");
  for (const ref of request.evidenceRefs) lines.push(`- ${ref.kind} ${ref.ref}${ref.line ? `#L${ref.line}` : ""}`);
  return lines.join("\n");
}

function summarizeRoot(request: SummarizeRequest): string {
  if (request.target.kind !== "ROOT") return "";
  const root = request.target;
  const lines: string[] = [];
  lines.push(`# Root: ${root.rootName}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`${root.rootName} is a workspace root with access mode ${root.access}.`);
  if (typeof root.filesIndexed === "number") {
    lines.push(`Indexed ${root.filesIndexed} files in the most recent run.`);
  }
  lines.push("");
  if (request.evidenceRefs.length > 0) {
    lines.push("## Evidence");
    lines.push("");
    for (const ref of request.evidenceRefs) lines.push(`- ${ref.kind} ${ref.ref}`);
  }
  return lines.join("\n");
}
