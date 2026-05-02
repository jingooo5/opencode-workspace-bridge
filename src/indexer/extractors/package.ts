import path from "node:path";
import { refOf } from "../../shared/path.js";
import type { RootSpec } from "../../types.js";
import type { ScannedFile } from "../scanner.js";
import type { ExtractedGraphFacts } from "./ts-js.js";
import { emptyFacts } from "./ts-js.js";

const PACKAGE_METADATA_FILES = new Set(["package.json", "tsconfig.json", "bunfig.toml", "pnpm-workspace.yaml", "yarn.lock", "package-lock.json", "bun.lock", "bun.lockb"]);

export function isPackageMetadataFile(relPath: string): boolean {
  return PACKAGE_METADATA_FILES.has(path.basename(relPath)) || relPath === "tsconfig.json";
}

export function extractPackageFacts(root: RootSpec, file: ScannedFile, text: string, updatedAt: string): ExtractedGraphFacts {
  const facts = emptyFacts();
  const basename = path.basename(file.relPath);
  if (!isPackageMetadataFile(file.relPath)) return facts;

  if (basename === "package.json") return extractPackageJson(root, file, text, updatedAt);
  if (basename === "tsconfig.json") return extractTsConfig(root, file, text, updatedAt);
  if (basename === "pnpm-workspace.yaml") return workspaceNode(root, file, updatedAt, { manager: "pnpm", source: basename });
  if (basename === "bunfig.toml" || basename === "bun.lock" || basename === "bun.lockb") return workspaceNode(root, file, updatedAt, { manager: "bun", source: basename });
  if (basename === "yarn.lock") return workspaceNode(root, file, updatedAt, { manager: "yarn", source: basename });
  if (basename === "package-lock.json") return workspaceNode(root, file, updatedAt, { manager: "npm", source: basename });
  return facts;
}

function extractPackageJson(root: RootSpec, file: ScannedFile, text: string, updatedAt: string): ExtractedGraphFacts {
  const facts = emptyFacts();
  const parsed = parseJsonObject(text, file, facts);
  if (!parsed) return facts;

  const name = stringField(parsed, "name") ?? path.basename(path.dirname(file.relPath));
  const dependencies = dependencyNames(parsed);
  const scripts = objectKeys(parsed.scripts);
  const scriptCommands = commandMap(parsed.scripts, scripts);
  const buildScripts = scripts.filter((script) => /build|compile|bundle/i.test(script));
  const testScripts = scripts.filter((script) => /test|spec|check/i.test(script));
  const attrs = stableAttrs({
    buildCommands: commandMap(parsed.scripts, buildScripts),
    buildScripts,
    dependencies,
    devDependencies: objectKeys(parsed.devDependencies),
    frameworkHints: frameworkHints(parsed),
    languageHints: languageHints(parsed),
    packageManager: stringField(parsed, "packageManager"),
    private: typeof parsed.private === "boolean" ? parsed.private : undefined,
    scripts,
    scriptCommands,
    testCommands: commandMap(parsed.scripts, testScripts),
    testScripts,
    version: stringField(parsed, "version"),
  });
  addPackageNode(facts, root, file, updatedAt, name, attrs, 1);
  facts.legacyEntries.push({ root: root.name, ref: refOf(root.name, file.relPath), path: file.relPath, kind: "package", name, updatedAt });
  return sortFacts(facts);
}

function extractTsConfig(root: RootSpec, file: ScannedFile, text: string, updatedAt: string): ExtractedGraphFacts {
  const facts = emptyFacts();
  const parsed = parseJsonObject(text, file, facts);
  if (!parsed) return facts;
  const compilerOptions = isRecord(parsed.compilerOptions) ? parsed.compilerOptions : {};
  addPackageNode(facts, root, file, updatedAt, "tsconfig.json", stableAttrs({
    extends: stringField(parsed, "extends"),
    jsx: stringField(compilerOptions, "jsx"),
    module: stringField(compilerOptions, "module"),
    moduleResolution: stringField(compilerOptions, "moduleResolution"),
    paths: objectKeys(compilerOptions.paths),
    target: stringField(compilerOptions, "target"),
    type: "typescript-config",
  }), 0.95);
  return sortFacts(facts);
}

