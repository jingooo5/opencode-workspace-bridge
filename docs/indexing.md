# indexing.md

이 문서는 `opencode-context-bridge`의 Basic Indexer V0.2이 실제로 어떤 증거를 만들고, 어떤 파일을 디스크에 남기며, 도구가 그 증거를 어떻게 읽는지 정리한다.

진실의 출처는 `src/indexer/light-index.ts`, `src/indexer/index-runner.ts`, `src/indexer/scanner.ts`, `src/indexer/sqlite-store.ts`, `src/indexer/resolver.ts`, `src/indexer/contracts/{builder,promote-rules,yaml-emit}.ts`, `src/indexer/memory/{writer,summarizer-template,summarizer-iface}.ts`, `src/tools/context-tools.ts`, `src/tools/{ctx-summarize,ctx-pack-extension,ctx-impact-extension}.ts`, `src/state/{workspace-store,edit-state,contract-cache}.ts`, `src/hooks/{contract-gate,reindex,safety}.ts`, `src/types.ts`다. 검증 harness는 `tests/` 아래의 6개 파일이다.

---

## 1. 현재 단계 개요 (V0.2)

V0.2는 deterministic evidence graph + Contract Registry + Semantic Memory의 이중 구조를 완성한다. LogicLens 류의 LLM 의미 그래프 아이디어를 채택하되, hallucination 위험을 막기 위해 모든 의미 요약은 **deterministic evidence anchor**를 동반하도록 설계한다.

- 기본 저장소는 `.opencode/context-bridge/index.sqlite` (schema v2)다. `bun:sqlite`를 사용하며, WAL 모드와 busy timeout을 시도한다.
- `index.jsonl`은 호환성과 디버깅을 위한 fallback이다. `readEntries()`, `searchIndex()`, SQLite 부재 시 도구가 계속 사용한다.
- 스캐너는 deterministic하다. 경로를 정렬하고 파일 hash를 계산하며 `.opencode`, `node_modules`, `dist`, `.git`, `.venv`, `__pycache__` 같은 디렉터리를 건너뛴다.
- 추출기는 TS/JS, `package.json`, Python (source + metadata 일부)를 다룬다. 결과는 nodes, edges, spans, unresolved, legacy entries로 나뉜다.
- resolver는 보수적이다. 패키지 의존성, 상대 import, 정확히 일치하는 HTTP endpoint 후보, 테스트 파일 링크만 연결한다.
- **Contract Registry**가 resolver 직후 실행된다. `HTTP_ROUTE_CANDIDATE`, exposed `DTO_CANDIDATE`, exported `PACKAGE`, contract glob 매칭 파일을 `contracts` 테이블로 승격하고 `.opencode/context-bridge/contracts/generated/*.yaml`을 결정적으로 작성한다.
- **Semantic Memory**는 `ctx_summarize` 도구로 별도 호출된다. `summaries` 테이블의 `evidence_hash`로 stale 판정하고, 본문은 `SummarizerProvider` 인터페이스로 교체 가능 (V0.2 기본은 deterministic template, LLM 백엔드는 v0.3+).
- **Edit lifecycle**의 4개 state 파일이 hook이 작성한다: `state/touched_nodes.json`, `state/pending_validations.jsonl`, `state/stale_summaries.json`, `state/impact_ledger.jsonl`.
- **Contract gate hook** (`src/hooks/contract-gate.ts`)이 5단계 검사를 수행: root 식별 → 비밀/접근 모드 → contract boundary (registry + glob) → 최근 ctx_impact 분석 → allow/block.
- 도구는 항상 SQLite snapshot을 우선 읽고, SQLite가 missing/corrupt/locked/schema mismatch 상태면 JSONL 또는 빈 degraded 응답으로 내려간다.

V0.2는 OpenAPI/proto 구조 파싱, tsconfig path alias, pnpm-workspace 자동 root 등록, LLM 백엔드 요약기는 제공하지 않는다 (v0.3+).

---

## 2. `.opencode/context-bridge/` 디스크 레이아웃

