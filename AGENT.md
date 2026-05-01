# opencode-context-bridge Finalized Development Document

Document version: v1.0  
Project codename: **opencode-context-bridge**  
Development goal: A plugin-style agent harness that enables opencode to recognize multiple directories, repositories, modules, and microservices as a single workspace, and enables agents to perform **exploration → indexing → summarization → impact analysis → modification → validation** across them.

---

## 0. Finalized Core Decisions

| Decision Item | Final Decision |
|---|---|
| Project name | **opencode-context-bridge** |
| Core position | Not a `/add-dir` replacement, but a **multi-root context orchestration layer** |
| Implementation form | opencode plugin + sidecar indexer CLI + file-backed state |
| Context structure | **Evidence Graph + Semantic Memory + Contract Boundary Registry + Context Pack** |
| Parser role | Not a natural-language summary generator, but a deterministic evidence extractor |
| Summary role | Natural-language interpretation layer anchored to the Evidence Graph |
| Need for graph | Required. Cross-workspace relationships are managed by graph/contract registry, not summary |
| Storage | `.opencode/context-bridge/` |
| DB | SQLite primary, JSONL auxiliary for debug/export |
| MVP target languages | TypeScript / JavaScript, JSON, YAML |
| MVP target frameworks | package.json, pnpm workspace, tsconfig paths, Express, partial NestJS, fetch/axios, OpenAPI |
| Parser tools | tree-sitter + ast-grep + ripgrep fallback, with LSP as optional augmentation |
| opencode command UX | `/ctx:*` custom commands call custom tools |
| Root default permissions | Primary root is `rw`; added roots default to `ro`; explicit `--rw` required |
| Contract file edit policy | Block editing or require approval without impact analysis |
| Automatic modification policy | Plan/impact-centered until v0.4; cross-root automatic modification is approval-based |
| Research evaluation direction | Compare vanilla opencode, external_directory only, simple graph MCP, RepoMap-like summary, and context-bridge full |

As organized in the previous ideation document, this project is finalized not as a simple external-directory access feature, but as an opencode-native plugin that connects multiple repo/service/module roots through a workflow of “discovery → indexing → summarization → search → impact analysis → modification/validation.”

---

# 1. Problem Definition

## 1.1 Problem to Solve

Because opencode currently operates around the current working directory, the following problems arise when a task requires multiple repositories or microservices.

```text
1. It is difficult to naturally add directories outside the current session into the workspace.
2. Even if external directories can be read, they are not managed as separate workspaces from opencode's context/indexing perspective.
3. The agent must infer, through grep/read every time, relationships such as repository A using module B.
4. It is difficult to systematically track the impact of boundary objects such as DTOs, OpenAPI, proto, GraphQL, cache keys, message topics, and DB schemas.
5. In long-running tasks, added roots, impact decisions, and validation state can disappear after compaction.
6. When modifying multiple repositories, there is a high risk of missing read-only roots, public contracts, generated clients, and affected tests.
```

