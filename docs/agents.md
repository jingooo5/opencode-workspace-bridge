# agents.md

이 문서는 `opencode-context-bridge` 플러그인이 OpenCode에 주입하는 에이전트들의 역할, 권한, 그리고 실제 사용 흐름을 정리한다. 모든 에이전트 정의의 단일 출처는 `src/agents/agent-configs.ts`이며, 본 문서는 그 코드와 동기화된 설명이다.

---

## 1. 에이전트 주입 경로

에이전트는 두 가지 경로로 OpenCode에 노출된다.

1. **런타임 주입 (`config` 훅)**
   `plugin-interface.ts`의 `config` 훅이 매 세션마다 `injectContextBridgeAgents`를 호출한다. 이 함수는 `Config.agent`에 다섯 에이전트를 등록하고, 옵션이 켜져 있으면 `Config.default_agent`를 `ctx-orchestrator`로 지정하며, `ctx-list`/`ctx-pack`/`ctx-impact` 슬래시 명령을 `Config.command`에 추가한다. 이 경로는 플러그인이 로드되어 있는 한 항상 동작하므로, 사용자가 글로벌 마크다운 파일을 수동으로 관리할 필요가 없다.

2. **글로벌 마크다운 파일 (옵션)**
   `globalBootstrap` + `globalInstallAgents` 옵션이 켜져 있거나 사용자가 `npx opencode-context-bridge install`을 실행하면, `agentMarkdown(spec)`이 같은 스펙을 마크다운 frontmatter로 직렬화해 `~/.config/opencode/agents/<name>.md`에 기록한다. 이는 OpenCode가 플러그인 없이도 에이전트를 인식할 수 있도록 하는 백업 경로다.

`getContextBridgeAgentSpecs(defaultAgentName)` 한 번이 두 경로의 진실의 출처(single source of truth)를 형성한다. 따라서 에이전트 변경은 `agent-configs.ts` 한 곳만 수정하면 된다.

---

## 2. 에이전트 목록

다섯 에이전트가 정의되어 있다. 모두 같은 OpenCode 권한 모델을 따른다(`read`/`grep`/`glob`/`list`/`edit`/`bash`/`external_directory`/`task`).

| 이름                      | 모드       | hidden | 기본 권한 요약                                                                                                          |
| ------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| `ctx-orchestrator`        | `primary`  | no     | read/grep/glob/list allow, edit/bash/external_directory ask, task는 `ctx-*`만 allow                                     |
| `ctx-workspace-architect` | `subagent` | yes    | 읽기 전용. bash는 `git status*`, `git diff*`, `rg *`, `grep *`, `find *`, `ls *`만 allow                                |
| `ctx-context-curator`     | `subagent` | yes    | 읽기 전용. bash는 deny + 위 화이트리스트                                                                                |
| `ctx-impact-analyst`      | `subagent` | yes    | 읽기 전용. bash는 deny + 위 화이트리스트                                                                                |
| `ctx-test-router`         | `subagent` | yes    | 읽기 전용 + 테스트 명령 ask: `npm test*`, `pnpm test*`, `bun test*`, `yarn test*`, `pytest*`, `go test*`, `cargo test*` |

`ctx-orchestrator`만 `mode: primary`이며 사용자 메시지를 직접 받는다. 나머지는 hidden subagent로 OpenCode의 Task 도구를 통해서만 호출된다. `ctx-orchestrator`의 `task` 권한은 `"*": "deny", "ctx-*": "allow"`이므로, primary가 자기 패밀리 외 임의의 에이전트를 위임 호출할 수 없게 잠겨 있다.

### 2.1 ctx-orchestrator (primary)

**역할.** Context Bridge의 기본 primary 에이전트. 멀티 루트, cross-repository, DTO/API, 서비스 경계 작업을 받았을 때 다음을 수행하도록 프롬프트가 작성되어 있다.

