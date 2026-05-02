import { afterAll, expect, test } from "bun:test";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { openSQLiteIndexStore } from "../src/indexer/sqlite-store.ts";
import { INDEX_SCHEMA_VERSION } from "../src/indexer/schema.ts";

const FIXTURE_PARENT = "/tmp/opencode/context-bridge-schema-migration";
const cleanupPaths = new Set<string>();

afterAll(async () => {
  await Promise.all(Array.from(cleanupPaths, (target) => rm(target, { recursive: true, force: true })));
});

test("v1 SQLite database upgrades to v2 without data loss", async () => {
  const fixtureDir = path.join(FIXTURE_PARENT, `migration-${Date.now()}-${crypto.randomUUID()}`);
  cleanupPaths.add(fixtureDir);
  await mkdir(fixtureDir, { recursive: true });
  const dbPath = path.join(fixtureDir, "index.sqlite");

  // Build a synthetic v1 database that has only the legacy tables and v1 summaries shape.
  const legacy = new Database(dbPath, { create: true, readwrite: true, strict: true });
  try {
    legacy.run("PRAGMA foreign_keys = ON;");
    legacy.run(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`);
    legacy.run("INSERT INTO schema_meta (key, value, updated_at) VALUES ('schema_version', '1', '1970-01-01T00:00:00.000Z')");
    legacy.run(`CREATE TABLE roots (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, abs_path TEXT NOT NULL, rel_path TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'unknown', access TEXT NOT NULL, languages_json TEXT NOT NULL DEFAULT '[]', tags_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'stale', last_indexed_at TEXT, updated_at TEXT NOT NULL DEFAULT '1970')`);
    legacy.run(`CREATE TABLE files (id TEXT PRIMARY KEY, root_id TEXT NOT NULL, rel_path TEXT NOT NULL, abs_path TEXT NOT NULL, language TEXT, hash TEXT NOT NULL, size_bytes INTEGER NOT NULL DEFAULT 0, is_generated INTEGER NOT NULL DEFAULT 0, indexed_at TEXT NOT NULL, mtime_ms INTEGER, updated_at TEXT NOT NULL)`);
    legacy.run(`CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, root_id TEXT NOT NULL, file_id TEXT, start_line INTEGER NOT NULL DEFAULT 1, end_line INTEGER NOT NULL DEFAULT 1, attrs_json TEXT NOT NULL DEFAULT '{}', confidence REAL NOT NULL DEFAULT 1.0, updated_at TEXT NOT NULL)`);
    legacy.run(`CREATE TABLE edges (id TEXT PRIMARY KEY, from_id TEXT, to_id TEXT, kind TEXT NOT NULL, file_id TEXT, start_line INTEGER, end_line INTEGER, attrs_json TEXT NOT NULL DEFAULT '{}', confidence REAL NOT NULL DEFAULT 1.0, updated_at TEXT NOT NULL)`);
    legacy.run(`CREATE TABLE spans (id TEXT PRIMARY KEY, root_id TEXT NOT NULL, file_id TEXT, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, text TEXT, kind TEXT, updated_at TEXT NOT NULL)`);
    legacy.run(`CREATE TABLE unresolved (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, root_id TEXT NOT NULL, file_id TEXT, attrs_json TEXT NOT NULL DEFAULT '{}', reason TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    legacy.run(`CREATE TABLE summaries (id TEXT PRIMARY KEY, target_id TEXT NOT NULL, target_kind TEXT NOT NULL, summary_path TEXT NOT NULL, evidence_hash TEXT NOT NULL, status TEXT NOT NULL, generated_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    legacy.run(`CREATE TABLE index_runs (id TEXT PRIMARY KEY, reason TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, roots_json TEXT NOT NULL DEFAULT '[]', stats_json TEXT NOT NULL DEFAULT '{}', diagnostics_json TEXT NOT NULL DEFAULT '[]')`);

    legacy.run("INSERT INTO roots (id, name, abs_path, rel_path, role, access, languages_json, tags_json, status, last_indexed_at, updated_at) VALUES ('root:legacy', 'legacy', '/tmp/legacy', '.', 'service', 'rw', '[]', '[]', 'indexed', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')");
    legacy.run("INSERT INTO summaries (id, target_id, target_kind, summary_path, evidence_hash, status, generated_at, updated_at) VALUES ('sum1', 'node:legacy', 'NODE', '/tmp/legacy.md', 'sha:abc', 'fresh', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')");
  } finally {
    legacy.close();
  }

  // Open via the production path; bootstrap should add v2 tables and columns idempotently.
  const opened = await openSQLiteIndexStore(dbPath);
  expect(opened.ok).toBe(true);
  if (!opened.ok) return;
  const close = opened.value.close();
  expect(close.ok).toBe(true);

  const verify = new Database(dbPath, { readonly: true, strict: true });
  try {
    const tables = (verify.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
    for (const required of ["roots", "files", "nodes", "edges", "spans", "summaries", "contracts", "contract_consumers", "contract_related_nodes", "schema_meta"]) {
      expect(tables).toContain(required);
    }

    const summariesColumns = (verify.query("PRAGMA table_info(summaries)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(summariesColumns).toContain("stale");
    expect(summariesColumns).toContain("evidence_refs_json");

    const summary = verify.query("SELECT id, status, stale, evidence_refs_json FROM summaries WHERE id = 'sum1'").get() as {
      id: string;
      status: string;
      stale: number;
      evidence_refs_json: string;
    };
    expect(summary.id).toBe("sum1");
    expect(summary.status).toBe("fresh");
    expect(summary.stale).toBe(0);
    expect(summary.evidence_refs_json).toBe("[]");

    const root = verify.query("SELECT name FROM roots WHERE id = 'root:legacy'").get() as { name: string } | null;
    expect(root?.name).toBe("legacy");

    const version = (verify.query("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value;
    expect(Number.parseInt(version, 10)).toBe(INDEX_SCHEMA_VERSION);
  } finally {
    verify.close();
  }
});
