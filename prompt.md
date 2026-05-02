# Task Brief: Basic Indexer V0.1

## Reference Basis

This task implements the V0.1 indexer for `opencode-context-bridge`: a multi-root workspace layer that stores deterministic evidence under `{session_root}/.opencode/context-bridge/` and lets agents use indexed context for search, context packs, and impact analysis. The design requires deterministic scripts for parsing/indexing, while natural-language agents only interpret and orchestrate results. Durable state must be file-backed, path-addressable, and stable across compaction/restart/delegation. The confirmed project architecture uses `Evidence Graph + Semantic Memory + Contract Boundary Registry + Context Pack`, with Bun's built-in SQLite (`bun:sqlite`) as the primary store and JSONL as debug/export output. The MVP target is TypeScript/JavaScript and Python indexing with root aliasing, context search/read, context packs, impact analysis, affected test planning, and compaction memory.

---

## Implementation Reason

Implement the basic indexer because the current plugin must stop relying on raw file scans, ad-hoc grep, or summary-only context.

The indexer must provide:

- stable multi-root workspace state
- deterministic evidence extraction
- root-aware file and symbol search
- cross-root import and endpoint candidates
- context packs backed by stored evidence
- impact analysis input for tools and agents
- safe local storage under `.opencode/context-bridge/`

The indexer must be treated as deterministic infrastructure. Do not use an LLM to generate index data.

---

## Required Scope

Implement the MVP indexer for:

- TypeScript / JavaScript
- Python
- JSON / YAML metadata
- package metadata
- import/export extraction
- function/class/type/interface extraction
- Python class/function/import extraction
- Pydantic / dataclass / TypedDict candidates
- FastAPI / Flask route candidates
- Express route candidates
- fetch / axios / requests / httpx client-call candidates
- pytest / vitest / jest test candidates

Do not implement:

- automatic multi-root editing
- generated semantic summaries
- full OpenAPI resolver unless already present
- gRPC / GraphQL / Kafka / Redis / DB migration indexing
- telemetry or runtime graph ingestion
- new agent prompts unless the current implementation already generates them

---

## Current Workspace Rule

The current workspace may not match previous design documents.

Before changing implementation:

1. Inspect the actual current source tree.
2. Identify existing indexer, state store, tool, hook, and agent integrations.
3. Preserve existing public interfaces where possible.
4. Do not delete existing light indexing until all callers are migrated.
5. Do not introduce unrelated rewrites.
6. Do not change agent prompts unless indexer output shape requires it.
7. Keep the current workspace manifest file as `.opencode/context-bridge/workspace.json`. Do not migrate the canonical manifest to `workspace.yaml` in this task.

### Compatibility Rule

The new indexer must upgrade the internals without breaking the existing plugin surface.

- Preserve existing tool names, argument schemas, and return shapes for `ctx_status`, `ctx_neighbors`, `ctx_refresh_memory`, `ctx_symbols`, `ctx_search`, `ctx_pack`, and `ctx_impact`.
- Preserve existing tool names, argument schemas, and return shapes for `ctx_add_dir`, `ctx_list_roots`, `ctx_index`, `ctx_read`, and `ctx_test_plan` unless a required new field is additive and backward-compatible.
- Existing callers that parse current JSON fields or current text output must continue to work.
- Add new fields only as additive metadata. Do not remove or rename existing fields.
- Keep compatibility wrappers around the old light-index exports until all imports and tests prove callers have migrated.

---

## Indexer Functional Specification

### Inputs

The indexer must accept these targets:

| Target            | Meaning                                                                |
| ----------------- | ---------------------------------------------------------------------- |
| workspace         | all roots from `.opencode/context-bridge/workspace.json`               |
| root name         | one registered root, such as `frontend` or `backend`                   |
| file ref          | one root-alias path, such as `backend:src/main.py`                     |
| changed file list | files from hook-driven reindex queue                                   |
| full flag         | force complete reindex                                                 |
| reason            | `init`, `add_dir`, `manual`, `file_edited`, `watcher`, `session_start` |

### External Tool Policy

Allowed core dependencies:

- Node/Bun filesystem APIs
- Bun built-in SQLite via `bun:sqlite` as the primary database implementation
- TypeScript parser/compiler API if available in project dependencies
- JSON/YAML/TOML parsers already present or added with minimal justification

SQLite implementation requirements:

