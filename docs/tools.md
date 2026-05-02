# tools.md

이 문서는 `opencode-context-bridge` 플러그인이 OpenCode에 노출하는 인터페이스를 정리한다. 기준 코드는 `src/tools/context-tools.ts`, `src/agents/agent-configs.ts`, `src/cli.ts`, `src/install/global-config.ts`다.

인터페이스는 세 종류다.

1. OpenCode 커스텀 도구: LLM이 직접 호출하는 `ctx_*` 도구.
2. Runtime command: OpenCode `Config.command`에 주입되는 `ctx-*` command.
3. CLI 명령: `context-bridge install`, `context-bridge doctor`.

V0.1 도구의 evidence 읽기 원칙은 공통이다. SQLite snapshot(`index.sqlite`)을 먼저 사용하고, SQLite가 없거나 잠겨 있거나 손상됐거나 schema를 읽을 수 없으면 legacy `index.jsonl` 또는 안전한 빈 degraded 응답으로 내려간다. 각 도구는 가능한 경우 `sqlite` report와 diagnostics를 반환한다.

---

## 1. OpenCode 커스텀 도구

도구 인자 스키마는 SDK가 제공하는 `tool.schema`를 사용한다. 모든 도구는 문자열을 반환한다. JSON 객체를 반환하는 도구도 실제 반환값은 JSON 문자열이다.

### 1.1 `ctx_install_agents`

Context Bridge 글로벌 부트스트랩을 다시 실행한다. 보통 플러그인 startup 경로가 정상이라면 직접 호출할 일이 많지 않다.

동작:

- `ensureGlobalBootstrap(ctx, { ...options, globalBootstrap: true })` 호출.
- 쓴 agent 파일, config path, skip 사유를 JSON으로 반환.
- 새 글로벌 agent 파일은 OpenCode 재시작 후 새 프로세스가 인식한다.

### 1.2 `ctx_add_dir`

외부 디렉터리나 저장소를 workspace root로 추가한다.

인자:

- `path: string`: 절대 경로 또는 현재 OpenCode directory 기준 상대 경로.
- `name?: string`: 안정적인 root alias.
- `access?: "ro" | "rw"`: 분석 전용 또는 편집 허용. 기본값은 `options.defaultAccess`.
- `role?: "primary" | "app" | "service" | "library" | "tooling" | "docs" | "unknown"`.
- `tags?: string[]`.

동작:

- `WorkspaceStore.addRoot`로 `workspace.json`을 갱신한다.
- 같은 경로나 alias는 중복 생성하지 않고 갱신한다.
- `autoIndex`가 켜져 있으면 `indexRoot`를 호출해 SQLite와 legacy JSONL을 갱신한다.

반환 예시:

```json
{
  "added": { "name": "backend", "path": "../backend", "access": "ro" },
  "manifest": "/repo/app/.opencode/context-bridge/workspace.json"
}
```

### 1.3 `ctx_list_roots`

활성 루트, alias, access, role, stale/indexed/not-indexed 상태, manifest path를 사람이 읽을 수 있는 텍스트로 반환한다.

반환 예시:

```text
Manifest: /repo/app/.opencode/context-bridge/workspace.json
Roots:
- primary: . (rw, primary, indexed 2026-05-02T03:11:00.000Z)
- backend: ../backend (ro, service, stale)
- shared: ../shared (ro, library, not-indexed)
```

### 1.4 `ctx_index`

한 루트 또는 모든 루트의 Basic Indexer V0.1 evidence를 갱신한다.

인자:

- `root?: string`: 인덱싱할 root alias. 생략하면 모든 루트.

동작:

- 선택된 루트마다 `indexRoot(store, root)`를 호출한다.
- SQLite primary store인 `index.sqlite`를 열고, scanner/extractor/resolver 결과를 저장한다.
- compatibility 파일인 `index.jsonl`도 root 단위로 갱신한다.
- SQLite snapshot을 읽어 `sqlite` report와 `latestIndexRun`을 반환한다.

반환 형태:

```json
{
  "index": "/repo/app/.opencode/context-bridge/index.jsonl",
  "result": [
    { "root": "primary", "entries": 142 },
    { "root": "backend", "entries": 87 }
  ],
  "sqlite": {
    "path": "/repo/app/.opencode/context-bridge/index.sqlite",
    "available": true,
    "degraded": false,
    "schemaVersion": 1,
    "counts": { "nodes": 100, "edges": 20, "spans": 80, "unresolved": 4, "indexRuns": 1 }
  },
  "latestIndexRun": { "id": "...", "reason": "root.index", "stats": { "degraded": false } }
}
```

`index` 필드는 public compatibility 때문에 `index.jsonl` path를 가리킨다. primary evidence는 `sqlite.path`의 `index.sqlite`다.