opencode officially supports behavioral extension through plugins and event hooks, adding tools callable by LLMs through custom tools, and custom commands and agents. Therefore, this project will be implemented as an extension layer composed of plugins, commands, tools, hooks, and agents rather than by modifying opencode core. ([opencode.ai](https://opencode.ai/docs/plugins/?utm_source=chatgpt.com))

## 1.2 Project Goals

**opencode-context-bridge** provides the following.

```text
1. Add multiple root directories/repositories to an opencode session.
2. Manage each root in a manifest with alias, role, access policy, and tags.
3. Analyze code, configuration, and contract files in each root with a deterministic parser.
4. Store analysis results in the Evidence Graph.
5. Promote shared boundaries such as DTO/API/schema/cache/topic/DB to the Contract Registry.
6. Generate Semantic Memory on top of the Evidence Graph.
7. Generate the Context Pack required for each user task.
8. Perform impact analysis and permission gates before modification.
9. After modification, validate affected tests, contract drift, and stale summaries.
10. Preserve task state even in long sessions through file-backed state and compaction memory.
```

---

# 2. Design Principles

## 2.1 Applying Natural Language Harness Principles

This project adopts the NLAH perspective. The NLAH paper views an agent harness not as a simple prompt, but as an orchestration layer that manages **control, contracts, and state**. It explains that harness components such as contracts, roles, stage structure, adapters/scripts, state semantics, and failure taxonomy must be explicit. It also distinguishes natural language as carrying high-level orchestration logic, while deterministic hooks are handled by adapters/scripts, rather than replacing deterministic code.

Therefore, this project's structure is also divided as follows.

```text
Natural-language layer:
- agent prompts
- workflow stages
- role definitions
- contract policies
- failure taxonomy
- summary/memory files

Deterministic layer:
- parser
- indexer
- resolver
- permission checker
- contract diff checker
- test command detector
- SQLite graph query
```

## 2.2 File-backed State Principle

The NLAH paper describes the core properties of file-backed state as externalized, path-addressable, and compaction-stable. In other words, important state should remain as file artifacts rather than only inside the conversation window; later stages should be able to reopen it by path; and it should be recoverable after compaction, restart, or delegation.

Therefore, all long-lived state is stored in the following directory.

```text
.opencode/context-bridge/
  workspace.yaml
  index.sqlite
  evidence/
  memory/
  contracts/
  packs/
  state/
  logs/
  snapshots/
```

## 2.3 Evidence-first Principle

Semantic Memory is useful, but it cannot serve as the original evidence.

Final principles:

```text
1. The parser extracts only deterministic facts.
2. Relationships between workspaces are managed by the Evidence Graph.
3. Summaries are anchored to graph nodes and evidence spans.
4. Context packs include not only summaries, but also evidence, exact file spans, contracts, and tests.
5. Final answers, impact analyses, and review claims should include evidence anchors whenever possible.
```

The evidence-backed answering module in the appendix of the NLAH paper also suggests that release-critical claims should leave provenance and supporting spans. This project applies that principle to code context management.

---

# 3. Overall System Architecture

```text
opencode
  ├─ plugin layer
  │   ├─ custom commands: /ctx:*
  │   ├─ custom tools: ctx_*
  │   ├─ hooks: tool/session/file/tui
  │   └─ agents: context-curator, impact-analyst, ...
  │
  ├─ sidecar indexer CLI
  │   ├─ scanner
  │   ├─ extractors
  │   ├─ resolvers/stitchers
  │   ├─ contract registry builder
  │   └─ semantic memory generator
  │
  └─ file-backed state
      ├─ workspace.yaml
      ├─ index.sqlite
      ├─ evidence/*.jsonl
      ├─ contracts/*.yaml
      ├─ memory/**/*.md
      ├─ packs/*.md
      └─ state/*.jsonl
```

## 3.1 opencode Plugin Layer

The opencode plugin has the following responsibilities.

```text
1. Provide /ctx:* commands.
2. Register ctx_* custom tools.
3. Invoke the sidecar indexer.
4. Handle opencode session/tool/file hooks.
5. Check additional root permissions.
6. Preserve workspace state during compaction.
7. Install and configure agents/skills and their permissions.
```

According to opencode's official documentation, custom tools are functions that the LLM can call during conversation and that operate alongside built-in tools. Custom commands are prompt-based repeated tasks executed from the TUI, and permission config determines whether specific actions are automatically executed, require approval, or are blocked. ([opencode.ai](https://opencode.ai/docs/custom-tools/?utm_source=chatgpt.com))

## 3.2 Sidecar Indexer CLI

The parser is not fully placed inside the plugin. The parser and graph builder are kept as a separate sidecar CLI.

```text
context-bridge index
context-bridge search
context-bridge read
context-bridge impact
context-bridge pack
context-bridge validate
context-bridge doctor
```

Reasons:

```text
1. The parser is heavy work, so it should be separated from the plugin event loop.
2. It is easier to test at the CLI level.
3. It can later be reused from MCP, VSCode, and CI.
4. The opencode plugin can focus on orchestration and UX.
```

## 3.3 Evidence Graph

The Evidence Graph represents the following.

```text
- root
- repository
- package
- file
- symbol
- import
- route
- endpoint
- DTO
- schema
- test
- build target
- service
- cache key
- message topic
- DB table
```

A minimal graph is introduced from the MVP. However, the MVP graph starts small.

```text
MVP graph:
- ROOT
- PACKAGE
- FILE
- SYMBOL
- TYPE
- DTO candidate
- IMPORT
- TEST candidate

Expansion after v0.2:
- REST_ENDPOINT
- OPENAPI_OPERATION
- ROUTE_HANDLER
- CLIENT_CALL
- CONTRACT
- TEST_TARGET

Expansion after v0.3:
- GRPC_SERVICE
- GRPC_METHOD
- GRAPHQL_FIELD
- MESSAGE_TOPIC
- CACHE_KEY
- DB_TABLE
- MIGRATION
- RUNTIME_SERVICE
```

## 3.4 Semantic Memory

Semantic Memory is markdown summary anchored to graph nodes.

```text
.opencode/context-bridge/memory/
  roots/frontend.md
  roots/backend.md
  files/backend/src/routes/orders.ts.md
  symbols/shared/OrderDto.md
  contracts/rest.POST_orders.md
  services/order-service.md
```

Rules:

```text
1. A summary has an evidence_hash.
2. If related evidence changes, it is marked stale.
3. Claims inside summaries have evidence anchors.
4. Summaries are used as compressed interpretive information when generating context packs.
5. Cross-root relationships are not judged from summaries alone.
```

## 3.5 Contract Boundary Registry

DTOs, REST APIs, gRPC, GraphQL, cache keys, message topics, and DB schemas are not managed as ordinary symbols, but as **Contract Boundary Nodes**.

```text
.opencode/context-bridge/contracts/
  dto.OrderDto.yaml
  rest.POST_orders.yaml
  grpc.OrderService.CreateOrder.yaml
  graphql.Order.billingAddress.yaml
  topic.order_created.yaml
  cache.order_by_id.yaml
  db.orders.yaml
```

The Contract Registry contains the following information.

```text
- contract id
- kind
- owner root
- visibility
- provider
- consumers
- related DTO/schema
- tests
- generated artifacts
- change policy
- last verified timestamp
```

## 3.6 Context Pack

A Context Pack is the execution context required for a specific user task.

```text
.opencode/context-bridge/packs/
  2026-xx-xx-add-billing-address.md
```

Contents:

```text
1. task
2. active roots
3. relevant evidence nodes
4. relevant files and line ranges
5. semantic summaries
6. contract boundaries
7. affected tests
8. risk and unknowns
9. suggested edit order
10. validation plan
```

---

# 4. Repository and File Structure

## 4.1 Project Repository Structure

```text
opencode-context-bridge/
  package.json
  README.md

  packages/
    plugin/
      src/
        index.ts
        tools/
        hooks/
        commands/
        agents/
      opencode.template.json

    core/
      src/
        workspace/
        graph/
        contracts/
        memory/
        packs/
        policy/
        utils/

    indexer/
      src/
        cli.ts
        scan/
        extractors/
        resolvers/
        writers/
        diagnostics/

    rules/
      ast-grep/
        typescript/
        express-route.yml
        axios-call.yml
        redis-cache.yml
        kafka-topic.yml

    agents/
      workspace-architect.md
      context-curator.md
      impact-analyst.md
      service-boundary-analyst.md
      contract-reviewer.md
      test-router.md
      validation-runner.md
      security-boundary-auditor.md
      multi-repo-builder.md

    commands/
      ctx-init.md
      ctx-add-dir.md
      ctx-list.md
      ctx-index.md
      ctx-search.md
      ctx-pack.md
      ctx-impact.md
      ctx-map.md
      ctx-validate.md
      ctx-review.md

  fixtures/
    ts-express-openapi/
    ts-nest-openapi/
    ts-shared-dto/
    grpc-proto/
    kafka-topic/
    redis-cache/
    prisma-db/

  docs/
    architecture.md
    parser-design.md
    graph-schema.md
    contract-registry.md
    roadmap.md
    evaluation.md
```

## 4.2 Internal State Structure Inside the User Project

```text
.opencode/
  context-bridge/
    workspace.yaml
    index.sqlite

    evidence/
      nodes.jsonl
      edges.jsonl
      spans.jsonl
      diagnostics.jsonl

    contracts/
      dto.OrderDto.yaml
      rest.POST_orders.yaml

    memory/
      roots/
      files/
      symbols/
      contracts/
      services/

    packs/
      current.md
      history/

    state/
      task_history.jsonl
      active_roots.json
      touched_nodes.json
      pending_validations.json
      policy_decisions.jsonl

    logs/
      index.log
      hooks.log
      validation.log

    snapshots/
      2026-xx-xx-before-change/
```

---

# 5. Final Workspace Manifest

File: `.opencode/context-bridge/workspace.yaml`

```yaml
version: 1

workspace:
  name: default
  primary_root: app

roots:
  - name: app
    path: .
    role: primary
    access: rw
    tags: [primary]
    index: true

  - name: frontend
    path: ../frontend
    role: app
    access: rw
    tags: [react, web]
    index: true

  - name: backend
    path: ../backend
    role: service
    access: rw
    tags: [api, node]
    index: true

  - name: shared
    path: ../shared
    role: library
    access: ro
    tags: [types, sdk]
    index: true

policies:
  default_added_root_access: ro

  require_impact_before_edit:
    - "**/openapi*.yaml"
    - "**/*.proto"
    - "**/schema.graphql"
    - "**/schema.prisma"
    - "**/migrations/**"
    - "**/contracts/**"
    - "**/generated/**"

  secret_patterns:
    - "**/.env"
    - "**/.env.*"
    - "**/secrets/**"
    - "**/*secret*"
    - "**/*credential*"

  generated_patterns:
    - "**/generated/**"
    - "**/__generated__/**"
    - "**/*.gen.ts"
    - "**/*.pb.go"

index:
  exclude:
    - ".git/**"
    - "node_modules/**"
    - "dist/**"
    - "build/**"
    - "coverage/**"
    - ".next/**"
    - "target/**"
  include_generated: true
  generated_readonly_by_default: true

memory:
  auto_summarize: true
  stale_on_evidence_hash_change: true

validation:
  prefer_targeted_tests: true
  require_contract_review_for_boundary_changes: true
```

---

# 6. Parser / Indexer Design

## 6.1 Definition of Parser

In this project, a parser is defined as follows.

```text
Parser = a deterministic extractor pipeline that extracts evidenced facts from each workspace and inserts them into the Evidence Graph
```

The parser does not generate natural-language summaries. The parser extracts the following facts.

```text
- Which symbols does this file define?
- Which packages does this file import?
- Which endpoint does this route file provide?
- Which endpoint does this frontend file call?
- Which operations/schemas does this OpenAPI file define?
- Which services/methods/messages does this proto file define?
- Which table/column does this migration modify?
```

## 6.2 Pipeline

```text
Workspace Manifest
  ↓
File Scanner
  ↓
Extractor Pipeline
  ├─ Package / Build Extractor
  ├─ Language Symbol Extractor
  ├─ Import / Dependency Extractor
  ├─ Route Provider Extractor
  ├─ Client-call Extractor
  ├─ Contract Extractor
  ├─ Cache / Queue / DB Extractor
  └─ Test Extractor
  ↓
Resolver / Stitcher
  ├─ import resolution
  ├─ package-to-root linking
  ├─ endpoint provider-consumer linking
  ├─ DTO-schema linking
  ├─ generated-client linking
  └─ test-to-code linking
  ↓
Evidence Graph
  ↓
Contract Registry Builder
  ↓
Semantic Memory Generator
  ↓
Context Pack Generator
```

## 6.3 Role of Each Tool

```text
tree-sitter:
- General-purpose syntax tree
- Extract function/class/type/interface/enum
- Extract import/export
- Extract symbol spans

ast-grep:
- Extract framework-specific patterns
- Express route
- NestJS decorator
- axios/fetch call
- Redis get/set
- Kafka publish/subscribe
- Prisma query

ripgrep:
- Fast fallback
- Candidate string search
- Provide text-only evidence when parser fails

LSP:
- Optional augmentation
- definition/reference/documentSymbol/call hierarchy
- optional after v0.2
```

## 6.4 Extractor Interface

```ts
export interface FileMeta {
  root: string
  absPath: string
  relPath: string
  language: string
  sizeBytes: number
  hash: string
  isGenerated: boolean
}

export interface EvidenceSpan {
  root: string
  path: string
  startLine: number
  endLine: number
  startColumn?: number
  endColumn?: number
  text?: string
}

export interface GraphNode {
  id: string
  kind: string
  name: string
  root?: string
  path?: string
  span?: EvidenceSpan
  attrs?: Record<string, unknown>
  confidence?: number
}

export interface GraphEdge {
  from: string
  to: string
  kind: string
  evidence?: EvidenceSpan
  confidence: number
  attrs?: Record<string, unknown>
}

export interface ExtractResult {
  nodes: GraphNode[]
  edges: GraphEdge[]
  diagnostics: ParserDiagnostic[]
}

export interface Extractor {
  name: string
  supports(file: FileMeta): boolean
  extract(ctx: ExtractContext, file: FileMeta): Promise<ExtractResult>
}
```

## 6.5 Resolver Principles

Extractors only extract file-level facts. Cross-workspace linking is handled by the resolver.

Example:

```text
frontend imports @acme/shared-types
shared package name is @acme/shared-types
shared exports OrderDto
```

Resolver result:

```text
frontend:src/api/orders.ts REFERENCES dto:shared:OrderDto
```

Endpoint example:

```text
frontend calls POST /orders
backend provides POST /orders
backend OpenAPI documents POST /orders
```

Resolver result:

```text
frontend:src/api/orders.ts CALLS_ENDPOINT rest:backend:POST:/orders
rest:backend:POST:/orders DOCUMENTED_BY backend:openapi.yaml
```

Do not force links when they are ambiguous.

```text
- If confidence < threshold, leave it unresolved.
- Mark it in summaries as Unknown or Low-confidence relation.
- In impact analysis, classify low-confidence edges as “requires additional confirmation.”
```

---

# 7. Evidence Graph Schema

## 7.1 Core Node Kinds

```text
ROOT
REPOSITORY
PACKAGE
BUILD_TARGET
TEST_TARGET
FILE
SYMBOL
FUNCTION
CLASS
TYPE
DTO
REST_ENDPOINT
ROUTE_HANDLER
CLIENT_CALL
OPENAPI_OPERATION
OPENAPI_SCHEMA
GRPC_SERVICE
GRPC_METHOD
PROTO_MESSAGE
GRAPHQL_TYPE
GRAPHQL_FIELD
MESSAGE_TOPIC
EVENT_SCHEMA
CACHE_KEY
DB_TABLE
DB_COLUMN
MIGRATION
ENV_VAR
GENERATED_ARTIFACT
SERVICE
DOC
DECISION
```

## 7.2 Core Edge Kinds

```text
CONTAINS
DEFINES
IMPORTS
EXPORTS
REFERENCES
CALLS
DEPENDS_ON
BUILDS
TESTS

HANDLES_ROUTE
CALLS_ENDPOINT
DOCUMENTED_BY
USES_SCHEMA
GENERATED_FROM

PROVIDES_API
CONSUMES_API
IMPLEMENTS_RPC
CALLS_RPC

PUBLISHES_TOPIC
CONSUMES_TOPIC
USES_EVENT_SCHEMA

READS_CACHE
WRITES_CACHE
INVALIDATES_CACHE
USES_CACHE_KEY

READS_TABLE
WRITES_TABLE
MIGRATES_TABLE
MAPS_TO_MODEL

OWNED_BY
MENTIONED_IN
RUNTIME_CALLS
```

## 7.3 Minimal SQLite Schema

```sql
CREATE TABLE roots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  access TEXT NOT NULL,
  role TEXT,
  metadata_json TEXT
);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  abs_path TEXT NOT NULL,
  language TEXT,
  hash TEXT NOT NULL,
  size_bytes INTEGER,
  is_generated INTEGER DEFAULT 0,
  indexed_at TEXT
);

CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  root_id TEXT,
  file_id TEXT,
  start_line INTEGER,
  end_line INTEGER,
  attrs_json TEXT,
  confidence REAL DEFAULT 1.0
);

CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  root_id TEXT,
  file_id TEXT,
  start_line INTEGER,
  end_line INTEGER,
  attrs_json TEXT,
  confidence REAL DEFAULT 1.0
);

CREATE TABLE spans (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  text TEXT
);

CREATE TABLE unresolved (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  root_id TEXT,
  file_id TEXT,
  attrs_json TEXT,
  reason TEXT
);

CREATE TABLE summaries (
  id TEXT PRIMARY KEY,
  target_node_id TEXT,
  summary_path TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  stale INTEGER DEFAULT 0
);
```

---

# 8. Contract Boundary Management

## 8.1 Why Manage It Separately

The following elements are more important than ordinary symbols.

```text
- DTO
- REST endpoint
- OpenAPI schema
- gRPC service/method/message
- GraphQL type/field/operation
- message topic/event schema
- cache key pattern
- DB table/column/migration
- environment variable
- generated client
```

Because these are boundaries between multiple workspaces, impact analysis, contract review, and affected test routing are required before and after modification.

## 8.2 Contract Registry Example

```yaml
id: rest:backend:POST:/orders
kind: REST_ENDPOINT
owner_root: backend
visibility: public

provider:
  handler: backend:src/routes/orders.ts#L42-L78
  schema: backend:openapi.yaml#/paths/~1orders/post

consumers:
  - frontend:src/api/orders.ts#L18-L18
  - admin:src/api/orders.ts#L14-L22

related_dtos:
  - dto:shared:OrderDto
  - schema:backend:CreateOrderRequest

generated_artifacts:
  - frontend:src/generated/orders.ts

tests:
  - backend:tests/orders.create.test.ts
  - frontend:tests/checkout.test.tsx

change_policy:
  require_impact_analysis: true
  require_contract_review: true
  require_consumer_check: true
  require_targeted_tests: true
```

## 8.3 DTO Policy

```text
Adding optional field:
- usually non-breaking
- still requires provider/consumer/schema check

Removing field:
- breaking

Renaming field:
- breaking

Changing field type:
- breaking unless all consumers are updated

Changing requiredness:
- possibly breaking
```

## 8.4 gRPC / Proto Policy

```text
Adding new field with new tag:
- usually non-breaking

Removing field:
- breaking

Reusing field number:
- dangerous, block by default

Changing field type:
- breaking

Changing service/method name:
- breaking
```

## 8.5 Cache / Topic / DB Policy

```text
Cache key shape change:
- require readers/writers/invalidators check

Topic name change:
- breaking

Event schema required field removal:
- breaking

DB table/column change:
- require migration and consumer check

DB column non-null addition:
- require default/backfill check
```

---

# 9. opencode Commands / Tools / Hooks / Agents

## 9.1 Commands

Initial commands are implemented as custom commands, and internally guide calls to `ctx_*` tools. opencode custom commands can be configured as TUI command prompts for repeated tasks. ([opencode.ai](https://opencode.ai/docs/commands/?utm_source=chatgpt.com))

```text
/ctx:init
/ctx:add-dir <path> [--name name] [--ro|--rw] [--tags ...]
/ctx:remove-dir <name|path>
/ctx:list
/ctx:index [root|--all]
/ctx:search <query>
/ctx:read <root:path> [--lines 10-30]
/ctx:map [--type root|service|contract]
/ctx:pack <task>
/ctx:impact <ref>
/ctx:validate
/ctx:doctor
```

Added in v0.4:

```text
/ctx:change <task>
/ctx:debug <symptom>
/ctx:contract-change <description>
/ctx:review
```

## 9.2 Custom Tools

```text
Workspace:
- ctx_init
- ctx_add_dir
- ctx_remove_dir
- ctx_list_roots
- ctx_set_access
- ctx_doctor

Index/Search:
- ctx_index
- ctx_search
- ctx_search_symbol
- ctx_search_endpoint
- ctx_search_contract
- ctx_read

Graph:
- ctx_neighbors
- ctx_path
- ctx_callers
- ctx_callees
- ctx_route_to_handler
- ctx_client_to_route

Context:
- ctx_pack
- ctx_pack_from_diff
- ctx_summarize_root
- ctx_summarize_file
- ctx_refresh_summary

Impact:
- ctx_impact
- ctx_impact_diff
- ctx_affected_tests
- ctx_affected_services
- ctx_contract_diff

Policy:
- ctx_preflight_edit
- ctx_check_policy
- ctx_mark_task_scope
- ctx_snapshot_roots

Validation:
- ctx_test_plan
- ctx_run_targeted_tests
- ctx_collect_diagnostics
- ctx_validate_contracts
- ctx_validate_workspace
```

## 9.3 Hooks

Because opencode plugins can extend behavior through event hooks, this project actively uses hooks for safety and memory preservation. ([opencode.ai](https://opencode.ai/docs/plugins/?utm_source=chatgpt.com))

### `tool.execute.before`

```text
- Block editing read-only roots
- Check permissions before editing external roots
- Require impact analysis before editing public contracts
- Block reading secret files
- Warn against directly modifying generated files
- Block destructive bash commands
```

### `tool.execute.after`

```text
- Record file access logs from read results
- Invalidate file hash after edit
- Store bash test results in validation log
- Detect contract file modification
```

### `file.edited`

```text
- Mark affected graph nodes stale
- Mark summaries stale
- Create pending impact queue
```

### `session.diff`

```text
- Generate root-level diff summary
- Summarize changes by service
- Generate input for PR review
```

### `session.compacted`

```text
- Preserve active roots
- Preserve current task
- Preserve touched files/contracts
- Preserve pending validations
- Preserve unresolved risks
```

### `tui.toast.show`

```text
- index stale notification
- contract review required notification
- read-only edit blocked notification
- validation pending notification
```

## 9.4 Agents

opencode supports agent-specific permissions and restricted agent patterns for planning/analysis. This project also separates responsibility and permissions by agent. ([opencode.ai](https://opencode.ai/docs/agents/?utm_source=chatgpt.com))

| Agent | Phase | Permissions | Role |
|---|---:|---|---|
| `workspace-architect` | MVP | read-only | Understand root structure, package, and service roles |
| `context-curator` | MVP | read-only | Generate task-specific context packs |
| `impact-analyst` | MVP | read-only | Analyze change impact |
| `test-router` | MVP | bash ask/limited | Generate affected test candidates |
| `service-boundary-analyst` | v0.2 | read-only | Analyze endpoint/topic/schema/service boundaries |
| `contract-reviewer` | v0.2 | read-only | Review breaking changes in API/schema/proto/GraphQL |
| `validation-runner` | v0.3 | bash limited | Run targeted validation and organize logs |
| `security-boundary-auditor` | v0.3 | read-only | Check secret/auth/PII/permission boundaries |
| `multi-repo-builder` | v0.4 | edit ask/allow | Modify multiple roots based on an approved plan |

---

# 10. Failure Taxonomy

NLAH explains that a failure taxonomy should be specified as a harness component. This project uses the following failure classification.

| Failure | Meaning | Recovery Strategy |
|---|---|---|
| `workspace_missing` | workspace.yaml missing | Run `/ctx:init` |
| `root_unreachable` | Root path inaccessible | Check path, remove root, or modify root |
| `permission_denied` | Root/file policy violation | Change access or provide patch suggestion only |
| `parse_failure` | Parser failure | Use text-only fallback and record diagnostic |
| `unresolved_reference` | Import/call linking failure | Keep unresolved node and mark low-confidence |
| `stale_index` | Index not updated after file change | Re-index affected root |
| `stale_summary` | Evidence hash changed | Regenerate summary |
| `impact_required` | Missing impact analysis before contract change | Require `ctx_impact` |
| `contract_drift` | Code/schema/generated client mismatch | Require contract review and regeneration |
| `validation_failed` | Targeted test failed | Generate failure evidence pack |
| `tool_error` | Sidecar/tool execution failed | Retry once and store diagnostic |
| `compaction_loss_risk` | Risk of losing long-session state | Inject compaction memory |
| `unsafe_cross_root_edit` | Improper edit to read-only or external root | Block or require explicit approval |

---

# 11. Phased Development Roadmap

## MVP / v0.1 — Multi-root Workspace + Minimal Evidence Graph

### Goal

Register directories outside the current opencode session as roots and provide root-alias-based search/read/context pack. The core of this phase is a `/ctx:add-dir` UX that is actually usable and a minimal Evidence Graph rather than summary-only memory.

### Included Features

```text
1. workspace manifest
2. /ctx:init
3. /ctx:add-dir
4. /ctx:list
5. /ctx:index
6. /ctx:search
7. /ctx:read
8. /ctx:pack
9. /ctx:doctor
10. minimal SQLite graph
11. root/file/package/symbol/import extraction
12. file-backed state
13. compaction memory hook
14. read-only root edit block
```

### MVP Parser Scope

```text
Languages:
- TypeScript
- JavaScript
- JSON
- YAML

Extractors:
- file scanner
- package.json parser
- pnpm-workspace.yaml parser
- tsconfig paths parser
- TypeScript import/export extractor
- TypeScript function/class/type/interface extractor
- test file heuristic extractor

Resolvers:
- package dependency resolver
- tsconfig path resolver
- local import resolver
```

### MVP Agents

```text
- workspace-architect
- context-curator
- impact-analyst
- test-router
```

### MVP Commands

```text
/ctx:init
/ctx:add-dir ../backend --name backend --rw
/ctx:add-dir ../shared --name shared --ro
/ctx:list
/ctx:index --all
/ctx:search OrderDto
/ctx:read shared:src/types/order.ts --lines 1-80
/ctx:pack "Add a billingAddress field to OrderDto"
```

### MVP Context Pack Example

```md
# Context Pack: Add billingAddress to OrderDto

## Active roots
- frontend: ../frontend, rw
- backend: ../backend, rw
- shared: ../shared, ro

## Evidence
- shared:src/types/order.ts defines OrderDto
- frontend:src/api/orders.ts imports OrderDto
- backend package depends on @acme/shared-types

## Relevant files
- shared:src/types/order.ts#L1-L40
- frontend:src/api/orders.ts#L1-L35

## Risks
- shared root is read-only
- DTO change may require backend/frontend updates
- OpenAPI not indexed yet in MVP

## Suggested next
- run /ctx:impact dto:shared:OrderDto
- promote shared root to rw only after approval
```

### MVP Acceptance Criteria

```text
1. Three roots (frontend/backend/shared) can be registered.
2. Files can be read using root alias path syntax.
3. TypeScript exported type/interface/function can be searched.
4. An import in root A resolves to a package in root B.
5. /ctx:pack generates an evidence-based context pack.
6. Edit/write attempts against read-only roots are blocked.
7. Active roots and current task are preserved before session compaction.
8. Files that fail indexing are recorded in diagnostics without breaking the entire index.
```

### Explicitly Excluded from MVP

```text
- REST endpoint matching
- OpenAPI full parsing
- gRPC/proto
- GraphQL
- Kafka/PubSub
- Redis/cache
- DB migration impact
- automatic multi-root edit workflow
- runtime telemetry ingestion
```

---

## v0.2 — REST/API Graph + Initial Contract Registry

### Goal

Extend the MVP multi-root graph around REST/API. Connect frontend client calls, backend route handlers, and OpenAPI operations/schemas, and compute the impact of DTO/API changes.

### Included Features

```text
1. Express route extractor
2. Initial NestJS route extractor
3. fetch/axios client-call extractor
4. OpenAPI YAML/JSON extractor
5. REST endpoint resolver
6. Promote DTO candidates
7. Initial Contract Boundary Registry
8. Formal implementation of /ctx:impact
9. /ctx:map --type contract
10. Initial /ctx:map --type service
11. Semantic Memory generation
12. stale summary management
13. contract-reviewer agent
14. service-boundary-analyst agent
```

### v0.2 Graph Expansion

```text
Additional nodes:
- REST_ENDPOINT
- ROUTE_HANDLER
- CLIENT_CALL
- OPENAPI_OPERATION
- OPENAPI_SCHEMA
- CONTRACT

Additional edges:
- HANDLES_ROUTE
- CALLS_ENDPOINT
- DOCUMENTED_BY
- USES_SCHEMA
- ALIGNED_WITH_SCHEMA
```

### v0.2 Contract Registry Example

```yaml
id: rest:backend:POST:/orders
kind: REST_ENDPOINT
owner_root: backend
visibility: public

provider:
  handler: backend:src/routes/orders.ts#L42-L78
  schema: backend:openapi.yaml#/paths/~1orders/post

consumers:
  - frontend:src/api/orders.ts#L18-L18

related_dtos:
  - dto:shared:OrderDto
  - schema:backend:CreateOrderRequest

change_policy:
  require_impact_analysis: true
  require_contract_review: true
  require_consumer_check: true
```

### v0.2 Semantic Memory Example

```md
# POST /orders

## Summary
POST /orders is the backend order creation endpoint used by the frontend checkout flow.

## Evidence
- backend:src/routes/orders.ts#L42-L78
- backend:openapi.yaml#/paths/~1orders/post
- frontend:src/api/orders.ts#L18

## Consumers
- frontend checkout API client

## Change policy
- Request body field addition requires OpenAPI schema update.
- Required field addition may be breaking.
- Generated client may need regeneration if present.
```

### v0.2 Acceptance Criteria

```text
1. frontend axios.post("/orders") is connected to backend POST /orders route.
2. backend route and OpenAPI operation are connected.
3. When OrderDto changes, frontend/backend/OpenAPI impact is displayed.
4. The impact gate works before editing public contract files.
5. Semantic Memory is generated with evidence hash.
6. When evidence changes, the summary is marked stale.
7. /ctx:impact outputs in Direct / Indirect / Contract / Tests / Unknowns format.
```

---

## v0.3 — Microservice Architecture Graph

### Goal

Move beyond REST-centered modeling and represent real microservice boundaries. Add gRPC, GraphQL, message topics, cache keys, DB migrations, Kubernetes/compose/Backstage metadata to the graph.

### Included Features

```text
1. proto parser
2. gRPC service/method/message extraction
3. GraphQL schema/query/resolver extraction
4. Kafka/PubSub/RabbitMQ topic extraction
5. Redis/cache key pattern extraction
6. Prisma schema parser
7. SQL migration parser
8. docker-compose service parser
9. Kubernetes/Helm/Kustomize metadata parser
10. Backstage catalog-info.yaml parser
11. service map builder
12. runtime topology import placeholder
13. validation-runner agent
14. security-boundary-auditor agent
```

### Additional v0.3 Commands

```text
/ctx:map --type service
/ctx:map --type runtime
/ctx:search-topic order.created
/ctx:search-schema OrderCreatedEvent
/ctx:flow frontend backend
/ctx:impact topic:order.created
/ctx:impact db:orders.billing_address
```

### v0.3 Service Map Example

```text
services:
  frontend
    calls:
      - backend: POST /orders

  backend
    provides:
      - POST /orders
    publishes:
      - order.created
    writes:
      - orders table
    writes_cache:
      - order:{orderId}

  worker
    consumes:
      - order.created
    reads:
      - orders table
    invalidates_cache:
      - order:{orderId}
```

### v0.3 Acceptance Criteria

```text
1. Extract service/method/message from proto files.
2. Connect gRPC client calls and provider implementation.
3. Connect GraphQL schema fields, resolvers, and frontend queries.
4. Display Kafka/PubSub topic producer-consumer relationships.
5. Display Redis cache key readers/writers/invalidators.
6. Convert DB migrations into table/column nodes.
7. Generate service candidates from docker-compose or k8s manifests.
8. /ctx:map --type service outputs provides/consumes/calls/writes by service.
9. Include related services and tests in impact analysis when DB/schema/topic/cache changes.
```

---

## v0.4 — Agent Workflow Automation

### Goal

Complete the plugin as an opencode-native agent harness rather than a simple context/search tool. Run the workflow plan → impact → approval → edit → validate → review.

### Included Features

```text
1. /ctx:change
2. /ctx:debug
3. /ctx:contract-change
4. /ctx:review
5. multi-repo-builder agent
6. full validation-runner
7. evidence-backed final report
8. verifier separation
9. limited introduction of self-evolution retry loop
10. limited introduction of dynamic orchestration
11. multi-root PR review
12. benchmark/evaluation harness
```

The NLAH paper's results show that modules such as file-backed state, evidence-backed answering, verifier separation, self-evolution, multi-candidate search, and dynamic orchestration can be explicitly ablated. However, it also reports that adding more structure does not always improve performance, and that verifier or multi-candidate search can diverge from the final evaluator. Therefore, v0.4 does not turn complex orchestration on excessively by default, and instead selects the minimal topology required by each workflow.

### Workflow A: Cross-repo Feature Change

Command:

```text
/ctx:change "Add billingAddress to checkout"
```

Flow:

```text
1. workspace-architect
   - Explore candidate relevant roots

2. context-curator
   - Generate context pack

3. impact-analyst
   - Analyze DTO/API/schema impact

4. contract-reviewer
   - Determine breaking/non-breaking

5. user approval
   - Approve modification scope

6. multi-repo-builder
   - Modify only approved roots

7. test-router
   - Select affected tests

8. validation-runner
   - Run targeted validation

9. final evidence report
   - Summarize changes, validation results, and remaining risks
```

### Workflow B: Symptom-based Debugging

Command:

```text
/ctx:debug "Payment succeeds, but order status remains pending"
```

Flow:

```text
1. Search relevant service candidates through Semantic Memory
2. Check service flow in Evidence Graph
3. Explore topic/event/cache/db edges
4. Connect recent diff and validation logs
5. Present candidate suspicious files/contracts/tests
6. Generate modification plan
7. After approval, perform targeted edit/validation
```

### Workflow C: API Contract Change

Command:

```text
/ctx:contract-change "Add billingAddress field to POST /orders"
```

Flow:

```text
1. Search OpenAPI operation
2. Search route handler
3. Search request validator
4. Search shared DTO
5. Search client SDK/generated artifacts
6. Search consumers
7. Determine breaking change
8. Generate edit order
9. After approval, modify and validate
```

### Workflow D: Multi-repo Review

Command:

```text
/ctx:review
```

Output:

```text
Changed roots:
- backend: 4 files
- frontend: 2 files
- shared: 1 file

Cross-root risks:
- shared OrderDto changed but admin consumer not updated
- OpenAPI schema changed but generated SDK unchanged
- backend tests ran, frontend tests not run

Recommended actions:
1. Regenerate SDK
2. Run frontend checkout tests
3. Document read-only admin impact
```

### v0.4 Acceptance Criteria

```text
1. /ctx:change generates context pack, impact report, and edit plan in sequence.
2. It does not modify public contracts or read-only roots before approval.
3. After multi-root edits, it generates a root-level diff summary.
4. It selects affected tests and stores execution results in the validation log.
5. /ctx:review detects cross-root drift.
6. The final report is generated in evidence-backed format.
7. On the benchmark task set, it improves time-to-first-correct-file, affected file recall, and contract drift detection compared to vanilla opencode.
```

---

# 12. Research Evaluation Plan

## 12.1 Baselines

```text
B0: vanilla opencode
B1: opencode + external_directory only
B2: opencode + simple tree-sitter MCP
B3: opencode + RepoMap-like summary only
B4: opencode-context-bridge full
```

## 12.2 Task Set

```text
1. Cross-repo type change
2. Frontend-backend API field addition
3. Shared library refactor
4. Microservice event consumer bug
5. OpenAPI breaking change detection
6. DB migration + ORM + handler update
7. Multi-root test selection
8. Read-only dependency impact reporting
9. Cache key shape change
10. gRPC proto field addition
```

## 12.3 Metrics

```text
Correctness:
- task success rate
- patch correctness
- contract drift detection
- breaking change detection

Context efficiency:
- tool calls
- token usage
- time to first correct file
- time to first correct contract

Graph quality:
- symbol extraction precision/recall
- endpoint provider recall
- endpoint consumer recall
- cross-root dependency recall
- affected file recall
- affected test recall

Safety:
- unsafe edit attempts blocked
- read-only root violation count
- impact gate bypass count
- stale summary usage count

Workflow:
- validation completion rate
- root-level diff coverage
- final evidence report completeness
```

## 12.4 Research Questions

```text
RQ1. Does the multi-root workspace registry reduce time to find relevant files compared to external_directory only?

RQ2. Does the Evidence Graph + Semantic Memory structure improve affected file recall compared to summary-only methods?

RQ3. Does the Contract Boundary Registry better detect drift and breaking changes in API/schema changes?

RQ4. Does hook-based safety gate reduce inconsistent states in multi-root edits?

RQ5. Do file-backed state and compaction memory improve task continuity in long sessions?

RQ6. Does the v0.4 agent workflow improve end-to-end change success rate compared to simple context retrieval?
```

---

# 13. Implementation Priorities

## 13.1 Implement Immediately

```text
1. workspace.yaml loader/writer
2. ctx_init
3. ctx_add_dir
4. ctx_list_roots
5. file scanner
6. SQLite schema
7. package.json extractor
8. TypeScript import/export/symbol extractor
9. ctx_search
10. ctx_read
11. ctx_pack MVP
12. read-only root policy
13. compaction state writer
```

## 13.2 Implement Next

```text
1. Express route extractor
2. axios/fetch client-call extractor
3. OpenAPI extractor
4. endpoint resolver
5. contract registry builder
6. semantic memory generator
7. ctx_impact
8. contract-reviewer agent
```

## 13.3 Implement Later

```text
1. gRPC/proto
2. GraphQL
3. Kafka/PubSub
4. Redis/cache
5. DB migration
6. k8s/Backstage
7. runtime telemetry import
8. automated multi-root edit workflow
```

---

# 14. Final Product Definition

**opencode-context-bridge** is defined in one sentence as follows.

> opencode-context-bridge is an opencode-native plugin harness that adds multiple repository, module, and service roots to an opencode session, manages them through a deterministic Evidence Graph and evidence-anchored Semantic Memory, and helps agents safely explore, modify, and validate cross-root software changes.

The final differentiators this project must provide are as follows.

```text
1. A multi-root workspace registry larger than a simple /add-dir UX
2. More practical opencode-native commands/tools/hooks/agents than a simple tree-sitter MCP
3. Safer Evidence Graph + Semantic Memory than summary-only memory
4. A Contract Boundary Registry better suited for microservices than a general code graph
5. An agent harness that includes not only exploration, but also impact, edit safety, validation, and review
6. Long-running task stability through file-backed state and compaction-stable memory
```

Development proceeds in the order **MVP/v0.1 → v0.2 → v0.3 → v0.4**. The first implementation goal is to “register the three roots frontend/backend/shared and put the related files and risks of a shared type change such as `OrderDto` into an evidence-based context pack.”
