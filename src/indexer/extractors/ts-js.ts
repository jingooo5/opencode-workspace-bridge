import path from "node:path";
import { refOf } from "../../shared/path.js";
import type { IndexEntry, RootSpec } from "../../types.js";
import type { ScannedFile } from "../scanner.js";

export type ExtractedNodeKind =
  | "SYMBOL"
  | "FUNCTION"
  | "CLASS"
  | "TYPE"
  | "DTO_CANDIDATE"
  | "HTTP_ROUTE_CANDIDATE"
  | "HTTP_CLIENT_CALL_CANDIDATE"
  | "TEST_CANDIDATE"
  | "PACKAGE";

export interface ExtractedNode {
  id: string;
  kind: ExtractedNodeKind;
  name: string;
  rootId: string;
  fileId: string;
  startLine: number;
  endLine: number;
  attrs: Record<string, unknown>;
  confidence: number;
}

export interface ExtractedEdge {
  id: string;
  fromId?: string;
  toId?: string;
  kind: string;
  fileId: string;
  startLine?: number;
  endLine?: number;
  attrs: Record<string, unknown>;
  confidence: number;
}

export interface ExtractedSpan {
  id: string;
  rootId: string;
  fileId: string;
  startLine: number;
  endLine: number;
  text?: string;
  kind?: string;
}

export interface ExtractedUnresolved {
  id: string;
  kind: string;
  name: string;
  rootId: string;
  fileId?: string;
  attrs: Record<string, unknown>;
  reason: string;
}

export interface ExtractedGraphFacts {
  nodes: ExtractedNode[];
  edges: ExtractedEdge[];
  spans: ExtractedSpan[];
  unresolved: ExtractedUnresolved[];
  legacyEntries: IndexEntry[];
  diagnostics: Array<{ level: "warn" | "error"; code: string; message: string; path?: string }>;
}

interface LineMatch {
  name: string;
  line: number;
  text: string;
  groups: Record<string, string | undefined>;
}

const TS_JS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export function isTsJsFile(relPath: string): boolean {
  return TS_JS_EXTENSIONS.has(path.extname(relPath).toLowerCase());
}

