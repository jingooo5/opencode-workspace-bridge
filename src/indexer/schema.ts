import type { Database } from "bun:sqlite";

export const INDEX_SCHEMA_VERSION = 2;

export class UnsupportedSchemaVersionError extends Error {
  constructor(readonly actualVersion: number, readonly supportedVersion: number) {
    super(`Unsupported SQLite schema version ${actualVersion}; this build supports up to ${supportedVersion}.`);
    this.name = "UnsupportedSchemaVersionError";
  }
}

export class InvalidSchemaVersionError extends Error {
  constructor(readonly rawVersion: string) {
    super(`Invalid SQLite schema version value: ${rawVersion}.`);
    this.name = "InvalidSchemaVersionError";
  }
}

export type SchemaDiagnosticLevel = "info" | "warn" | "error";

export interface SchemaDiagnostic {
  level: SchemaDiagnosticLevel;
  code: string;
  message: string;
}

export interface SchemaBootstrapResult {
  schemaVersion: number;
  diagnostics: SchemaDiagnostic[];
}

const TABLE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  `CREATE TABLE IF NOT EXISTS roots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    abs_path TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'unknown',
    access TEXT NOT NULL,
    languages_json TEXT NOT NULL DEFAULT '[]',
    tags_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'stale',
    last_indexed_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  `CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    abs_path TEXT NOT NULL,
    language TEXT,
    hash TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    is_generated INTEGER NOT NULL DEFAULT 0,
    indexed_at TEXT NOT NULL,
    mtime_ms INTEGER,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(root_id) REFERENCES roots(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    root_id TEXT NOT NULL,
    file_id TEXT,
    start_line INTEGER NOT NULL DEFAULT 1,
    end_line INTEGER NOT NULL DEFAULT 1,
    attrs_json TEXT NOT NULL DEFAULT '{}',
    confidence REAL NOT NULL DEFAULT 1.0,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(root_id) REFERENCES roots(id) ON DELETE CASCADE,
    FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    from_id TEXT,
    to_id TEXT,
    kind TEXT NOT NULL,
    file_id TEXT,
    start_line INTEGER,
    end_line INTEGER,
    attrs_json TEXT NOT NULL DEFAULT '{}',
    confidence REAL NOT NULL DEFAULT 1.0,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS spans (
    id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL,
    file_id TEXT,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    text TEXT,
    kind TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(root_id) REFERENCES roots(id) ON DELETE CASCADE,
    FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS unresolved (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    root_id TEXT NOT NULL,
    file_id TEXT,
    attrs_json TEXT NOT NULL DEFAULT '{}',
    reason TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(root_id) REFERENCES roots(id) ON DELETE CASCADE,
    FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS summaries (
    id TEXT PRIMARY KEY,
    target_id TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    summary_path TEXT NOT NULL,
    evidence_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS index_runs (
    id TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    roots_json TEXT NOT NULL DEFAULT '[]',
    stats_json TEXT NOT NULL DEFAULT '{}',
    diagnostics_json TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE TABLE IF NOT EXISTS contracts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    root_id TEXT NOT NULL,
    file_id TEXT,
    source_node_id TEXT,
    version TEXT,
    signature_hash TEXT NOT NULL,
    generated_yaml_path TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    confidence REAL NOT NULL DEFAULT 1.0,
    attrs_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL,
    FOREIGN KEY(root_id) REFERENCES roots(id) ON DELETE CASCADE,
    FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS contract_consumers (
    contract_id TEXT NOT NULL,
    consumer_node_id TEXT NOT NULL,
    consumer_root_id TEXT NOT NULL,
    evidence_edge_id TEXT,
    confidence REAL NOT NULL DEFAULT 0.8,
    attrs_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL,
    PRIMARY KEY(contract_id, consumer_node_id),
    FOREIGN KEY(contract_id) REFERENCES contracts(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS contract_related_nodes (
    contract_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.7,
    attrs_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL,
    PRIMARY KEY(contract_id, node_id, relation),
    FOREIGN KEY(contract_id) REFERENCES contracts(id) ON DELETE CASCADE
  )`,
] as const;

const INDEX_STATEMENTS = [
  "CREATE INDEX IF NOT EXISTS idx_roots_status ON roots(status)",
  "CREATE INDEX IF NOT EXISTS idx_files_root_path ON files(root_id, rel_path)",
  "CREATE INDEX IF NOT EXISTS idx_files_abs_path ON files(abs_path)",
  "CREATE INDEX IF NOT EXISTS idx_nodes_root_kind_name ON nodes(root_id, kind, name)",
  "CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_id)",
  "CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id)",
  "CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id)",
  "CREATE INDEX IF NOT EXISTS idx_edges_file ON edges(file_id)",
  "CREATE INDEX IF NOT EXISTS idx_spans_file ON spans(file_id)",
  "CREATE INDEX IF NOT EXISTS idx_unresolved_root_kind ON unresolved(root_id, kind)",
  "CREATE INDEX IF NOT EXISTS idx_summaries_target ON summaries(target_id, target_kind)",
  "CREATE INDEX IF NOT EXISTS idx_summaries_stale ON summaries(stale)",
  "CREATE INDEX IF NOT EXISTS idx_index_runs_started_at ON index_runs(started_at)",
  "CREATE INDEX IF NOT EXISTS idx_contracts_root_kind ON contracts(root_id, kind)",
  "CREATE INDEX IF NOT EXISTS idx_contracts_file ON contracts(file_id)",
  "CREATE INDEX IF NOT EXISTS idx_contract_consumers_node ON contract_consumers(consumer_node_id)",
  "CREATE INDEX IF NOT EXISTS idx_contract_related_node ON contract_related_nodes(node_id)",
] as const;

const REQUIRED_COLUMNS: Record<string, ReadonlyArray<{ name: string; definition: string }>> = {
  roots: [
    { name: "id", definition: "TEXT" },
    { name: "name", definition: "TEXT" },
    { name: "abs_path", definition: "TEXT" },
    { name: "rel_path", definition: "TEXT" },
    { name: "role", definition: "TEXT DEFAULT 'unknown'" },
    { name: "access", definition: "TEXT" },
    { name: "languages_json", definition: "TEXT DEFAULT '[]'" },
    { name: "tags_json", definition: "TEXT DEFAULT '[]'" },
    { name: "status", definition: "TEXT DEFAULT 'stale'" },
    { name: "last_indexed_at", definition: "TEXT" },
  ],
  files: [
    { name: "id", definition: "TEXT" },
    { name: "root_id", definition: "TEXT" },
    { name: "rel_path", definition: "TEXT" },
    { name: "abs_path", definition: "TEXT" },
    { name: "language", definition: "TEXT" },
    { name: "hash", definition: "TEXT" },
    { name: "size_bytes", definition: "INTEGER DEFAULT 0" },
    { name: "is_generated", definition: "INTEGER DEFAULT 0" },
    { name: "indexed_at", definition: "TEXT" },
    { name: "mtime_ms", definition: "INTEGER" },
    { name: "updated_at", definition: "TEXT" },
  ],
  nodes: [
    { name: "id", definition: "TEXT" },
    { name: "kind", definition: "TEXT" },
    { name: "name", definition: "TEXT" },
    { name: "root_id", definition: "TEXT" },
    { name: "file_id", definition: "TEXT" },
    { name: "start_line", definition: "INTEGER DEFAULT 1" },
    { name: "end_line", definition: "INTEGER DEFAULT 1" },
    { name: "attrs_json", definition: "TEXT DEFAULT '{}'" },
    { name: "confidence", definition: "REAL DEFAULT 1.0" },
    { name: "updated_at", definition: "TEXT" },
  ],
  edges: [
    { name: "id", definition: "TEXT" },
    { name: "from_id", definition: "TEXT" },
    { name: "to_id", definition: "TEXT" },
    { name: "kind", definition: "TEXT" },
    { name: "file_id", definition: "TEXT" },
    { name: "start_line", definition: "INTEGER" },
    { name: "end_line", definition: "INTEGER" },
    { name: "attrs_json", definition: "TEXT DEFAULT '{}'" },
    { name: "confidence", definition: "REAL DEFAULT 1.0" },
    { name: "updated_at", definition: "TEXT" },
  ],
  spans: [
    { name: "id", definition: "TEXT" },
    { name: "root_id", definition: "TEXT" },
    { name: "file_id", definition: "TEXT" },
    { name: "start_line", definition: "INTEGER" },
    { name: "end_line", definition: "INTEGER" },
    { name: "text", definition: "TEXT" },
    { name: "kind", definition: "TEXT" },
    { name: "updated_at", definition: "TEXT" },
  ],
  unresolved: [
    { name: "id", definition: "TEXT" },
    { name: "kind", definition: "TEXT" },
    { name: "name", definition: "TEXT" },
    { name: "root_id", definition: "TEXT" },
    { name: "file_id", definition: "TEXT" },
    { name: "attrs_json", definition: "TEXT DEFAULT '{}'" },
    { name: "reason", definition: "TEXT" },
    { name: "updated_at", definition: "TEXT" },
  ],
  summaries: [
    { name: "id", definition: "TEXT" },
    { name: "target_id", definition: "TEXT" },
    { name: "target_kind", definition: "TEXT" },
    { name: "summary_path", definition: "TEXT" },
    { name: "evidence_hash", definition: "TEXT" },
    { name: "status", definition: "TEXT" },
    { name: "generated_at", definition: "TEXT" },
    { name: "updated_at", definition: "TEXT" },
    { name: "stale", definition: "INTEGER NOT NULL DEFAULT 0" },
    { name: "evidence_refs_json", definition: "TEXT NOT NULL DEFAULT '[]'" },
  ],
  index_runs: [
    { name: "id", definition: "TEXT" },
    { name: "reason", definition: "TEXT" },
    { name: "started_at", definition: "TEXT" },
    { name: "finished_at", definition: "TEXT" },
    { name: "roots_json", definition: "TEXT DEFAULT '[]'" },
    { name: "stats_json", definition: "TEXT DEFAULT '{}'" },
    { name: "diagnostics_json", definition: "TEXT DEFAULT '[]'" },
  ],
  contracts: [
    { name: "id", definition: "TEXT" },
    { name: "kind", definition: "TEXT" },
    { name: "name", definition: "TEXT" },
    { name: "root_id", definition: "TEXT" },
    { name: "file_id", definition: "TEXT" },
    { name: "source_node_id", definition: "TEXT" },
    { name: "version", definition: "TEXT" },
    { name: "signature_hash", definition: "TEXT" },
    { name: "generated_yaml_path", definition: "TEXT" },
    { name: "status", definition: "TEXT DEFAULT 'active'" },
    { name: "confidence", definition: "REAL DEFAULT 1.0" },
    { name: "attrs_json", definition: "TEXT DEFAULT '{}'" },
    { name: "updated_at", definition: "TEXT" },
  ],
  contract_consumers: [
    { name: "contract_id", definition: "TEXT" },
    { name: "consumer_node_id", definition: "TEXT" },
    { name: "consumer_root_id", definition: "TEXT" },
    { name: "evidence_edge_id", definition: "TEXT" },
    { name: "confidence", definition: "REAL DEFAULT 0.8" },
    { name: "attrs_json", definition: "TEXT DEFAULT '{}'" },
    { name: "updated_at", definition: "TEXT" },
  ],
  contract_related_nodes: [
    { name: "contract_id", definition: "TEXT" },
    { name: "node_id", definition: "TEXT" },
    { name: "relation", definition: "TEXT" },
    { name: "confidence", definition: "REAL DEFAULT 0.7" },
    { name: "attrs_json", definition: "TEXT DEFAULT '{}'" },
    { name: "updated_at", definition: "TEXT" },
  ],
  schema_meta: [
    { name: "key", definition: "TEXT" },
    { name: "value", definition: "TEXT" },
    { name: "updated_at", definition: "TEXT" },
  ],
};

export function bootstrapIndexSchema(db: Database): SchemaBootstrapResult {
  const diagnostics: SchemaDiagnostic[] = [];

  db.run("PRAGMA foreign_keys = ON;");
  const existingVersion = readStoredSchemaVersion(db);
  if (existingVersion !== undefined && existingVersion > INDEX_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(existingVersion, INDEX_SCHEMA_VERSION);
  }
  const migrate = db.transaction(() => {
    for (const statement of TABLE_STATEMENTS) db.run(statement);
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) ensureColumns(db, table, columns);
    for (const statement of INDEX_STATEMENTS) db.run(statement);
    db.query(
      `INSERT INTO schema_meta (key, value, updated_at)
       VALUES ('schema_version', $version, $updatedAt)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run({ version: String(INDEX_SCHEMA_VERSION), updatedAt: new Date(0).toISOString() });
  });

  migrate();
  diagnostics.push({
    level: "info",
    code: "schema.bootstrapped",
    message: `SQLite index schema is at version ${INDEX_SCHEMA_VERSION}.`,
  });

  return { schemaVersion: INDEX_SCHEMA_VERSION, diagnostics };
}

export function readStoredSchemaVersion(db: Database): number | undefined {
  if (!tableExists(db, "schema_meta")) return undefined;
  const statement = db.query("SELECT value FROM schema_meta WHERE key = 'schema_version'");
  try {
    const row = statement.get() as { value?: string } | null;
    if (!row?.value) return undefined;
    const parsed = Number.parseInt(row.value, 10);
    if (!Number.isFinite(parsed)) throw new InvalidSchemaVersionError(row.value);
    return parsed;
  } finally {
    statement.finalize();
  }
}

function ensureColumns(db: Database, table: string, columns: ReadonlyArray<{ name: string; definition: string }>): void {
  const statement = db.query(`PRAGMA table_info(${table})`);
  const existing = new Set<string>();
  try {
    for (const column of statement.all() as Array<{ name: string }>) existing.add(column.name);
  } finally {
    statement.finalize();
  }
  for (const column of columns) {
    if (!existing.has(column.name)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column.name} ${column.definition}`);
  }
}

function tableExists(db: Database, table: string): boolean {
  const statement = db.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = $name LIMIT 1",
  );
  try {
    return !!statement.get({ name: table });
  } finally {
    statement.finalize();
  }
}
