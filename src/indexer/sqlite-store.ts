import path from "node:path";
import { mkdir } from "node:fs/promises";
import { Database } from "bun:sqlite";
import {
  bootstrapIndexSchema,
  INDEX_SCHEMA_VERSION,
  InvalidSchemaVersionError,
  readStoredSchemaVersion,
  type SchemaDiagnostic,
  UnsupportedSchemaVersionError,
} from "./schema.js";
import type { ExtractedGraphFacts } from "./extractors/ts-js.js";
import { buildResolverFacts, type ResolverEdgeRecord, type ResolverFileRecord, type ResolverNodeRecord, type ResolverUnresolvedRecord } from "./resolver.js";

export type StorageDiagnosticLevel = "info" | "warn" | "error";

export interface StorageDiagnostic {
  level: StorageDiagnosticLevel;
  code: string;
  message: string;
  path?: string;
  cause?: string;
}

export type StorageResult<T> =
  | { ok: true; value: T; diagnostics: StorageDiagnostic[]; degraded?: boolean }
  | { ok: false; diagnostics: StorageDiagnostic[]; degraded: true };

export interface IndexRunInput {
  runId?: string;
  root?: string;
  roots?: string[];
  reason?: string;
  startedAt?: string;
  stats?: Record<string, unknown>;
}

export interface IndexRunRecord {
  id: string;
  runId: string;
  root?: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
  filesSeen: number;
  reason: string;
  roots: string[];
  stats: Record<string, unknown>;
  diagnostics: StorageDiagnostic[];
}

export interface FinishIndexRunInput {
  runId: string;
  status: "completed" | "failed";
  finishedAt?: string;
  filesSeen?: number;
  stats?: Record<string, unknown>;
  diagnostics?: StorageDiagnostic[];
}

export interface SQLiteRootRecordInput {
  id: string;
  name: string;
  absPath: string;
  relPath: string;
  role: string;
  access: string;
  languages: string[];
  tags: string[];
  status: string;
  lastIndexedAt: string;
  updatedAt: string;
}

export interface SQLiteFileRecordInput {
  id: string;
  rootId: string;
  relPath: string;
  absPath: string;
  language?: string;
  hash: string;
  sizeBytes: number;
  isGenerated: boolean;
  indexedAt: string;
  mtimeMs?: number;
  updatedAt: string;
}

export interface PersistScanInput {
  root: SQLiteRootRecordInput;
  files: SQLiteFileRecordInput[];
  pruneMissing: boolean;
}

export interface PersistExtractedFactsInput {
  fileIds: string[];
  facts: ExtractedGraphFacts;
  updatedAt: string;
}

export interface PruneFileTargetsInput {
  rootId: string;
  relPaths: string[];
}

export interface MarkSummariesStaleForFileInput {
  fileId: string;
  updatedAt?: string;
}

export interface SQLiteContractInput {
  id: string;
  kind: string;
  name: string;
  rootId: string;
  fileId?: string;
  sourceNodeId?: string;
  signatureHash: string;
  generatedYamlPath?: string | null;
  confidence: number;
  attrs: Record<string, unknown>;
  consumers: Array<{
    consumerNodeId: string;
    consumerRootId: string;
    evidenceEdgeId?: string;
    confidence: number;
    attrs: Record<string, unknown>;
  }>;
  related: Array<{
    nodeId: string;
    relation: string;
    confidence: number;
    attrs: Record<string, unknown>;
  }>;
}

export interface PersistContractsInput {
  contracts: SQLiteContractInput[];
  updatedAt: string;
}

export interface DebugContractRecord {
  id: string;
  kind: string;
  name: string;
  rootId: string;
  rootName: string;
  fileId?: string;
  relPath?: string;
  sourceNodeId?: string;
  signatureHash: string;
  generatedYamlPath?: string;
  status: string;
  confidence: number;
  attrs: Record<string, unknown>;
  consumers: Array<{
    consumerNodeId: string;
    consumerRootId: string;
    evidenceEdgeId?: string;
    confidence: number;
    attrs: Record<string, unknown>;
  }>;
  related: Array<{
    nodeId: string;
    relation: string;
    confidence: number;
    attrs: Record<string, unknown>;
  }>;
}

export interface DebugNodeRecord {
  id: string;
  kind: string;
  name: string;
  rootId: string;
  rootName: string;
  fileId?: string;
  relPath?: string;
  startLine: number;
  endLine: number;
  attrs: Record<string, unknown>;
  confidence: number;
}

export interface DebugEdgeRecord {
  id: string;
  kind: string;
  fromId?: string;
  toId?: string;
  fileId?: string;
  rootId?: string;
  rootName?: string;
  relPath?: string;
  startLine?: number;
  endLine?: number;
  attrs: Record<string, unknown>;
  confidence: number;
}

export interface DebugSpanRecord {
  id: string;
  kind?: string;
  rootId: string;
  rootName: string;
  fileId?: string;
  relPath?: string;
  startLine: number;
  endLine: number;
  text?: string;
}

export interface DebugUnresolvedRecord {
  id: string;
  kind: string;
  name: string;
  rootId: string;
  rootName: string;
  fileId?: string;
  relPath?: string;
  attrs: Record<string, unknown>;
  reason: string;
}

export interface DebugIndexRunRecord {
  id: string;
  reason: string;
  startedAt: string;
  finishedAt?: string;
  roots: string[];
  stats: Record<string, unknown>;
  diagnostics: StorageDiagnostic[];
}

export interface DebugSnapshot {
  nodes: DebugNodeRecord[];
  edges: DebugEdgeRecord[];
  spans: DebugSpanRecord[];
  unresolved: DebugUnresolvedRecord[];
  indexRuns: DebugIndexRunRecord[];
}

interface IndexRunRow {
  id: string;
  reason: string;
  started_at: string;
  finished_at: string | null;
  roots_json: string;
  stats_json: string;
  diagnostics_json: string;
}

export interface SummaryRow {
  id: string;
  target_id: string;
  target_kind: string;
  summary_path: string;
  evidence_hash: string;
  status: string;
  generated_at: string;
  updated_at: string;
  stale: number;
  evidence_refs_json: string;
}