기본 상태 디렉터리는 `options.stateDir`이며 기본값은 `.opencode/context-bridge`다.

```
.opencode/context-bridge/
├── workspace.json
├── index.sqlite                    # schema v2
├── index.sqlite.lock
├── index.jsonl                     # legacy fallback
├── task-history.jsonl
├── contracts/
│   └── generated/
│       └── contract_<kind>_<hash>.yaml
├── memory/
│   ├── contracts/
│   │   └── <slug>.md
│   ├── symbols/
│   │   └── <root>__<slug>.md
│   └── roots/
│       └── <root>.md
├── state/
│   ├── touched_nodes.json
│   ├── pending_validations.jsonl
│   ├── stale_summaries.json
│   └── impact_ledger.jsonl
├── evidence/
│   ├── nodes.jsonl
│   ├── edges.jsonl
│   └── spans.jsonl
├── diagnostics/
│   └── indexer.jsonl
├── logs/
│   └── index-runs.jsonl
├── queue/
│   └── reindex.jsonl
└── packs/
    ├── <timestamp>-<slug>.json
    └── <timestamp>-<slug>.md       # human-readable sibling
```

### 2.1 `workspace.json`

`WorkspaceStore.init()`이 만들고 `ctx_add_dir`, stale marking, indexing 완료 시점에 갱신한다. 루트 alias, 절대 경로, 접근 모드, role, tags, `indexedAt`, `stale` 상태를 보관한다.

- `primary`는 현재 worktree 또는 directory에서 자동 생성된다.
- 같은 `absPath`나 alias는 중복 추가하지 않고 in-place로 갱신한다.
- 새 루트와 편집된 루트는 `stale: true`가 된다.
- `policies.secretGlobs`, `policies.contractGlobs`, `policies.enforceImpactBeforeContractEdit`는 safety hook이 읽는다.

### 2.2 `index.sqlite`

V0.2의 primary store다 (schema v2). 스키마는 `src/indexer/schema.ts`와 `sqlite-store.ts`가 관리한다. 주요 테이블:

- `roots`: 루트 alias, 경로, role, access, language/tag 요약.
- `files`: root별 파일, hash, size, language, generated 여부, mtime.
- `nodes`: 파일, 패키지, 심볼, HTTP route/client 후보, test 후보 같은 anchor.
- `edges`: extractor와 resolver가 만든 관계 후보. 예: `IMPORTS`, `DEPENDS_ON_PACKAGE`, `CALLS_ENDPOINT_CANDIDATE`, `TESTS`.
- `spans`: line span과 짧은 source text.
- `unresolved`: 해결하지 못했거나 애매한 import, endpoint, test source 등.
- `summaries`: semantic memory 인덱스. 컬럼 = id, target_id, target_kind, summary_path, evidence_hash, status, generated_at, updated_at, **stale**, **evidence_refs_json**.
- `contracts`: 승격된 contract row. id, kind (`HTTP_ROUTE`/`DTO`/`PACKAGE`/`CONTRACT_FILE`), name, root_id, file_id, source_node_id, signature_hash, generated_yaml_path, confidence, attrs_json.
- `contract_consumers`: contract → consumer node 매핑.
- `contract_related_nodes`: contract → related node (DTO 등) 매핑.
- `index_runs`: 실행 reason, roots, stats, diagnostics.
- `schema_meta`: SQLite schema version (현재 2).

SQLite open 단계에서 busy timeout을 설정하고, 쓰기 모드에서는 WAL을 시도한다. 실패해도 치명적이지 않으며 diagnostics에 남긴다. 읽기 도구는 readonly snapshot을 열고, 실패하면 degraded path로 내려간다.

### 2.3 `index.jsonl`

`IndexEntry[]` legacy compatibility 파일이다.

```jsonl
{"root":"primary","ref":"primary:src/index.ts","path":"src/index.ts","kind":"file","name":"index.ts","updatedAt":"2026-05-02T03:11:00.000Z"}
{"root":"backend","ref":"backend:src/routes.ts","path":"src/routes.ts","kind":"route","name":"POST /orders","line":4,"text":"app.post(\"/orders\", handler)","updatedAt":"..."}
```

