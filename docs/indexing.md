# indexing.md

이 문서는 `opencode-context-bridge`의 Basic Indexer V0.2이 실제로 어떤 증거를 만들고, 어떤 파일을 디스크에 남기며, 도구가 그 증거를 어떻게 읽는지 정리한다.

진실의 출처는 `src/indexer/light-index.ts`, `src/indexer/index-runner.ts`, `src/indexer/scanner.ts`, `src/indexer/sqlite-store.ts`, `src/indexer/resolver.ts`, `src/tools/context-tools.ts`, `src/state/workspace-store.ts`, `src/types.ts`다. 검증 harness는 `tests/indexer-v0-1.smoke.test.ts`다.

---

## 1. 현재 단계 개요 (V0.2)

Basic Indexer V0.2은 SQLite를 기본 내부 저장소로 쓰는 경량 증거 인덱서다. 목적은 완전한 정적 분석이 아니라, 멀티 루트 작업 전에 모델이 확인할 수 있는 파일, 심볼, 패키지, 라우트 후보, 테스트 후보, 보수적 그래프 후보를 빠르게 모으는 것이다.

- 기본 저장소는 `.opencode/context-bridge/index.sqlite`다. `bun:sqlite`를 사용하며, 가능한 환경에서는 WAL과 busy timeout 진단을 기록한다.
- `index.jsonl`은 호환성과 디버깅을 위한 fallback이다. `readEntries()`, `searchIndex()`, SQLite가 없거나 읽을 수 없는 도구 경로가 계속 사용한다.
- 스캐너는 deterministic하다. 경로를 정렬하고, 파일 hash를 계산하며, `.opencode`, `node_modules`, `dist`, `.git`, `.venv`, `__pycache__` 같은 디렉터리를 건너뛴다.
- 추출기는 TS/JS, `package.json`, Python source와 Python metadata 일부를 다룬다. 결과는 nodes, edges, spans, unresolved, legacy entries로 나뉜다.
- resolver는 보수적이다. 패키지 의존성, 상대 import, 정확히 일치하는 HTTP endpoint 후보, 테스트 파일 링크만 연결한다. 애매하거나 빠진 근거는 unresolved record로 남긴다.
- 도구는 SQLite snapshot을 먼저 읽고, SQLite가 missing, corrupt, locked, schema mismatch 상태면 `index.jsonl` 또는 빈 degraded 응답으로 안전하게 내려간다.

이 단계의 핵심은 증거 기반 탐색이다. V0.2은 LLM semantic memory, embeddings, 완전한 call graph, 완전한 API contract registry를 제공하지 않는다.

---

## 2. `.opencode/context-bridge/` 디스크 레이아웃

기본 상태 디렉터리는 `options.stateDir`이며 기본값은 `.opencode/context-bridge`다.

```
.opencode/context-bridge/
├── workspace.json
├── index.sqlite
├── index.sqlite.lock
├── index.jsonl
├── task-history.jsonl
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
├── memory/
│   └── roots/
└── packs/
    └── <timestamp>-<slug>.json
```

### 2.1 `workspace.json`

`WorkspaceStore.init()`이 만들고 `ctx_add_dir`, stale marking, indexing 완료 시점에 갱신한다. 루트 alias, 절대 경로, 접근 모드, role, tags, `indexedAt`, `stale` 상태를 보관한다.

- `primary`는 현재 worktree 또는 directory에서 자동 생성된다.
- 같은 `absPath`나 alias는 중복 추가하지 않고 in-place로 갱신한다.
- 새 루트와 편집된 루트는 `stale: true`가 된다.
- `policies.secretGlobs`, `policies.contractGlobs`, `policies.enforceImpactBeforeContractEdit`는 safety hook이 읽는다.

### 2.2 `index.sqlite`

V0.2의 primary store다. 스키마는 `src/indexer/schema.ts`와 `sqlite-store.ts`가 관리한다. 주요 테이블은 다음과 같다.

- `roots`: 루트 alias, 경로, role, access, language/tag 요약.
- `files`: root별 파일, hash, size, language, generated 여부, mtime.
- `nodes`: 파일, 패키지, 심볼, HTTP route/client 후보, test 후보 같은 anchor.
- `edges`: extractor와 resolver가 만든 관계 후보. 예: `IMPORTS`, `DEPENDS_ON_PACKAGE`, `CALLS_ENDPOINT_CANDIDATE`, `TESTS`.
- `spans`: line span과 짧은 source text.
- `unresolved`: 해결하지 못했거나 애매한 import, endpoint, test source 등.
- `index_runs`: 실행 reason, roots, stats, diagnostics.
- `schema_meta`: SQLite schema version.

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