interface DebugNodeRow {
  id: string;
  kind: string;
  name: string;
  root_id: string;
  root_name: string | null;
  file_id: string | null;
  rel_path: string | null;
  start_line: number;
  end_line: number;
  attrs_json: string;
  confidence: number;
}

interface DebugEdgeRow {
  id: string;
  kind: string;
  from_id: string | null;
  to_id: string | null;
  file_id: string | null;
  root_id: string | null;
  root_name: string | null;
  rel_path: string | null;
  start_line: number | null;
  end_line: number | null;
  attrs_json: string;
  confidence: number;
}

interface DebugSpanRow {
  id: string;
  kind: string | null;
  root_id: string;
  root_name: string | null;
  file_id: string | null;
  rel_path: string | null;
  start_line: number;
  end_line: number;
  text: string | null;
}

interface ResolverFileRow {
  id: string;
  root_id: string;
  rel_path: string;
}

interface ResolverNodeRow {
  id: string;
  kind: string;
  name: string;
  root_id: string;
  file_id: string | null;
  start_line: number;
  end_line: number;
  attrs_json: string;
  confidence: number;
}

interface ResolverUnresolvedRow {
  id: string;
  kind: string;
  name: string;
  root_id: string;
  file_id: string | null;
  attrs_json: string;
  reason: string;
}

interface DebugUnresolvedRow {
  id: string;
  kind: string;
  name: string;
  root_id: string;
  root_name: string | null;
  file_id: string | null;
  rel_path: string | null;
  attrs_json: string;
  reason: string;
}

interface SQLiteRunStatement {
  run(params: Record<string, string | number | bigint | boolean | Uint8Array | null>): { changes: number };
  finalize?(): void;
}

interface OpenSQLiteIndexStoreOptions {
  readonly?: boolean;
  skipMigrations?: boolean;
}

const SQLITE_BUSY_TIMEOUT_MS = 750;

export class SQLiteIndexStore {
  readonly path: string;
  readonly schemaVersion = INDEX_SCHEMA_VERSION;
  private readonly db: Database;

  constructor(db: Database, dbPath: string) {
    this.db = db;
    this.path = dbPath;
  }

  withTransaction<T>(name: string, work: () => T): StorageResult<T> {
    const transaction = this.db.transaction(work);
    try {
      return { ok: true, value: transaction.immediate(), diagnostics: [] };
    } catch (error) {
      return degradedResult("sqlite.transaction_failed", `SQLite transaction failed: ${name}.`, this.path, error);
    }
  }

  startIndexRun(input: IndexRunInput = {}): StorageResult<IndexRunRecord> {
    return this.withTransaction("index_runs.start", () => {
      const runId = input.runId ?? crypto.randomUUID();
      const startedAt = input.startedAt ?? new Date().toISOString();
      const roots = input.roots ?? (input.root ? [input.root] : []);
      const stats = { status: "running", filesSeen: 0, ...(input.stats ?? {}) };
      this.db.query(
        `INSERT INTO index_runs (id, reason, started_at, roots_json, stats_json, diagnostics_json)
         VALUES ($id, $reason, $startedAt, $rootsJson, $statsJson, '[]')`,
      ).run({
        id: runId,
        reason: input.reason ?? "manual",
        startedAt,
        rootsJson: JSON.stringify(roots),
        statsJson: JSON.stringify(stats),
      });
      const row = this.db.query("SELECT * FROM index_runs WHERE id = $id").get({ id: runId }) as IndexRunRow;
      return rowToIndexRun(row);
    });
  }

  finishIndexRun(input: FinishIndexRunInput): StorageResult<IndexRunRecord> {
    return this.withTransaction("index_runs.finish", () => {
      const finishedAt = input.finishedAt ?? new Date().toISOString();
      const current = this.db.query("SELECT * FROM index_runs WHERE id = $id").get({ id: input.runId }) as IndexRunRow | undefined;
      if (!current) throw new Error(`Index run not found: ${input.runId}`);
      const stats = parseObject(current.stats_json);
      stats.status = input.status;
      stats.filesSeen = input.filesSeen ?? stats.filesSeen ?? 0;
      Object.assign(stats, input.stats ?? {});
      this.db.query(
        `UPDATE index_runs
         SET finished_at = $finishedAt,
             stats_json = $statsJson,
             diagnostics_json = $diagnosticsJson
         WHERE id = $id`,
      ).run({
        id: input.runId,
        finishedAt,
        statsJson: JSON.stringify(stats),
        diagnosticsJson: JSON.stringify(input.diagnostics ?? []),
      });
      const row = this.db.query("SELECT * FROM index_runs WHERE id = $id").get({ id: input.runId }) as IndexRunRow | undefined;
      if (!row) throw new Error(`Index run not found: ${input.runId}`);
      return rowToIndexRun(row);
    });
  }