- 루트 상태가 불명확하면 `ctx_list_roots`로 매니페스트를 확인.
- 광범위한 cross-root 구현 전에는 `ctx_pack`을 먼저 호출.
- 작업이 넓으면 `ctx-context-curator`에게 컨텍스트 최소화를 위임.
- 공유 DTO/계약/스키마 또는 cross-root 의존을 편집하기 전에 `ctx-impact-analyst`에 위임.
- 편집 후에는 `ctx-test-router`에 위임해 타깃 검증을 선택.
- 단일 파일/단일 루트 작업처럼 위험 신호가 없으면 OpenCode의 기본 동작을 그대로 사용.

**프롬프트 핵심 지침.** evidence가 없는 시맨틱 요약을 신뢰하지 않는다. 단순 작업에서는 위 위임 절차를 강제하지 않고, 멀티 루트나 경계 위험이 있을 때만 단계를 추가한다.

### 2.2 ctx-workspace-architect (hidden subagent)

**역할.** 워크스페이스 루트, 패키지, 모듈, 서비스 경계의 지도화. 루트의 역할 추정, 패키지/빌드 메타데이터 단서, 가능한 provider/consumer 관계, unknown, 그리고 다음에 호출하면 좋은 `ctx_add_dir`/`ctx_index` 액션을 반환한다.

**호출 시점.** 사용자가 새 외부 디렉터리를 도입하거나, 알려지지 않은 멀티 루트 구조를 처음 분석할 때 자동 라우터(`hooks/auto-router.ts`)가 라우팅 힌트로 추천한다.

**비편집 보장.** 권한이 read-only로 잠겨 있어 어떤 파일도 편집하지 않는다.

### 2.3 ctx-context-curator (hidden subagent)

**역할.** 주어진 작업에 대해 최소한의 evidence-backed 컨텍스트 팩을 만든다. whole-file 덤프 대신 정확한 ref, 심볼 이름, 계약 스니펫, 테스트, 위험 항목을 우선한다. 모든 클레임은 `root:path`나 인덱싱된 evidence 항목을 인용해야 한다.

**호출 시점.** primary가 cross-repo 구현에 들어가기 전에 위임. 자동 라우터는 워크스페이스/계약 관련 단어를 감지하면 이 에이전트와 `ctx-workspace-architect`를 함께 추천한다.

### 2.4 ctx-impact-analyst (hidden subagent)

**역할.** 변경의 직접/간접/계약/런타임/테스트/unknown 영향을 분석한다. DTO, OpenAPI, gRPC/proto, GraphQL, cache key, message topic, DB schema, generated client, read-only 루트에 특히 주의를 기울이고, 편집 순서와 검증 체크리스트를 반환한다.

**호출 시점.** 자동 라우터가 다음 패턴을 감지하면 라우팅 힌트에 포함한다: `dto|schema|payload|request|response|openapi|api|endpoint|grpc|proto|graphql|interface`(계약), `cache|redis|ttl|invalidation|kafka|topic|queue|pubsub|db|database|migration|table|column`(런타임/데이터 경계).

### 2.5 ctx-test-router (hidden subagent)

**역할.** 영향받은 루트에 대해 가장 작은 유의미한 테스트/빌드 체크 셋을 선택한다. 패키지 메타데이터, 파일명, 테스트 명명 관습, 변경 ref를 사용한다. 명시적으로 허용되지 않은 명령은 실행 전 ask한다.

**bash 권한 화이트리스트.** `npm test*`, `pnpm test*`, `bun test*`, `yarn test*`, `pytest*`, `go test*`, `cargo test*`. 그 외 명령은 모두 ask.

---

## 3. 자동 라우팅과의 연결

`hooks/auto-router.ts`의 `chat.message` 훅이 사용자 발화를 분류해 `RouteHint`를 만들고 `SessionState`에 저장한다. 같은 모듈의 `experimental.chat.system.transform` 훅이 시스템 프롬프트에 다음 섹션을 항상 추가한다.

- 현재 활성 루트와 매니페스트 경로.
- 사용 가능한 hidden subagent 목록(이 문서의 다섯 에이전트 중 primary를 제외한 넷).
- 이번 세션의 라우팅 힌트(있다면).
- "위험한 cross-root 변경의 기본 시퀀스: ctx_list_roots → ctx_pack → Task(ctx-impact-analyst) → 승인된 rw 루트만 편집 → Task(ctx-test-router)" 안내.