- Use `bun:sqlite`; do not add a native SQLite dependency unless a concrete limitation is documented.
- Enable WAL mode for the index database where supported: `PRAGMA journal_mode = WAL`.
- Use explicit transactions for batch index writes and resolver writes.
- Keep SQL migrations deterministic and file-backed or versioned in the database.
- Use cached prepared statements intentionally. Avoid unbounded cached dynamic SQL; use uncached prepared statements for one-off dynamic SQL when appropriate.
- Record database open/migration failures as diagnostics and fall back to compatible light-index behavior when possible.

Optional tools:

- `ripgrep`: fallback text search only
- `ast-grep`: optional pattern extraction only
- LSP: optional future enhancement only. Use Opencode default LSP

If an optional tool is unavailable, indexing must continue with reduced capability and record diagnostics.

### Generated Values

The indexer must generate:

| Value         | Description                                                                    |
| ------------- | ------------------------------------------------------------------------------ |
| roots         | registered workspace roots                                                     |
| files         | indexed files with hash and metadata                                           |
| nodes         | graph nodes for files, packages, symbols, routes, DTO candidates, tests        |
| edges         | graph edges for containment, definitions, imports, references, candidate calls |
| spans         | source line ranges for evidence                                                |
| unresolved    | unresolved imports, calls, and extraction failures                             |
| diagnostics   | parser and resolver errors                                                     |
| index_runs    | index execution history and stats                                              |
| stale markers | files/nodes affected by edits or failed refresh                                |

### Storage Space

All generated indexer state must be stored under:

- `{session_root}/.opencode/context-bridge/`

Do not store indexer state in source directories outside `{session_root}/.opencode/context-bridge/`.

---

## Storage Layout

Create or update this structure as needed:

| Path                                                                | Purpose                                        |
| ------------------------------------------------------------------- | ---------------------------------------------- |
| `{session_root}/.opencode/context-bridge/workspace.json`            | canonical registered roots, policies, indexing config; preserve existing manifest format |
| `{session_root}/.opencode/context-bridge/index.sqlite`              | primary index database                         |
| `{session_root}/.opencode/context-bridge/evidence/nodes.jsonl`      | debug/export node log                          |
| `{session_root}/.opencode/context-bridge/evidence/edges.jsonl`      | debug/export edge log                          |
| `{session_root}/.opencode/context-bridge/evidence/spans.jsonl`      | debug/export evidence spans                    |
| `{session_root}/.opencode/context-bridge/diagnostics/indexer.jsonl` | parse and resolver diagnostics                 |
| `{session_root}/.opencode/context-bridge/logs/index-runs.jsonl`     | index run summaries(only for debug)            |
| `{session_root}/.opencode/context-bridge/queue/reindex.jsonl`       | pending changed-file reindex queue             |
| `{session_root}/.opencode/context-bridge/memory/roots/*.md`         | optional deterministic root summary stubs only |
| `{session_root}/.opencode/context-bridge/packs/`                    | context packs generated by tools               |

---

## Primary Database Schema

Implement or migrate toward this SQLite schema.

| Table        | Required fields                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `roots`      | `id`, `name`, `abs_path`, `rel_path`, `role`, `access`, `languages_json`, `tags_json`, `status`, `last_indexed_at` |
| `files`      | `id`, `root_id`, `rel_path`, `abs_path`, `language`, `hash`, `size_bytes`, `is_generated`, `indexed_at`            |
| `nodes`      | `id`, `kind`, `name`, `root_id`, `file_id`, `start_line`, `end_line`, `attrs_json`, `confidence`                   |
| `edges`      | `id`, `from_id`, `to_id`, `kind`, `file_id`, `start_line`, `end_line`, `attrs_json`, `confidence`                  |
| `spans`      | `id`, `root_id`, `file_id`, `start_line`, `end_line`, `text`                                                       |
| `unresolved` | `id`, `kind`, `name`, `root_id`, `file_id`, `attrs_json`, `reason`                                                 |
| `summaries`  | `id`, `target_id`, `target_kind`, `summary_path`, `evidence_hash`, `status`, `generated_at`                        |
| `index_runs` | `id`, `reason`, `started_at`, `finished_at`, `roots_json`, `stats_json`, `diagnostics_json`                        |
| `schema_meta` | `key`, `value`, `updated_at`; stores schema version and migration metadata                                         |

Use stable IDs. ID format must include root alias and relative path where possible.

Examples of ID formats:

- `root:frontend`
- `file:backend:src/main.py`
- `symbol:frontend:src/api/orders.ts:createOrder`
- `type:shared:src/types/order.ts:OrderDto`
- `dto_candidate:backend:src/schemas.py:CreateOrderRequest`
- `route_candidate:backend:POST:/orders`
- `client_call:frontend:src/api/orders.ts:18`

Stable ID rules:

- Normalize all stored relative paths to POSIX separators.
- Root aliases are part of durable IDs. If a root alias changes, mark old facts stale and rebuild affected IDs.
- For default exports, anonymous functions/classes, overloads, and duplicate symbols, include a deterministic suffix from file path, symbol kind, line range, and local ordinal.
- Normalize route parameters before endpoint matching where possible, for example `:id`, `{id}`, and `<id>` should be comparable as a parameter segment.
- Line-number IDs may be used for candidate calls, but must store source hash/span evidence so line shifts can be detected and refreshed.

Database migration rules:

- Migrations must be deterministic and idempotent.
- On startup or first index use, open `index.sqlite`, create missing tables, apply pending migrations, and record schema version in `schema_meta`.
- If migration fails, record diagnostics and keep existing tool behavior through the compatibility layer rather than crashing the whole plugin.

---

## Node and Edge Requirements

### Minimum Node Kinds

- `ROOT`
- `PACKAGE`
- `FILE`
- `SYMBOL`
- `FUNCTION`
- `CLASS`
- `TYPE`
- `DTO_CANDIDATE`
- `HTTP_ROUTE_CANDIDATE`
- `HTTP_CLIENT_CALL_CANDIDATE`
- `TEST_CANDIDATE`

### Minimum Edge Kinds

- `CONTAINS`
- `DEFINES`
- `IMPORTS`
- `EXPORTS`
- `REFERENCES`
- `DEPENDS_ON`
- `HANDLES_ROUTE_CANDIDATE`
- `CALLS_ENDPOINT_CANDIDATE`
- `TESTS_CANDIDATE`

Do not force low-confidence cross-root links. Store unresolved or low-confidence relations explicitly.

---

## Extractor Requirements

### File Scanner

The scanner must:

- read roots from workspace manifest
- normalize absolute paths
- classify files by extension and path
- compute file hash
- skip ignored directories
- mark generated files
- support incremental indexing by hash comparison

Default excludes:

- `.git`
- `node_modules`
- `dist`
- `build`
- `coverage`
- `.next`
- `target`
- `__pycache__`
- `.venv`
- `venv`

### TypeScript / JavaScript Extractor

Extract:

- imports
- exports
- exported interfaces
- exported types
- functions
- classes
- DTO candidates
- Express route candidates
- fetch/axios client-call candidates
- test file candidates

DTO candidate rule:

- exported type/interface/class
- name ends with `Dto`, `DTO`, `Request`, `Response`, `Payload`, or `Event`
- or located in shared/types/schema directories
- or used near route/client-call candidate

### Python Extractor

Extract:

- imports
- functions
- classes
- dataclass candidates
- Pydantic `BaseModel` candidates
- `TypedDict` candidates
- FastAPI route candidates
- Flask route candidates
- requests/httpx client-call candidates
- pytest test candidates

Python helper may use standard library `ast`. If Python is unavailable, record diagnostic and fall back to text-only file indexing.

Python extraction caveats:

- Prefer `ast.parse(source, type_comments=True)` in a helper process.
- Treat Pydantic, dataclass, TypedDict, FastAPI/Flask routes, and requests/httpx calls as static candidates with confidence and reason fields.
- Python `end_lineno` / `end_col_offset` require Python 3.8+ and may still be absent on some nodes. Store partial spans when needed.
- Syntax errors, unsupported Python versions, dynamic imports, decorator indirection, aliases, and unresolved call targets must be diagnostics or unresolved records, not fatal workspace failures.

### Package Extractors

TypeScript metadata:

- `package.json`
- `tsconfig.json`
- workspace config if present

Python metadata:

- `pyproject.toml`
- `requirements.txt`
- `setup.py`
- `setup.cfg`
- `pytest.ini`
- `tox.ini`

Extract:

- package name
- dependency names
- test commands
- build commands
- language hints
- framework hints

---

## Resolver Requirements

Resolvers must run after extractors.

Implement MVP resolvers for:

| Resolver                   | Required behavior                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| package resolver           | connect package dependency names to registered roots when package names match              |
| local import resolver      | connect relative imports to files in the same root where possible                          |
| cross-root import resolver | connect package imports to symbols/files in another root when package metadata supports it |
| endpoint resolver          | connect client-call candidates to route candidates by method/path with confidence          |
| test resolver              | connect test files to likely source files by naming and directory conventions              |

If a relation is uncertain, store it in `unresolved` or create a low-confidence edge.

Incremental resolver scope rules:

- Changed source files must delete and replace only that file's direct facts first.
- Resolver-generated edges may need broader refresh than the changed file. Recompute the affected resolver scope deterministically.
- Package metadata changes may affect package and cross-root import resolution across all registered roots.
- Route or client-call candidate changes may affect endpoint resolver edges across all route/client candidates.
- Test file or source file changes may affect same-root test resolver edges.
- Never leave resolver edges pointing to deleted file/node IDs.

---

## Indexing Result Save Method

Each index run must:

1. create an `index_runs` row at start
2. scan target roots/files
3. delete old facts for changed files only
4. insert new files, nodes, edges, spans
5. run resolvers
6. update unresolved records
7. write diagnostics
8. update root `last_indexed_at`
9. write JSONL debug/export files if enabled
10. mark affected summaries stale if the evidence hash changed
11. return an index report to the caller

Index report must include:

- roots indexed
- files scanned
- files indexed
- files skipped
- node count
- edge count
- span count
- unresolved count
- diagnostics count
- elapsed time
- degraded mode flags

---

## Existing Light Index Replacement

Replace the existing light indexing by adapter migration, not by deletion.

Required approach:

1. Locate the existing light index entry point.
2. Preserve its exported function names or command/tool-facing API if currently used.
3. Replace its internals with the new pipeline.
4. If compatibility is unsafe, create a wrapper that maps old light-index calls to the new indexer.
5. Keep old output fields that tools currently consume.
6. Add new fields without breaking existing callers.
7. Update `ctx_index` to call the new indexer.
8. Update `ctx_status`, `ctx_neighbors`, `ctx_refresh_memory`, `ctx_symbols`, `ctx_search`, `ctx_pack`, and `ctx_impact` to use the new indexer and storage paths while preserving their existing names, argument schemas, and return shapes.
9. Update `ctx_read` to continue resolving root alias paths from `workspace.json` and source files, while using SQLite metadata only as supporting evidence.
10. Keep fallback behavior for missing DB or failed migration.
11. Add diagnostics for stale old index state.

Do not remove old light index files unless all imports are updated and tests confirm no callers remain.

Compatibility targets:

- `src/indexer/light-index.ts` currently exports `indexRoot`, `searchIndex`, `readEntries`, `indexStaleRoots`, and `ensureIndexReady`; these exports must remain available until all callers are migrated.
- `readEntries()` may become a compatibility adapter over SQLite-backed facts, but it must still return entries compatible with the existing `IndexEntry` shape for old callers.
- `searchIndex()` may query SQLite internally, but it must still return `SearchHit[]` compatible with current tool rendering.
- Existing `index.jsonl` data may be retained as fallback/debug input, but `index.sqlite` becomes the primary source once migration succeeds.

---

## Side Effects on Existing Tools

### `ctx_add_dir`

Expected side effects:

- writes root entry to workspace manifest
- triggers index run if `index: true`
- writes event log
- updates session active roots
- returns root badge and index report

### `ctx_index`

Expected side effects:

- writes SQLite facts
- writes diagnostics
- updates index run log
- marks summaries stale
- clears processed reindex queue items
- returns a backward-compatible JSON shape including the existing `index` and `result` fields, with additional report fields only added additively

### `ctx_status`

Expected side effects:

- no mutation
- reads `workspace.json`, SQLite status, diagnostics, recent ledger, and stale markers
- preserves existing status JSON fields and notes while adding SQLite/index-run fields additively

### `ctx_search`

Expected side effects:

- no mutation
- reads SQLite nodes/files/spans
- supports root filtering
- supports kind filtering
- preserves current human-readable hit output format so existing agent prompts and callers continue to work

### `ctx_symbols`

Expected side effects:

- no mutation
- reads symbol/function/class/type nodes from SQLite
- preserves existing JSON return shape for filters, count, symbols, and notes

### `ctx_neighbors`

Expected side effects:

- no mutation
- reads graph neighbors, same-file evidence, direct definitions, imports, unresolved records, and low-confidence edges
- preserves existing JSON return shape for target, directEvidence, neighbors, unknowns, and disclaimer