  persistRootScan(input: PersistScanInput): StorageResult<{ filesPersisted: number }> {
    return this.withTransaction("root_scan.persist", () => {
      const root = input.root;
      this.db.query(
        `INSERT INTO roots (id, name, abs_path, rel_path, role, access, languages_json, tags_json, status, last_indexed_at, updated_at)
         VALUES ($id, $name, $absPath, $relPath, $role, $access, $languagesJson, $tagsJson, $status, $lastIndexedAt, $updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           abs_path = excluded.abs_path,
           rel_path = excluded.rel_path,
           role = excluded.role,
           access = excluded.access,
           languages_json = excluded.languages_json,
           tags_json = excluded.tags_json,
           status = excluded.status,
           last_indexed_at = excluded.last_indexed_at,
           updated_at = excluded.updated_at`,
      ).run({
        id: root.id,
        name: root.name,
        absPath: root.absPath,
        relPath: root.relPath,
        role: root.role,
        access: root.access,
        languagesJson: JSON.stringify(root.languages),
        tagsJson: JSON.stringify(root.tags),
        status: root.status,
        lastIndexedAt: root.lastIndexedAt,
        updatedAt: root.updatedAt,
      });

      const seen = new Set<string>();
      for (const file of input.files) {
        seen.add(file.id);
        this.db.query(
          `INSERT INTO files (id, root_id, rel_path, abs_path, language, hash, size_bytes, is_generated, indexed_at, mtime_ms, updated_at)
           VALUES ($id, $rootId, $relPath, $absPath, $language, $hash, $sizeBytes, $isGenerated, $indexedAt, $mtimeMs, $updatedAt)
           ON CONFLICT(id) DO UPDATE SET
             root_id = excluded.root_id,
             rel_path = excluded.rel_path,
             abs_path = excluded.abs_path,
             language = excluded.language,
             hash = excluded.hash,
             size_bytes = excluded.size_bytes,
             is_generated = excluded.is_generated,
             indexed_at = excluded.indexed_at,
             mtime_ms = excluded.mtime_ms,
             updated_at = excluded.updated_at`,
        ).run({
          id: file.id,
          rootId: file.rootId,
          relPath: file.relPath,
          absPath: file.absPath,
          language: file.language ?? null,
          hash: file.hash,
          sizeBytes: file.sizeBytes,
          isGenerated: file.isGenerated ? 1 : 0,
          indexedAt: file.indexedAt,
          mtimeMs: file.mtimeMs ?? null,
          updatedAt: file.updatedAt,
        });
        this.db.query(
          `INSERT INTO nodes (id, kind, name, root_id, file_id, start_line, end_line, attrs_json, confidence, updated_at)
           VALUES ($id, 'FILE', $name, $rootId, $fileId, 1, 1, $attrsJson, 1.0, $updatedAt)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             root_id = excluded.root_id,
             file_id = excluded.file_id,
             attrs_json = excluded.attrs_json,
             updated_at = excluded.updated_at`,
        ).run({
          id: `node:${file.id}`,
          name: path.basename(file.relPath),
          rootId: file.rootId,
          fileId: file.id,
          attrsJson: JSON.stringify({ relPath: file.relPath, language: file.language ?? null, isGenerated: file.isGenerated }),
          updatedAt: file.updatedAt,
        });
      }

      if (input.pruneMissing) {
        const existingStatement = this.db.query("SELECT id FROM files WHERE root_id = $rootId");
        const deleteFile = this.db.query("DELETE FROM files WHERE id = $id");
        try {
          const existing = existingStatement.all({ rootId: root.id }) as Array<{ id: string }>;
          const stale = existing.map((row) => row.id).filter((id) => !seen.has(id));
          for (const id of stale) deleteFile.run({ id });
        } finally {
          finalizeStatement(existingStatement);
          finalizeStatement(deleteFile);
        }
      }

      return { filesPersisted: input.files.length };
    });
  }

  persistExtractedFacts(input: PersistExtractedFactsInput): StorageResult<{ nodesPersisted: number; edgesPersisted: number; unresolvedPersisted: number }> {
    return this.withTransaction("extracted_facts.persist", () => {
      const fileIds = [...new Set(input.fileIds)].sort((a, b) => a.localeCompare(b));
      const deleteEdges = this.db.query("DELETE FROM edges WHERE file_id = $fileId");
      const deleteSpans = this.db.query("DELETE FROM spans WHERE file_id = $fileId");
      const deleteUnresolved = this.db.query("DELETE FROM unresolved WHERE file_id = $fileId");
      const deleteNodes = this.db.query("DELETE FROM nodes WHERE file_id = $fileId AND id != $fileNodeId");
      for (const fileId of fileIds) {
        deleteEdges.run({ fileId });
        deleteSpans.run({ fileId });
        deleteUnresolved.run({ fileId });
        deleteNodes.run({ fileId, fileNodeId: `node:${fileId}` });
      }

      const insertNode = this.db.query(
        `INSERT INTO nodes (id, kind, name, root_id, file_id, start_line, end_line, attrs_json, confidence, updated_at)
         VALUES ($id, $kind, $name, $rootId, $fileId, $startLine, $endLine, $attrsJson, $confidence, $updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           name = excluded.name,
           root_id = excluded.root_id,
           file_id = excluded.file_id,
           start_line = excluded.start_line,
           end_line = excluded.end_line,
           attrs_json = excluded.attrs_json,
            confidence = excluded.confidence,
            updated_at = excluded.updated_at`,
      );
      try {
        for (const node of input.facts.nodes) {
          insertNode.run({
            id: node.id,
            kind: node.kind,
            name: node.name,
            rootId: node.rootId,
            fileId: node.fileId,
            startLine: node.startLine,
            endLine: node.endLine,
            attrsJson: JSON.stringify(node.attrs),
            confidence: node.confidence,
            updatedAt: input.updatedAt,
          });
        }
      } finally {
        finalizeStatement(insertNode);
      }

      const insertEdge = this.db.query(
        `INSERT INTO edges (id, from_id, to_id, kind, file_id, start_line, end_line, attrs_json, confidence, updated_at)
         VALUES ($id, $fromId, $toId, $kind, $fileId, $startLine, $endLine, $attrsJson, $confidence, $updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           from_id = excluded.from_id,
           to_id = excluded.to_id,
           kind = excluded.kind,
           file_id = excluded.file_id,
           start_line = excluded.start_line,
           end_line = excluded.end_line,
           attrs_json = excluded.attrs_json,
            confidence = excluded.confidence,
            updated_at = excluded.updated_at`,
      );
      try {
        for (const edge of input.facts.edges) {
          insertEdge.run({
            id: edge.id,
            fromId: edge.fromId ?? null,
            toId: edge.toId ?? null,
            kind: edge.kind,
            fileId: edge.fileId,
            startLine: edge.startLine ?? null,
            endLine: edge.endLine ?? null,
            attrsJson: JSON.stringify(edge.attrs),
            confidence: edge.confidence,
            updatedAt: input.updatedAt,
          });
        }
      } finally {
        finalizeStatement(insertEdge);
      }

      const insertSpan = this.db.query(
        `INSERT INTO spans (id, root_id, file_id, start_line, end_line, text, kind, updated_at)
         VALUES ($id, $rootId, $fileId, $startLine, $endLine, $text, $kind, $updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           root_id = excluded.root_id,
           file_id = excluded.file_id,
           start_line = excluded.start_line,
           end_line = excluded.end_line,
           text = excluded.text,
            kind = excluded.kind,
            updated_at = excluded.updated_at`,
      );
      try {
        for (const span of input.facts.spans) {
          insertSpan.run({
            id: span.id,
            rootId: span.rootId,
            fileId: span.fileId,
            startLine: span.startLine,
            endLine: span.endLine,
            text: span.text ?? null,
            kind: span.kind ?? null,
            updatedAt: input.updatedAt,
          });
        }
      } finally {
        finalizeStatement(insertSpan);
      }

      const insertUnresolved = this.db.query(
        `INSERT INTO unresolved (id, kind, name, root_id, file_id, attrs_json, reason, updated_at)
         VALUES ($id, $kind, $name, $rootId, $fileId, $attrsJson, $reason, $updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           name = excluded.name,
           root_id = excluded.root_id,
           file_id = excluded.file_id,
           attrs_json = excluded.attrs_json,
            reason = excluded.reason,
            updated_at = excluded.updated_at`,
      );
      try {
        for (const unresolved of input.facts.unresolved) {
          insertUnresolved.run({
            id: unresolved.id,
            kind: unresolved.kind,
            name: unresolved.name,
            rootId: unresolved.rootId,
            fileId: unresolved.fileId ?? null,
            attrsJson: JSON.stringify(unresolved.attrs),
            reason: unresolved.reason,
            updatedAt: input.updatedAt,
          });
        }
      } finally {
        finalizeStatement(insertUnresolved);
      }

      return { nodesPersisted: input.facts.nodes.length, edgesPersisted: input.facts.edges.length, unresolvedPersisted: input.facts.unresolved.length };
    });
  }

