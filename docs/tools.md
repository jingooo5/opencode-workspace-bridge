# tools.md

이 문서는 `opencode-context-bridge` 플러그인이 OpenCode에 노출하는 모든 인터페이스를 정리한다. 진실의 출처는 `src/tools/context-tools.ts`(커스텀 도구), `src/agents/agent-configs.ts`(슬래시 명령 등록), `src/cli.ts` + `src/install/global-config.ts`(CLI)이다.

세 종류의 인터페이스가 있다.

1. **OpenCode 커스텀 도구** — LLM이 직접 호출하는 `ctx_*` 도구. `@opencode-ai/plugin`의 `tool()`로 정의.
2. **슬래시 명령** — `/ctx-list`, `/ctx-pack`, `/ctx-impact`. `config` 훅에서 `Config.command`에 동적으로 등록.
3. **CLI 명령** — `context-bridge install`, `context-bridge doctor`. 패키지 셔뱅 진입점.

---

## 1. OpenCode 커스텀 도구

도구 인자 스키마는 SDK가 제공하는 `tool.schema`(zod)를 그대로 사용한다. 이것은 SDK 런타임이 사용하는 zod 인스턴스와 동일하므로 호환성 문제가 없다. 모든 도구는 결과를 문자열로 반환한다(JSON 직렬화 또는 사람이 읽을 수 있는 텍스트). 도구가 던지는 `Error`는 OpenCode가 LLM 응답에 그대로 노출한다.

### 1.1 ctx_install_agents

**설명**: Context Bridge 글로벌 부트스트랩을 다시 실행한다. 일반적으로 필요하지 않다. 플러그인 startup의 부트스트랩이 정상이면 호출할 일이 없다.

**인자**: 없음.

**동작**:

- `ensureGlobalBootstrap(ctx, { ...options, globalBootstrap: true })`를 호출.
- 결과 객체에 안내 노트를 붙여 JSON으로 반환. 새로 쓴 글로벌 에이전트 파일은 OpenCode를 재시작해야 새 프로세스가 인식한다.

**반환 형태**:

```json
{
  "note": "Global bootstrap completed. ...",
  "configPath": "...",
  "agentDir": "...",
  "wroteAgents": ["..."],
  "wroteConfig": false,
  "skipped": []
}
```

### 1.2 ctx_add_dir

**설명**: 외부 디렉터리/리포지토리를 Context Bridge 워크스페이스 매니페스트에 추가. primary OpenCode 디렉터리 외부의 파일을 읽거나 추론하기 전에 사용한다.

**인자**:

- `path: string` (필수) — 절대 경로 또는 현재 OpenCode 디렉터리 기준 상대 경로.
- `name?: string` — 안정적인 루트 별칭. 예: `backend`, `shared`.
- `access?: "ro" | "rw"` — 분석 전용은 `ro`, 편집 허용은 `rw`. 기본값은 `options.defaultAccess`.
- `role?: "primary" | "app" | "service" | "library" | "tooling" | "docs" | "unknown"` — `RootRoleSchema`의 enum.
- `tags?: string[]`.

**동작**:

- `WorkspaceStore.addRoot(path, { name, access, role, tags })`로 매니페스트 갱신. 별칭 충돌 시 `-2`, `-3` 접미사로 회피.
- `options.autoIndex`가 `true`(기본값)이면 즉시 `indexRoot(store, root)` 호출.

**반환 형태**:

```json
{
  "added": { "name": "...", "path": "...", "absPath": "...", "access": "ro", ... },
  "manifest": "<absPath>/.opencode/context-bridge/workspace.json"
}
```

### 1.3 ctx_list_roots

**설명**: 활성 워크스페이스 루트, 별칭, 접근 모드, 인덱스 상태, 매니페스트 경로를 사람이 읽을 수 있는 텍스트로 반환.

**인자**: 없음.

**반환 예시**:

```
Manifest: /repo/app/.opencode/context-bridge/workspace.json
Roots:
- primary: . (rw, primary, indexed 2026-05-02T03:11:00.000Z)
- backend: ../backend (ro, service, stale)
- shared: ../shared (ro, library, not-indexed)
```

상태 라벨은 `stale` → `indexed <ts>` → `not-indexed` 순으로 우선 결정된다.

### 1.4 ctx_index

