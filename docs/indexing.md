# indexing.md

이 문서는 `opencode-context-bridge`가 사용하는 인덱싱과 컨텍스트 관리 메커니즘을 정리한다. 현재 코드베이스(V0.1)가 무엇을 하는지, 어떤 파일을 디스크에 만드는지, 그리고 향후 어떤 단계로 확장될 것인지 분리해서 기술한다.

진실의 출처는 `src/indexer/light-index.ts`(인덱서), `src/state/workspace-store.ts`(매니페스트/ledger 저장), `src/state/session-state.ts`(인메모리 세션 상태), `src/types.ts`(스키마)이다.

---

## 1. 현재 단계 개요 (V0.1)

V0.1 인덱서는 외부 의존성 없이 동작하는 라이트 구현이다. 다음 원칙을 따른다.

- **외부 라이브러리 없음**: tree-sitter, ts-morph, ast-grep, ripgrep, LSP, SQLite를 사용하지 않는다. 표준 라이브러리(`node:fs/promises`)와 정규식만 사용한다.
- **Deterministic하지만 휴리스틱**: 라인 단위 정규식으로 심볼/라우트/계약/테스트 후보를 추출한다. 정확한 AST/타입 정보가 필요한 케이스는 의도적으로 V0.2 이후로 미뤘다.
- **JSONL 인덱스**: 단일 파일 `index.jsonl`에 모든 엔트리를 저장한다. 한 루트를 다시 인덱싱하면 그 루트 소속 엔트리가 전부 새 엔트리로 대체된다(부분 incremental은 V0.2 이후).
- **풀 텍스트 + 부분 일치 검색**: `searchIndex`는 `name`/`path`/`text`에 lowercase 부분 일치를 한다. 점수는 정확 일치(10) > 이름 부분 일치(6) > 경로 부분 일치(4) > 그 외(1) 순으로 단순.

이 단계의 목표는 단일하다. **사용자가 외부 디렉터리를 멀티 루트로 부착하고, 그 위에서 검색/읽기/팩 생성/영향 추정을 동작 가능한 형태로 제공한다.** 정밀한 cross-language reference resolution은 명시적으로 다음 단계의 책임이다.

---

## 2. `.opencode/context-bridge/` 디스크 레이아웃

플러그인이 만드는 모든 상태 파일은 `options.stateDir`(기본 `.opencode/context-bridge`) 아래에 모인다. 현재 구현이 실제로 만드는 파일/디렉터리는 다음과 같다.

```
.opencode/context-bridge/
├── workspace.json                # WorkspaceManifest. 항상 존재.
├── index.jsonl                   # IndexEntry[]의 라인 단위 직렬화. 인덱싱 후 생성.
├── task-history.jsonl            # 운영 ledger. 모든 주요 액션이 한 줄씩 추가.
└── packs/
    └── <timestamp>-<slug>.json   # ctx_pack이 생성한 컨텍스트 팩.
```

이외에 `memory/`, `contracts/`, `evidence/`, `sessions/`, `logs/`, `diagnostics/`, `queue/`, `snapshots/` 같은 하위 디렉터리는 V0.1에서 만들지 않는다. 향후 단계에서 도입 예정인 디렉터리들은 본 문서의 로드맵 절을 참고한다.

### 2.1 `workspace.json` (WorkspaceManifest)

`WorkspaceStore.init()`이 처음 만들고, 이후 `addRoot`/`markIndexed`/`markStaleByAbsPath`가 갱신한다. 스키마는 `types.ts`의 `WorkspaceManifestSchema`이다.