  pruneFileTargets(input: PruneFileTargetsInput): StorageResult<{ filesPruned: number }> {
    return this.withTransaction("file_targets.prune", () => {
      const relPaths = [...new Set(input.relPaths)].sort((a, b) => a.localeCompare(b));
      const deleteFile = this.db.query("DELETE FROM files WHERE root_id = $rootId AND rel_path = $relPath");
      let filesPruned = 0;
      try {
        for (const relPath of relPaths) {
          const result = deleteFile.run({ rootId: input.rootId, relPath });
          filesPruned += result.changes;
        }
      } finally {
        finalizeStatement(deleteFile);
      }
      this.cleanupDanglingGraphRecords();
      return { filesPruned };
    });
  }

  markSummariesStaleForFile(input: MarkSummariesStaleForFileInput): StorageResult<{ summariesMarkedStale: number }> {
    return this.withTransaction("summaries.mark_stale_for_file", () => {
      const updatedAt = input.updatedAt ?? new Date().toISOString();
      const fileNodeId = `node:${input.fileId}`;
      const result = this.db.query(
        `UPDATE summaries
         SET status = 'stale',
             stale = 1,
             updated_at = $updatedAt
         WHERE target_id = $fileId
            OR target_id = $fileNodeId
            OR target_id IN (SELECT id FROM nodes WHERE file_id = $fileId)`,
      ).run({
        updatedAt,
        fileId: input.fileId,
        fileNodeId,
      });
      return { summariesMarkedStale: result.changes };
    });
  }

  readFileHashes(): StorageResult<Map<string, string>> {
    try {
      const rows = this.db.query("SELECT id, hash FROM files").all() as Array<{ id: string; hash: string }>;
      return { ok: true, value: new Map(rows.map((row) => [row.id, row.hash])), diagnostics: [] };
    } catch (error) {
      return degradedResult("sqlite.read_file_hashes_failed", "SQLite file hash read failed.", this.path, error);
    }
  }

  readFilesAbs(): StorageResult<Array<{ rootName: string; relPath: string; absPath: string }>> {
    try {
      const rows = this.db.query(
        `SELECT r.name AS root_name, f.rel_path AS rel_path, f.abs_path AS abs_path
         FROM files f
         JOIN roots r ON r.id = f.root_id`,
      ).all() as Array<{ root_name: string; rel_path: string; abs_path: string }>;
      return {
        ok: true,
        value: rows.map((row) => ({ rootName: row.root_name, relPath: row.rel_path, absPath: row.abs_path })),
        diagnostics: [],
      };
    } catch (error) {
      return degradedResult("sqlite.read_files_abs_failed", "SQLite file path read failed.", this.path, error);
    }
  }

