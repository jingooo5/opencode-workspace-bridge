import path from "node:path";
import { refOf } from "../../shared/path.js";
import type { RootSpec } from "../../types.js";
import type { ScannedFile } from "../scanner.js";
import type { ExtractedGraphFacts, ExtractedNodeKind } from "./ts-js.js";
import { emptyFacts, mergeFacts } from "./ts-js.js";

const PYTHON_METADATA_FILES = new Set(["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "pytest.ini", "tox.ini"]);
const PYTHON_HELPER_TIMEOUT_MS = 3_000;

interface PythonSymbol {
  kind: "function" | "class" | "import" | "route" | "client_call" | "test" | "dto";
  name: string;
  line: number;
  endLine?: number;
  attrs: Record<string, unknown>;
  confidence?: number;
}

interface PythonHelperResult {
  ok: boolean;
  symbols: PythonSymbol[];
  unresolved: Array<{ kind: string; name: string; line: number; attrs: Record<string, unknown>; reason: string }>;
  diagnostics: Array<{ level: "warn" | "error"; code: string; message: string }>;
}

export function isPythonFile(relPath: string): boolean {
  return path.extname(relPath).toLowerCase() === ".py";
}

export function isPythonMetadataFile(relPath: string): boolean {
  return PYTHON_METADATA_FILES.has(path.basename(relPath));
}

export function extractPythonFacts(root: RootSpec, file: ScannedFile, text: string, updatedAt: string): ExtractedGraphFacts {
  const facts: ExtractedGraphFacts[] = [];
  if (isPythonFile(file.relPath)) facts.push(extractPythonSourceFacts(root, file, text, updatedAt));
  if (isPythonMetadataFile(file.relPath)) facts.push(extractPythonMetadataFacts(root, file, text, updatedAt));
  return facts.length ? mergeFacts(facts) : emptyFacts();
}

function extractPythonSourceFacts(root: RootSpec, file: ScannedFile, text: string, updatedAt: string): ExtractedGraphFacts {
  const facts = emptyFacts();
  const lines = splitLines(text);
  const helper = runPythonHelper(text);
  if (helper.ok) {
    addHelperSymbols(facts, root, file, lines, updatedAt, helper.symbols);
    for (const unresolved of helper.unresolved) addUnresolved(facts, file, unresolved.kind, unresolved.name, unresolved.line, unresolved.attrs, unresolved.reason);
  } else {
    facts.diagnostics.push(...helper.diagnostics.map((diagnostic) => ({ ...diagnostic, path: file.absPath })));
    facts.diagnostics.push({ level: "warn", code: "python.degraded_text_fallback", message: "Python AST helper unavailable or failed; using bounded text-only extraction.", path: file.absPath });
    addHelperSymbols(facts, root, file, lines, updatedAt, fallbackTextSymbols(file.relPath, lines));
  }
  return sortFacts(dedupeLegacy(facts));
}

function extractPythonMetadataFacts(root: RootSpec, file: ScannedFile, text: string, updatedAt: string): ExtractedGraphFacts {
  const facts = emptyFacts();
  const basename = path.basename(file.relPath);
  const attrs = stableAttrs({
    buildCommands: metadataBuildCommands(basename, text),
    dependencies: metadataDependencies(basename, text),
    frameworkHints: frameworkHints(text),
    languageHints: ["python"],
    packageName: metadataPackageName(basename, text),
    source: basename,
    testCommands: metadataTestCommands(basename, text),
    type: "python-metadata",
  });
  const name = stringValue(attrs.packageName) ?? basename;
  addNode(facts, root, file, updatedAt, "PACKAGE", name, 1, 1, `${basename} ${name}`.trim(), attrs, 0.9);
  return sortFacts(dedupeLegacy(facts));
}

function addHelperSymbols(
  facts: ExtractedGraphFacts,
  root: RootSpec,
  file: ScannedFile,
  lines: string[],
  updatedAt: string,
  symbols: PythonSymbol[],
): void {
  for (const symbol of symbols) {
    const line = boundedLine(symbol.line, lines.length);
    const endLine = boundedLine(symbol.endLine ?? symbol.line, lines.length);
    const text = lineText(lines, line, symbol.name);
    if (symbol.kind === "import") {
      addUnresolved(facts, file, "IMPORT", symbol.name, line, { ...symbol.attrs, text }, "resolver_not_run");
      continue;
    }
    const kind = graphKind(symbol.kind);
    addNode(facts, root, file, updatedAt, kind, symbol.name, line, endLine, text, symbol.attrs, symbol.confidence ?? defaultConfidence(symbol.kind));
    if (kind === "FUNCTION" || kind === "CLASS") addNode(facts, root, file, updatedAt, "SYMBOL", symbol.name, line, endLine, text, { sourceKind: kind }, 1);
  }
}

function addNode(
  facts: ExtractedGraphFacts,
  root: RootSpec,
  file: ScannedFile,
  updatedAt: string,
  kind: ExtractedNodeKind,
  name: string,
  startLine: number,
  endLine: number,
  text: string,
  attrs: Record<string, unknown>,
  confidence: number,
): string {
  const id = stableId("node", kind, file.id, name, String(startLine));
  if (facts.nodes.some((node) => node.id === id)) return id;
  facts.nodes.push({ id, kind, name, rootId: file.rootId, fileId: file.id, startLine, endLine, attrs: stableAttrs(attrs), confidence });
  facts.spans.push({ id: stableId("span", kind, file.id, name, String(startLine)), rootId: file.rootId, fileId: file.id, startLine, endLine, text, kind });
  facts.edges.push({
    id: stableId("edge", "CONTAINS", `node:${file.id}`, id),
    fromId: `node:${file.id}`,
    toId: id,
    kind: "CONTAINS",
    fileId: file.id,
    startLine,
    endLine,
    attrs: {},
    confidence: 1,
  });
  const ref = refOf(root.name, file.relPath);
  if (kind === "FUNCTION" || kind === "CLASS" || kind === "SYMBOL" || kind === "DTO_CANDIDATE") {
    facts.legacyEntries.push({ root: root.name, ref, path: file.relPath, kind: "symbol", name, line: startLine, text, updatedAt });
  } else if (kind === "HTTP_ROUTE_CANDIDATE") {
    facts.legacyEntries.push({ root: root.name, ref, path: file.relPath, kind: "route", name, line: startLine, text, updatedAt });
  } else if (kind === "TEST_CANDIDATE") {
    facts.legacyEntries.push({ root: root.name, ref, path: file.relPath, kind: "test", name, line: startLine, text, updatedAt });
  } else if (kind === "PACKAGE") {
    facts.legacyEntries.push({ root: root.name, ref, path: file.relPath, kind: "package", name, line: startLine, text, updatedAt });
  }
  return id;
}

function addUnresolved(facts: ExtractedGraphFacts, file: ScannedFile, kind: string, name: string, line: number, attrs: Record<string, unknown>, reason: string): void {
  facts.unresolved.push({
    id: stableId("unresolved", kind, file.id, name, String(line)),
    kind,
    name,
    rootId: file.rootId,
    fileId: file.id,
    attrs: stableAttrs({ line, ...attrs }),
    reason,
  });
}

function runPythonHelper(text: string): PythonHelperResult {
  if (process.env.CTX_BRIDGE_DISABLE_PYTHON_HELPER === "1") return helperFailure("python.helper_disabled", "Python helper disabled by environment.");
  try {
    const proc = Bun.spawnSync({
      cmd: ["python3", "-c", PYTHON_HELPER],
      stdin: new TextEncoder().encode(text),
      stdout: "pipe",
      stderr: "pipe",
      timeout: PYTHON_HELPER_TIMEOUT_MS,
    });
    if (proc.exitCode !== 0) {
      const stderr = new TextDecoder().decode(proc.stderr).trim();
      return helperFailure("python.helper_failed", stderr || `python3 exited with code ${proc.exitCode}`);
    }
    const raw = new TextDecoder().decode(proc.stdout);
    const parsed = parseHelperResult(raw);
    return parsed ?? helperFailure("python.helper_invalid_output", "Python helper returned invalid JSON.");
  } catch (error) {
    return helperFailure("python.helper_unavailable", error instanceof Error ? error.message : String(error));
  }
}

function parseHelperResult(raw: string): PythonHelperResult | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || typeof value.ok !== "boolean" || !Array.isArray(value.symbols) || !Array.isArray(value.unresolved) || !Array.isArray(value.diagnostics)) return undefined;
    return {
      ok: value.ok,
      symbols: value.symbols.flatMap(toPythonSymbol),
      unresolved: value.unresolved.flatMap(toHelperUnresolved),
      diagnostics: value.diagnostics.flatMap(toHelperDiagnostic),
    };
  } catch {
    return undefined;
  }
}