한 루트를 다시 인덱싱하면 그 루트의 legacy entries를 교체한다. 다른 루트의 entries는 보존된다. SQLite가 정상일 때도 이 파일은 `readEntries()`와 `searchIndex()` 호환 경로를 위해 유지된다.

### 2.4 JSONL debug artifacts

SQLite snapshot은 사람이 확인하기 쉬운 JSONL export로도 남는다.

- `evidence/nodes.jsonl`: SQLite `nodes` 요약.
- `evidence/edges.jsonl`: SQLite `edges` 요약.
- `evidence/spans.jsonl`: SQLite `spans` 요약.
- `diagnostics/indexer.jsonl`: scanner, extractor, storage diagnostics.
- `logs/index-runs.jsonl`: SQLite `index_runs` 요약.

이 파일들은 primary source가 아니라 debug export다. 도구는 가능한 경우 SQLite snapshot을 읽고, JSONL은 fallback 또는 사람이 직접 확인하는 용도로 쓴다.

### 2.5 `queue/`, `state/`, `memory/`, `contracts/`, `packs/`

- `queue/reindex.jsonl`: hooks가 편집 후 stale 처리한 파일을 누적. `ensureIndexReady`가 다음 호출 시 처리.
- `state/touched_nodes.json`: 세션 단위 수정된 ref + nodeIds 매핑. `tool.execute.after`가 atomic write.
- `state/pending_validations.jsonl`: contract 편집 후 필요한 validation 요청 + 만족 row.
- `state/stale_summaries.json`: SQLite `summaries.stale=1` 행의 미러. `markStaleAndQueuePath` 후 동기화.
- `state/impact_ledger.jsonl`: `ctx_impact` 실행 기록 (target, contractIds, requiredGates, evidenceCounts).
- `memory/contracts/*.md`: contract 단위 semantic memory. frontmatter = `evidence_hash, evidence_refs, generated_at, stale, target_id, target_kind`.
- `memory/symbols/*.md`: 심볼 단위. 같은 frontmatter 형식.
- `memory/roots/*.md`: 루트 단위.
- `contracts/generated/*.yaml`: contract registry artifact. 사람과 도구 모두 읽음. 인덱싱마다 결정적으로 다시 작성됨.
- `packs/*.json` + `packs/*.md`: `ctx_pack` 결과의 JSON과 Markdown sibling.

---

## 3. 인덱싱 파이프라인

공개 호환 surface는 `indexRoot`, `indexWorkspace`, `indexStaleRoots`, `ensureIndexReady`, `readEntries`, `searchIndex`다. 실제 SQLite 중심 실행은 `runIndex(store, target)`가 맡는다.

### 3.1 실행 대상

`runIndex`는 다음 target을 받는다.

- `workspace` 또는 `full`: 모든 루트.
- `root`: 특정 루트.
- `file-list`: 특정 파일 목록. 누락된 파일은 SQLite에서 prune한다.
- `reason`: reason과 선택 roots 기반 실행.

`ctx_index`는 root 인자가 있으면 그 루트만, 없으면 모든 루트를 인덱싱한다. `ctx_add_dir`는 `autoIndex`가 켜져 있으면 새 루트를 즉시 인덱싱한다.

### 3.2 파일 스캔

`scanRoot`는 정렬된 순서로 파일을 수집하고 hash를 계산한다.

- 기본 제외 디렉터리: `.git`, `.opencode`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `target`, `__pycache__`, `.venv`, `venv`.
- 기본 한도: 루트당 2,500 파일.
- 파일별 기록: root, rootId, fileId, absPath, relPath, sha256 hash, sizeBytes, language, isGenerated, indexedAt, mtimeMs.
- generated 후보: `generated/`, `.cache/`, lockfile, minified JS/CSS.
- file-list target은 루트 밖 경로를 버리고, 실제 scan 결과에 없는 파일은 stale target으로 prune한다.

### 3.3 추출기

`index-runner.ts`는 각 scanned file을 최대 500KB까지 읽고 NUL 바이트가 있으면 binary로 보고 건너뛴다.