  persistContracts(input: PersistContractsInput): StorageResult<{ contractsPersisted: number }> {
    return this.withTransaction("contracts.persist", () => {
      const seen = new Set<string>();
      const upsertContract = this.db.query(
        `INSERT INTO contracts (id, kind, name, root_id, file_id, source_node_id, signature_hash, generated_yaml_path,
                                status, confidence, attrs_json, updated_at)
         VALUES ($id, $kind, $name, $rootId, $fileId, $sourceNodeId, $signatureHash, $generatedYamlPath,
                 'active', $confidence, $attrsJson, $updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           name = excluded.name,
           root_id = excluded.root_id,
           file_id = excluded.file_id,
           source_node_id = excluded.source_node_id,
           signature_hash = excluded.signature_hash,
           generated_yaml_path = excluded.generated_yaml_path,
           status = 'active',
           confidence = excluded.confidence,
           attrs_json = excluded.attrs_json,
           updated_at = excluded.updated_at`,
      );
      const deleteConsumers = this.db.query("DELETE FROM contract_consumers WHERE contract_id = $contractId");
      const deleteRelated = this.db.query("DELETE FROM contract_related_nodes WHERE contract_id = $contractId");
      const insertConsumer = this.db.query(
        `INSERT INTO contract_consumers (contract_id, consumer_node_id, consumer_root_id, evidence_edge_id, confidence, attrs_json, updated_at)
         VALUES ($contractId, $consumerNodeId, $consumerRootId, $evidenceEdgeId, $confidence, $attrsJson, $updatedAt)
         ON CONFLICT(contract_id, consumer_node_id) DO UPDATE SET
           consumer_root_id = excluded.consumer_root_id,
           evidence_edge_id = excluded.evidence_edge_id,
           confidence = excluded.confidence,
           attrs_json = excluded.attrs_json,
           updated_at = excluded.updated_at`,
      );
      const insertRelated = this.db.query(
        `INSERT INTO contract_related_nodes (contract_id, node_id, relation, confidence, attrs_json, updated_at)
         VALUES ($contractId, $nodeId, $relation, $confidence, $attrsJson, $updatedAt)
         ON CONFLICT(contract_id, node_id, relation) DO UPDATE SET
           confidence = excluded.confidence,
           attrs_json = excluded.attrs_json,
           updated_at = excluded.updated_at`,
      );

      try {
        for (const contract of input.contracts) {
          seen.add(contract.id);
          upsertContract.run({
            id: contract.id,
            kind: contract.kind,
            name: contract.name,
            rootId: contract.rootId,
            fileId: contract.fileId ?? null,
            sourceNodeId: contract.sourceNodeId ?? null,
            signatureHash: contract.signatureHash,
            generatedYamlPath: contract.generatedYamlPath ?? null,
            confidence: contract.confidence,
            attrsJson: JSON.stringify(contract.attrs),
            updatedAt: input.updatedAt,
          });
          deleteConsumers.run({ contractId: contract.id });
          deleteRelated.run({ contractId: contract.id });
          for (const consumer of contract.consumers) {
            insertConsumer.run({
              contractId: contract.id,
              consumerNodeId: consumer.consumerNodeId,
              consumerRootId: consumer.consumerRootId,
              evidenceEdgeId: consumer.evidenceEdgeId ?? null,
              confidence: consumer.confidence,
              attrsJson: JSON.stringify(consumer.attrs),
              updatedAt: input.updatedAt,
            });
          }
          for (const related of contract.related) {
            insertRelated.run({
              contractId: contract.id,
              nodeId: related.nodeId,
              relation: related.relation,
              confidence: related.confidence,
              attrsJson: JSON.stringify(related.attrs),
              updatedAt: input.updatedAt,
            });
          }
        }

        const existing = this.db.query("SELECT id FROM contracts").all() as Array<{ id: string }>;
        const stale = existing.map((row) => row.id).filter((id) => !seen.has(id));
        if (stale.length > 0) {
          const deleteContract = this.db.query("DELETE FROM contracts WHERE id = $id");
          try {
            for (const id of stale) deleteContract.run({ id });
          } finally {
            finalizeStatement(deleteContract);
          }
        }
      } finally {
        finalizeStatement(upsertContract);
        finalizeStatement(deleteConsumers);
        finalizeStatement(deleteRelated);
        finalizeStatement(insertConsumer);
        finalizeStatement(insertRelated);
      }

      return { contractsPersisted: input.contracts.length };
    });
  }

  readSummaryByTarget(input: { targetId: string; targetKind: string }): StorageResult<SummaryRow | undefined> {
    try {
      const row = this.db.query(
        `SELECT id, target_id, target_kind, summary_path, evidence_hash, status, generated_at, updated_at, stale, evidence_refs_json
         FROM summaries
         WHERE target_id = $targetId AND target_kind = $targetKind`,
      ).get({ targetId: input.targetId, targetKind: input.targetKind }) as SummaryRow | null;
      return { ok: true, value: row ?? undefined, diagnostics: [] };
    } catch (error) {
      return degradedResult("sqlite.read_summary_failed", "SQLite summaries read failed.", this.path, error);
    }
  }

  readSummariesTotal(): StorageResult<number> {
    try {
      const row = this.db.query("SELECT COUNT(*) AS count FROM summaries").get() as { count: number };
      return { ok: true, value: row.count, diagnostics: [] };
    } catch (error) {
      return degradedResult("sqlite.read_summaries_total_failed", "SQLite summaries total failed.", this.path, error);
    }
  }

  readStaleSummaries(): StorageResult<SummaryRow[]> {
    try {
      const rows = this.db.query(
        `SELECT id, target_id, target_kind, summary_path, evidence_hash, status, generated_at, updated_at, stale, evidence_refs_json
         FROM summaries
         WHERE stale = 1 OR status = 'stale'
         ORDER BY target_id ASC`,
      ).all() as SummaryRow[];
      return { ok: true, value: rows, diagnostics: [] };
    } catch (error) {
      return degradedResult("sqlite.read_stale_summaries_failed", "SQLite stale summaries read failed.", this.path, error);
    }
  }

  upsertSummary(input: {
    id: string;
    targetId: string;
    targetKind: string;
    summaryPath: string;
    evidenceHash: string;
    evidenceRefsJson: string;
    generatedAt: string;
    updatedAt: string;
  }): StorageResult<void> {
    return this.withTransaction("summaries.upsert", () => {
      this.db.query(
        `INSERT INTO summaries (id, target_id, target_kind, summary_path, evidence_hash, status, generated_at, updated_at, stale, evidence_refs_json)
         VALUES ($id, $targetId, $targetKind, $summaryPath, $evidenceHash, 'fresh', $generatedAt, $updatedAt, 0, $evidenceRefsJson)
         ON CONFLICT(id) DO UPDATE SET
           target_id = excluded.target_id,
           target_kind = excluded.target_kind,
           summary_path = excluded.summary_path,
           evidence_hash = excluded.evidence_hash,
           status = 'fresh',
           generated_at = excluded.generated_at,
           updated_at = excluded.updated_at,
           stale = 0,
           evidence_refs_json = excluded.evidence_refs_json`,
      ).run({
        id: input.id,
        targetId: input.targetId,
        targetKind: input.targetKind,
        summaryPath: input.summaryPath,
        evidenceHash: input.evidenceHash,
        evidenceRefsJson: input.evidenceRefsJson,
        generatedAt: input.generatedAt,
        updatedAt: input.updatedAt,
      });
      return undefined;
    });
  }

