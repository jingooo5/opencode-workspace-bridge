import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { PluginInput } from "@opencode-ai/plugin";
import type { AccessMode, ContextBridgeOptions, RootSpec, WorkspaceManifest } from "../types.js";
import { globishMatch, isInside, parseRef, refOf, slugify, toAbs, toRelOrAbs } from "../shared/path.js";

export class WorkspaceStore {
  readonly ctx: PluginInput;
  readonly options: ContextBridgeOptions;
  readonly stateDirAbs: string;
  readonly manifestPath: string;
  readonly indexPath: string;
  readonly ledgerPath: string;

  constructor(ctx: PluginInput, options: ContextBridgeOptions) {
    this.ctx = ctx;
    this.options = options;
    this.stateDirAbs = toAbs(ctx.directory, options.stateDir);
    this.manifestPath = path.join(this.stateDirAbs, "workspace.json");
    this.indexPath = path.join(this.stateDirAbs, "index.jsonl");
    this.ledgerPath = path.join(this.stateDirAbs, "task-history.jsonl");
  }

  async init(): Promise<void> {
    await mkdir(this.stateDirAbs, { recursive: true });
    if (!existsSync(this.manifestPath)) {
      const primary: RootSpec = {
        name: "primary",
        path: ".",
        absPath: this.ctx.worktree || this.ctx.directory,
        access: "rw",
        role: "primary",
        tags: ["primary"],
      };
      const manifest: WorkspaceManifest = {
        version: 1,
        primary,
        roots: [primary],
        policies: {
          secretGlobs: this.options.secretGlobs,
          contractGlobs: this.options.contractGlobs,
          enforceImpactBeforeContractEdit: this.options.enforceImpactBeforeContractEdit,
        },
      };
      await this.writeManifest(manifest);
    }
    for (const root of this.options.roots) {
      await this.addRoot(root.path, {
        name: root.name,
        access: root.access ?? this.options.defaultAccess,
        role: root.role,
        tags: root.tags,
      });
    }
  }

  async readManifest(): Promise<WorkspaceManifest> {
    const text = await readFile(this.manifestPath, "utf8");
    return JSON.parse(text) as WorkspaceManifest;
  }

  async writeManifest(manifest: WorkspaceManifest): Promise<void> {
    await mkdir(path.dirname(this.manifestPath), { recursive: true });
    await writeFile(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  async addRoot(
    rootPath: string,
    opts: { name?: string; access?: AccessMode; role?: RootSpec["role"]; tags?: string[] } = {},
  ): Promise<RootSpec> {
    const manifest = await this.readManifest();
    const absPath = toAbs(this.ctx.directory, rootPath);
    const fallbackName = slugify(path.basename(absPath));
    let name = slugify(opts.name ?? fallbackName);
    let suffix = 2;
    while (manifest.roots.some((root) => root.name === name && root.absPath !== absPath)) {
      name = `${slugify(opts.name ?? fallbackName)}-${suffix++}`;
    }

    const existing = manifest.roots.find((root) => root.absPath === absPath || root.name === name);
    const root: RootSpec = {
      name,
      path: toRelOrAbs(this.ctx.directory, absPath),
      absPath,
      access: opts.access ?? this.options.defaultAccess,
      role: opts.role ?? "unknown",
      tags: opts.tags ?? [],
      stale: true,
    };

    if (existing) Object.assign(existing, root);
    else manifest.roots.push(root);

    await this.writeManifest(manifest);
    await this.appendLedger({ type: "root.added", root });
    return root;
  }

  async listRoots(): Promise<RootSpec[]> {
    return (await this.readManifest()).roots;
  }

  async resolveRef(ref: string): Promise<{ root: RootSpec; absPath: string; relPath: string } | undefined> {
    const parsed = parseRef(ref);
    if (!parsed) return undefined;
    const manifest = await this.readManifest();
    const root = manifest.roots.find((candidate) => candidate.name === parsed.root);
    if (!root) return undefined;
    const absPath = path.resolve(root.absPath, parsed.relPath);
    if (!isInside(root.absPath, absPath)) return undefined;
    return { root, absPath, relPath: parsed.relPath };
  }

  async findRootByPath(absPath: string): Promise<{ root: RootSpec; relPath: string } | undefined> {
    const manifest = await this.readManifest();
    const normalized = path.normalize(absPath);
    const matches = manifest.roots
      .filter((root) => isInside(root.absPath, normalized))
      .sort((a, b) => b.absPath.length - a.absPath.length);
    const root = matches[0];
    if (!root) return undefined;
    return { root, relPath: path.relative(root.absPath, normalized).replaceAll(path.sep, "/") || "." };
  }

  async markStaleByAbsPath(absPath: string): Promise<void> {
    const found = await this.findRootByPath(absPath);
    if (!found) return;
    const manifest = await this.readManifest();
    const root = manifest.roots.find((candidate) => candidate.name === found.root.name);
    if (!root) return;
    root.stale = true;
    await this.writeManifest(manifest);
  }

  async markIndexed(rootName: string): Promise<void> {
    const manifest = await this.readManifest();
    const root = manifest.roots.find((candidate) => candidate.name === rootName);
    if (!root) return;
    root.indexedAt = new Date().toISOString();
    root.stale = false;
    await this.writeManifest(manifest);
  }

  async isSecretPath(absPath: string): Promise<boolean> {
    const found = await this.findRootByPath(absPath);
    if (!found) return false;
    const manifest = await this.readManifest();
    return manifest.policies.secretGlobs.some((pattern) => globishMatch(pattern, found.relPath));
  }

  async isContractPath(absPath: string): Promise<boolean> {
    const found = await this.findRootByPath(absPath);
    if (!found) return false;
    const manifest = await this.readManifest();
    return manifest.policies.contractGlobs.some((pattern) => globishMatch(pattern, found.relPath));
  }

  async appendLedger(entry: Record<string, unknown>): Promise<void> {
    await mkdir(path.dirname(this.ledgerPath), { recursive: true });
    await writeFile(
      this.ledgerPath,
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      { flag: "a", encoding: "utf8" },
    );
  }

  async recentLedger(limit = 30): Promise<string[]> {
    if (!existsSync(this.ledgerPath)) return [];
    const text = await readFile(this.ledgerPath, "utf8");
    return text.trim().split("\n").filter(Boolean).slice(-limit);
  }

  async workspaceSummary(): Promise<string> {
    const manifest = await this.readManifest();
    const lines = manifest.roots.map((root) => {
      const state = root.stale ? "stale" : root.indexedAt ? `indexed ${root.indexedAt}` : "not-indexed";
      return `- ${root.name}: ${root.path} (${root.access}, ${root.role ?? "unknown"}, ${state})`;
    });
    return [`Manifest: ${this.manifestPath}`, "Roots:", ...lines].join("\n");
  }

  refOf(root: RootSpec, relPath: string): string {
    return refOf(root.name, relPath);
  }
}