### `ctx_read`

Expected side effects:

- no mutation
- resolves root alias path
- reads source file by line range
- must enforce root access and secret path policy

### `ctx_pack`

Expected side effects:

- reads graph evidence
- writes pack files under `.opencode/context-bridge/packs/`
- must include evidence anchors
- must mark unknowns when graph coverage is incomplete
- preserves existing pack JSON fields: task, workspace, evidence, risks, suggestedNext, generatedAt; new graph fields must be additive

### `ctx_refresh_memory`

Expected side effects:

- preserves compatibility/status behavior for agents that request memory refresh
- may trigger the new indexer when `reindex` is true
- may create a fresh SQLite-backed context pack when `task` is provided
- must not claim generated semantic summaries unless deterministic summary stubs already exist
- preserves existing JSON return shape for version, status, actions, recommendations, notes, and pack

### `ctx_impact`

Expected side effects:

- no source mutation
- reads graph neighbors and unresolved records
- may write impact report artifact if existing tool design already does so
- preserves existing JSON return shape for target, roots, directEvidence, risks, unknowns, and suggestedNext

### `ctx_test_plan`

Expected side effects:

- no test execution
- reads package metadata, test candidates, and graph relations
- returns targeted commands only

---

## Side Effects on Hooks

### `session.created`

- ensure `.opencode/context-bridge/` exists
- ensure primary root exists in workspace manifest
- do not run full index unless current behavior already does this

### `file.edited`

- compute root alias and relative path
- enqueue file for reindex
- mark affected file facts stale
- mark affected summaries stale

### `file.watcher.updated`

- enqueue changed file for incremental reindex
- do not run full index automatically

### `tool.execute.before`

- block edit/write on read-only roots
- block secret file reads
- warn or block contract boundary edits if impact analysis is missing

### `tool.execute.after`

- record tool event
- enqueue edited files for reindex
- record test output if command was a validation command

### `session.compacting`

- include active roots
- include last index run
- include stale index warnings
- include pending validation and impact gates

---

## Side Effects on Agents and Subagents

### `ctx-orchestrator`

- must use `ctx_status`, `ctx_list_roots`, `ctx_index`, and `ctx_pack` instead of raw exploration for multi-root tasks
- must request reindex when index is stale
- must not directly edit files based only on summary text

### `ctx-workspace-architect`

- must use indexed roots, packages, files, and dependencies
- should report unresolved references separately
- should not infer cross-root relations without graph evidence

### `ctx-context-curator`

- must build context packs from SQLite evidence and source spans
- must include unknowns and stale warnings
- must not dump whole files unless required

### `ctx-impact-analyst`

- must use graph neighbors, edges, unresolved records, and test candidates
- must separate direct impact, cross-root impact, contract/boundary impact, tests, and unknowns

### `ctx-test-router`

- must use package metadata and test candidates from the index
- must not run tests unless explicitly invoked as validation runner

### `ctx-validation-runner`

- no direct index mutation
- may trigger reindex after test-related edits only through existing tool/hook path

### `ctx-builder`

- must check root access and impact gates before editing
- must not edit read-only roots
- must not expand edit scope without updated context pack

---

## Acceptance Criteria

The implementation is acceptable when:

1. Primary root can be indexed.
2. Additional root can be indexed after `ctx_add_dir`.
3. TypeScript imports, exports, functions, classes, interfaces, and type aliases are stored.
4. Python imports, functions, classes, Pydantic/dataclass/TypedDict candidates are stored.
5. Basic route and client-call candidates are stored for TypeScript and Python.
6. Test candidates are stored.
7. Incremental reindex only updates changed files.
8. SQLite contains roots, files, nodes, edges, spans, unresolved records, and index runs.
9. `ctx_search` returns indexed symbols/files.
10. `ctx_read` resolves root alias paths.
11. `ctx_pack` creates an evidence-backed pack.
12. `ctx_impact` can use graph edges for at least imports, references, route/client candidates, and tests.
13. Existing tools still work if the new DB is missing or empty.
14. Index failures are stored in diagnostics and do not abort the whole workspace run.
15. The canonical workspace manifest remains `.opencode/context-bridge/workspace.json`; no `workspace.yaml` migration is required or introduced.
16. `ctx_status`, `ctx_neighbors`, `ctx_refresh_memory`, `ctx_symbols`, `ctx_search`, `ctx_pack`, and `ctx_impact` use the new indexer/storage internally while preserving existing tool names, argument schemas, and return shapes.
17. `ctx_add_dir`, `ctx_list_roots`, `ctx_index`, `ctx_read`, and `ctx_test_plan` remain backward-compatible.
18. The implementation uses Bun built-in SQLite (`bun:sqlite`) for `index.sqlite`.
19. SQLite migrations are versioned/idempotent, WAL/transactions are used where appropriate, and database failures degrade to diagnostics plus compatibility fallback where possible.
20. Optional tools such as `ripgrep` and `ast-grep` may be absent; indexing continues with degraded diagnostics.
21. Incremental reindex removes stale file facts and refreshes resolver-generated edges that reference changed or deleted facts.
22. Python static extraction records uncertain semantic findings as candidates with confidence/reason fields, diagnostics, or unresolved records.
23. `bun run typecheck` and `bun run build` pass after implementation.