export function extractTsJsFacts(root: RootSpec, file: ScannedFile, text: string, updatedAt: string): ExtractedGraphFacts {
  const facts = emptyFacts();
  if (!isTsJsFile(file.relPath)) return facts;

  const lines = splitLines(text);
  const ref = refOf(root.name, file.relPath);
  const fileNodeId = `node:${file.id}`;
  const routeMatches = matchRouteCandidates(lines);
  const clientCallMatches = matchClientCallCandidates(lines);
  const routeClientContextLines = [...routeMatches, ...clientCallMatches].map((match) => match.line);

  for (const diagnostic of lightweightSyntaxDiagnostics(text, file.absPath)) facts.diagnostics.push(diagnostic);

  const seenNodes = new Set<string>();
  const addNode = (kind: ExtractedNodeKind, name: string, line: number, lineText: string, attrs: Record<string, unknown>, confidence = 1): string => {
    const id = stableId("node", kind, file.id, name, String(line));
    if (seenNodes.has(id)) return id;
    seenNodes.add(id);
    facts.nodes.push({ id, kind, name, rootId: file.rootId, fileId: file.id, startLine: line, endLine: line, attrs: stableAttrs(attrs), confidence });
    facts.spans.push({ id: stableId("span", kind, file.id, name, String(line)), rootId: file.rootId, fileId: file.id, startLine: line, endLine: line, text: lineText, kind });
    facts.edges.push({
      id: stableId("edge", "CONTAINS", fileNodeId, id),
      fromId: fileNodeId,
      toId: id,
      kind: "CONTAINS",
      fileId: file.id,
      startLine: line,
      endLine: line,
      attrs: {},
      confidence: 1,
    });
    if (kind === "FUNCTION" || kind === "CLASS" || kind === "TYPE" || kind === "SYMBOL" || kind === "DTO_CANDIDATE") {
      facts.legacyEntries.push({ root: root.name, ref, path: file.relPath, kind: "symbol", name, line, text: lineText, updatedAt });
    } else if (kind === "HTTP_ROUTE_CANDIDATE") {
      facts.legacyEntries.push({ root: root.name, ref, path: file.relPath, kind: "route", name, line, text: lineText, updatedAt });
    } else if (kind === "TEST_CANDIDATE") {
      facts.legacyEntries.push({ root: root.name, ref, path: file.relPath, kind: "test", name, line, text: lineText, updatedAt });
    }
    return id;
  };
  const isExportedMatch = (match: LineMatch) => exportedNames.has(match.name) || /^export\b/.test(match.text);
  const addDtoCandidate = (sourceKind: "TYPE" | "CLASS", match: LineMatch, exported: boolean): void => {
    const dtoReason = dtoCandidateReason(match.name, file.relPath, exported, match.line, routeClientContextLines);
    if (!dtoReason) return;
    addNode("DTO_CANDIDATE", match.name, match.line, match.text, { exported, reason: dtoReason, sourceKind }, 0.85);
  };
  const addSymbolNode = (sourceKind: "FUNCTION" | "CLASS" | "TYPE", match: LineMatch, exported: boolean): void => {
    addNode("SYMBOL", match.name, match.line, match.text, { exported, sourceKind }, 1);
  };

  const exportedNames = collectExportedNames(lines);
  for (const match of matchLines(lines, [
    /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+(?<name>[A-Za-z_$][\w$]*)/,
    /\b(?:async\s+)?function\s+(?<name>[A-Za-z_$][\w$]*)/,
    /\bexport\s+const\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
    /\bconst\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  ])) {
    const exported = isExportedMatch(match);
    const nodeId = addNode("FUNCTION", match.name, match.line, match.text, { exported });
    addSymbolNode("FUNCTION", match, exported);
    if (exported) addExportEdge(facts, file.id, fileNodeId, nodeId, match.name, match.line);
  }

  for (const match of matchLines(lines, [/\bexport\s+(?:default\s+)?class\s+(?<name>[A-Za-z_$][\w$]*)/, /\bclass\s+(?<name>[A-Za-z_$][\w$]*)/])) {
    const exported = isExportedMatch(match);
    const nodeId = addNode("CLASS", match.name, match.line, match.text, { exported });
    addSymbolNode("CLASS", match, exported);
    addDtoCandidate("CLASS", match, exported);
    if (exported) addExportEdge(facts, file.id, fileNodeId, nodeId, match.name, match.line);
  }

  for (const match of matchLines(lines, [
    /\bexport\s+interface\s+(?<name>[A-Za-z_$][\w$]*)/,
    /\binterface\s+(?<name>[A-Za-z_$][\w$]*)/,
    /\bexport\s+type\s+(?<name>[A-Za-z_$][\w$]*)\s*=/,
    /\btype\s+(?<name>[A-Za-z_$][\w$]*)\s*=/,
    /\bexport\s+enum\s+(?<name>[A-Za-z_$][\w$]*)/,
    /\benum\s+(?<name>[A-Za-z_$][\w$]*)/,
  ])) {
    const exported = isExportedMatch(match);
    const nodeId = addNode("TYPE", match.name, match.line, match.text, { exported });
    addSymbolNode("TYPE", match, exported);
    addDtoCandidate("TYPE", match, exported);
    if (exported) addExportEdge(facts, file.id, fileNodeId, nodeId, match.name, match.line);
  }

  for (const match of routeMatches) {
    const method = (match.groups.method ?? match.groups[1] ?? "GET").toUpperCase();
    const routePath = match.groups.routePath ?? match.groups[2] ?? "/";
    addNode("HTTP_ROUTE_CANDIDATE", `${method} ${routePath || "/"}`, match.line, match.text, { method, path: routePath || "/" }, 0.9);
  }

  for (const match of clientCallMatches) {
    const method = (match.groups.method ?? "GET").toUpperCase();
    const url = match.groups.url ?? match.name;
    addNode("HTTP_CLIENT_CALL_CANDIDATE", `${method} ${url}`, match.line, match.text, { method, url }, 0.85);
  }

  if (/(^|[./_-])(test|spec)\.[cm]?[jt]sx?$/i.test(file.relPath) || /\b(describe|it|test)\s*\(/.test(text)) {
    const firstTestLine = lines.findIndex((line) => /\b(describe|it|test)\s*\(/.test(line)) + 1 || 1;
    addNode("TEST_CANDIDATE", path.basename(file.relPath), firstTestLine, lines[firstTestLine - 1]?.trim().slice(0, 240) ?? path.basename(file.relPath), { relPath: file.relPath }, 0.9);
  }

  for (const unresolved of collectUnresolvedImports(lines, file)) facts.unresolved.push(unresolved);
  for (const exported of exportedNames) {
    facts.edges.push({
      id: stableId("edge", "EXPORTS_NAME", fileNodeId, exported),
      fromId: fileNodeId,
      kind: "EXPORTS_NAME",
      fileId: file.id,
      attrs: { name: exported },
      confidence: 0.75,
    });
  }

  return sortFacts(dedupeLegacy(facts));
}

export function emptyFacts(): ExtractedGraphFacts {
  return { nodes: [], edges: [], spans: [], unresolved: [], legacyEntries: [], diagnostics: [] };
}

export function mergeFacts(items: ExtractedGraphFacts[]): ExtractedGraphFacts {
  return sortFacts({
    nodes: items.flatMap((item) => item.nodes),
    edges: items.flatMap((item) => item.edges),
    spans: items.flatMap((item) => item.spans),
    unresolved: items.flatMap((item) => item.unresolved),
    legacyEntries: items.flatMap((item) => item.legacyEntries),
    diagnostics: items.flatMap((item) => item.diagnostics),
  });
}

function collectUnresolvedImports(lines: string[], file: ScannedFile): ExtractedUnresolved[] {
  const out: ExtractedUnresolved[] = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^"'`]+?\s+from\s+)?["'`](?<source>[^"'`]+)["'`]/,
    /\brequire\s*\(\s*["'`](?<source>[^"'`]+)["'`]\s*\)/,
    /\bimport\s*\(\s*["'`](?<source>[^"'`]+)["'`]\s*\)/,
    /\bexport\s+[^"'`]+\s+from\s+["'`](?<source>[^"'`]+)["'`]/,
  ];
  for (const match of matchLines(lines, patterns)) {
    const source = match.groups.source ?? match.name;
    out.push({
      id: stableId("unresolved", "IMPORT", file.id, source, String(match.line)),
      kind: "IMPORT",
      name: source,
      rootId: file.rootId,
      fileId: file.id,
      attrs: { line: match.line, text: match.text },
      reason: "resolver_not_run",
    });
  }
  return out;
}

function collectExportedNames(lines: string[]): Set<string> {
  const names = new Set<string>();
  for (const line of lines) {
    const direct = line.match(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/);
    if (direct?.[1]) names.add(direct[1]);
    const list = line.match(/\bexport\s*\{([^}]+)\}/);
    if (list?.[1]) {
      for (const part of list[1].split(",")) {
        const cleaned = part.trim().split(/\s+as\s+/i).pop()?.trim();
        if (cleaned && /^[A-Za-z_$][\w$]*$/.test(cleaned)) names.add(cleaned);
      }
    }
  }
  return names;
}

function matchLines(lines: string[], patterns: RegExp[]): LineMatch[] {
  const hits: LineMatch[] = [];
  lines.forEach((line, index) => {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (!match) continue;
      const groups = { ...(match.groups ?? {}) } as Record<string, string | undefined>;
      match.forEach((value, idx) => {
        if (idx > 0) groups[String(idx)] = value;
      });
      const name = groups.name ?? groups.routePath ?? groups.url ?? groups.source ?? groups[1];
      if (!name) continue;
      hits.push({ name, line: index + 1, text: line.trim().slice(0, 240), groups });
      break;
    }
  });
  return hits;
}

function matchRouteCandidates(lines: string[]): LineMatch[] {
  return matchLines(lines, [
    /\b(?:router|app)\.(?<method>get|post|put|patch|delete|head|options)\s*\(\s*["'`](?<routePath>[^"'`]+)["'`]/i,
    /@(Get|Post|Put|Patch|Delete|Head|Options)\s*\(\s*["'`]?([^"'`)]*)["'`]?\s*\)/,
  ]);
}

function matchClientCallCandidates(lines: string[]): LineMatch[] {
  return matchLines(lines, [
    /\bfetch\s*\(\s*["'`](?<url>[^"'`]+)["'`]/i,
    /\baxios\.(?<method>get|post|put|patch|delete|head|options)\s*\(\s*["'`](?<url>[^"'`]+)["'`]/i,
  ]);
}

function addExportEdge(facts: ExtractedGraphFacts, fileId: string, fileNodeId: string, nodeId: string, name: string, line: number): void {
  facts.edges.push({
    id: stableId("edge", "EXPORTS", fileNodeId, nodeId),
    fromId: fileNodeId,
    toId: nodeId,
    kind: "EXPORTS",
    fileId,
    startLine: line,
    endLine: line,
    attrs: { name },
    confidence: 1,
  });
}

function lightweightSyntaxDiagnostics(text: string, filePath: string): ExtractedGraphFacts["diagnostics"] {
  const diagnostics: ExtractedGraphFacts["diagnostics"] = [];
  for (const [open, close, code] of [["{", "}", "brace"], ["(", ")", "paren"], ["[", "]", "bracket"]] as const) {
    if (countChar(text, open) !== countChar(text, close)) {
      diagnostics.push({ level: "warn", code: `tsjs.malformed_${code}_balance`, message: `Possible malformed TS/JS: unbalanced ${open}${close}.`, path: filePath });
    }
  }
  return diagnostics;
}

function dtoCandidateReason(name: string, relPath: string, exported: boolean, line: number, routeClientContextLines: number[]): string | undefined {
  if (!exported) return undefined;
  if (/(Dto|DTO|Input|Payload|Request|Response|Event)$/.test(name)) return "name_suffix";
  if (isDtoCandidatePath(relPath)) return "path_context";
  if (isNearRouteClientCandidate(line, routeClientContextLines)) return "route_client_context";
  return undefined;
}

function isDtoCandidatePath(relPath: string): boolean {
  return relPath.split("/").some((part) => /^(shared|types|schema|schemas)$/i.test(part));
}

function isNearRouteClientCandidate(line: number, routeClientContextLines: number[]): boolean {
  return routeClientContextLines.some((candidateLine) => Math.abs(candidateLine - line) <= 2);
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

function stableId(...parts: string[]): string {
  return parts.map((part) => part.replace(/[^A-Za-z0-9:_./-]+/g, "_")).join(":");
}

function stableAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b)));
}

function countChar(text: string, char: string): number {
  return [...text].filter((item) => item === char).length;
}

function sortFacts(facts: ExtractedGraphFacts): ExtractedGraphFacts {
  return {
    nodes: facts.nodes.sort((a, b) => a.id.localeCompare(b.id)),
    edges: facts.edges.sort((a, b) => a.id.localeCompare(b.id)),
    spans: facts.spans.sort((a, b) => a.id.localeCompare(b.id)),
    unresolved: facts.unresolved.sort((a, b) => a.id.localeCompare(b.id)),
    legacyEntries: facts.legacyEntries.sort((a, b) => `${a.path}:${a.kind}:${a.name}:${a.line ?? 0}`.localeCompare(`${b.path}:${b.kind}:${b.name}:${b.line ?? 0}`)),
    diagnostics: facts.diagnostics.sort((a, b) => `${a.path ?? ""}:${a.code}`.localeCompare(`${b.path ?? ""}:${b.code}`)),
  };
}

function dedupeLegacy(facts: ExtractedGraphFacts): ExtractedGraphFacts {
  const seen = new Set<string>();
  facts.legacyEntries = facts.legacyEntries.filter((entry) => {
    const key = `${entry.path}:${entry.kind}:${entry.name}:${entry.line ?? 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return facts;
}