현재 extractor 범위:

- TS/JS: export/function/class/interface/type/enum, import 후보, HTTP route/client 후보, test 후보, span, unresolved.
- Package metadata: `package.json` name, scripts, test scripts, dependencies.
- Python: Python source와 metadata 일부. Python도 nodes, spans, unresolved, legacy entries를 만든다.
- Contract 후보: `openapi`, `schema`, `.proto`, `migrations/`, `.graphql`, `.prisma` 같은 경계 파일은 파일과 경로 기반 증거로 남는다.

legacy `index.jsonl`에는 `file`, `package`, `symbol`, `route`, `contract`, `test` kind가 유지된다. SQLite에는 더 자세한 node kind와 attrs가 저장된다.

### 3.4 SQLite 저장과 debug export

인덱싱 실행은 다음 순서로 진행된다.

1. `openSQLiteIndexStore(store.sqlitePath)`로 `index.sqlite`를 연다 (schema v2 bootstrap, idempotent).
2. `index_runs`에 running record를 만든다.
3. root scan 결과를 `roots`, `files`, file node에 저장한다.
4. extractor facts를 `nodes`, `edges`, `spans`, `unresolved`에 저장한다.
5. resolver facts를 재계산한다.
6. **Contract Registry 빌드**: `nodes`/`edges` 스냅샷에서 contract 후보를 승격한 뒤 `contracts`, `contract_consumers`, `contract_related_nodes` 행을 upsert하고 stale row를 prune한다. 동시에 `contracts/generated/*.yaml`을 결정적으로 다시 작성한다.
7. `index_runs`를 completed 또는 failed로 마감한다.
8. `evidence/*.jsonl`, `diagnostics/indexer.jsonl`, `logs/index-runs.jsonl`을 쓴다.

SQLite 쓰기 중 어느 단계든 실패하면 이후 SQLite write를 건너뛰고 degraded diagnostics를 남긴다. 이 경우에도 legacy JSONL과 안전한 도구 fallback은 유지된다.

### 3.5 Contract 승격 규칙 (`src/indexer/contracts/promote-rules.ts`)

- `HTTP_ROUTE_CANDIDATE` → 항상 `HTTP_ROUTE` contract.
- `DTO_CANDIDATE` → exported (또는 같은 file에 HTTP_ROUTE_CANDIDATE 있음)이면 `DTO` contract, 아니면 `contract_related_nodes`에 `internal_dto`로만 기록.
- `PACKAGE` 노드 중 `main`/`exports`/`bin`을 가진 것 → `PACKAGE` contract.
- contract glob 매칭 파일 (openapi.yaml, *.proto, schema.graphql, schema.prisma, migrations/) → 파싱 없이 `CONTRACT_FILE` contract. `signature_hash = file.hash`.
- 그래프의 `_CANDIDATE` kind와 confidence는 보존된다. 정식 명칭은 contract 레이어에서만 사용.

### 3.6 Semantic Memory (`src/indexer/memory/writer.ts`)

- `ctx_summarize` 도구가 `MemoryWriter.write()`를 호출. 인덱싱 critical path에는 들어가지 않음 (`autoSummarize` 옵션은 향후 추가).
- `evidence_hash = sha256({ targetId, sortedRefs, sourceFileHashes })`. 동일 hash + `stale=0`이면 rewrite skip.
- frontmatter는 알파벳 정렬 (`evidence_hash`, `evidence_refs`, `generated_at`, `stale`, `target_id`, `target_kind`).
- `SummarizerProvider` 인터페이스는 LLM 백엔드 교체점. V0.2 기본은 `TemplateSummarizer` (graph evidence를 마크다운으로 결정적 변환).

### 3.7 Resolver

`resolver.ts`는 보수적으로만 edge를 만든다.