### 1.5 `ctx_search`

멀티 루트 evidence index를 검색한다. raw grep보다 root alias와 index evidence에 맞춘 검색이다.

인자:

- `query: string`.
- `roots?: string[]`.
- `limit?: number`, 기본값 `options.maxSearchResults`.

동작:

- `ensureIndexReady`가 stale 또는 미인덱스 루트를 보강한다.
- SQLite snapshot이 있으면 nodes와 spans에서 `IndexEntry` 모양을 만들고 검색한다.
- SQLite evidence가 비어 있거나 열 수 없으면 `searchIndex()`로 `index.jsonl`을 검색한다.
- fallback이 쓰이면 응답 앞에 `SQLite unavailable ... using legacy JSONL fallback.` 같은 banner가 붙을 수 있다.

검색 점수는 exact name 10, name 포함 6, path 포함 4, text 포함 1이다.

### 1.6 `ctx_status`

workspace와 index 상태를 요약한다.

인자:

- `ledgerLimit?: number`.

반환 내용:

- `manifest`: path, primary, roots, indexedAt, stale.
- `index`: legacy `index.jsonl` path, 존재 여부, kind/root별 entry 수, stale roots.
- `sqlite`: `index.sqlite` path, availability, degraded 여부, schemaVersion, diagnostics, counts, latestIndexRun.
- `recentLedger`: 최근 `task-history.jsonl` entries.
- `notes`: SQLite evidence와 JSONL fallback 설명.

### 1.7 `ctx_symbols`

심볼 evidence를 나열한다.

인자:

- `query?: string`.
- `root?: string`.
- `ref?: string`.
- `limit?: number`.

동작:

- SQLite symbol nodes를 우선 사용한다.
- SQLite가 없으면 legacy JSONL의 `kind: "symbol"` entries를 사용한다.
- 결과에는 `sqlite` report와 `Symbol evidence is lightweight extraction, not LSP graph analysis.` note가 포함된다.

### 1.8 `ctx_neighbors`

target 주변의 관련 evidence를 찾는다.

인자:

- `target: string`: symbol name 또는 `root:path` ref.
- `limit?: number`.

동작:

- SQLite graph evidence가 있으면 matching node, edge, unresolved를 함께 반환한다.
- legacy heuristic도 유지한다. same-file, same-name, same-directory, ref-related 기준으로 neighbor를 점수화한다.
- SQLite가 없으면 graph evidence 없이 heuristic neighbor만 반환하고 degraded warning을 포함한다.

주의:

- `ctx_neighbors`는 graph-aware tool이지만 완전한 call graph proof가 아니다.
- unresolved가 있으면 영향 없음의 증거로 해석하지 않는다.

### 1.9 `ctx_read`

`root:path` ref로 파일을 읽는다.

인자:

- `ref: string`.
- `startLine?: number`.
- `endLine?: number`.

동작:

- `WorkspaceStore.resolveRef`로 루트 밖 escape를 막는다.
- secret-like 경로는 읽지 않는다.
- `options.maxReadBytes`를 넘으면 잘라서 반환한다.

### 1.10 `ctx_pack`

작업별 context pack을 생성한다.

인자:

- `task: string`.
- `roots?: string[]`.
- `limit?: number`, 기본값 12.

동작:

- stale 루트를 보강한다.
- SQLite evidence를 우선 검색하고, 없으면 JSONL fallback 검색을 사용한다.
- `graph`, `evidenceAnchors`, `unknowns`, `warnings`, `risks`, `suggestedNext`를 포함한 pack을 만든다.
- 결과를 `.opencode/context-bridge/packs/<timestamp>-<slug>.json`에 저장한다.
- ledger에 `context.pack`을 남긴다.

반환 필드 요약:

- `evidence`: 검색 evidence.
- `graph.graphNeighbors`: SQLite edge 후보.
- `graph.packages`: package metadata evidence.
- `graph.testCandidates`: test 후보.
- `graph.unresolved`: unresolved records.
- `warnings`: degraded 또는 낮은 증거 경고.

### 1.11 `ctx_test_plan`

변경 범위에 맞는 테스트 명령 후보를 제안한다. 이 도구는 테스트를 실행하지 않는다.

인자:

- `target?: string`.
- `root?: string`.
- `ref?: string`.
- `limit?: number`.

동작:

- indexed test entries와 package entries를 읽는다.
- SQLite `TESTS` edges와 package nodes가 있으면 `graphMatchingTests`, `graphTestEdges`, `graphPackages`에 포함한다.
- `package.json` scripts를 읽어 `bun run <script>` 또는 `bun --cwd <dir> run <script>` 후보를 만든다.
- 직접 실행, 성공 판정, coverage 보장은 하지 않는다.