분류 규칙(코드 그대로):

- 워크스페이스 / 리포지토리 / 모듈 단어가 보이면 `ctx-workspace-architect` + `ctx-context-curator`, `taskShape: "workspace"`.
- 계약/인터페이스/스키마 단어가 보이면 `ctx-impact-analyst` + `ctx-context-curator`, `taskShape: "contract"`.
- 런타임/데이터 경계 단어가 보이면 `ctx-impact-analyst`, `taskShape: "impact"`.
- 테스트/디버그 단어가 보이면 `ctx-test-router`, `taskShape`는 디버그 어휘가 있으면 `"debug"`, 그 외 `"test"`.

이 규칙은 한국어 단어("작업영역", "레포", "모듈", "서비스", "인터페이스", "스키마", "검증", "오류", "실패")를 일부 포함한다.

---

## 4. 사용 사례별 흐름

아래 흐름은 모두 현재 코드에서 동작 가능한 도구/훅만 사용한다.

### 사례 A — 외부 백엔드를 추가하고 영향 분석

사용자: "../backend 디렉터리도 워크스페이스에 넣어줘. 그다음 OrderDto 바꾸면 영향 받는 곳 정리해줘."

흐름:

1. `ctx-orchestrator`가 메시지를 받는다. 자동 라우터는 "워크스페이스 추가"와 "DTO 영향" 단어를 감지해 `ctx-workspace-architect` + `ctx-context-curator` + `ctx-impact-analyst` 라우팅 힌트를 시스템 프롬프트에 주입한다.
2. orchestrator가 `ctx_add_dir({ path: "../backend" })`를 호출. `WorkspaceStore.addRoot`가 매니페스트에 `backend` 별칭으로 루트를 등록(기본 `ro`). `autoIndex`가 켜져 있으므로 `indexRoot(store, root)`가 즉시 실행되어 `index.jsonl`에 엔트리를 추가한다.
3. orchestrator가 `Task("ctx-context-curator", "OrderDto 변경 영향 분석을 위한 최소 컨텍스트")`를 위임.
4. curator는 `ctx_pack({ task: "OrderDto change impact" })`를 호출. `ctx_pack` 도구는 `ensureIndexReady`로 stale 루트를 보강 인덱싱하고, `searchIndex`로 evidence를 모아 `packs/<ts>-orderdto-change-impact.json`에 저장한다.
5. orchestrator가 `Task("ctx-impact-analyst", "OrderDto 영향 분석")`을 위임. analyst는 `ctx_impact({ target: "OrderDto" })`를 호출하고, 추가로 `ctx_search`나 `ctx_read`로 ref를 확인한다.
6. orchestrator가 결과를 종합해 사용자에게 직접 영향 ref, 위험 항목, 추천 편집 순서, 알 수 없는 항목을 보고한다. 실제 편집 단계로는 넘어가지 않는다.

이 사례에서 발생하는 부수 효과는 다음과 같다. `ledger`(`task-history.jsonl`)에 `root.added`, `root.indexed`, `context.pack`, `impact.analysis` 항목이 기록된다.

### 사례 B — read-only 루트를 잘못 편집하려는 경우

사용자: "shared 모듈의 OrderDto 정의를 직접 바꿔줘."

흐름:

1. 사용자가 사전에 `ctx_add_dir({ path: "../shared", access: "ro" })`를 등록했다고 가정.
2. orchestrator가 OpenCode 내장 `edit` 도구로 `../shared/src/types/order.ts`에 패치를 시도.
3. `tool.execute.before` 훅(`hooks/safety.ts`)이 인자에서 path-like 문자열을 추출하고, `WorkspaceStore.findRootByPath`로 가장 깊은 매칭 루트(`shared`)를 찾는다.
4. 도구가 `edit`/`write`/`apply_patch` 중 하나이고 루트의 `access`가 `ro`이므로 훅이 `Error("Context Bridge blocked edit: root 'shared' is read-only. ...")`를 던진다.
5. 사용자는 `ctx_add_dir({ path: "../shared", access: "rw" })`로 재등록하거나, primary 루트에서 처리할 패치만 만들고 끝낸다.