function toPythonSymbol(value: unknown): PythonSymbol[] {
  if (!isRecord(value)) return [];
  const kind = typeof value.kind === "string" ? value.kind : "";
  if (!isPythonSymbolKind(kind) || typeof value.name !== "string" || typeof value.line !== "number") return [];
  return [{
    kind,
    name: value.name,
    line: value.line,
    endLine: typeof value.endLine === "number" ? value.endLine : undefined,
    attrs: isRecord(value.attrs) ? value.attrs : {},
    confidence: typeof value.confidence === "number" ? value.confidence : undefined,
  }];
}

function toHelperUnresolved(value: unknown): Array<{ kind: string; name: string; line: number; attrs: Record<string, unknown>; reason: string }> {
  if (!isRecord(value) || typeof value.kind !== "string" || typeof value.name !== "string" || typeof value.line !== "number" || typeof value.reason !== "string") return [];
  return [{ kind: value.kind, name: value.name, line: value.line, attrs: isRecord(value.attrs) ? value.attrs : {}, reason: value.reason }];
}

function toHelperDiagnostic(value: unknown): Array<{ level: "warn" | "error"; code: string; message: string }> {
  if (!isRecord(value) || (value.level !== "warn" && value.level !== "error") || typeof value.code !== "string" || typeof value.message !== "string") return [];
  return [{ level: value.level, code: value.code, message: value.message }];
}