```json
{
  "version": 1,
  "primary": {
    "name": "primary",
    "path": ".",
    "absPath": "/repo/app",
    "access": "rw",
    "role": "primary",
    "tags": ["primary"]
  },
  "roots": [
    {
      "name": "primary",
      "path": ".",
      "absPath": "/repo/app",
      "access": "rw",
      "role": "primary",
      "tags": ["primary"],
      "indexedAt": "2026-05-02T03:11:00.000Z",
      "stale": false
    },
    {
      "name": "backend",
      "path": "../backend",
      "absPath": "/repo/backend",
      "access": "ro",
      "role": "service",
      "tags": ["python", "fastapi"],
      "stale": true
    }
  ],
  "policies": {
    "secretGlobs": [".env", ".env.*", "**/secrets/**", "**/*.pem", "**/*.key"],
    "contractGlobs": [
      "**/openapi*.yaml",
      "**/openapi*.yml",
      "**/openapi*.json",
      "**/*.proto",
      "**/schema.graphql",
      "**/*.graphql",
      "**/schema.prisma",
      "**/migrations/**"
    ],
    "enforceImpactBeforeContractEdit": false
  }
}
```

매니페스트 사용 규칙:

- `primary`는 항상 worktree 또는 directory에서 자동 생성. 별도로 추가하지 않는다.
- 모든 루트는 `absPath`로 비교한다. 같은 `absPath`가 다른 별칭으로 들어오면 in-place 갱신.
- `stale: true`인 루트는 다음 인덱싱 사이클에서 다시 인덱싱된다. `stale`은 새 루트 추가 시점, 그리고 `markStaleByAbsPath`가 호출될 때 켜진다.
- `policies`는 안전 훅이 직접 읽는다. 매니페스트를 수동으로 편집해 정책을 조정할 수 있다.

### 2.2 `index.jsonl` (IndexEntry[])

스키마는 `IndexEntrySchema`이다.

```jsonl
{"root":"primary","ref":"primary:src/index.ts","path":"src/index.ts","kind":"file","name":"index.ts","updatedAt":"2026-05-02T03:11:00.000Z"}
{"root":"primary","ref":"primary:package.json","path":"package.json","kind":"package","name":"@acme/app","updatedAt":"2026-05-02T03:11:00.000Z"}
{"root":"backend","ref":"backend:src/routes/orders.ts","path":"src/routes/orders.ts","kind":"symbol","name":"createOrder","line":42,"text":"export async function createOrder(req, res) { ... }","updatedAt":"..."}
{"root":"backend","ref":"backend:src/routes/orders.ts","path":"src/routes/orders.ts","kind":"route","name":"POST /orders","line":67,"text":"router.post(\"/orders\", createOrder)","updatedAt":"..."}
{"root":"backend","ref":"backend:openapi.yaml","path":"openapi.yaml","kind":"contract","name":"openapi.yaml","updatedAt":"..."}
{"root":"backend","ref":"backend:tests/orders.test.ts","path":"tests/orders.test.ts","kind":"test","name":"orders.test.ts","updatedAt":"..."}
```

`kind`는 `"file" | "package" | "symbol" | "route" | "contract" | "test"` 중 하나이다. 같은 파일에 대해 여러 kind 엔트리가 동시에 존재할 수 있다(예: 파일 그 자체 + 그 파일의 심볼들 + 라우트 후보).

### 2.3 `task-history.jsonl` (운영 ledger)

`WorkspaceStore.appendLedger`가 한 줄씩 append한다. 현재 코드에서 기록되는 이벤트:

- `root.added`: `addRoot` 호출 시.
- `root.indexed`: `indexRoot` 완료 시(엔트리 수 포함).
- `route.hint`: `chat.message` 훅이 분류한 라우팅 힌트.
- `session.created`, `session.diff`, `session.idle`: OpenCode `event` 훅이 받은 이벤트.
- `file.edited.event`: `event` 훅이 `file.edited` 이벤트를 받았을 때.
- `file.touched`: `tool.execute.after` 훅이 편집 도구 성공을 감지했을 때.
- `contract.edit.warning`: 안전 훅이 계약 파일 편집을 통과시켰지만 경고가 필요한 경우.
- `context.pack`: `ctx_pack` 호출 시.
- `impact.analysis`: `ctx_impact` 호출 시.