### 사례 C — 계약 파일 편집과 ledger 경고

사용자: "openapi.yaml에 새 엔드포인트 추가해줘."

흐름:

1. `tool.execute.before` 훅이 path를 검사한다. 파일이 `policies.contractGlobs`(기본값에 `**/openapi*.yaml` 포함)에 매치되므로 계약 파일로 분류.
2. `enforceImpactBeforeContractEdit`이 `false`(기본값)이면 차단하지 않고, `appendLedger({ type: "contract.edit.warning", ... })`로 경고만 기록한다.
3. `enforceImpactBeforeContractEdit`이 `true`이면 즉시 throw. orchestrator는 사용자에게 먼저 `ctx_pack` + `ctx-impact-analyst`를 거치도록 안내한다.

이 정책은 매니페스트의 `policies.enforceImpactBeforeContractEdit` 한 줄로 켜고 끌 수 있다.

### 사례 D — 컴팩션 후 작업 재개

사용자가 긴 세션에서 여러 외부 루트를 추가하고 일부 파일을 편집한 뒤 컴팩션이 일어나는 경우.

흐름:

1. `experimental.session.compacting` 훅(`hooks/compaction.ts`)이 호출된다.
2. 훅은 `WorkspaceStore.workspaceSummary()`로 루트 목록 텍스트, `SessionState.touched(sessionID)`로 이번 세션에서 touched된 ref 목록, `WorkspaceStore.recentLedger(12)`로 최근 ledger를 모은다.
3. 이 정보를 컨티뉴에이션 컨텍스트(`output.context`)에 마크다운으로 푸시한다. 마지막 항목은 "재개 규칙: cross-root 작업이라면 매니페스트를 경로로 다시 열고 `ctx_list_roots`를 호출하고 stale 루트를 편집하기 전에 `ctx_pack`을 다시 만들어라"이다.
4. 컴팩션 후 새 컨텍스트에서도 활성 루트와 진행 상태가 살아 있으므로, orchestrator가 작업을 자연스럽게 이어간다.

### 사례 E — 테스트 라우팅

사용자: "지금 변경된 파일에 대해 빠르게 검증만 돌려줘."

흐름:

1. orchestrator가 `Task("ctx-test-router", "현재 touched ref에 대한 타깃 테스트 선택")`을 위임.
2. test-router는 `ctx_list_roots`로 루트와 패키지 메타데이터를 확인하고 `ctx_search`로 테스트 후보를 찾는다.
3. router의 bash 권한이 `pnpm test*`, `pytest*` 등에 한해 `ask`이므로, 후보 명령만 제시하고 실제 실행은 사용자 승인 후에만 수행한다.

---

## 5. 슬래시 명령

`injectContextBridgeAgents`가 등록하는 슬래시 명령은 셋이다. 모두 `agent: ctx-orchestrator`로 위임된다.

- `/ctx-list`: orchestrator가 `ctx_list_roots`를 호출하고 stale/ro 루트를 설명하도록 지시.
- `/ctx-pack <task>`: `ctx_pack`을 호출해 작업 팩을 생성.
- `/ctx-impact <target>`: `ctx-impact-analyst`에게 위임. 필요시 `ctx_search`/`ctx_pack` 보강.

도구와 명령의 정확한 인자/리턴 형식은 `tools.md` 참고.

---

## 6. 안전 원칙 요약

코드에 명시된 다음 원칙을 모든 에이전트가 공유한다.

- evidence 없는 시맨틱 요약은 신뢰하지 않는다. 모든 클레임에 ref가 붙어야 한다.
- subagent는 파일을 직접 편집하지 않는다(`ctx-test-router` 포함, 편집 권한이 deny로 잠금).
- primary는 위임 가능한 에이전트가 `ctx-*`로 한정된다.
- read-only 루트, 시크릿 경로, 계약 파일에 대한 편집은 `tool.execute.before`에서 일관되게 게이트된다.
- 도구 실행 후 touched ref는 `SessionState`와 매니페스트의 stale 플래그로 추적되어, 이후 인덱싱과 컴팩션에서 사용된다.