function helperFailure(code: string, message: string): PythonHelperResult {
  return { ok: false, symbols: [], unresolved: [], diagnostics: [{ level: "warn", code, message }] };
}

function fallbackTextSymbols(relPath: string, lines: string[]): PythonSymbol[] {
  const symbols: PythonSymbol[] = [];
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const trimmed = line.trim();
    const functionMatch = trimmed.match(/^async\s+def\s+([A-Za-z_]\w*)\s*\(|^def\s+([A-Za-z_]\w*)\s*\(/);
    const classMatch = trimmed.match(/^class\s+([A-Za-z_]\w*)\s*(?:\(|:)/);
    const importMatch = trimmed.match(/^(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.]*))/);
    const routeMatch = trimmed.match(/^@(app|router|blueprint)\.(get|post|put|patch|delete|head|options|route)\s*\(\s*["']([^"']*)/i);
    const clientMatch = trimmed.match(/\b(requests|httpx)\.(get|post|put|patch|delete|head|options|request)\s*\(\s*["']([^"']*)/i);
    if (functionMatch?.[1] || functionMatch?.[2]) symbols.push({ kind: "function", name: functionMatch[1] ?? functionMatch[2], line: lineNo, attrs: { async: trimmed.startsWith("async "), source: "text_fallback" } });
    if (classMatch?.[1]) symbols.push({ kind: "class", name: classMatch[1], line: lineNo, attrs: { source: "text_fallback" } });
    if (importMatch?.[1] || importMatch?.[2]) symbols.push({ kind: "import", name: importMatch[1] ?? importMatch[2], line: lineNo, attrs: { source: "text_fallback" } });
    if (routeMatch?.[2] && routeMatch[3] !== undefined) symbols.push({ kind: "route", name: `${routeMatch[2].toUpperCase()} ${routeMatch[3] || "/"}`, line: lineNo, attrs: { method: routeMatch[2].toUpperCase(), path: routeMatch[3] || "/", reason: "decorator_text_match" }, confidence: 0.65 });
    if (clientMatch?.[2] && clientMatch[3] !== undefined) symbols.push({ kind: "client_call", name: `${clientMatch[2].toUpperCase()} ${clientMatch[3]}`, line: lineNo, attrs: { method: clientMatch[2].toUpperCase(), url: clientMatch[3], reason: "call_text_match" }, confidence: 0.6 });
  });
  if (/(^|\/)(test_[^/]+|[^/]+_test)\.py$/i.test(relPath) || lines.some((line) => /^\s*def\s+test_/.test(line))) {
    symbols.push({ kind: "test", name: path.basename(relPath), line: firstMatchingLine(lines, /^\s*def\s+test_/) ?? 1, attrs: { relPath, reason: "pytest_naming" }, confidence: 0.75 });
  }
  return symbols;
}

function metadataPackageName(basename: string, text: string): string | undefined {
  if (basename === "pyproject.toml") return matchFirst(text, /^name\s*=\s*["']([^"']+)["']/m);
  if (basename === "setup.py") return matchFirst(text, /setup\s*\([\s\S]*?name\s*=\s*["']([^"']+)["']/m);
  if (basename === "setup.cfg") return matchFirst(text, /^name\s*=\s*([^\n#]+)/m)?.trim();
  return undefined;
}

function metadataDependencies(basename: string, text: string): string[] {
  if (basename === "requirements.txt") return sortedUnique(text.split(/\r?\n/).flatMap(requirementName));
  if (basename === "setup.cfg") return sortedUnique(extractSetupCfgDependencies(text));
  const deps = new Set<string>();
  for (const match of text.matchAll(/["']([A-Za-z0-9_.-]+)(?:[<>=!~ ].*)?["']/g)) {
    const name = normalizeDependencyName(match[1]);
    if (name && name !== metadataPackageName(basename, text)?.toLowerCase() && knownDependencyContext(text, match.index ?? 0)) deps.add(name);
  }
  return [...deps].sort((a, b) => a.localeCompare(b));
}

function extractSetupCfgDependencies(text: string): string[] {
  const deps: string[] = [];
  const lines = splitLines(text);
  for (let index = 0; index < lines.length; index++) {
    if (!/^install_requires\s*=/.test(lines[index].trim())) continue;
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const line = lines[cursor];
      if (/^\[[^\]]+\]/.test(line.trim()) || (/^\S/.test(line) && !line.includes("="))) break;
      deps.push(...requirementName(line));
    }
  }
  return deps;
}

function requirementName(line: string): string[] {
  const cleaned = line.trim().replace(/\s+#.*$/, "");
  if (!cleaned || cleaned.startsWith("#") || cleaned.startsWith("-") || cleaned.includes("://")) return [];
  const name = normalizeDependencyName(cleaned.split(/[<>=!~;\[]/)[0]);
  return name ? [name] : [];
}

function metadataTestCommands(basename: string, text: string): Record<string, string> {
  const commands: Record<string, string> = {};
  if (basename === "tox.ini" && /\bcommands\s*=/.test(text)) commands.tox = "tox";
  if (basename === "pytest.ini") commands.pytest = "pytest";
  const script = matchFirst(text, /(?:test|pytest)[^\n=]*=\s*([^\n]+)/i);
  if (script) commands.configured = script.trim();
  return stableStringRecord(commands);
}

function metadataBuildCommands(basename: string, text: string): Record<string, string> {
  const commands: Record<string, string> = {};
  if (basename === "pyproject.toml" && /\[build-system\]/.test(text)) commands.build = "python -m build";
  const backend = matchFirst(text, /^build-backend\s*=\s*["']([^"']+)["']/m);
  if (backend) commands.buildBackend = backend;
  return stableStringRecord(commands);
}

function frameworkHints(text: string): string[] {
  const lower = text.toLowerCase();
  return ["fastapi", "flask", "django", "pydantic", "pytest", "requests", "httpx"].filter((name) => lower.includes(name));
}

function knownDependencyContext(text: string, index: number): boolean {
  return /dependencies|requires|install_requires|extras_require/.test(text.slice(Math.max(0, index - 120), index + 120));
}

function graphKind(kind: PythonSymbol["kind"]): ExtractedNodeKind {
  if (kind === "function") return "FUNCTION";
  if (kind === "class") return "CLASS";
  if (kind === "route") return "HTTP_ROUTE_CANDIDATE";
  if (kind === "client_call") return "HTTP_CLIENT_CALL_CANDIDATE";
  if (kind === "test") return "TEST_CANDIDATE";
  return "DTO_CANDIDATE";
}

function defaultConfidence(kind: PythonSymbol["kind"]): number {
  if (kind === "dto" || kind === "route" || kind === "client_call" || kind === "test") return 0.85;
  return 1;
}

function isPythonSymbolKind(kind: string): kind is PythonSymbol["kind"] {
  return ["function", "class", "import", "route", "client_call", "test", "dto"].includes(kind);
}

function boundedLine(line: number, lineCount: number): number {
  return Math.max(1, Math.min(Math.trunc(line), Math.max(1, lineCount)));
}

function lineText(lines: string[], line: number, fallback: string): string {
  return (lines[line - 1]?.trim() || fallback).slice(0, 240);
}

function firstMatchingLine(lines: string[], pattern: RegExp): number | undefined {
  const index = lines.findIndex((line) => pattern.test(line));
  return index >= 0 ? index + 1 : undefined;
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

function matchFirst(text: string, pattern: RegExp): string | undefined {
  return text.match(pattern)?.[1];
}

function normalizeDependencyName(value: string): string | undefined {
  const name = value.trim().toLowerCase().replaceAll("_", "-");
  return /^[a-z0-9][a-z0-9.-]*$/.test(name) ? name : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function stableStringRecord(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
}

function stableAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(attrs).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)));
}

function stableId(...parts: string[]): string {
  return parts.map((part) => part.replace(/[^A-Za-z0-9:_./-]+/g, "_")).join(":");
}

function sortFacts(facts: ExtractedGraphFacts): ExtractedGraphFacts {
  facts.nodes.sort((a, b) => a.id.localeCompare(b.id));
  facts.edges.sort((a, b) => a.id.localeCompare(b.id));
  facts.spans.sort((a, b) => a.id.localeCompare(b.id));
  facts.unresolved.sort((a, b) => a.id.localeCompare(b.id));
  facts.legacyEntries.sort((a, b) => `${a.path}:${a.kind}:${a.name}:${a.line ?? 0}`.localeCompare(`${b.path}:${b.kind}:${b.name}:${b.line ?? 0}`));
  facts.diagnostics.sort((a, b) => `${a.path ?? ""}:${a.code}`.localeCompare(`${b.path ?? ""}:${b.code}`));
  return facts;
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

const PYTHON_HELPER = String.raw`
import ast, json, sys

source = sys.stdin.read()
symbols = []
unresolved = []
diagnostics = []

def end_line(node):
    return getattr(node, "end_lineno", getattr(node, "lineno", 1))

def dotted(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = dotted(node.value)
        return (base + "." if base else "") + node.attr
    if isinstance(node, ast.Call):
        return dotted(node.func)
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None

def literal(node):
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None

def add(kind, name, node, attrs=None, confidence=None):
    item = {"kind": kind, "name": name, "line": getattr(node, "lineno", 1), "endLine": end_line(node), "attrs": attrs or {}}
    if confidence is not None:
        item["confidence"] = confidence
    symbols.append(item)

def decorator_route(dec):
    if not isinstance(dec, ast.Call):
        return None
    target = dotted(dec.func) or ""
    parts = target.split(".")
    if len(parts) < 2:
        return None
    method = parts[-1].lower()
    owner = parts[-2].lower()
    if method not in {"get", "post", "put", "patch", "delete", "head", "options", "route"}:
        return None
    if owner not in {"app", "router", "blueprint", "api"}:
        return None
    route_path = literal(dec.args[0]) if dec.args else None
    if route_path is None:
        return None
    methods = []
    for keyword in dec.keywords:
        if keyword.arg == "methods" and isinstance(keyword.value, (ast.List, ast.Tuple)):
            methods = [literal(item).upper() for item in keyword.value.elts if literal(item)]
    method_name = methods[0] if method == "route" and methods else method.upper()
    return method_name, route_path, target

def class_bases(node):
    return [name for base in node.bases for name in [dotted(base)] if name]

def has_dataclass(node):
    return any((dotted(dec) or "").split(".")[-1] == "dataclass" for dec in node.decorator_list)

def is_typed_dict(node, bases):
    return any(base.split(".")[-1] == "TypedDict" for base in bases)

def is_pydantic(node, bases):
    return any(base.split(".")[-1] == "BaseModel" for base in bases)

def call_target(node):
    return dotted(node.func) if isinstance(node, ast.Call) else None

try:
    tree = ast.parse(source, type_comments=True)
except SyntaxError as exc:
    print(json.dumps({"ok": False, "symbols": [], "unresolved": [], "diagnostics": [{"level": "warn", "code": "python.syntax_error", "message": f"{exc.msg} at line {exc.lineno or 0}"}]}))
    raise SystemExit(0)
except Exception as exc:
    print(json.dumps({"ok": False, "symbols": [], "unresolved": [], "diagnostics": [{"level": "warn", "code": "python.ast_parse_failed", "message": str(exc)}]}))
    raise SystemExit(0)

for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        for alias in node.names:
            name = alias.name
            add("import", name, node, {"alias": alias.asname, "importKind": "import"})
            unresolved.append({"kind": "IMPORT", "name": name, "line": getattr(node, "lineno", 1), "attrs": {"alias": alias.asname, "importKind": "import"}, "reason": "resolver_not_run"})
    elif isinstance(node, ast.ImportFrom):
        module = node.module or ""
        add("import", module or ".", node, {"level": node.level, "importKind": "from", "names": [alias.name for alias in node.names]})
        unresolved.append({"kind": "IMPORT", "name": module or ".", "line": getattr(node, "lineno", 1), "attrs": {"level": node.level, "importKind": "from", "names": [alias.name for alias in node.names]}, "reason": "resolver_not_run"})
    elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        add("function", node.name, node, {"async": isinstance(node, ast.AsyncFunctionDef)})
        if node.name.startswith("test_"):
            add("test", node.name, node, {"reason": "pytest_function_name"}, 0.9)
        for dec in node.decorator_list:
            route = decorator_route(dec)
            if route:
                method, route_path, target = route
                add("route", f"{method} {route_path or '/'}", node, {"method": method, "path": route_path or "/", "handler": node.name, "decorator": target, "confidenceReason": "static_decorator"}, 0.85)
    elif isinstance(node, ast.ClassDef):
        bases = class_bases(node)
        add("class", node.name, node, {"bases": bases})
        if has_dataclass(node):
            add("dto", node.name, node, {"sourceKind": "CLASS", "candidateKind": "dataclass", "confidence": 0.85, "reason": "dataclass_decorator"}, 0.85)
        if is_pydantic(node, bases):
            add("dto", node.name, node, {"sourceKind": "CLASS", "candidateKind": "pydantic", "confidence": 0.85, "reason": "BaseModel_base"}, 0.85)
        if is_typed_dict(node, bases):
            add("dto", node.name, node, {"sourceKind": "CLASS", "candidateKind": "typed_dict", "confidence": 0.85, "reason": "TypedDict_base"}, 0.85)
    elif isinstance(node, ast.Call):
        target = call_target(node) or ""
        parts = target.split(".")
        if len(parts) >= 2 and parts[-2] in {"requests", "httpx"} and parts[-1].lower() in {"get", "post", "put", "patch", "delete", "head", "options", "request"}:
            method = parts[-1].upper()
            if method == "REQUEST" and node.args:
                first = literal(node.args[0])
                if first:
                    method = first.upper()
            url_arg = node.args[1] if parts[-1].lower() == "request" and len(node.args) > 1 else (node.args[0] if node.args else None)
            url = literal(url_arg) or "<dynamic>"
            add("client_call", f"{method} {url}", node, {"method": method, "url": url, "target": target, "reason": "static_call_target"}, 0.8 if url != "<dynamic>" else 0.55)

print(json.dumps({"ok": True, "symbols": symbols, "unresolved": unresolved, "diagnostics": diagnostics}, sort_keys=True))
`;