---

## Full Flow Example

### Initial state

Current root:

- `frontend`
- TypeScript project
- contains `src/api/orders.ts`
- contains a client call to `POST /orders`

External root to add:

- `../backend`
- Python FastAPI project
- contains `src/main.py`
- contains `@app.post("/orders")`
- contains `src/schemas.py`
- defines `CreateOrderRequest`

### Step 1: User adds external root

User command:

- `/ctx-add-dir ../backend --name backend --ro --role service --tags python,fastapi`

Expected operations:

1. `ctx_add_dir` validates path.
2. `workspace.json` receives root `backend`.
3. Session state adds `backend` to active roots.
4. `ctx_index` runs for `backend`.
5. Indexer scans Python files and metadata.
6. Python extractor stores FastAPI route candidate.
7. Python extractor stores `CreateOrderRequest` as DTO candidate.
8. Test resolver stores `tests/test_orders.py` as test candidate.
9. Index report is returned.

Expected stored facts:

- `root:backend`
- `file:backend:src/main.py`
- `file:backend:src/schemas.py`
- `route_candidate:backend:POST:/orders`
- `dto_candidate:backend:src/schemas.py:CreateOrderRequest`
- `test_candidate:backend:tests/test_orders.py`

### Step 2: Existing frontend is indexed

Expected operations:

1. TypeScript extractor scans `frontend`.
2. `src/api/orders.ts` is indexed.
3. fetch/axios client-call candidate is extracted.
4. Package metadata is stored.

Expected stored facts:

- `file:frontend:src/api/orders.ts`
- `client_call:frontend:src/api/orders.ts:POST:/orders`

### Step 3: Resolver links frontend and backend

Expected resolver output:

- edge from frontend client-call candidate to backend route candidate
- confidence based on method/path match
- unresolved record if base URL or service mapping is ambiguous

Expected edge:

- `frontend:src/api/orders.ts CALLS_ENDPOINT_CANDIDATE backend:POST:/orders`

### Step 4: User asks for a change

User command:

- `/ctx-pack "Add billingAddress to order creation"`

Expected operations:

1. `ctx_pack` searches indexed nodes for order-related routes, DTOs, and client calls.
2. It reads exact spans through `ctx_read`.
3. It writes a context pack under `.opencode/context-bridge/packs/`.
4. Pack includes relevant roots, evidence, risks, unknowns, and validation plan.

Expected pack content:

- `frontend:src/api/orders.ts` calls `POST /orders`
- `backend:src/main.py` handles `POST /orders`
- `backend:src/schemas.py` defines `CreateOrderRequest`
- `backend:tests/test_orders.py` is a likely affected test
- risk: API request body change
- unknown: OpenAPI file not indexed if absent

### Step 5: Impact analysis

User command:

- `/ctx-impact route_candidate:backend:POST:/orders`

Expected output:

- direct impact: backend route handler
- cross-root impact: frontend client call
- boundary impact: `CreateOrderRequest`
- affected tests: backend order tests and possible frontend API tests
- risk level: medium or high if request schema changes
- required gates: impact before edit, targeted validation
- unknowns: unresolved consumers, missing OpenAPI, missing generated client detection

### Step 6: Edit and validation planning

Expected agent behavior:

1. Orchestrator does not edit directly.
2. Builder may edit only after approved plan.
3. Builder must not edit read-only roots.
4. Test-router proposes targeted tests.
5. Validation-runner runs only approved targeted commands.
6. File edits enqueue reindex.
7. Reindex updates stale graph facts.
8. Final response cites changed files, tests, and remaining unknowns.
