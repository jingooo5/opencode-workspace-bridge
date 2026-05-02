import path from "node:path";

export interface ResolverFileRecord {
  id: string;
  rootId: string;
  relPath: string;
}

export interface ResolverNodeRecord {
  id: string;
  kind: string;
  name: string;
  rootId: string;
  fileId?: string;
  startLine: number;
  endLine: number;
  attrs: Record<string, unknown>;
  confidence: number;
}

export interface ResolverUnresolvedRecord {
  id: string;
  kind: string;
  name: string;
  rootId: string;
  fileId?: string;
  attrs: Record<string, unknown>;
  reason: string;
}

export interface ResolverEdgeRecord {
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

export interface ResolverFacts {
  edges: ResolverEdgeRecord[];
  unresolved: ResolverUnresolvedRecord[];
}

const RESOLVABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".py"] as const;
const RESOLVER_ATTR = { resolver: "mvp", resolverGenerated: true } as const;

export function buildResolverFacts(input: {
  files: ResolverFileRecord[];
  nodes: ResolverNodeRecord[];
  unresolved: ResolverUnresolvedRecord[];
}): ResolverFacts {
  const builder = new ResolverBuilder(input.files, input.nodes, input.unresolved);
  builder.resolveLocalImports();
  builder.resolvePackageDependencies();
  builder.resolvePackageImports();
  builder.resolveEndpoints();
  builder.resolveTests();
  return builder.facts();
}

class ResolverBuilder {
  private readonly filesById = new Map<string, ResolverFileRecord>();
  private readonly fileNodeIds = new Map<string, string>();
  private readonly nodesByKind = new Map<string, ResolverNodeRecord[]>();
  private readonly packageNodesByName = new Map<string, ResolverNodeRecord[]>();
  private readonly rootPackageNodes = new Map<string, ResolverNodeRecord[]>();
  private readonly edges = new Map<string, ResolverEdgeRecord>();
  private readonly pending = new Map<string, ResolverUnresolvedRecord>();

  constructor(
    files: ResolverFileRecord[],
    nodes: ResolverNodeRecord[],
    private readonly unresolved: ResolverUnresolvedRecord[],
  ) {
    for (const file of files) this.filesById.set(file.id, file);
    for (const node of nodes) {
      if (node.kind === "FILE" && node.fileId) this.fileNodeIds.set(node.fileId, node.id);
      const byKind = this.nodesByKind.get(node.kind) ?? [];
      byKind.push(node);
      this.nodesByKind.set(node.kind, byKind);
      if (node.kind === "PACKAGE") {
        const normalizedName = normalizePackageName(node.name);
        const byName = this.packageNodesByName.get(normalizedName) ?? [];
        byName.push(node);
        this.packageNodesByName.set(normalizedName, byName);
        const byRoot = this.rootPackageNodes.get(node.rootId) ?? [];
        byRoot.push(node);
        this.rootPackageNodes.set(node.rootId, byRoot);
      }
    }
  }

