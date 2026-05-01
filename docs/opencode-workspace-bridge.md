# opencode-workspace-bridge-plugin

OpenCode 플러그인으로, 여러 디렉터리/리포지토리/모듈을 하나의 OpenCode 세션에 등록하고, 그 위에서 다중 루트(multi-root) 컨텍스트 오케스트레이션 레이어를 제공한다. Claude Code의 `/add-dir` 같은 외부 디렉터리 부착 기능을 시작점으로 삼되, 그 위에 워크스페이스 매니페스트, 라이트 인덱서, 안전성 훅, 컨텍스트 팩, 영향 분석, 자동 라우팅을 얹어 마이크로서비스/멀티 리포 환경에서의 cross-repository 작업을 지원한다.

---

## 1. 해결하려는 문제

OpenCode 자체는 다음을 제공한다.

- 시작 디렉터리(worktree) 안에서의 read/edit/grep/glob/bash 도구
- `external_directory` 권한을 통한 워크트리 외부 경로 접근 제어
- 플러그인 SDK(`@opencode-ai/plugin`)와 이벤트 훅, 커스텀 도구, 에이전트, 명령어 시스템

하지만 실제 멀티 리포/마이크로서비스 환경에서는 다음이 부족하다.

1. 시작 디렉터리 외부의 다른 리포를 "워크스페이스 루트"로 등록하고 별칭(alias)으로 참조하는 개념이 없다.
2. 외부 루트를 인덱싱하고, 루트 별로 read-only/read-write 정책을 부여하는 메커니즘이 없다.
3. 여러 루트에 걸친 심볼/라우트/계약(contract) 파일을 통합 검색하고, 변경 영향을 추정하는 도구가 없다.
4. 긴 세션에서 컨텍스트 컴팩션이 발생하면 "어떤 외부 루트를 추가했고, 어떤 파일을 건드렸는지" 같은 운영 상태가 사라진다.
5. 시크릿 파일이나 read-only 루트, 계약 파일에 대한 편집 시도를 일관되게 차단할 수 있는 안전 게이트가 없다.

이 플러그인은 위 다섯 가지 문제를 OpenCode 플러그인 SDK 위에서 해결한다.

---

## 2. 목표

- **외부 디렉터리 등록**: `ctx_add_dir` 도구로 외부 디렉터리를 워크스페이스 루트로 등록하고, 루트 별 별칭/접근 모드/역할을 부여한다.
- **루트 별칭 기반 참조**: `backend:src/routes/orders.ts` 같은 `root:relPath` 표기로 모든 도구가 작동하도록 한다.
- **라이트 인덱싱**: 외부 의존성 없이 동작하는 V0.1 인덱서로 파일/패키지/심볼/라우트/계약/테스트 후보를 JSONL 인덱스에 적재한다.
- **컨텍스트 팩 / 영향 분석**: 작업 설명을 받아 관련 증거(evidence)를 모아 `ctx_pack`을 생성하고, 대상 ref/심볼에 대한 영향 후보를 `ctx_impact`로 산출한다.
- **안전 게이트**: `tool.execute.before` 훅에서 시크릿 경로 차단, read-only 루트 편집 차단, 계약 파일 편집 시 영향 분석 강제(옵션)를 수행한다.
- **자동 라우팅**: 사용자 발화에서 워크스페이스/계약/런타임 경계/테스트 단어를 감지해 적절한 hidden subagent를 시스템 프롬프트로 안내한다.
- **컴팩션 보존**: `experimental.session.compacting` 훅에서 활성 루트, 최근 ledger, 세션에서 건드린 ref를 컨티뉴에이션 컨텍스트에 주입한다.
- **운영 가능성**: `~/.config/opencode/` 글로벌 설정과 에이전트 마크다운 파일을 idempotent하게 생성/패치하는 부트스트랩과 CLI를 제공한다.

---

## 3. 개요

플러그인은 단일 npm 패키지(`opencode-context-bridge`)이며, OpenCode가 플러그인을 로드할 때 `serverPlugin`을 호출한다. `PluginInput`으로 들어오는 `directory`/`worktree`/`client`를 기준으로 `.opencode/context-bridge/` 아래 상태 파일을 만들고 관리한다.

런타임 흐름은 다음과 같다.