### 2.5 `queue/reindex.jsonl`, `memory/roots`, `packs/`

hooks는 편집된 파일과 루트를 stale로 표시하고 reindex 요청을 누적할 수 있다. `memory/roots`는 현재 durable semantic memory가 아니라 호환 상태 경로다. `ctx_refresh_memory`도 semantic memory를 만들지 않고 reindex와 pack refresh 상태를 반환한다.

`ctx_pack`은 `packs/<timestamp>-<slug>.json`에 task별 evidence pack을 저장한다.

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

1. `openSQLiteIndexStore(store.sqlitePath)`로 `index.sqlite`를 연다.
2. schema bootstrap과 diagnostics를 기록한다.
3. `index_runs`에 running record를 만든다.
4. root scan 결과를 `roots`, `files`, file node에 저장한다.
5. extractor facts를 `nodes`, `edges`, `spans`, `unresolved`에 저장한다.
6. resolver facts를 재계산한다.
7. `index_runs`를 completed 또는 failed로 마감한다.
8. `evidence/*.jsonl`, `diagnostics/indexer.jsonl`, `logs/index-runs.jsonl`을 쓴다.

SQLite 쓰기 중간에 실패하면 이후 SQLite write를 건너뛰고 degraded diagnostics를 남긴다. 이 경우에도 legacy JSONL과 안전한 도구 fallback은 유지된다.

### 3.5 Resolver

`resolver.ts`는 보수적으로만 edge를 만든다.

- 같은 루트의 상대 import가 정확히 한 파일로 해결되면 `IMPORTS`.
- package metadata dependency가 다른 root의 package name과 정확히 하나만 맞으면 `DEPENDS_ON_PACKAGE`.
- package import는 source root가 dependency를 선언한 경우에만 package 후보와 연결한다.
- HTTP client 후보와 route 후보가 method와 normalized path로 정확히 하나만 맞으면 `CALLS_ENDPOINT_CANDIDATE`.
- test 파일명과 source 파일명이 결정적으로 맞고 디렉터리 근접성이 맞으면 `TESTS`.

후보가 없거나 여러 개면 `resolver_*` reason의 unresolved record를 만든다. 이 unresolved 기록은 중요한 안전 장치다. 링크가 없다는 사실만으로 영향이 없다고 판단하면 안 된다.

### 3.6 Stale, queue, incremental behavior

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

- `ctx_search`: SQLite nodes에서 `IndexEntry` 모양을 만들고 검색한다. SQLite evidence가 없거나 비어 있으면 `searchIndex()` legacy JSONL 검색으로 fallback한다.
- `ctx_symbols`: SQLite symbol evidence 우선, 없으면 JSONL symbol entries.
- `ctx_neighbors`: SQLite graph edges와 legacy same-file, same-name, same-directory, ref-related heuristic을 함께 반환한다.
- `ctx_pack`: task 검색 결과, graph evidence, evidenceAnchors, unresolved, warnings, risks를 pack으로 저장한다.
- `ctx_impact`: direct evidence, graphDirectEvidence, crossRootEvidence, unknownEvidence, testCandidateEvidence를 반환한다.
- `ctx_test_plan`: indexed test/package entries와 package scripts로 명령 후보를 제안한다. 테스트를 실행하지 않는다.

SQLite가 missing, corrupt, locked, schema unsupported 상태면 `sqlite` report와 diagnostics가 응답에 포함되고, 가능한 경우 legacy JSONL fallback을 쓴다.

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

## 7. 한계와 비목표 (V0.1)

현재 구현된 한계는 다음과 같다.

- Resolver는 보수적이다. package import, relative import, endpoint, test link가 애매하면 edge를 만들지 않고 unresolved로 남긴다.
- OpenAPI, gRPC, GraphQL, Kafka, Redis, DB migration의 의미적 추출과 contract registry 승격은 범위 밖이다.
- DTO, Pydantic, OpenAPI schema, Prisma model 사이의 의미적 동치 추론은 제공하지 않는다.
- LSP 기반 reference, definition, call hierarchy 보강은 제공하지 않는다.
- tree-sitter, ts-morph, ast-grep 기반 정밀 AST pipeline은 제공하지 않는다. optional helper가 없어도 built-in scanner와 extractor로 계속 동작한다.
- `ctx_refresh_memory`는 compatibility/status shim이다. durable semantic memory, embeddings, graph memory를 만들지 않는다.
- `ctx_test_plan`은 테스트 명령 후보를 제안할 뿐 실행하지 않는다.

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