  facts(): ResolverFacts {
    return {
      edges: [...this.edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
      unresolved: [...this.pending.values()].sort((left, right) => left.id.localeCompare(right.id)),
    };
  }

  resolveLocalImports(): void {
    for (const item of this.imports()) {
      if (!isRelativeImport(item.name) || !item.fileId) continue;
      const sourceFile = this.filesById.get(item.fileId);
      const sourceNodeId = this.fileNodeIds.get(item.fileId);
      if (!sourceFile || !sourceNodeId) continue;
      const targets = this.localImportTargets(sourceFile, item.name);
      if (targets.length === 1) {
        const targetNodeId = this.fileNodeIds.get(targets[0].id);
        if (!targetNodeId) continue;
        this.addEdge({
          id: stableId("edge", "resolver", "IMPORTS", item.fileId, targets[0].id, String(lineOf(item))),
          fromId: sourceNodeId,
          toId: targetNodeId,
          kind: "IMPORTS",
          fileId: item.fileId,
          startLine: lineOf(item),
          endLine: lineOf(item),
          attrs: stableAttrs({ ...RESOLVER_ATTR, importSource: item.name, resolution: "same_root_relative", targetPath: targets[0].relPath }),
          confidence: 0.95,
        });
      } else {
        this.addPending(item, targets.length > 1 ? "resolver_ambiguous_local_import" : "resolver_local_import_not_found", {
          candidates: targets.map((target) => target.relPath),
          importSource: item.name,
        });
      }
    }
  }

  resolvePackageDependencies(): void {
    for (const node of this.packageNodes()) {
      for (const dependency of dependencyNames(node)) {
        const candidates = this.packageCandidates(dependency, node.rootId, true);
        if (candidates.length === 1) {
          this.addEdge({
            id: stableId("edge", "resolver", "DEPENDS_ON_PACKAGE", node.id, candidates[0].id, dependency),
            fromId: node.id,
            toId: candidates[0].id,
            kind: "DEPENDS_ON_PACKAGE",
            fileId: node.fileId ?? "",
            startLine: node.startLine,
            endLine: node.endLine,
            attrs: stableAttrs({ ...RESOLVER_ATTR, dependency, resolution: "package_metadata_name_match" }),
            confidence: 0.9,
          });
        } else if (candidates.length > 1 && node.fileId) {
          this.addSyntheticPending("PACKAGE_DEPENDENCY", dependency, node.rootId, node.fileId, "resolver_ambiguous_package_dependency", {
            candidates: candidates.map((candidate) => ({ id: candidate.id, rootId: candidate.rootId })),
            dependency,
          });
        }
      }
    }
  }

  resolvePackageImports(): void {
    for (const item of this.imports()) {
      if (isRelativeImport(item.name) || !item.fileId) continue;
      const sourceFile = this.filesById.get(item.fileId);
      const sourceNodeId = this.fileNodeIds.get(item.fileId);
      const packageName = packageNameOfImport(item.name);
      if (!sourceFile || !sourceNodeId || !packageName) continue;
      if (!rootDeclaresDependency(sourceFile.rootId, packageName, this.rootPackageNodes)) {
        this.addPending(item, "resolver_package_metadata_missing", { importSource: item.name, packageName });
        continue;
      }
      const candidates = this.packageCandidates(packageName, sourceFile.rootId, true);
      if (candidates.length === 1) {
        this.addEdge({
          id: stableId("edge", "resolver", "IMPORTS", item.fileId, candidates[0].id, String(lineOf(item))),
          fromId: sourceNodeId,
          toId: candidates[0].id,
          kind: "IMPORTS",
          fileId: item.fileId,
          startLine: lineOf(item),
          endLine: lineOf(item),
          attrs: stableAttrs({ ...RESOLVER_ATTR, importSource: item.name, packageName, resolution: "package_metadata_name_match" }),
          confidence: 0.8,
        });
      } else {
        this.addPending(item, candidates.length > 1 ? "resolver_ambiguous_package_import" : "resolver_package_target_not_found", {
          candidates: candidates.map((candidate) => ({ id: candidate.id, rootId: candidate.rootId })),
          importSource: item.name,
          packageName,
        });
      }
    }
  }

  resolveEndpoints(): void {
    const routesByKey = new Map<string, ResolverNodeRecord[]>();
    for (const route of this.nodesOfKind("HTTP_ROUTE_CANDIDATE")) {
      const key = endpointKey(route);
      if (!key) continue;
      const keyText = endpointKeyText(key);
      const items = routesByKey.get(keyText) ?? [];
      items.push(route);
      routesByKey.set(keyText, items);
    }
    for (const client of this.nodesOfKind("HTTP_CLIENT_CALL_CANDIDATE")) {
      const key = endpointKey(client);
      if (!key || !client.fileId) {
        if (client.fileId) this.addSyntheticPending("ENDPOINT", client.name, client.rootId, client.fileId, "resolver_endpoint_not_static", { nodeId: client.id });
        continue;
      }
      const routes = routesByKey.get(endpointKeyText(key)) ?? [];
      if (routes.length === 1) {
        this.addEdge({
          id: stableId("edge", "resolver", "CALLS_ENDPOINT_CANDIDATE", client.id, routes[0].id),
          fromId: client.id,
          toId: routes[0].id,
          kind: "CALLS_ENDPOINT_CANDIDATE",
          fileId: client.fileId,
          startLine: client.startLine,
          endLine: client.endLine,
          attrs: stableAttrs({ ...RESOLVER_ATTR, confidenceReason: "exact_method_path", method: key.method, path: key.path }),
          confidence: 0.85,
        });
      } else {
        this.addSyntheticPending("ENDPOINT", client.name, client.rootId, client.fileId, routes.length > 1 ? "resolver_ambiguous_endpoint" : "resolver_endpoint_not_found", {
          candidates: routes.map((route) => ({ id: route.id, fileId: route.fileId, rootId: route.rootId })),
          method: key.method,
          path: key.path,
          nodeId: client.id,
        });
      }
    }
  }

  resolveTests(): void {
    const sourceFiles = [...this.filesById.values()].filter((file) => !isTestPath(file.relPath));
    for (const test of this.nodesOfKind("TEST_CANDIDATE")) {
      if (!test.fileId) continue;
      const file = this.filesById.get(test.fileId);
      if (!file) continue;
      const candidates = sourceFiles.filter((source) => source.rootId === file.rootId && isDeterministicTestSource(file.relPath, source.relPath));
      if (candidates.length === 1) {
        const targetNodeId = this.fileNodeIds.get(candidates[0].id);
        if (!targetNodeId) continue;
        this.addEdge({
          id: stableId("edge", "resolver", "TESTS", test.id, candidates[0].id),
          fromId: test.id,
          toId: targetNodeId,
          kind: "TESTS",
          fileId: test.fileId,
          startLine: test.startLine,
          endLine: test.endLine,
          attrs: stableAttrs({ ...RESOLVER_ATTR, confidenceReason: "deterministic_naming_path_proximity", sourcePath: candidates[0].relPath, testPath: file.relPath }),
          confidence: 0.75,
        });
      } else {
        this.addSyntheticPending("TEST_SOURCE", test.name, test.rootId, test.fileId, candidates.length > 1 ? "resolver_ambiguous_test_source" : "resolver_test_source_not_found", {
          candidates: candidates.map((candidate) => candidate.relPath),
          nodeId: test.id,
          testPath: file.relPath,
        });
      }
    }
  }

  private imports(): ResolverUnresolvedRecord[] {
    return this.unresolved.filter((item) => item.kind === "IMPORT" && item.reason !== "resolver_import_resolved");
  }

  private nodesOfKind(kind: string): ResolverNodeRecord[] {
    return [...(this.nodesByKind.get(kind) ?? [])].sort((left, right) => left.id.localeCompare(right.id));
  }

  private packageNodes(): ResolverNodeRecord[] {
    return this.nodesOfKind("PACKAGE");
  }

  private packageCandidates(name: string, sourceRootId: string, excludeSourceRoot: boolean): ResolverNodeRecord[] {
    return [...(this.packageNodesByName.get(normalizePackageName(name)) ?? [])]
      .filter((node) => !excludeSourceRoot || node.rootId !== sourceRootId)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private localImportTargets(sourceFile: ResolverFileRecord, importSource: string): ResolverFileRecord[] {
    const baseDir = path.posix.dirname(sourceFile.relPath);
    const rawTarget = path.posix.normalize(path.posix.join(baseDir, importSource));
    if (rawTarget.startsWith("../") || rawTarget === "..") return [];
    const candidates = candidateImportPaths(rawTarget);
    return [...this.filesById.values()]
      .filter((file) => file.rootId === sourceFile.rootId && candidates.has(file.relPath))
      .sort((left, right) => left.relPath.localeCompare(right.relPath));
  }

  private addEdge(edge: ResolverEdgeRecord): void {
    if (!edge.fileId) return;
    this.edges.set(edge.id, edge);
  }

  private addPending(source: ResolverUnresolvedRecord, reason: string, attrs: Record<string, unknown>): void {
    if (!source.fileId) return;
    this.addSyntheticPending(source.kind, source.name, source.rootId, source.fileId, reason, { ...attrs, sourceUnresolvedId: source.id });
  }

  private addSyntheticPending(kind: string, name: string, rootId: string, fileId: string, reason: string, attrs: Record<string, unknown>): void {
    const id = stableId("unresolved", "resolver", kind, fileId, name, reason);
    this.pending.set(id, { id, kind, name, rootId, fileId, attrs: stableAttrs({ ...RESOLVER_ATTR, ...attrs }), reason });
  }
}

function candidateImportPaths(rawTarget: string): Set<string> {
  const out = new Set<string>();
  const ext = path.posix.extname(rawTarget);
  if (ext) out.add(rawTarget);
  else {
    for (const candidateExt of RESOLVABLE_EXTENSIONS) out.add(`${rawTarget}${candidateExt}`);
    for (const candidateExt of RESOLVABLE_EXTENSIONS) out.add(`${rawTarget}/index${candidateExt}`);
  }
  return out;
}

function dependencyNames(node: ResolverNodeRecord): string[] {
  const raw = node.attrs.dependencies;
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string").map(normalizePackageName).filter(Boolean) : [];
}

function rootDeclaresDependency(rootId: string, packageName: string, rootPackages: Map<string, ResolverNodeRecord[]>): boolean {
  const normalized = normalizePackageName(packageName);
  return (rootPackages.get(rootId) ?? []).some((node) => dependencyNames(node).includes(normalized));
}

function endpointKey(node: ResolverNodeRecord): { method: string; path: string } | undefined {
  const method = typeof node.attrs.method === "string" ? node.attrs.method.toUpperCase() : node.name.split(/\s+/)[0]?.toUpperCase();
  const rawPath = typeof node.attrs.path === "string" ? node.attrs.path : typeof node.attrs.url === "string" ? node.attrs.url : node.name.replace(/^\S+\s+/, "");
  const normalizedPath = normalizeEndpointPath(rawPath);
  if (!method || !normalizedPath || normalizedPath.includes("<") || normalizedPath.includes("${")) return undefined;
  return { method, path: normalizedPath };
}

function endpointKeyText(key: { method: string; path: string }): string {
  return `${key.method} ${key.path}`;
}

function normalizeEndpointPath(value: string): string | undefined {
  if (!value) return undefined;
  try {
    if (/^https?:\/\//i.test(value)) return normalizePathname(new URL(value).pathname);
  } catch {
    return undefined;
  }
  if (!value.startsWith("/")) return undefined;
  return normalizePathname(value.split(/[?#]/)[0] ?? value);
}

function normalizePathname(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed || "/";
}

function packageNameOfImport(source: string): string | undefined {
  if (!source || source.startsWith("#")) return undefined;
  const parts = source.split("/").filter(Boolean);
  if (parts.length === 0) return undefined;
  return normalizePackageName(parts[0].startsWith("@") && parts[1] ? `${parts[0]}/${parts[1]}` : parts[0]);
}

function normalizePackageName(name: string): string {
  return name.trim().toLowerCase().replaceAll("_", "-");
}

function isRelativeImport(source: string): boolean {
  return source === "." || source === ".." || source.startsWith("./") || source.startsWith("../");
}

function lineOf(item: ResolverUnresolvedRecord): number | undefined {
  return typeof item.attrs.line === "number" ? item.attrs.line : undefined;
}

function isTestPath(relPath: string): boolean {
  return /(^|\/)(__tests__|tests?)\//i.test(relPath) || /(^|[._-])(test|spec)\.[^.]+$/i.test(path.posix.basename(relPath)) || /^test_/i.test(path.posix.basename(relPath));
}

function isDeterministicTestSource(testPath: string, sourcePath: string): boolean {
  if (path.posix.extname(testPath) !== path.posix.extname(sourcePath)) return false;
  const testStem = sourceStem(testPath);
  const sourceStemName = sourceStem(sourcePath);
  if (!testStem || testStem !== sourceStemName) return false;
  const testDir = normalizeTestDir(path.posix.dirname(testPath));
  const sourceDir = path.posix.dirname(sourcePath);
  return testDir === sourceDir;
}

function sourceStem(relPath: string): string {
  return path.posix.basename(relPath, path.posix.extname(relPath)).replace(/\.(test|spec)$/i, "").replace(/_(test|spec)$/i, "").replace(/^test_/, "");
}

function normalizeTestDir(dir: string): string {
  return dir.replace(/(^|\/)__tests__$/i, "").replace(/(^|\/)tests?$/i, "").replace(/\/$/, "") || ".";
}

function stableAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(attrs).filter(([, value]) => value !== undefined).sort(([left], [right]) => left.localeCompare(right)));
}

function stableId(...parts: string[]): string {
  return parts.map((part) => part.replace(/[^A-Za-z0-9:_./-]+/g, "_")).join(":");
}