1. `serverPlugin(input, options)`이 호출되면 `normalizeOptions`가 zod 스키마로 옵션을 정규화한다.
2. `globalBootstrap` 옵션이 켜져 있으면 `ensureGlobalBootstrap`이 글로벌 에이전트 마크다운/설정을 idempotent하게 갱신한다.
3. `createManagers`가 `WorkspaceStore`와 `SessionState`를 만든다. `WorkspaceStore.init`이 매니페스트가 없으면 `primary` 루트(현재 worktree 또는 directory)를 만들고, `options.roots`로 선언된 외부 루트를 추가한다.
4. `autoIndex`가 켜진 경우 stale 루트나 인덱스 미생성 루트를 즉시 인덱싱한다(실패해도 startup은 진행).
5. `createTools`가 `ctx_*` 커스텀 도구를 생성한다.
6. `createHooks`가 이벤트/셸 환경/자동 라우터/안전성/컴팩션 훅을 묶어서 반환한다.
7. `createPluginInterface`가 OpenCode SDK가 요구하는 `Hooks` 형태로 묶고, `config` 훅에서 동적으로 에이전트와 일부 슬래시 명령어를 주입한다.

이 모든 상태(매니페스트, 인덱스, ledger, packs)는 디스크의 `.opencode/context-bridge/` 아래에 보존되므로 세션 컴팩션이나 재시작 후에도 path-addressable하게 복구할 수 있다.

---

## 4. 기술 스택

- **런타임**: Node.js (CLI는 `#!/usr/bin/env node` 셔뱅), `Bun.write`도 일부 사용. OpenCode 자체는 Bun 기반으로 동작한다.
- **언어**: TypeScript, ES 모듈(`.js` 확장자 import).
- **플러그인 SDK**: `@opencode-ai/plugin` (`Plugin`, `PluginInput`, `PluginOptions`, `PluginModule`, `Hooks`, `Config`, `tool`, `ToolDefinition`).
- **스키마/검증**: `zod` (옵션, 매니페스트, 인덱스 엔트리, 검색 히트, 라우트 힌트, CLI 인자 등 모든 경계에 zod 스키마를 둔다). 도구 인자는 SDK가 제공하는 `tool.schema`를 사용해 SDK와 동일한 zod 인스턴스를 공유한다.
- **JSONC 파싱**: `jsonc-parser` (`applyEdits`, `modify`, `parse`)로 글로벌 OpenCode 설정 파일을 안전하게 패치한다.
- **표준 라이브러리**: `node:fs/promises`, `node:path`, `node:os`만 사용. tree-sitter, LSP, SQLite, ripgrep 등 외부 인덱서 의존성은 V0.1에 포함하지 않는다.
- **저장 포맷**: 매니페스트는 `workspace.json`(JSON), 인덱스는 `index.jsonl`, 운영 ledger는 `task-history.jsonl`, 컨텍스트 팩은 `packs/<timestamp>-<slug>.json`.

---

## 5. 디렉터리 구성

현재 코드베이스의 `src/` 트리는 다음과 같다.

```
src/
├── agents/
│   └── agent-configs.ts          # 에이전트 스펙(prompt/permission)과 OpenCode Config 주입
├── bootstrap/
│   └── global-bootstrap.ts       # 플러그인 startup 시 글로벌 ~/.config/opencode 부트스트랩
├── cli.ts                        # context-bridge install / doctor CLI
├── config.ts                     # 옵션 zod 스키마 + DEFAULT_OPTIONS + normalizeOptions
├── create-hooks.ts               # 모든 훅 묶음
├── create-managers.ts            # WorkspaceStore + SessionState 생성, autoIndex 실행
├── create-tools.ts               # ctx_* 도구 생성 진입점
├── hooks/
│   ├── auto-router.ts            # chat.message 분류 + 시스템 프롬프트에 라우팅 정책 주입
│   ├── compaction.ts             # experimental.session.compacting에 워크스페이스/ledger 주입
│   ├── events.ts                 # event 훅: session.created/file.edited/session.diff/session.idle
│   ├── index.ts
│   ├── safety.ts                 # tool.execute.before/after 안전성 게이트
│   └── shell-env.ts              # shell.env 훅: CTX_BRIDGE_* 환경변수
├── index.ts                      # PluginModule 기본 export
├── indexer/
│   └── light-index.ts            # V0.1 라이트 인덱서: 파일 스캔/심볼/라우트/계약/테스트
├── install/
│   └── global-config.ts          # CLI install: jsonc-parser로 글로벌 설정 패치
├── plugin-interface.ts           # config 훅에서 에이전트 주입, Hooks 결과 조립
├── shared/
│   ├── log.ts                    # ctx.client.app.log 래퍼(절대 throw하지 않음)
│   └── path.ts                   # slugify, toAbs, isInside, refOf, parseRef, globishMatch
├── state/
│   ├── session-state.ts          # 인메모리 세션 라우팅 힌트, touched ref 추적
│   └── workspace-store.ts        # 매니페스트/인덱스/ledger 저장소
├── tools/
│   ├── context-tools.ts          # ctx_install_agents, ctx_add_dir, ctx_list_roots,
│   │                              # ctx_index, ctx_search, ctx_read, ctx_pack, ctx_impact
│   └── index.ts
└── types.ts                      # 모든 zod 스키마/타입(AccessMode, RootSpec, Manifest,
                                  # ContextBridgeOptions, IndexEntry, SearchHit, RouteHint)
```