  readContracts(): StorageResult<DebugContractRecord[]> {
    try {
      const rows = this.db.query(
        `SELECT c.id, c.kind, c.name, c.root_id, r.name AS root_name, c.file_id, f.rel_path,
                c.source_node_id, c.signature_hash, c.generated_yaml_path, c.status, c.confidence,
                c.attrs_json
         FROM contracts c
         LEFT JOIN roots r ON r.id = c.root_id
         LEFT JOIN files f ON f.id = c.file_id`,
      ).all() as Array<{
        id: string;
        kind: string;
        name: string;
        root_id: string;
        root_name: string | null;
        file_id: string | null;
        rel_path: string | null;
        source_node_id: string | null;
        signature_hash: string;
        generated_yaml_path: string | null;
        status: string;
        confidence: number;
        attrs_json: string;
      }>;
      const consumers = this.db.query(
        "SELECT contract_id, consumer_node_id, consumer_root_id, evidence_edge_id, confidence, attrs_json FROM contract_consumers",
      ).all() as Array<{
        contract_id: string;
        consumer_node_id: string;
        consumer_root_id: string;
        evidence_edge_id: string | null;
        confidence: number;
        attrs_json: string;
      }>;
      const related = this.db.query(
        "SELECT contract_id, node_id, relation, confidence, attrs_json FROM contract_related_nodes",
      ).all() as Array<{
        contract_id: string;
        node_id: string;
        relation: string;
        confidence: number;
        attrs_json: string;
      }>;
      const consumerMap = new Map<string, DebugContractRecord["consumers"]>();
      for (const item of consumers) {
        const list = consumerMap.get(item.contract_id) ?? [];
        list.push({
          consumerNodeId: item.consumer_node_id,
          consumerRootId: item.consumer_root_id,
          evidenceEdgeId: item.evidence_edge_id ?? undefined,
          confidence: item.confidence,
          attrs: parseObject(item.attrs_json),
        });
        consumerMap.set(item.contract_id, list);
      }
      const relatedMap = new Map<string, DebugContractRecord["related"]>();
      for (const item of related) {
        const list = relatedMap.get(item.contract_id) ?? [];
        list.push({
          nodeId: item.node_id,
          relation: item.relation,
          confidence: item.confidence,
          attrs: parseObject(item.attrs_json),
        });
        relatedMap.set(item.contract_id, list);
      }
      const contracts = rows.map((row): DebugContractRecord => ({
        id: row.id,
        kind: row.kind,
        name: row.name,
        rootId: row.root_id,
        rootName: row.root_name ?? "",
        fileId: row.file_id ?? undefined,
        relPath: row.rel_path ?? undefined,
        sourceNodeId: row.source_node_id ?? undefined,
        signatureHash: row.signature_hash,
        generatedYamlPath: row.generated_yaml_path ?? undefined,
        status: row.status,
        confidence: row.confidence,
        attrs: parseObject(row.attrs_json),
        consumers: (consumerMap.get(row.id) ?? []).sort((a, b) => a.consumerNodeId.localeCompare(b.consumerNodeId)),
        related: (relatedMap.get(row.id) ?? []).sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
      })).sort((a, b) => a.id.localeCompare(b.id));
      return { ok: true, value: contracts, diagnostics: [] };
    } catch (error) {
      return degradedResult("sqlite.read_contracts_failed", "SQLite contracts read failed.", this.path, error);
    }
  }

  recomputeResolverFacts(updatedAt: string): StorageResult<{ edgesPersisted: number; unresolvedPersisted: number }> {
    return this.withTransaction("resolver_facts.recompute", () => {
      this.deleteResolverFacts();
      this.cleanupDanglingGraphRecords();

      const files = (this.db.query("SELECT id, root_id, rel_path FROM files").all() as ResolverFileRow[]).map((row): ResolverFileRecord => ({
        id: row.id,
        rootId: row.root_id,
        relPath: row.rel_path,
      }));
      const nodes = (this.db.query(
        `SELECT id, kind, name, root_id, file_id, start_line, end_line, attrs_json, confidence
         FROM nodes`,
      ).all() as ResolverNodeRow[]).map((row): ResolverNodeRecord => ({
        id: row.id,
        kind: row.kind,
        name: row.name,
        rootId: row.root_id,
        fileId: row.file_id ?? undefined,
        startLine: row.start_line,
        endLine: row.end_line,
        attrs: parseObject(row.attrs_json),
        confidence: row.confidence,
      }));
      const unresolved = (this.db.query(
        `SELECT id, kind, name, root_id, file_id, attrs_json, reason
         FROM unresolved
         WHERE reason = 'resolver_not_run' OR reason NOT LIKE 'resolver_%'`,
      ).all() as ResolverUnresolvedRow[]).map((row): ResolverUnresolvedRecord => ({
        id: row.id,
        kind: row.kind,
        name: row.name,
        rootId: row.root_id,
        fileId: row.file_id ?? undefined,
        attrs: parseObject(row.attrs_json),
        reason: row.reason,
      }));

      const facts = buildResolverFacts({ files, nodes, unresolved });
      const insertEdge = this.db.query(
        `INSERT INTO edges (id, from_id, to_id, kind, file_id, start_line, end_line, attrs_json, confidence, updated_at)
         VALUES ($id, $fromId, $toId, $kind, $fileId, $startLine, $endLine, $attrsJson, $confidence, $updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           from_id = excluded.from_id,
           to_id = excluded.to_id,
           kind = excluded.kind,
           file_id = excluded.file_id,
           start_line = excluded.start_line,
           end_line = excluded.end_line,
           attrs_json = excluded.attrs_json,
           confidence = excluded.confidence,
            updated_at = excluded.updated_at`,
      );
      try {
        for (const edge of facts.edges) insertResolverEdge(insertEdge, edge, updatedAt);
      } finally {
        finalizeStatement(insertEdge);
      }

      const insertUnresolved = this.db.query(
        `INSERT INTO unresolved (id, kind, name, root_id, file_id, attrs_json, reason, updated_at)
         VALUES ($id, $kind, $name, $rootId, $fileId, $attrsJson, $reason, $updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           name = excluded.name,
           root_id = excluded.root_id,
           file_id = excluded.file_id,
           attrs_json = excluded.attrs_json,
           reason = excluded.reason,
            updated_at = excluded.updated_at`,
      );
      try {
        for (const item of facts.unresolved) insertResolverUnresolved(insertUnresolved, item, updatedAt);
      } finally {
        finalizeStatement(insertUnresolved);
      }

      this.cleanupDanglingGraphRecords();
      return { edgesPersisted: facts.edges.length, unresolvedPersisted: facts.unresolved.length };
    });
  }