각 엔트리는 `{ at: <ISO timestamp>, type: <name>, ... }` 형태이다. `recentLedger(limit)`가 마지막 N줄을 읽어 컴팩션 훅이 컨티뉴에이션 컨텍스트에 주입한다.

### 2.4 `packs/<timestamp>-<slug>.json`

`ctx_pack` 도구가 호출될 때마다 생성된다. 슬러그는 task의 lowercase ASCII 60자 슬러그이고, 파일명은 `${Date.now()}-${slug}.json`. 내용은 도구 반환값과 동일한 JSON 객체(task, workspace, evidence, risks, suggestedNext, generatedAt).

이 파일들은 자동 정리되지 않는다. 필요하면 사용자가 수동으로 삭제하거나, 향후 단계에서 보존 정책을 추가한다.

---

## 3. 인덱싱 파이프라인

`indexer/light-index.ts`의 `indexRoot(store, root, maxFiles=2500)`이 한 루트의 인덱싱 사이클이다.

### 3.1 파일 스캔

`listFiles(rootAbs, maxFiles)`가 BFS로 디렉터리를 순회한다.

- 제외 디렉터리: `.git`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `target`, `vendor`.
- 점으로 시작하는 항목은 기본적으로 무시. 예외는 `.opencode`, `.env`, `.env.example`. 그러나 `.env`/`.env.example`은 예외로 통과시켜 인덱싱 후보가 된다(시크릿 패턴은 안전 훅에서 별도 차단된다).
- 한 루트당 최대 2,500 파일까지만 스캔. 한도 도달 시 중단.

### 3.2 텍스트 분류와 읽기

`TEXT_EXTENSIONS`에 포함된 확장자만 내용 추출 대상이 된다.
`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.json`, `.yaml`, `.yml`, `.md`, `.py`, `.go`, `.rs`, `.java`, `.kt`, `.proto`, `.graphql`, `.sql`, `.prisma`.

`safeRead(file)`이 다음을 보장한다.

- 파일 읽기 실패는 `undefined` 반환(throw 없음).
- 내용에 NUL 바이트(`\u0000`)가 있으면 바이너리로 간주해 무시.
- 500,000 바이트로 슬라이싱.

`readJson(file)`은 `package.json` 파싱에만 쓰인다. 객체가 아니면 `undefined`.

### 3.3 엔트리 생성

각 파일에 대해 다음 엔트리가 생성된다.

1. **file 엔트리** (모든 스캔된 파일에 대해 1개).
2. **package 엔트리**: 파일명이 `package.json`이고 `name` 필드가 문자열인 경우.
3. **symbol 엔트리**: TEXT 확장자 파일에서 라인별로 다음 패턴 중 하나가 매치되면 1개. 한 라인은 첫 매치만 사용한다.
   - `\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)`
   - `\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)`
   - `\bclass\s+([A-Za-z_$][\w$]*)`
   - `\binterface\s+([A-Za-z_$][\w$]*)`
   - `\btype\s+([A-Za-z_$][\w$]*)\s*=`