각 모듈은 다음 책임 분리 원칙을 따른다.

- 외부 입력(옵션, 매니페스트, 인덱스 엔트리, 도구 인자)은 모두 `types.ts`의 zod 스키마로 검증된다.
- 파일 시스템과 상태 변경은 전부 `WorkspaceStore`를 거친다. 훅과 도구는 직접 매니페스트나 인덱스 파일을 만지지 않는다.
- 각 훅 모듈은 자신이 의존하는 매니저(`WorkspaceStore`, `SessionState`)만 받고, OpenCode SDK의 부분 `Hooks` 객체를 반환한다.
- 로그는 `shared/log.ts`의 `log()`만 사용하고, 어떤 경우에도 훅 실행을 깨지 않도록 try/catch로 감싼다.

---

## 6. 세부 구성

### 6.1 옵션과 디폴트

`ContextBridgeOptions`는 `types.ts`에서 zod로 정의된다. 주요 필드는 다음과 같다.

- `stateDir`: 기본값 `.opencode/context-bridge`. 모든 상태 파일의 베이스.
- `defaultAccess`: 새 루트의 기본 접근 모드. 기본값 `ro`.
- `autoAgents`: `config` 훅에서 매 세션마다 OpenCode `Config`에 에이전트와 `ctx-list`/`ctx-pack`/`ctx-impact` 슬래시 명령을 주입한다. 기본값 `true`.
- `autoDefaultAgent` / `defaultAgentName`: 주입된 에이전트 중 하나를 `default_agent`로 지정한다. 기본 `ctx-orchestrator`.
- `globalBootstrap` / `globalInstallAgents` / `globalSetDefaultAgent` / `globalRegisterPlugin` / `globalPluginName`: 글로벌 `~/.config/opencode/` 부트스트랩 동작을 제어한다.
- `autoIndex`: 플러그인 startup과 도구 호출 시점에 stale 루트를 자동 인덱싱한다.
- `maxSearchResults`, `maxReadBytes`: 검색/읽기 응답 크기 제한.
- `secretGlobs`, `contractGlobs`: 안전성 게이트가 사용하는 globish 패턴.
- `enforceImpactBeforeContractEdit`: 켜지면 계약 파일 편집을 즉시 차단한다.
- `roots`: 플러그인 로드 시 자동 추가할 외부 루트 목록.

`normalizeOptions`는 잘못된 필드를 무시하고 디폴트로 채운다. 옵션 파싱 단계에서 throw하지 않는 것이 원칙이다.

### 6.2 워크스페이스 매니페스트

`WorkspaceStore.init()`이 매니페스트를 처음 만들 때 구조는 다음과 같다.

```json
{
  "version": 1,
  "primary": {
    "name": "primary",
    "path": ".",
    "absPath": "<worktree or directory>",
    "access": "rw",
    "role": "primary",
    "tags": ["primary"]
  },
  "roots": [
    { "name": "primary", "path": ".", "absPath": "...", "access": "rw", "role": "primary", "tags": ["primary"] }
  ],
  "policies": {
    "secretGlobs": [...],
    "contractGlobs": [...],
    "enforceImpactBeforeContractEdit": false
  }
}
```