function workspaceNode(root: RootSpec, file: ScannedFile, updatedAt: string, attrs: Record<string, unknown>): ExtractedGraphFacts {
  const facts = emptyFacts();
  addPackageNode(facts, root, file, updatedAt, path.basename(file.relPath), stableAttrs({ ...attrs, type: "workspace-metadata" }), 0.8);
  return sortFacts(facts);
}

function addPackageNode(
  facts: ExtractedGraphFacts,
  root: RootSpec,
  file: ScannedFile,
  updatedAt: string,
  name: string,
  attrs: Record<string, unknown>,
  confidence: number,
): void {
  const lineText = `${path.basename(file.relPath)} ${name}`.trim();
  const id = stableId("node", "PACKAGE", file.id, name);
  facts.nodes.push({ id, kind: "PACKAGE", name, rootId: file.rootId, fileId: file.id, startLine: 1, endLine: 1, attrs, confidence });
  facts.spans.push({ id: stableId("span", "PACKAGE", file.id, name), rootId: file.rootId, fileId: file.id, startLine: 1, endLine: 1, text: lineText, kind: "PACKAGE" });
  facts.edges.push({
    id: stableId("edge", "CONTAINS", `node:${file.id}`, id),
    fromId: `node:${file.id}`,
    toId: id,
    kind: "CONTAINS",
    fileId: file.id,
    startLine: 1,
    endLine: 1,
    attrs: {},
    confidence: 1,
  });
  if (path.basename(file.relPath) !== "package.json") {
    facts.legacyEntries.push({ root: root.name, ref: refOf(root.name, file.relPath), path: file.relPath, kind: "package", name, text: lineText, updatedAt });
  }
}

function parseJsonObject(text: string, file: ScannedFile, facts: ExtractedGraphFacts): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    if (isRecord(value)) return value;
    facts.unresolved.push({ id: stableId("unresolved", "JSON_METADATA", file.id), kind: "JSON_METADATA", name: path.basename(file.relPath), rootId: file.rootId, fileId: file.id, attrs: {}, reason: "json_root_not_object" });
    return undefined;
  } catch (error) {
    facts.diagnostics.push({ level: "warn", code: "package.malformed_json", message: error instanceof Error ? error.message : String(error), path: file.absPath });
    facts.unresolved.push({ id: stableId("unresolved", "JSON_METADATA", file.id), kind: "JSON_METADATA", name: path.basename(file.relPath), rootId: file.rootId, fileId: file.id, attrs: {}, reason: "malformed_json" });
    return undefined;
  }
}

function dependencyNames(pkg: Record<string, unknown>): string[] {
  return sortedUnique([...objectKeys(pkg.dependencies), ...objectKeys(pkg.peerDependencies), ...objectKeys(pkg.optionalDependencies)]);
}

function frameworkHints(pkg: Record<string, unknown>): string[] {
  const deps = new Set([...dependencyNames(pkg), ...objectKeys(pkg.devDependencies)]);
  return ["react", "next", "vue", "svelte", "express", "fastify", "hono", "nestjs", "astro", "vite", "bun"].filter((name) => deps.has(name) || deps.has(`@${name}/core`));
}

function languageHints(pkg: Record<string, unknown>): string[] {
  const deps = new Set([...dependencyNames(pkg), ...objectKeys(pkg.devDependencies)]);
  const hints = ["javascript"];
  if (deps.has("typescript") || deps.has("ts-node") || deps.has("tsx")) hints.push("typescript");
  return hints;
}

function objectKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value).sort((a, b) => a.localeCompare(b)) : [];
}

function commandMap(value: unknown, keys: string[]): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(keys.flatMap((key) => (typeof value[key] === "string" ? [[key, value[key] as string]] : [])));
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
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
  facts.legacyEntries.sort((a, b) => `${a.path}:${a.kind}:${a.name}`.localeCompare(`${b.path}:${b.kind}:${b.name}`));
  facts.diagnostics.sort((a, b) => `${a.path ?? ""}:${a.code}`.localeCompare(`${b.path ?? ""}:${b.code}`));
  return facts;
}