- 같은 루트의 상대 import가 정확히 한 파일로 해결되면 `IMPORTS`.
- package metadata dependency가 다른 root의 package name과 정확히 하나만 맞으면 `DEPENDS_ON_PACKAGE`.
- package import는 source root가 dependency를 선언한 경우에만 package 후보와 연결한다.
- HTTP client 후보와 route 후보가 method와 normalized path로 정확히 하나만 맞으면 `CALLS_ENDPOINT_CANDIDATE`.
- test 파일명과 source 파일명이 결정적으로 맞고 디렉터리 근접성이 맞으면 `TESTS`.

후보가 없거나 여러 개면 `resolver_*` reason의 unresolved record를 만든다. 이 unresolved 기록은 중요한 안전 장치다. 링크가 없다는 사실만으로 영향이 없다고 판단하면 안 된다.

### 3.8 Stale, queue, incremental behavior

V0.1은 hash 기반 파일 기록과 stale pruning을 갖고 있지만, 완전한 background incremental worker는 아니다.

- `file.edited` event와 편집 도구 성공 후 hook은 해당 루트 또는 파일을 stale로 표시한다.
- `queue/reindex.jsonl`은 reindex 요청 기록에 쓰인다.
- `ensureIndexReady`는 `autoIndex`가 켜져 있고 `index.jsonl`이 없거나 stale, 미인덱스 루트가 있으면 해당 루트를 다시 인덱싱한다.
- `file-list` target은 존재하지 않는 파일을 SQLite에서 prune한다.
- `indexRoot`는 legacy JSONL에서 해당 루트 entries를 교체한다.

따라서 V0.1은 변경 감지와 stale 보강을 제공하지만, daemon식 실시간 incremental indexing이나 semantic memory refresh는 제공하지 않는다.

---

## 4. 검색과 도구 증거 모델

도구 레이어는 SQLite snapshot을 우선한다.

- `ctx_search`: SQLite nodes에서 `IndexEntry`를 합성해 검색. 비어 있으면 legacy JSONL fallback.
- `ctx_symbols`: SQLite symbol evidence 우선, 없으면 JSONL symbol entries.
- `ctx_neighbors`: SQLite graph edges + legacy same-file/same-name/same-directory/ref-related heuristic 동시 반환.
- `ctx_pack`: 기존 evidence/graph 필드에 더해 **`contracts`, `memory`, `editFocus`, `suggestedEditOrder`** 를 추가. `packs/<ts>-<slug>.json`과 `packs/<ts>-<slug>.md` 두 파일을 작성한다.
- `ctx_impact`: 기존 graph evidence + **`contractIds`, `requiredGates`, `pendingGates`** 추가. 실행 시 `state/impact_ledger.jsonl`에 entry를 append한다.
- `ctx_summarize`: `memory/{contracts,symbols,roots}/*.md`를 생성/갱신. evidence_hash가 안 바뀌었으면 skip.
- `ctx_test_plan`: indexed test/package entries와 package scripts로 명령 후보 제안.
- `ctx_status`: manifest, legacy index, SQLite snapshot, **contracts byKind, memory total/stale**, recent ledger를 한 번에 반환.

SQLite가 missing/corrupt/locked/schema unsupported 상태면 `sqlite` report와 diagnostics가 응답에 포함되고, 가능한 경우 legacy JSONL fallback을 사용한다.

### 4.1 Contract Gate (`src/hooks/contract-gate.ts`)

`tool.execute.before`는 다음 단계를 거친다:
1. `findRootByPath` — 루트 밖이면 통과.
2. secret glob — read/edit 모두 즉시 차단.
3. read-only root — edit이면 즉시 차단.
4. **contract boundary**: `ContractCache`가 SQLite contract row + glob 양쪽으로 검사 (in-memory 캐시, `index.sqlite` mtime 변경 시 lazy reload).
5. **recent impact analysis**: `state/impact_ledger.jsonl` 600초 윈도우 + 같은 sessionID + contractId 매칭. enforce 모드에서 미충족이면 차단, 그 외엔 `contract.edit.warning` ledger.

`tool.execute.after`는 stale 처리 + reindex 큐 + `state/touched_nodes.json` upsert + contract 편집 시 `state/pending_validations.jsonl`에 row를 append하고, contract 캐시를 무효화한다.

---

## 5. Shell 환경 노출

