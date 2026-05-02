import { existsSync, statSync } from "node:fs";
import { openSQLiteIndexStore } from "../indexer/sqlite-store.js";
import type { WorkspaceStore } from "./workspace-store.js";

export interface ContractCacheEntry {
  contractId: string;
  kind: string;
  name: string;
  rootName: string;
  relPath?: string;
  signatureHash: string;
}

interface CacheState {
  loadedAtMs: number;
  sqliteMtimeMs: number;
  byAbsPath: Map<string, ContractCacheEntry[]>;
  byContractId: Map<string, ContractCacheEntry>;
}

/**
 * In-memory contract lookup keyed by absolute file path. The cache invalidates
 * itself when index.sqlite mtime changes, avoiding repeated SQLite opens during
 * the edit-hook critical path. Falls back to glob-only checks when SQLite is
 * absent or unreadable.
 */
export class ContractCache {
  private state: CacheState | undefined;

  constructor(private readonly store: WorkspaceStore) {}

  async refreshIfStale(): Promise<void> {
    const sqlitePath = this.store.sqlitePath;
    if (!existsSync(sqlitePath)) {
      this.state = { loadedAtMs: Date.now(), sqliteMtimeMs: 0, byAbsPath: new Map(), byContractId: new Map() };
      return;
    }
    const mtime = currentMtime(sqlitePath);
    if (this.state && this.state.sqliteMtimeMs === mtime) return;
    await this.reload(mtime);
  }

  async contractsForAbsPath(absPath: string): Promise<ContractCacheEntry[]> {
    await this.refreshIfStale();
    if (!this.state) return [];
    return this.state.byAbsPath.get(absPath) ?? [];
  }

  async contractById(id: string): Promise<ContractCacheEntry | undefined> {
    await this.refreshIfStale();
    return this.state?.byContractId.get(id);
  }

  async allContractIds(): Promise<string[]> {
    await this.refreshIfStale();
    if (!this.state) return [];
    return [...this.state.byContractId.keys()];
  }

  invalidate(): void {
    this.state = undefined;
  }

  private async reload(mtimeMs: number): Promise<void> {
    const opened = await openSQLiteIndexStore(this.store.sqlitePath, { readonly: true, skipMigrations: true });
    if (!opened.ok) {
      this.state = { loadedAtMs: Date.now(), sqliteMtimeMs: mtimeMs, byAbsPath: new Map(), byContractId: new Map() };
      return;
    }
    const sqlite = opened.value;
    try {
      const contracts = sqlite.readContracts();
      const byAbs = new Map<string, ContractCacheEntry[]>();
      const byId = new Map<string, ContractCacheEntry>();
      if (contracts.ok) {
        const filesByRoot = await this.fileAbsPathsByRoot();
        for (const contract of contracts.value) {
          const entry: ContractCacheEntry = {
            contractId: contract.id,
            kind: contract.kind,
            name: contract.name,
            rootName: contract.rootName,
            relPath: contract.relPath,
            signatureHash: contract.signatureHash,
          };
          byId.set(contract.id, entry);
          if (contract.relPath) {
            const abs = filesByRoot.get(`${contract.rootName}:${contract.relPath}`);
            if (abs) {
              const list = byAbs.get(abs) ?? [];
              list.push(entry);
              byAbs.set(abs, list);
            }
          }
        }
      }
      this.state = { loadedAtMs: Date.now(), sqliteMtimeMs: mtimeMs, byAbsPath: byAbs, byContractId: byId };
    } finally {
      sqlite.close();
    }
  }

  private async fileAbsPathsByRoot(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const opened = await openSQLiteIndexStore(this.store.sqlitePath, { readonly: true, skipMigrations: true });
    if (!opened.ok) return out;
    try {
      const snapshot = opened.value.readDebugSnapshot();
      if (!snapshot.ok) return out;
      const filesQuery = (opened.value as unknown as { readFilesAbs?: () => Map<string, string> }).readFilesAbs;
      void filesQuery;
      const rows = readFilesAbsQuery(opened.value);
      for (const row of rows) {
        out.set(`${row.rootName}:${row.relPath}`, row.absPath);
      }
      return out;
    } finally {
      opened.value.close();
    }
  }
}

function currentMtime(p: string): number {
  try {
    return Math.trunc(statSync(p).mtimeMs);
  } catch {
    return 0;
  }
}

interface FileAbsRow {
  rootName: string;
  relPath: string;
  absPath: string;
}

function readFilesAbsQuery(sqlite: import("../indexer/sqlite-store.js").SQLiteIndexStore): FileAbsRow[] {
  const rows = sqlite.readFilesAbs();
  if (!rows.ok) return [];
  return rows.value;
}