반환에는 다음 disclaimer가 포함된다.

```text
Test planning uses indexed test/package entries and package.json scripts only. It does not execute or validate the commands.
```

### 1.12 `ctx_refresh_memory`

V0.1 memory refresh 요청을 받는 compatibility/status shim이다.

인자:

- `reindex?: boolean`.
- `root?: string`.
- `task?: string`.
- `limit?: number`.

동작:

- `durableSemanticMemory: false`를 명시한다.
- `reindex: true`면 선택 루트를 다시 인덱싱한다.
- `task`가 있으면 새 context pack을 만든다.
- semantic embeddings, durable markdown memory, graph memory를 만들지 않는다.

### 1.13 `ctx_impact`

대상 ref, symbol, DTO, API, 검색어에 대해 영향 후보를 반환한다.

인자:

- `target: string`.
- `limit?: number`, 기본값 30.

동작:

- SQLite 또는 JSONL 검색으로 `directEvidence`를 만든다.
- SQLite graph가 있으면 `graphDirectEvidence`, `crossRootEvidence`, `unknownEvidence`, `testCandidateEvidence`를 채운다.
- `inferRisks`로 DTO/schema, endpoint, cache, DB migration 위험 힌트를 붙인다.
- ledger에 `impact.analysis`를 남긴다.

제한:

- OpenAPI/proto/GraphQL/Kafka/Redis/DB semantic matching은 하지 않는다.
- 낮거나 없는 evidence는 `ctx_read`, `ctx_search`, targeted validation으로 확인해야 한다.

---

## 2. Runtime commands

Runtime command는 OpenCode `Config.command`에 주입되는 command다. command 이름은 public UI entry이며, 실제 작업은 위 `ctx_*` 도구와 에이전트가 수행한다.

대표 command:

- `ctx-add-dir`: 외부 루트 추가.
- `ctx-index`: 루트 인덱싱.
- `ctx-pack`: context pack 생성.
- `ctx-impact`: 영향 후보 분석.
- `ctx-build`: 준비된 context 기반 구현 위임.
- `ctx-validate`: 승인된 validation 범위 실행 위임.
- `ctx-summarize`: 증거와 판단 요약.

설치 환경에 따라 `/ctx-list`, `/ctx-pack`, `/ctx-impact`처럼 slash 형태로 보일 수 있는 문서와 예시가 있지만, 구현 기준 public tool 이름은 `ctx_*`다. 혼동될 때는 `ctx_list_roots`, `ctx_pack`, `ctx_impact` 도구를 기준으로 보면 된다.

---

## 3. CLI 명령

패키지 bin은 `context-bridge`이며 `./dist/cli.js`를 가리킨다.

### 3.1 `context-bridge install`

글로벌 OpenCode 설정에 플러그인을 등록하고 기본 에이전트 스텁을 보조한다.

플래그:

- `--no-default-agent`: `default_agent` 변경을 건너뜀.
- `--keep-default-agent`: 기존 `default_agent`가 있으면 덮어쓰지 않음.

### 3.2 `context-bridge doctor`

설정 경로와 등록 상태를 확인한다. 현재 구현은 내부 설치 로직 일부를 사용하므로 완전한 read-only 점검으로 가정하면 안 된다.

---

## 4. 도구 호출과 안전 게이트

`ctx_*` 도구도 OpenCode의 일반 도구처럼 safety hook과 함께 동작한다.

- `ctx_read({ ref: "shared:.env" })`는 `ctx_read` 자체와 safety hook에서 secret-like 경로를 막는다.
- `ctx_pack`, `ctx_impact`, `ctx_test_plan`은 파일을 편집하지 않는다.
- 실제 edit/write/apply_patch가 실행되면 read-only root, secret-like path, contract file 정책이 적용된다.
- 편집 성공 후 hook은 touched ref를 세션 상태에 기록하고, 해당 root/file을 stale로 표시하며 reindex queue 호환 기록을 남긴다.

---

## 5. 호출 가이드 요약

- 외부 루트 등록은 `ctx_add_dir`를 사용한다.
- 루트 상태와 SQLite availability는 `ctx_status`로 확인한다.
- 검색은 `ctx_search`, 심볼은 `ctx_symbols`, 주변 영향 후보는 `ctx_neighbors`를 사용한다.
- 넓은 작업 전에는 `ctx_pack`으로 evidence와 unknown을 먼저 모은다.
- DTO/API/schema/cache/DB/topic 변경 전에는 `ctx_impact`를 사용한다.
- 테스트 후보는 `ctx_test_plan`이 제안한다. 실행은 별도 validation runner나 사용자가 명시한 명령으로 한다.
- memory refresh 요청은 `ctx_refresh_memory`가 받지만, V0.1에서는 semantic memory를 만들지 않는다.