`hooks/shell-env.ts`는 다음 환경변수를 주입한다.

- `CTX_BRIDGE_STATE_DIR`: `.opencode/context-bridge/` 절대 경로.
- `CTX_BRIDGE_MANIFEST`: `workspace.json` 절대 경로.
- `CTX_BRIDGE_INDEX`: legacy `index.jsonl` 절대 경로.

SQLite primary store는 `WorkspaceStore.sqlitePath`로 관리되며 기본 파일명은 `index.sqlite`다.

---

## 6. Degraded behavior

V0.1은 인덱스 문제 때문에 OpenCode 세션 전체가 깨지지 않도록 설계되어 있다.

- SQLite open, migration, transaction, snapshot read, close 실패는 diagnostics로 기록된다.
- SQLite lock이 있으면 `sqlite.index_in_progress` 진단을 붙이고 마지막 readable snapshot 또는 fallback 응답을 쓴다.
- SQLite가 없으면 `sqlite.missing`과 함께 JSONL fallback을 사용한다.
- JSONL도 없으면 빈 evidence와 unknowns를 반환한다.
- extractor diagnostics는 `diagnostics/indexer.jsonl`과 `index_runs` stats에 남는다.

도구 응답의 graph edge는 증거 후보이지 완전한 proof가 아니다. low evidence나 unresolved가 있으면 `ctx_read`, `ctx_search`, targeted validation으로 확인해야 한다.

---

## 7. 한계와 비목표 (V0.2)

다음 항목은 v0.3+로 미뤘다:

- OpenAPI/proto/GraphQL의 **구조 파싱**: V0.2는 contract glob 일치 파일을 `CONTRACT_FILE`로 등록하지만 path/schema 추출은 하지 않는다.
- tsconfig path alias, pnpm-workspace 자동 root 등록.
- LLM 백엔드 요약기. `SummarizerProvider` 인터페이스는 정의되어 있으며 v0.3+에서 default를 교체할 수 있다.
- DTO/OpenAPI schema/Pydantic 사이의 의미적 동치 추론.
- LSP 기반 reference/definition/call hierarchy.
- tree-sitter, ts-morph, ast-grep 기반 정밀 AST pipeline.
- `ctx_test_plan` 자동 실행.
- 점진적 (daemon) incremental indexing.

V0.2 보장:
- 모든 의미 요약 (`memory/**`)은 deterministic evidence anchor (`evidence_refs`)를 가진다.
- `evidence_hash`로 stale 판정한다. 파일 hash가 바뀌면 hash가 바뀌고 다음 ctx_summarize에서 자동 재생성된다.
- Contract registry는 인덱싱마다 결정적으로 재계산된다 (sha256 signature, 정렬된 키).
- SQLite 부재/오염 상태에서도 도구는 degraded 응답으로 안전하게 내려간다.

---

## 8. 디버깅과 검증

상태 확인 예시:

```bash
ls .opencode/context-bridge
sqlite3 .opencode/context-bridge/index.sqlite '.tables'
sqlite3 .opencode/context-bridge/index.sqlite 'select count(*) from nodes;'
wc -l .opencode/context-bridge/index.jsonl
jq -c 'select(.kind == "route")' .opencode/context-bridge/evidence/nodes.jsonl
tail -n 50 .opencode/context-bridge/diagnostics/indexer.jsonl
tail -n 50 .opencode/context-bridge/logs/index-runs.jsonl
```

도구 기반 확인:

- `ctx_list_roots`: 루트와 stale 상태.
- `ctx_status`: manifest, legacy index, SQLite snapshot, 최근 ledger.
- `ctx_index`: 특정 루트 또는 전체 루트 인덱싱.
- `ctx_search`: evidence 검색.
- `ctx_symbols`, `ctx_neighbors`: 심볼과 주변 graph 후보 확인.

구현 smoke harness와 빌드 확인 명령:

```bash
bun test tests/indexer-v0-1.smoke.test.ts
bun run test
bun run typecheck
bun run build
```

`package.json`의 `test` script는 `bun test tests/indexer-v0-1.smoke.test.ts`로 매핑된다.