**설명**: V0.1 라이트 인덱스를 한 루트 또는 모든 루트에 대해 빌드/리프레시한다. `autoIndex`가 켜져 있으면 보통 호출할 필요가 없다.

**인자**:

- `root?: string` — 인덱싱할 루트 별칭. 생략 시 모든 루트.

**동작**:

- 매니페스트의 루트 목록을 가져와 선택된 루트에 대해 `indexRoot(store, root)` 호출.
- 각 루트별 엔트리 수를 모아 반환.

**반환 형태**:

```json
{
  "index": "<absPath>/.opencode/context-bridge/index.jsonl",
  "result": [
    { "root": "primary", "entries": 142 },
    { "root": "backend", "entries": 87 }
  ]
}
```

### 1.5 ctx_search

**설명**: Context Bridge 멀티 루트 evidence 인덱스를 검색한다. 작업이 여러 리포에 걸칠 수 있을 때 raw grep 대신 사용한다.

**인자**:

- `query: string` (필수).
- `roots?: string[]` — 검색을 제한할 루트 별칭.
- `limit?: number` — 최대 히트 수. 기본값 `options.maxSearchResults` (30).

**동작**:

- `ensureIndexReady(store, options)`가 stale 루트나 인덱스 미생성 루트를 보강 인덱싱(autoIndex 켜진 경우).
- `searchIndex(store, query, roots, limit)` 호출. 점수는 정확 일치(10) > 이름 부분 일치(6) > 경로 부분 일치(4) > 그 외(1) 순.

**반환 형태**: 사람이 읽을 수 있는 텍스트.

```
[symbol] backend:src/types/order.ts#L12
export interface OrderDto { ... }

[route] backend:src/routes/orders.ts#L42
router.post("/orders", createOrder)

...
```

히트가 없으면 `"No hits. Try ctx_index first or broaden the query."`를 반환한다.

### 1.6 ctx_read

**설명**: 루트 별칭 참조로 파일을 읽는다. 멀티 루트 작업에서 절대 경로 read보다 안전하다.

**인자**:

- `ref: string` (필수) — `root:path/to/file` 형식. 예: `backend:src/routes/orders.ts`.
- `startLine?: number` — 1-based.
- `endLine?: number` — 1-based.

**동작**:

- `WorkspaceStore.resolveRef(ref)`로 루트와 절대 경로를 결정. 알 수 없거나 루트 밖이면 `Error("Unknown or unsafe root reference: ...")` throw.
- `WorkspaceStore.isSecretPath(absPath)`가 true이면 `Error("Refusing to read protected secret-like file: ...")` throw.
- 파일을 읽고 라인 범위 슬라이싱. `startLine`/`endLine`을 안전하게 클램프.
- 결과가 `options.maxReadBytes`(기본 80,000)를 넘으면 잘라내고 `\n...[truncated]` 추가.

**반환**: 파일 내용 또는 라인 슬라이스(문자열).

### 1.7 ctx_pack

**설명**: 멀티 루트 evidence 인덱스에서 작업 전용 컨텍스트 팩을 생성. cross-repo 편집, DTO/API 변경, 분산 흐름 디버깅 전에 사용한다.

**인자**:

- `task: string` (필수) — 자연어 작업 설명.
- `roots?: string[]`.
- `limit?: number` — evidence 히트 상한. 기본값 12.

**동작**:

- `ensureIndexReady`로 stale 보강.
- `searchIndex(store, task, roots, limit)`로 evidence 수집.
- `WorkspaceStore.workspaceSummary()`로 워크스페이스 요약 텍스트.
- `inferRisks(task, paths)` 휴리스틱(아래 참고)으로 위험 항목 추론.
- 팩 객체를 만들어 `<stateDir>/packs/<timestamp>-<slug>.json`에 `Bun.write`로 저장. `slug`는 task의 소문자 ASCII slug 60자 제한.
- ledger에 `{ type: "context.pack", task, hits, risks }` 기록.

**반환 형태**:

```json
{
  "task": "...",
  "workspace": "Manifest: ...\nRoots:\n- ...",
  "evidence": [
    {
      "root": "...",
      "ref": "...",
      "path": "...",
      "kind": "...",
      "score": 10,
      "text": "..."
    }
  ],
  "risks": ["shared DTO/schema change; check all consumers"],
  "suggestedNext": [
    "Inspect the top evidence refs with ctx_read.",
    "If editing contract/DTO/schema files, run impact analysis or ask ctx-impact-analyst first.",
    "After edits, ask ctx-test-router for targeted validation."
  ],
  "generatedAt": "2026-05-02T03:11:00.000Z"
}
```

`inferRisks` 규칙:

- task에 `dto|payload|request|response|schema|type` → `"shared DTO/schema change; check all consumers"`.
- `api|endpoint|route|openapi|grpc|proto|graphql` → `"public network contract change; check provider and consumers"`.
- `cache|redis|ttl|invalidation` → `"cache key or invalidation risk"`.
- `db|database|migration|table|column` → `"database migration/backward compatibility risk"`.
- evidence 경로에 `openapi`, `.proto`, `schema.graphql`, `schema.prisma`, `migrations/`가 보이면 `"contract file appears in evidence"`.

### 1.8 ctx_impact

**설명**: V0.1 라이트 영향 분석. `root:path`, 심볼, DTO, API, 또는 검색 문구를 받아 evidence-backed 후보 영향 목록을 반환한다.

**인자**:

- `target: string` (필수) — 예: `shared:src/types/order.ts` 또는 `OrderDto`.
- `limit?: number` — 기본값 30.

**동작**:

- `ensureIndexReady`.
- `searchIndex(store, target, undefined, limit)`로 직접 evidence 수집.
- `inferRisks(target, paths)`로 위험 추론.
- 등장 루트 집합 산출.
- ledger에 `{ type: "impact.analysis", target, hits, roots, risks }` 기록.

**반환 형태**:

```json
{
  "target": "OrderDto",
  "roots": ["shared", "backend", "frontend"],
  "directEvidence": [ ... ],
  "risks": [ ... ],
  "unknowns": [
    "V0.1 uses lightweight text/symbol evidence; REST/OpenAPI/proto structural matching arrives in v0.2+.",
    "Low or missing evidence should be confirmed with ctx_read and targeted search."
  ],
  "suggestedNext": [
    "Create a ctx_pack for the concrete task.",
    "Delegate to ctx-impact-analyst for edit order.",
    "Delegate to ctx-test-router after edits."
  ]
}
```

이 도구는 의도적으로 단순하다. structural matching(OpenAPI 스키마 ↔ 라우트 핸들러, proto ↔ gRPC 서비스 등)은 이 단계에서 다루지 않으며, `unknowns`에 명시되어 있다.

---

## 2. 슬래시 명령

`agents/agent-configs.ts`의 `injectContextBridgeAgents`가 OpenCode `Config.command`에 다음 셋을 등록한다. 모두 `agent: ctx-orchestrator`로 라우팅된다.

| 명령          | 인자                         | 템플릿                                                                                                      |
| ------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `/ctx-list`   | 없음                         | `Call the ctx_list_roots tool and explain any stale roots or read-only roots.`                              |
| `/ctx-pack`   | `$ARGUMENTS` (작업 설명)     | `Create a context pack for this task using ctx_pack: $ARGUMENTS`                                            |
| `/ctx-impact` | `$ARGUMENTS` (대상 ref/심볼) | `Use ctx-impact-analyst. Analyze cross-root impact for: $ARGUMENTS. Use ctx_search and ctx_pack if needed.` |

명령 이름은 `options.commandPrefix`(기본 `ctx`)와 무관하게 코드에 하드코딩되어 있다(현재 단계). 추가 명령은 직접 `Config.command`를 확장하거나 `.opencode/commands/`에 마크다운 파일을 두면 된다.

---

## 3. CLI 명령

패키지의 `bin` 진입점은 `src/cli.ts`이다. 두 명령을 지원한다.

### 3.1 context-bridge install

**용도**: 글로벌 OpenCode 설정에 플러그인을 등록하고 기본 에이전트를 `ctx-orchestrator`로 지정.

**플래그**:

- `--no-default-agent` — `default_agent` 변경 자체를 건너뜀.
- `--keep-default-agent` — `default_agent`가 이미 다른 값이면 덮어쓰지 않음.

**동작 (`installGlobalConfig`)**:

- 글로벌 디렉터리 결정: `OPENCODE_CONFIG_DIR` > `%APPDATA%/opencode` (Windows) > `${XDG_CONFIG_HOME ?? ~/.config}/opencode`.
- 디렉터리 안에서 `opencode.jsonc` → `opencode.json` → `config.json` 순서로 기존 파일 탐색. 없으면 `opencode.json`을 새로 만든다.
- `jsonc-parser`의 `parse`/`modify`/`applyEdits`로 다음을 idempotent하게 적용:
  - `$schema`이 없으면 `https://opencode.ai/config.json` 추가.
  - `plugin` 배열에 `opencode-context-bridge`(또는 옵션의 이름)가 없으면 추가.
  - `setDefaultAgent && (forceDefaultAgent || !previousDefaultAgent)`이면 `default_agent`를 지정.
  - `agent.<defaultAgent>`가 없으면 작은 스텁(설명 + `mode: primary` + edit/bash/external_directory `ask`)을 추가. 플러그인이 로드되면 동적 주입이 이 스텁을 확장한다.
- 변경이 발생했고 기존 파일이 있었으면 `<configPath>.context-bridge.bak-<timestamp>`로 백업한다.
- 결과를 stdout에 JSON으로 출력하고 "Restart opencode to load Context Bridge agents and hooks." 안내를 덧붙인다.

**반환(JSON)**:

```json
{
  "ok": true,
  "configPath": "...",
  "backupPath": "...",
  "pluginRegistered": true,
  "defaultAgentSet": true,
  "previousDefaultAgent": "..."
}
```

### 3.2 context-bridge doctor

**용도**: 변경을 시도하지 않고 글로벌 설정 경로와 플러그인 등록 가능 여부를 확인.

**동작**: `installGlobalConfig({ setDefaultAgent: false, forceDefaultAgent: false })`를 호출. `setDefaultAgent: false`이므로 `default_agent`는 건드리지 않는다(다만 `$schema`/`plugin`/`agent` 스텁은 누락 시 그대로 추가된다는 점에 주의). 출력은 `configPath`와 `pluginRegistered: true`로 단순화되어 있다.

### 3.3 help

`install`/`doctor`가 아닌 인자가 들어오면 사용법을 stdout에 출력하고 종료한다.

---

## 4. 도구 호출과 안전 게이트의 상호작용

`ctx_*` 도구도 OpenCode의 일반 도구처럼 `tool.execute.before`/`tool.execute.after` 훅을 거친다. `hooks/safety.ts`가 인자에서 path-like 문자열을 추출하므로, 다음 동작이 자동으로 일어난다.

- `ctx_read({ ref: "shared:.env" })` 같은 호출은 `ctx_read` 자체에서 `isSecretPath`로 한 번 차단되고, 만약 우회되더라도 안전 훅의 path-like 검사가 두 번째 방어선이 된다.
- `ctx_pack`이나 `ctx_impact` 자체는 파일을 편집하지 않으므로 ro/계약 게이트의 영향을 받지 않는다. 그러나 그 결과를 본 LLM이 OpenCode 내장 `edit`/`write`/`apply_patch`를 호출하면 안전 훅이 적용된다.
- `tool.execute.after`에서 편집 도구가 성공한 경로는 `SessionState.touch(sessionID, "<root>:<relPath>")`로 추적되어 컴팩션 훅의 컨티뉴에이션 컨텍스트에 자동 포함된다.

---

## 5. 호출 가이드 요약

- 외부 루트 등록은 항상 `ctx_add_dir`. 한 번 등록하면 매니페스트에 영구 보존되고, 이후 도구는 별칭으로만 참조한다.
- 검색은 `ctx_search`, 읽기는 `ctx_read`. raw grep/read보다 멀티 루트 안전성이 높다.
- 광범위한 작업 전에는 `ctx_pack`을 먼저 만들어 evidence를 가시화한다.
- 위험 변경 전에는 `ctx_impact` 또는 `ctx-impact-analyst` 위임으로 영향 후보를 모은다.
- 인덱싱은 `autoIndex`가 알아서 처리하지만, 외부 변경이 많을 때는 `ctx_index`를 명시적으로 호출해 stale 상태를 즉시 해소한다.
- 글로벌 부트스트랩이 깨졌다고 판단되면 `ctx_install_agents`를 호출하거나 CLI의 `context-bridge install`을 실행한다.