  readDebugSnapshot(): StorageResult<DebugSnapshot> {
    try {
      const nodes = (this.db.query(
        `SELECT n.id, n.kind, n.name, n.root_id, r.name AS root_name, n.file_id, f.rel_path,
                n.start_line, n.end_line, n.attrs_json, n.confidence
         FROM nodes n
         LEFT JOIN roots r ON r.id = n.root_id
         LEFT JOIN files f ON f.id = n.file_id`,
      ).all() as DebugNodeRow[]).map((row) => ({
        id: row.id,
        kind: row.kind,
        name: row.name,
        rootId: row.root_id,
        rootName: row.root_name ?? "",
        fileId: row.file_id ?? undefined,
        relPath: row.rel_path ?? undefined,
        startLine: row.start_line,
        endLine: row.end_line,
        attrs: parseObject(row.attrs_json),
        confidence: row.confidence,
      }));

      const edges = (this.db.query(
        `SELECT e.id, e.kind, e.from_id, e.to_id, e.file_id, f.root_id, r.name AS root_name, f.rel_path,
                e.start_line, e.end_line, e.attrs_json, e.confidence
         FROM edges e
         LEFT JOIN files f ON f.id = e.file_id
         LEFT JOIN roots r ON r.id = f.root_id`,
      ).all() as DebugEdgeRow[]).map((row) => ({
        id: row.id,
        kind: row.kind,
        fromId: row.from_id ?? undefined,
        toId: row.to_id ?? undefined,
        fileId: row.file_id ?? undefined,
        rootId: row.root_id ?? undefined,
        rootName: row.root_name ?? undefined,
        relPath: row.rel_path ?? undefined,
        startLine: row.start_line ?? undefined,
        endLine: row.end_line ?? undefined,
        attrs: parseObject(row.attrs_json),
        confidence: row.confidence,
      }));

      const spans = (this.db.query(
        `SELECT s.id, s.kind, s.root_id, r.name AS root_name, s.file_id, f.rel_path,
                s.start_line, s.end_line, s.text
         FROM spans s
         LEFT JOIN roots r ON r.id = s.root_id
         LEFT JOIN files f ON f.id = s.file_id`,
      ).all() as DebugSpanRow[]).map((row) => ({
        id: row.id,
        kind: row.kind ?? undefined,
        rootId: row.root_id,
        rootName: row.root_name ?? "",
        fileId: row.file_id ?? undefined,
        relPath: row.rel_path ?? undefined,
        startLine: row.start_line,
        endLine: row.end_line,
        text: row.text ?? undefined,
      }));

      const indexRuns = (this.db.query("SELECT * FROM index_runs").all() as IndexRunRow[]).map((row) => ({
        id: row.id,
        reason: row.reason,
        startedAt: row.started_at,
        finishedAt: row.finished_at ?? undefined,
        roots: parseStringArray(row.roots_json),
        stats: parseObject(row.stats_json),
        diagnostics: parseDiagnostics(row.diagnostics_json),
      }));

      const unresolved = (this.db.query(
        `SELECT u.id, u.kind, u.name, u.root_id, r.name AS root_name, u.file_id, f.rel_path,
                u.attrs_json, u.reason
         FROM unresolved u
         LEFT JOIN roots r ON r.id = u.root_id
         LEFT JOIN files f ON f.id = u.file_id`,
      ).all() as DebugUnresolvedRow[]).map((row) => ({
        id: row.id,
        kind: row.kind,
        name: row.name,
        rootId: row.root_id,
        rootName: row.root_name ?? "",
        fileId: row.file_id ?? undefined,
        relPath: row.rel_path ?? undefined,
        attrs: parseObject(row.attrs_json),
        reason: row.reason,
      }));

      return { ok: true, value: { nodes, edges, spans, unresolved, indexRuns }, diagnostics: [] };
    } catch (error) {
      return degradedResult("sqlite.debug_snapshot_failed", "SQLite debug snapshot failed.", this.path, error);
    }
  }

  close(): StorageResult<void> {
    try {
      this.db.close();
      return { ok: true, value: undefined, diagnostics: [] };
    } catch (error) {
      return degradedResult("sqlite.close_failed", "SQLite index close failed.", this.path, error);
    }
  }

  private deleteResolverFacts(): void {
    this.db.run(
      `DELETE FROM edges
       WHERE kind IN ('IMPORTS', 'DEPENDS_ON', 'DEPENDS_ON_PACKAGE', 'CALLS_ENDPOINT_CANDIDATE', 'TESTS')`,
    );
    this.db.run("DELETE FROM unresolved WHERE reason LIKE 'resolver_%' AND reason != 'resolver_not_run'");
  }

  private cleanupDanglingGraphRecords(): void {
    this.db.run("DELETE FROM spans WHERE file_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM files WHERE files.id = spans.file_id)");
    this.db.run("DELETE FROM unresolved WHERE file_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM files WHERE files.id = unresolved.file_id)");
    this.db.run("DELETE FROM nodes WHERE file_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM files WHERE files.id = nodes.file_id)");
    this.db.run("DELETE FROM edges WHERE file_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM files WHERE files.id = edges.file_id)");
    this.db.run("DELETE FROM edges WHERE from_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM nodes WHERE nodes.id = edges.from_id)");
    this.db.run("DELETE FROM edges WHERE to_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM nodes WHERE nodes.id = edges.to_id)");
  }
}

function insertResolverEdge(statement: SQLiteRunStatement, edge: ResolverEdgeRecord, updatedAt: string): void {
  statement.run({
    id: edge.id,
    fromId: edge.fromId ?? null,
    toId: edge.toId ?? null,
    kind: edge.kind,
    fileId: edge.fileId,
    startLine: edge.startLine ?? null,
    endLine: edge.endLine ?? null,
    attrsJson: JSON.stringify(edge.attrs),
    confidence: edge.confidence,
    updatedAt,
  });
}