4. **route 엔트리**: 다음 정규식 중 하나가 매치되는 라인.
   - `\b(?:router|app)\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]`
   - `@(Get|Post|Put|Patch|Delete)\s*\(\s*["'`]?([^"'`)]_)["'`]?\s_\)` (NestJS 데코레이터)
   - `\b(fetch)\s*\(\s*["'`]([^"'`]+)["'`]`
   - `\baxios\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]`
`name`은 `"<METHOD> <PATH>"` 형태로 정규화된다.
5. **contract 엔트리**: `isContractFile(relPath)`이 true이면. 매칭 규칙: `(^|/)(openapi|schema)\.(ya?ml|json|graphql|prisma)$` 또는 `\.proto$` 또는 `migrations/`.
6. **test 엔트리**: 경로에 `\b(test|spec)\b`가 매치되는 모든 파일.

추출된 텍스트는 240자로 잘려 `text` 필드에 저장된다.

### 3.4 인덱스 갱신

`appendEntries(indexPath, entries)`가 다음을 수행한다.

- 기존 엔트리를 모두 읽는다(`readEntries`).
- 이번 인덱싱이 다룬 루트 집합을 만든다.
- 그 루트들에 속한 기존 엔트리를 모두 제거하고, 새 엔트리를 뒤에 붙인 뒤, 전체를 다시 쓴다.

따라서 한 루트의 인덱싱은 그 루트의 이전 엔트리와 항상 동기화된다. 다른 루트의 엔트리는 영향을 받지 않는다.

마지막으로 `WorkspaceStore.markIndexed(rootName)`이 매니페스트의 `indexedAt`을 갱신하고 `stale: false`로 만든다. ledger에는 `{ type: "root.indexed", root, entries }`가 기록된다.

### 3.5 stale 보강

`ensureIndexReady(store, options)`(`tools/context-tools.ts`)가 다음 도구의 시작 부분에서 호출된다: `ctx_search`, `ctx_pack`, `ctx_impact`.

- `options.autoIndex`가 false이면 아무것도 하지 않는다.
- `index.jsonl` 파일이 존재하지 않거나 어떤 루트라도 stale이거나 미인덱싱이면, 그 루트에 대해 `indexRoot`를 호출한다.

`create-managers.ts`의 startup 경로에서도 동일한 로직이 동작한다(stale 또는 미인덱싱 루트를 startup 시점에 보강). 인덱싱 실패는 `log()`로 경고를 남기고 startup을 계속한다.

`event` 훅의 `file.edited` 처리는 해당 파일이 속한 루트를 `markStaleByAbsPath`로 stale로 마크한다. `tool.execute.after`도 편집 도구가 성공한 path를 같은 방식으로 처리한다.

---

## 4. 검색 모델

`searchIndex(store, query, roots?, limit=30)`이 인덱스를 메모리에 로드한 뒤 다음 점수로 정렬한다.

- 모든 비교는 lowercase.
- `entry.name`이 query와 정확히 같으면 10점.
- `entry.name`이 query를 포함하면 6점.
- `entry.path`가 query를 포함하면 4점.
- 그 외(`entry.text` 매칭 등)는 1점.
- 정렬 후 상위 `limit`개만 반환.

반환 타입은 `SearchHit`이다. 도구 레이어에서 사람이 읽을 수 있는 텍스트로 직렬화될 때는 `[<kind>] <ref>#L<line>\n<text>` 형식이다.

---

## 5. 세션 상태

`state/session-state.ts`의 `SessionState`는 인메모리 상태이다(디스크에 저장되지 않음).

- `setHint(sessionID, hint)` / `getHint(sessionID)`: 자동 라우터가 만든 `RouteHint`를 세션 단위로 보관한다.
- `touch(sessionID, ref)` / `touched(sessionID)`: `tool.execute.after`가 편집 성공한 ref를 누적해 컴팩션 훅에 제공한다.

세션 상태는 플러그인 인스턴스 수명 동안만 유효하다. 영속이 필요한 정보는 매니페스트나 ledger에 별도로 기록된다.

---

## 6. 컴팩션과 컨티뉴에이션

`hooks/compaction.ts`의 `experimental.session.compacting` 훅이 컨티뉴에이션 컨텍스트에 다음을 마크다운으로 추가한다.

- `WorkspaceStore.workspaceSummary()`의 출력(매니페스트 경로 + 루트 목록).
- 이번 세션의 touched ref 목록(없으면 `- none recorded`).
- 최근 12개 ledger 엔트리 raw line.
- 재개 규칙 안내(매니페스트를 path로 다시 열고, `ctx_list_roots`로 점검, 편집 전에 `ctx_pack`을 다시 만들 것).

이 메커니즘 덕분에 컴팩션 후에도 활성 루트와 진행 중 작업의 흔적이 컨티뉴에이션에 살아남는다. 시맨틱 메모리 같은 더 풍부한 보존은 V0.2 이후의 영역이다.

---

## 7. Shell 환경 노출

`hooks/shell-env.ts`가 `shell.env` 훅에서 다음 환경변수를 주입한다.

- `CTX_BRIDGE_STATE_DIR` — `.opencode/context-bridge/`의 절대 경로.
- `CTX_BRIDGE_MANIFEST` — `workspace.json`의 절대 경로.
- `CTX_BRIDGE_INDEX` — `index.jsonl`의 절대 경로.

이는 OpenCode가 실행하는 셸 명령(예: 사용자 정의 스크립트, 테스트 러너)에서 매니페스트와 인덱스를 path-addressable하게 참조할 수 있게 한다.

---

## 8. 한계와 비목표 (V0.1)

이 단계에서 의도적으로 다루지 않는 것:

- **크로스-루트 reference resolution**. `frontend`의 `import { OrderDto } from "@acme/shared"`가 어떤 `shared` 루트의 어떤 파일을 가리키는지 정밀하게 풀지 않는다. 매칭은 단순 텍스트 검색에 의존한다.
- **REST/OpenAPI/proto 구조적 매칭**. `axios.post("/orders")` 호출과 `router.post("/orders", ...)` 또는 OpenAPI `POST /orders` 정의를 그래프 엣지로 잇는 단계는 V0.2 이상.
- **DTO/스키마 상호참조**. Pydantic `BaseModel`, TS `interface`, OpenAPI `components.schemas`, Prisma 모델 사이의 동치 관계 추론은 V0.2 이상.
- **gRPC, GraphQL, Kafka topic, cache key, DB migration의 의미적 추출**. V0.4 영역.
- **LSP 보강**. OpenCode의 실험 LSP 도구를 사용하는 reference/definition 보강은 V0.5 영역.
- **시맨틱 마크다운 메모리**. evidence anchor가 붙은 LLM 요약을 `memory/`에 자동 생성하는 단계는 V0.2 이후.
- **Incremental indexing**. 현재는 한 루트 단위로 전체 교체. 파일 단위 hash 비교로 교체하는 incremental은 V0.2.
- **SQLite로의 마이그레이션**. JSONL은 단순하고 디버그가 쉽지만, 수만 노드 규모에서는 SQLite가 필요하다. V0.2 영역.

이 한계들은 도구 응답에도 명시적으로 노출된다. 예를 들어 `ctx_impact`의 응답에는 다음 문구가 포함된다.

> "V0.1 uses lightweight text/symbol evidence; REST/OpenAPI/proto structural matching arrives in v0.2+."

---

## 9. 향후 로드맵

다음 단계는 코드 변경 단위로 다음 순서를 따른다.

### Phase 1 (현재) — 라이트 인덱서

코드베이스에 이미 구현된 단계. 본 문서의 1–7 절에 기술됨.

### Phase 2 — 정확한 파서와 incremental indexing

도입 예정 영역:

- TypeScript: `ts-morph` 또는 TypeScript compiler API 기반 extractor. import/export, interface/type/class/function, JSDoc 일부, axios/fetch 후보 호출 정확 추출.
- Python: stdlib `ast`를 사용하는 helper 스크립트. `pyproject.toml`/`requirements.txt`/`setup.py` 파서. Pydantic `BaseModel`, `@dataclass`, `TypedDict` 분류. FastAPI/Flask 라우트 데코레이터 정확 추출. requests/httpx call 추출. pytest 후보 추출.
- Package metadata: TS의 `pnpm-workspace.yaml`, `tsconfig paths`, Python의 `pyproject.toml` 워크스페이스 의존성 분석.
- Incremental: 파일 hash 캐시 후 변경 파일만 재추출. 인덱스 저장 포맷을 SQLite로 마이그레이션. 스키마 초안:

```sql
CREATE TABLE roots (...);
CREATE TABLE files (id, root_id, rel_path, abs_path, language, hash, size_bytes, is_generated, indexed_at);
CREATE TABLE nodes (id, kind, name, root_id, file_id, start_line, end_line, attrs_json, confidence);
CREATE TABLE edges (id, from_id, to_id, kind, file_id, start_line, end_line, attrs_json, confidence);
CREATE TABLE spans (id, root_id, file_id, start_line, end_line, text);
CREATE TABLE unresolved (...);
CREATE TABLE summaries (...);
CREATE TABLE index_runs (...);
```

추가될 디스크 레이아웃 항목:

- `evidence/nodes.jsonl`, `evidence/edges.jsonl`, `evidence/spans.jsonl` — Phase 2 도구가 생성하는 그래프 export.
- `diagnostics/indexer.jsonl`, `diagnostics/unresolved.jsonl` — 파서 실패와 해결 못한 참조.
- `queue/reindex.jsonl`, `queue/stale-memory.jsonl` — 백그라운드 작업 큐.

### Phase 3 — Resolver와 Contract Registry

추가될 책임:

- Resolver: 패키지 의존성, import, HTTP 클라이언트 ↔ 라우트 핸들러, 테스트 ↔ 대상 파일을 루트 간에 잇는다.
- Contract Registry: 그래프에서 중요한 경계 노드(REST 엔드포인트, gRPC 서비스, Kafka topic, cache key, DB 모델)를 별도 YAML로 승격한다. 디스크 레이아웃에 `contracts/dto/`, `contracts/rest/`, `contracts/python/`, `contracts/typescript/` 디렉터리가 생성된다.
- Confidence: 휴리스틱 매칭은 `confidence: 0.0–1.0`을 가진다. 영향 분석 게이트는 confidence 임계값에 따라 다르게 동작한다.

### Phase 4 — 시맨틱 메모리

추가될 디스크 레이아웃 항목:

```
memory/
├── roots/<root>.md
├── files/<root>.<path>.md
├── symbols/<symbol>.md
└── contracts/<id>.md
```

각 메모리 파일은 evidence anchor 없이 클레임을 만들지 않는다는 규칙을 따른다. evidence hash가 변하면 `summaries.status = "stale"`로 표시된다. `ctx_refresh_memory` 같은 도구가 추가되어 stale 메모리만 재생성한다.

### Phase 5 — 마이크로서비스 그래프

OpenAPI/proto/GraphQL 스키마, docker-compose/k8s/helm, Backstage `catalog-info.yaml`을 ingest해 service map을 생성한다. 옵션으로 OpenTelemetry, Kiali, Tempo의 런타임 토폴로지를 import한다. `ctx_service_flow`, `ctx_route_to_handler`, `ctx_client_to_route` 같은 그래프 도구가 추가된다.

### Phase 6 — LSP 보강

OpenCode의 실험 LSP 도구(definition, references, hover, documentSymbol, workspaceSymbol, call hierarchy)를 사용해 정규식 기반 추출이 놓친 reference를 보강한다. LSP 환경 의존성이 있으므로 옵트인으로 도입된다.

---

## 10. 디버깅과 검증

V0.1의 인덱싱 상태를 확인하는 가장 단순한 방법:

- `/ctx-list` 또는 `ctx_list_roots`: 루트 목록과 인덱스 상태(stale/indexed/not-indexed) 확인.
- `cat .opencode/context-bridge/workspace.json`: 매니페스트 직접 검사.
- `wc -l .opencode/context-bridge/index.jsonl`: 엔트리 총량.
- `jq -c 'select(.kind == "route")' .opencode/context-bridge/index.jsonl`: 추출된 라우트 후보만 보기.
- `tail -n 50 .opencode/context-bridge/task-history.jsonl`: 최근 운영 이벤트.

특정 루트만 다시 인덱싱하려면 `ctx_index({ root: "<alias>" })`를 호출하거나, 매니페스트에서 해당 루트의 `stale: true`로 설정한 뒤 다음 도구 호출(예: `ctx_search`)을 트리거하면 `ensureIndexReady`가 자동 처리한다.

전체 인덱스를 폐기하려면 `index.jsonl`을 삭제하고 모든 루트의 `stale`을 `true`로 만든 뒤 `ctx_index()`를 인자 없이 호출한다. 매니페스트와 ledger는 보존된다.