`addRoot`는 다음 규칙을 따른다.

- `path`는 `ctx.directory` 기준 상대/절대 모두 허용. `absPath`는 정규화된 절대 경로로 보관.
- 별칭은 `slugify(opts.name ?? basename(absPath))`로 생성. 같은 별칭이 다른 경로에 이미 있으면 `-2`, `-3` 접미사를 붙여 충돌을 회피한다.
- 같은 `absPath` 또는 별칭이 이미 있으면 기존 항목을 in-place로 갱신한다(중복 추가 금지).
- 새 루트는 `stale: true`로 시작하므로 다음 인덱싱 사이클에서 다시 인덱싱된다.

### 6.3 V0.1 라이트 인덱서

`indexer/light-index.ts`는 외부 의존성 없이 다음을 수행한다.

- 루트 디렉터리를 BFS로 스캔하되, `.git`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `target`, `vendor`는 건너뛴다. 점으로 시작하는 항목은 기본적으로 무시하지만 `.opencode`, `.env`, `.env.example`은 예외로 둔다. 한 번에 최대 2,500개 파일까지만 처리한다.
- 텍스트 확장자(`.ts/.tsx/.js/.jsx/.mjs/.cjs/.json/.yaml/.yml/.md/.py/.go/.rs/.java/.kt/.proto/.graphql/.sql/.prisma`)에 한해 내용을 읽고, 파일에 NUL 바이트가 있으면 바이너리로 간주해 무시한다. 파일은 500KB까지만 읽는다.
- 라인 단위 정규식으로 다음을 추출한다.
  - 심볼: `export (default)? (async)? (function|class|interface|type|enum) <Name>`, `function/class/interface/type` 직접 선언.
  - 라우트: `(router|app).(get|post|put|patch|delete)("/path")`, NestJS `@Get/@Post/...`, `fetch("/path")`, `axios.<method>("/path")`.
  - 계약: 파일명 패턴 `openapi.*`, `schema.*`, `*.proto`, `migrations/`.
  - 테스트: 경로에 `test`나 `spec`이 포함된 파일.
  - 패키지: `package.json`의 `name` 필드.
- 추출 결과는 `IndexEntry`로 정규화되어 `index.jsonl`에 저장된다. 한 루트를 다시 인덱싱하면 그 루트 소속 엔트리는 모두 새 엔트리로 교체된다.
- `searchIndex`는 query를 lowercase로 만들고 `name`/`path`/`text`에 부분 일치 검색을 한다. 점수는 정확 일치(10) > 이름 부분 일치(6) > 경로 부분 일치(4) > 그 외(1) 순.

이 인덱서는 의도적으로 단순하다. tree-sitter나 LSP, SQLite는 V0.2 이상에서 들어올 영역이며, 자세한 로드맵은 `indexing.md`에 정리되어 있다.

### 6.4 도구

`tools/context-tools.ts`에서 다음 도구들이 정의된다.

- `ctx_install_agents`: 글로벌 부트스트랩 재실행.
- `ctx_add_dir`: 외부 루트 등록 + 옵션 따라 즉시 인덱싱.
- `ctx_list_roots`: 활성 루트 요약 텍스트 반환.
- `ctx_index`: 특정 루트 또는 전 루트 인덱싱.
- `ctx_search`: 멀티 루트 통합 검색.
- `ctx_read`: `root:relPath` 별칭으로 파일 읽기. 시크릿 경로는 거부.
- `ctx_pack`: 작업 설명 → evidence + risks + suggestedNext를 모은 JSON 팩을 생성하고 `packs/`에 파일로 저장.
- `ctx_impact`: target ref/심볼에 대해 인덱스 검색 + 휴리스틱 risk 추론.

도구 목록과 시그니처 상세는 `tools.md`에 정리되어 있다.

### 6.5 훅

훅은 `create-hooks.ts`에서 합쳐지며 다음 OpenCode 이벤트를 사용한다.