function insertResolverUnresolved(statement: SQLiteRunStatement, item: ResolverUnresolvedRecord, updatedAt: string): void {
  statement.run({
    id: item.id,
    kind: item.kind,
    name: item.name,
    rootId: item.rootId,
    fileId: item.fileId ?? null,
    attrsJson: JSON.stringify(item.attrs),
    reason: item.reason,
    updatedAt,
  });
}

export async function openSQLiteIndexStore(dbPath: string, options: OpenSQLiteIndexStoreOptions = {}): Promise<StorageResult<SQLiteIndexStore>> {
  const diagnostics: StorageDiagnostic[] = [];
  let db: Database | undefined;
  const readonly = options.readonly === true;

  try {
    if (!readonly) await mkdir(path.dirname(dbPath), { recursive: true });
    db = readonly
      ? new Database(dbPath, { readonly: true, strict: true })
      : new Database(dbPath, { create: true, readwrite: true, strict: true });
  } catch (error) {
    return degradedResult("sqlite.open_failed", "SQLite index open failed; legacy JSONL paths remain usable.", dbPath, error);
  }

  try {
    db.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
    diagnostics.push({ level: "info", code: "sqlite.busy_timeout_set", message: `SQLite busy timeout set to ${SQLITE_BUSY_TIMEOUT_MS}ms.`, path: dbPath });
  } catch (error) {
    diagnostics.push(toDiagnostic("warn", "sqlite.busy_timeout_failed", "SQLite busy timeout could not be set; writes may fail faster under contention.", dbPath, error));
  }

  if (!readonly) {
    try {
      db.run("PRAGMA journal_mode = WAL;");
      diagnostics.push({ level: "info", code: "sqlite.wal_enabled", message: "SQLite WAL mode enabled.", path: dbPath });
    } catch (error) {
      diagnostics.push(toDiagnostic("warn", "sqlite.wal_failed", "SQLite WAL mode could not be enabled; continuing without WAL.", dbPath, error));
    }
  }

  try {
    if (options.skipMigrations) {
      const version = readStoredSchemaVersion(db);
      if (version === undefined) throw new Error("SQLite schema metadata is missing.");
      if (version > INDEX_SCHEMA_VERSION) throw new UnsupportedSchemaVersionError(version, INDEX_SCHEMA_VERSION);
      diagnostics.push({ level: "info", code: "sqlite.schema_checked", message: `SQLite schema version ${version} is readable.`, path: dbPath });
    } else {
      const schema = bootstrapIndexSchema(db);
      diagnostics.push(...schema.diagnostics.map(schemaDiagnosticToStorage));
    }
  } catch (error) {
    try {
      db.close();
    } catch {
      // Closing after a failed migration is best-effort; the migration diagnostic is the actionable result.
    }
    return degradedResult(
      "sqlite.migration_failed",
      readonly
        ? "SQLite index schema validation failed; legacy JSONL paths remain usable."
        : "SQLite index schema bootstrap failed; legacy JSONL paths remain usable.",
      dbPath,
      error,
      diagnostics,
    );
  }

  return { ok: true, value: new SQLiteIndexStore(db, dbPath), diagnostics, degraded: diagnostics.some((item) => item.level !== "info") || undefined };
}

function rowToIndexRun(row: IndexRunRow): IndexRunRecord {
  const stats = parseObject(row.stats_json);
  const roots = parseStringArray(row.roots_json);
  return {
    id: row.id,
    runId: row.id,
    root: roots[0],
    status: stats.status === "completed" || stats.status === "failed" ? stats.status : "running",
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    filesSeen: typeof stats.filesSeen === "number" ? stats.filesSeen : 0,
    reason: row.reason,
    roots,
    stats,
    diagnostics: parseDiagnostics(row.diagnostics_json),
  };
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseStringArray(text: string): string[] {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseDiagnostics(text: string): StorageDiagnostic[] {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? (value as StorageDiagnostic[]) : [];
  } catch {
    return [];
  }
}

function schemaDiagnosticToStorage(diagnostic: SchemaDiagnostic): StorageDiagnostic {
  return { level: diagnostic.level, code: diagnostic.code, message: diagnostic.message };
}

function degradedResult<T>(
  code: string,
  message: string,
  dbPath: string,
  error: unknown,
  priorDiagnostics: StorageDiagnostic[] = [],
): StorageResult<T> {
  return {
    ok: false,
    degraded: true,
    diagnostics: [...priorDiagnostics, classifySQLiteDiagnostic(code, message, dbPath, error)],
  };
}

function toDiagnostic(level: StorageDiagnosticLevel, code: string, message: string, dbPath: string, error: unknown): StorageDiagnostic {
  return {
    level,
    code,
    message,
    path: dbPath,
    cause: error instanceof Error ? error.message : String(error),
  };
}

function classifySQLiteDiagnostic(code: string, message: string, dbPath: string, error: unknown): StorageDiagnostic {
  if (error instanceof UnsupportedSchemaVersionError) {
    return { level: "error", code: "sqlite.schema_unsupported", message, path: dbPath, cause: error.message };
  }
  if (error instanceof InvalidSchemaVersionError) {
    return { level: "error", code: "sqlite.schema_invalid", message, path: dbPath, cause: error.message };
  }

  const cause = error instanceof Error ? error.message : String(error);
  const lower = cause.toLowerCase();
  if (lower.includes("database is locked") || lower.includes("sqlite_busy") || lower.includes(" busy")) {
    return { level: "error", code: "sqlite.locked", message, path: dbPath, cause };
  }
  if (
    lower.includes("malformed")
    || lower.includes("not a database")
    || lower.includes("file is not a database")
    || lower.includes("database disk image is malformed")
  ) {
    return { level: "error", code: "sqlite.corrupt", message, path: dbPath, cause };
  }
  return toDiagnostic("error", code, message, dbPath, error);
}

function finalizeStatement(statement: { finalize?: () => void }): void {
  try {
    statement.finalize?.();
  } catch {
    // Statement finalization is best-effort; primary diagnostics come from query/run failures.
  }
}