- `event`: `session.created`, `file.edited`, `session.diff`, `session.idle`을 ledger와 stale 처리에 사용.
- `shell.env`: `CTX_BRIDGE_STATE_DIR`, `CTX_BRIDGE_MANIFEST`, `CTX_BRIDGE_INDEX` 환경변수 주입.
- `chat.message` + `experimental.chat.system.transform`: 사용자 발화를 분류해서 hidden subagent 라우팅 정책을 시스템 프롬프트에 주입.
- `tool.execute.before`: 시크릿 경로 차단, read-only 루트 편집 차단, 계약 파일 편집 강제(옵션).
- `tool.execute.after`: 편집 도구가 성공했을 때 touched ref를 세션 상태에 기록하고 stale 처리.
- `experimental.session.compacting`: 컴팩션 직전에 워크스페이스 요약과 최근 ledger, touched ref를 컨티뉴에이션 컨텍스트에 주입.

각 훅의 의도는 "OpenCode 본 동작을 절대로 깨지 않는다"이다. 시그니처 위반이나 zod 파싱 실패 같은 회복 가능한 에러는 모두 silent로 처리하고, 의도적으로 차단해야 하는 경우에만 `Error`를 던진다.

### 6.6 에이전트 주입

`agents/agent-configs.ts`는 다섯 개의 에이전트 스펙을 정의한다.

- `ctx-orchestrator` (primary)
- `ctx-workspace-architect` (subagent, hidden)
- `ctx-context-curator` (subagent, hidden)
- `ctx-impact-analyst` (subagent, hidden)
- `ctx-test-router` (subagent, hidden)

스펙은 두 가지 경로로 사용된다.

1. `injectContextBridgeAgents`가 `config` 훅에서 OpenCode `Config.agent`에 동적으로 주입한다. 이때 `default_agent`도 옵션에 따라 지정한다. 추가로 `ctx-list`/`ctx-pack`/`ctx-impact` 슬래시 명령을 `Config.command`에 등록한다.
2. `agentMarkdown`이 같은 스펙을 `.md` 프론트매터 형식으로 직렬화해, `~/.config/opencode/agents/<name>.md`로 글로벌 부트스트랩이 기록한다.

에이전트별 역할과 사용 예시는 `agents.md` 참고.

### 6.7 글로벌 부트스트랩과 CLI

플러그인 startup의 `globalBootstrap` 경로(`bootstrap/global-bootstrap.ts`)는 다음을 수행한다.

- `OPENCODE_CONFIG_DIR` 환경변수 또는 `~/.config/opencode`를 글로벌 디렉터리로 사용.
- `globalInstallAgents`가 켜져 있으면 위 다섯 에이전트의 마크다운을 `agents/`에 덮어쓴다.
- `globalSetDefaultAgent` 또는 `globalRegisterPlugin`이 켜져 있으면 `opencode.jsonc` 또는 `opencode.json` 중 존재하는 파일을 패치한다. 둘 다 없으면 `opencode.jsonc`를 생성한다. 패치는 자체 JSONC 스트리퍼로 코멘트와 trailing comma를 제거하고 `JSON.parse`로 검증한 뒤 다시 정직한 JSON으로 기록한다. 기존 파일은 `*.context-bridge.bak`으로 백업한다.

CLI(`cli.ts`, `install/global-config.ts`)는 사용자가 `npx opencode-context-bridge install`처럼 직접 실행하는 경로다.

- `install`: `installGlobalConfig`를 호출. 내부에서 `jsonc-parser`의 `applyEdits`/`modify`로 정확한 JSONC 편집을 수행하고, `$schema`/`plugin`/`default_agent`/`agent.<defaultAgent>` 스텁을 idempotent하게 추가한다. 기존 설정이 있으면 타임스탬프 백업을 만든다. `--no-default-agent`/`--keep-default-agent` 플래그로 기본 에이전트 지정 동작을 제어한다.
- `doctor`: 패치를 시도하지 않고 설정 경로를 보고한다.

부트스트랩 경로와 CLI 경로의 코드가 일부 중복되는 것은 의도적이다. 부트스트랩은 매번 플러그인 로드시 안전하게 동작하도록 가벼운 자체 구현을 쓰고, CLI는 `jsonc-parser`로 더 정밀한 JSONC 편집을 한다.

### 6.8 안전성 모델

세 가지 게이트가 동시에 동작한다.

1. **시크릿 차단**: read/write/edit/apply_patch가 매니페스트의 `policies.secretGlobs`에 매치되는 경로를 만지면 `tool.execute.before`에서 throw.
2. **read-only 루트 편집 차단**: edit/write/apply_patch가 `access: "ro"` 루트의 파일을 만지면 throw.
3. **계약 파일 편집**: edit/write/apply_patch가 `policies.contractGlobs`에 매치되면 ledger에 경고를 적고, `enforceImpactBeforeContractEdit`이 켜져 있을 때만 throw.

`looksLikePath`는 도구 인자를 재귀 탐색해 path-like 문자열만 추출한다(슬래시 또는 확장자 휴리스틱 + 길이 제한). 이는 `ctx_*` 도구뿐 아니라 OpenCode 내장 read/edit 도구에도 일관되게 적용된다.

---

## 7. 개발 과정과 현재 상태

이 프로젝트는 처음부터 풀 스펙을 구현하지 않는다. 기능 추가 순서는 다음과 같이 진행되고 있다.

### Phase 0 — Proof of concept (현재)

현재 코드베이스가 도달한 단계다. 다음이 동작한다.

- 워크스페이스 매니페스트(`workspace.json`) 생성/갱신.
- 외부 루트 등록과 별칭 충돌 회피.
- 라이트 인덱서가 파일/패키지/심볼/라우트/계약/테스트 후보를 추출해 `index.jsonl`에 저장.
- 멀티 루트 검색(`ctx_search`), 별칭 기반 읽기(`ctx_read`).
- 컨텍스트 팩 생성(`ctx_pack`)과 휴리스틱 영향 분석(`ctx_impact`).
- 시크릿/계약/read-only 안전 게이트.
- 컴팩션 훅에서 운영 상태 보존.
- 자동 라우팅(`chat.message` 분류 + 시스템 프롬프트 주입).
- 글로벌 에이전트/설정 부트스트랩과 CLI.

### 향후 추가 예정

이 단계에서 의도적으로 배제한 영역이 있다.

- 언어별 정확한 파서: tree-sitter, ts-morph, Python `ast`, ast-grep 기반 extractor.
- Resolver: 패키지/임포트/엔드포인트/컨트랙트/테스트를 루트 간에 이어 붙이는 단계.
- Contract registry: REST/gRPC/topic/cache/DB 계약을 별도 YAML로 승격하는 단계.
- SQLite 인덱스: 현재 JSONL 인덱스를 SQLite 기반으로 마이그레이션.
- 시맨틱 메모리: `.opencode/context-bridge/memory/` 아래에 evidence-anchored 마크다운 요약을 자동 생성.
- LSP 보강: `lsp.updated` 훅과 OpenCode LSP 도구를 활용한 reference resolution.

자세한 단계는 `indexing.md`의 로드맵 절을 참고한다.

---

## 8. 운영 흐름 요약

전형적인 사용 흐름은 다음과 같다.

1. 사용자는 `npx opencode-context-bridge install`로 글로벌 설정에 플러그인을 등록하거나, 프로젝트 `opencode.json`/`opencode.jsonc`에 직접 등록한다. 디폴트 에이전트로 `ctx-orchestrator`가 지정된다.
2. OpenCode 세션이 시작되면 플러그인이 로드되고 `WorkspaceStore`가 `.opencode/context-bridge/workspace.json`을 만든다. primary 루트는 worktree 또는 directory로 잡힌다.
3. 사용자는 `/ctx-list`로 현재 상태를 확인하거나, 자연어로 "../backend도 같이 보고 OrderDto 변경 영향 분석해줘" 같이 말한다. 자동 라우터가 contract/impact 라우팅 힌트를 시스템 프롬프트에 추가한다.
4. `ctx-orchestrator`가 `ctx_add_dir`로 외부 루트를 등록하고, 자동 인덱싱이 끝나면 `ctx_pack`/`ctx_impact`를 사용해 evidence를 모은다.
5. 편집 단계에서는 `tool.execute.before` 훅이 시크릿/ro/계약 게이트를 검사하고, 통과한 편집은 `tool.execute.after`에서 stale/touched로 기록된다.
6. 세션이 길어져 컴팩션이 발생하면 `experimental.session.compacting` 훅이 활성 루트, 최근 ledger, touched ref를 컨티뉴에이션 컨텍스트에 다시 채워 넣는다.
