# agents.md

이 문서는 `opencode-context-bridge`가 OpenCode 런타임에 주입하는 에이전트, 명령, 도구, 자동 라우팅 흐름을 정리한다. 기준 코드는 `src/agents/agent-configs.ts`, `src/agents/agent-install.ts`, `src/commands/command-configs.ts`, `src/tools/context-tools.ts`, `src/plugin-interface.ts`, `src/hooks/auto-router.ts`다.

## 1. 런타임 주입 구조

에이전트 주입과 명령 주입은 분리되어 있다.

1. 에이전트 주입  
   `src/agents/agent-install.ts`의 `injectContextBridgeAgents`가 `Config.agent`에 Context Bridge 에이전트를 등록한다. `autoDefaultAgent`가 꺼져 있지 않으면 `Config.default_agent`도 기본 primary 에이전트로 설정한다. 이 함수는 명령을 등록하지 않는다.

2. 명령 주입  
   `src/commands/command-configs.ts`의 `injectContextBridgeCommands`가 `Config.command`에 runtime command를 등록한다. 명령별로 담당 에이전트와 `subtask` 여부를 지정한다.

3. 플러그인 연결  
   `src/plugin-interface.ts`의 `config` 훅은 `options.autoAgents`가 켜져 있을 때 `injectContextBridgeAgents`와 `injectContextBridgeCommands`를 둘 다 호출한다. 따라서 `autoAgents`는 에이전트와 명령의 런타임 주입을 함께 켜는 옵션이다.

에이전트 스펙의 단일 출처는 `getContextBridgeAgentSpecs`다. 명령 스펙의 단일 출처는 `getContextBridgeCommandSpecs`다.

## 2. 에이전트 목록

현재 에이전트는 모두 8개다. 기본 primary 이름은 `ctx-orchestrator`이며 `defaultAgentName` 옵션으로 바꿀 수 있다. 나머지 7개는 hidden subagent로 등록된다. 모든 에이전트의 `temperature`는 `0.1`이다.

| 이름                      | 모드 / 노출         | 역할 요약                                                     | 권한 요약                                                                                 |
| ------------------------- | ------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `ctx-orchestrator`        | `primary` / visible | `/ctx-*` 명령과 cross-repository 작업을 조율하는 parent agent | read/grep/glob/list/lsp allow, edit deny, bash ask, task allow, external_directory ask    |
| `ctx-workspace-architect` | `subagent` / hidden | 루트, 패키지, 언어, 서비스, 모듈, 경계 구조 탐색              | read-only 기본, bash는 ask 기본 + `git *`, `pwd`, `ls *`, `find *` allow, lsp allow       |
| `ctx-context-curator`     | `subagent` / hidden | 작업별 최소 evidence-backed context pack 구성                 | read-only 기본, `.opencode/context-bridge/packs/**`만 edit allow, bash deny, lsp allow    |
| `ctx-impact-analyst`      | `subagent` / hidden | 파일, 심볼, DTO, endpoint, contract 영향 분석                 | read-only 기본, bash deny, external_directory ask, lsp allow                              |
| `ctx-semantic-summarizer` | `subagent` / hidden | 증거 기반 semantic summary / memory 작성                      | read-only 기본, `.opencode/context-bridge/memory/**`와 `packs/**`만 edit allow, bash deny |
| `ctx-test-router`         | `subagent` / hidden | 테스트와 validation command 후보 선정                         | read/grep/glob/list allow, edit deny, bash ask, external_directory ask                    |
| `ctx-validation-runner`   | `subagent` / hidden | 승인된 validation plan 실행과 실패 매핑                       | read/grep/glob/list allow, edit deny, 테스트 계열 bash allowlist, external_directory ask  |
| `ctx-builder`             | `subagent` / hidden | 승인된 context pack과 impact report 기반 구현                 | read/grep/glob/list/lsp allow, edit ask, bash ask, external_directory ask                 |

주의할 점은 모든 subagent가 읽기 전용은 아니라는 것이다. `ctx-builder`는 구현을 위해 편집을 요청할 수 있고, `ctx-context-curator`와 `ctx-semantic-summarizer`는 지정된 Context Bridge 상태 디렉터리 아래에만 쓸 수 있다.

### 2.1 `ctx-orchestrator`

기본 primary 에이전트다. 다중 루트 작업, 외부 루트 추가, 컨텍스트 팩 생성, 영향 분석, 구현 위임, 검증 위임을 조율한다. 루트 상태가 불명확하면 `ctx_status` 또는 `ctx_list_roots`로 시작하고, 변경 작업은 `ctx_pack`과 필요 시 `ctx-impact-analyst`를 거친 뒤 `ctx-builder`에 넘기는 흐름을 따른다. V0.2에서는 `ctx_status`의 `sqlite` report를 확인해 `index.sqlite` evidence가 사용 가능한지, 또는 `index.jsonl` fallback인지 먼저 판단해야 한다.

권한상 프로젝트 소스 편집은 `deny`다. 따라서 직접 수정자가 아니라 parent orchestrator 역할을 맡는다. `task: allow`이므로 필요한 hidden subagent에게 위임할 수 있다.

### 2.2 `ctx-workspace-architect`

읽기 중심의 워크스페이스 구조 탐색 subagent다. 루트의 역할, 패키지와 빌드 단서, 언어와 프레임워크, 서비스 경계, provider/consumer 관계, DTO/schema/shared model 후보를 정리한다. 구조 판단은 `index.sqlite`의 package, file, symbol, route, test, resolver evidence를 우선하고, SQLite가 unavailable이면 도구가 노출하는 degraded JSONL fallback을 근거로 삼는다.

주요 도구는 `ctx_list_roots`, `ctx_status`, `ctx_search`, `ctx_symbols`, `ctx_neighbors`, `ctx_read`다. bash는 기본적으로 ask지만 `git *`, `pwd`, `ls *`, `find *`는 허용된다. 파일 편집은 금지된다.

### 2.3 `ctx-context-curator`

작업에 필요한 최소 context pack을 만드는 subagent다. 전체 파일 덤프보다 root/path ref, line span, symbol, contract, test, risk처럼 작은 evidence를 우선한다. 구현 전 컨텍스트를 줄이고 unknown을 명시하는 역할이다. `ctx_pack`의 `graph`, `evidenceAnchors`, `unknowns`, `warnings`를 함께 읽고, unresolved record가 있으면 영향 없음으로 해석하지 않는다.

소스 코드는 편집하지 않는다. 단, context pack 산출물을 위해 `.opencode/context-bridge/packs/**` 아래에는 쓸 수 있다. bash는 deny다.

### 2.4 `ctx-impact-analyst`

변경 영향 분석 전용 subagent다. 같은 파일/심볼의 직접 영향, cross-root reference, DTO/OpenAPI/schema/generated client 같은 contract 영향 후보, runtime-like 영향 후보, 테스트 영향 후보, read-only root 위험, unknown을 정리한다. V0.1의 graph evidence는 conservative resolver 결과이므로 package import, relative import, exact endpoint candidate, test link 외의 관계를 단정하지 않는다.

주요 도구는 `ctx_impact`, `ctx_neighbors`, `ctx_symbols`, `ctx_search`, `ctx_test_plan`이다. 구현과 파일 편집은 하지 않으며 bash도 deny다.

### 2.5 `ctx-semantic-summarizer`

증거 기반 요약을 작성하는 subagent다. root, file, symbol, contract에 대한 요약을 만들 때 모든 중요한 주장에 evidence anchor를 붙이고, 근거가 없으면 Unknown으로 남긴다.

쓰기 가능 경로는 `.opencode/context-bridge/memory/**`와 `.opencode/context-bridge/packs/**`뿐이다. 현재 V0.1에서 `ctx_refresh_memory`는 durable semantic memory 구현이 아니라 compatibility/status shim이므로, 이 에이전트도 실제 근거 파일과 pack을 기준으로 요약해야 한다. `memory/roots` 경로가 있어도 semantic embeddings나 durable LLM memory가 있다고 가정하지 않는다.

### 2.6 `ctx-test-router`

테스트를 직접 실행하지 않고 validation plan을 고르는 subagent다. `ctx_test_plan`, `ctx_status`, `ctx_impact`, package metadata, 파일명 관습을 사용해 가장 작은 유의미한 검증 범위를 제안한다. `ctx_test_plan`은 indexed test/package entries와 SQLite `TESTS` 후보 edge를 읽지만, 명령을 실행하거나 성공을 보장하지 않는다.

출력은 실행 명령 후보, 커버되는 파일/심볼/계약, 커버되지 않는 위험, 추천 runner를 포함한다. 실제 실행은 `ctx-validation-runner`가 맡는다.

### 2.7 `ctx-validation-runner`

승인된 validation plan이나 사용자가 명시한 검증 범위를 실행하고 결과를 해석하는 subagent다. 파일은 편집하지 않으며, 실패를 root/file/symbol/contract에 매핑해 다음 행동을 제안한다.

bash는 테스트 계열 명령만 allowlist로 허용된다. 허용 범위는 `npm test*`, `pnpm test*`, `yarn test*`, `npx vitest*`, `npx jest*`, `pytest*`, `python -m pytest*`다. 그 외 명령은 ask 규칙을 따른다.

### 2.8 `ctx-builder`

승인된 context pack과 impact report를 기반으로 실제 구현을 맡는 subagent다. 편집 전 root access, read-only 여부, impact analysis, contract review, user approval 같은 required gate를 확인해야 한다.

`edit`와 `bash`는 ask 권한이며 `lsp`는 allow다. 승인된 범위 밖의 파일은 편집하지 않고, 필요한 파일이 context pack에 없으면 orchestrator에게 pack 확장을 요청해야 한다. 구현 후에는 변경 파일, 근거, 필요한 검증, 남은 위험을 보고한다.

## 3. Runtime commands

현재 `src/commands/command-configs.ts`가 등록하는 command는 7개다. 이들은 OpenCode `Config.command` 항목이며, 각 command는 지정된 에이전트로 라우팅된다.

1. `ctx-add-dir`  
   외부 디렉터리나 저장소를 Context Bridge 루트로 추가한다. 담당 에이전트는 `ctx-orchestrator`다.

2. `ctx-index`  
   하나 이상의 루트를 다시 인덱싱한다. 담당 에이전트는 `ctx-orchestrator`다.

3. `ctx-pack`  
   작업 설명에 맞는 증거 기반 컨텍스트 팩을 만든다. 담당 에이전트는 `ctx-context-curator`이며 subtask로 실행된다.

4. `ctx-impact`  
   교차 루트 영향과 계약 영향을 분석한다. 담당 에이전트는 `ctx-impact-analyst`이며 subtask로 실행된다.

5. `ctx-build`  
   승인된 컨텍스트를 바탕으로 변경 준비 또는 구현을 맡긴다. 담당 에이전트는 `ctx-builder`이며 subtask로 실행된다.

6. `ctx-validate`  
   기존 validation plan이나 사용자가 지정한 검증 범위를 실행한다. 담당 에이전트는 `ctx-validation-runner`이며 subtask로 실행된다.

7. `ctx-summarize`  
   수집된 증거와 판단을 간결하게 요약한다. 담당 에이전트는 `ctx-semantic-summarizer`이며 subtask로 실행된다.

## 4. 자동 라우터

`src/hooks/auto-router.ts`는 사용자 메시지를 분류하고 hidden subagent 사용 힌트를 시스템 프롬프트에 주입한다.

1. `chat.message` 훅  
   사용자 텍스트를 읽고 `classify` 결과를 `SessionState`에 저장한다. 라우팅 힌트는 ledger에도 `route.hint`로 기록된다.

2. `experimental.chat.system.transform` 훅  
   활성 루트, manifest 경로, hidden subagent 7개 목록, 현재 session의 routing hint, risky cross-root 기본 시퀀스를 시스템 프롬프트에 추가한다.

자동 라우터가 노출하는 hidden subagent 목록은 다음 7개다.

1. `ctx-workspace-architect`
2. `ctx-context-curator`
3. `ctx-semantic-summarizer`
4. `ctx-impact-analyst`
5. `ctx-builder`
6. `ctx-validation-runner`
7. `ctx-test-router`

분류 규칙은 키워드 기반이다.

1. workspace, repository, module, service, external, add-dir, 작업영역, 레포, 모듈, 서비스  
   `ctx-workspace-architect`와 `ctx-context-curator`를 추천하고 `taskShape`를 `workspace`로 둔다.

2. summary, summarize, semantic summary, 요약, 정리  
   `ctx-semantic-summarizer`를 추천한다.

3. DTO, schema, payload, request, response, OpenAPI, API, endpoint, gRPC, proto, GraphQL, interface, 인터페이스, 스키마  
   `ctx-impact-analyst`와 `ctx-context-curator`를 추천하고 `taskShape`를 `contract`로 둔다.

4. cache, redis, TTL, invalidation, Kafka, topic, queue, pubsub, DB, database, migration, table, column  
   `ctx-impact-analyst`를 추천하고 `taskShape`를 `impact`로 둔다.

5. implement, build, edit, change, modify, refactor, code, 작성, 구현, 수정  
   `ctx-builder`를 추천한다.

6. test, 검증, validate, build, lint, failure, bug, debug, 오류, 실패  
   `ctx-test-router`를 추천한다. validate, validation, 검증, test plan, plan이 있으면 `ctx-validation-runner`도 추천한다.

기본 risky cross-root 흐름은 `ctx_list_roots`, `ctx_pack`, `Task(ctx-impact-analyst)`, `Task(ctx-builder)`, `Task(ctx-validation-runner)`, `Task(ctx-test-router)` 순서다. 실제 순서는 작업 성격과 이미 확보한 증거에 따라 줄어들 수 있다.

## 5. 사용 사례 흐름

### 사례 A. 외부 루트 추가 후 인덱싱

사용자 요청: `../backend를 Context Bridge 루트로 추가하고 인덱싱해줘.`

1. `ctx-add-dir` command 또는 primary 에이전트가 `ctx_add_dir`를 호출한다.
2. `autoIndex`가 켜져 있으면 새 루트를 즉시 인덱싱한다.
3. 필요하면 `ctx_index`로 명시 재인덱싱한다.
4. `ctx_list_roots` 또는 `ctx_status`로 manifest와 stale 상태를 요약한다.

### 사례 B. DTO 또는 API 변경 영향 확인

사용자 요청: `OrderDto를 바꾸면 영향 받는 곳을 정리해줘.`

1. 자동 라우터가 contract 키워드를 감지해 `ctx-impact-analyst`와 `ctx-context-curator`를 추천한다.
2. `ctx_pack`이 작업 관련 증거를 모은다.
3. `ctx_impact`와 필요 시 `ctx_neighbors`, `ctx_symbols`, `ctx_search`가 영향 후보를 찾는다.
4. 결과는 direct evidence, cross-root evidence 후보, contract risk 후보, affected test 후보, unresolved unknowns, recommended edit order로 정리한다.

### 사례 C. 승인된 구현 작업

사용자 요청: `팩과 영향 분석 기준으로 구현까지 진행해줘.`

1. `ctx-orchestrator`가 루트 접근 권한과 required gate를 확인한다.
2. 구현 범위가 명확하면 `ctx-builder`에 넘긴다.
3. `ctx-builder`는 승인된 파일과 범위 안에서만 편집을 요청한다.
4. 구현 뒤에는 변경 파일, 근거, 남은 위험, 검증 필요 항목을 보고한다.

### 사례 D. 검증 계획과 실행

사용자 요청: `변경 범위에 맞는 테스트를 고르고 실행해줘.`

1. 자동 라우터가 test 또는 validation 키워드를 감지한다.
2. `ctx-test-router`가 `ctx_test_plan`, `ctx_status`, `ctx_impact`, package metadata를 사용해 validation plan을 만든다. 이 단계에서는 테스트를 실행하지 않는다.
3. 실행 범위가 명확하면 `ctx-validation-runner`가 계획에 있는 명령 또는 명백히 동등한 targeted test를 실행한다.
4. 결과는 pass, fail, blocked, partial 중 하나로 보고하고 실패를 관련 root, file, symbol, contract에 매핑한다.

### 사례 E. 요약과 메모리 호환 흐름

사용자 요청: `현재 조사 결과를 요약해줘.`

1. 자동 라우터가 summary 키워드를 감지해 `ctx-semantic-summarizer`를 추천한다.
2. summarizer는 증거, 결정, unknown을 간결하게 정리한다.
3. 필요한 경우 `.opencode/context-bridge/memory/**` 또는 `packs/**` 아래에만 기록한다.
4. `ctx_refresh_memory`가 호출되더라도 V0.1에서는 durable semantic memory를 만드는 것이 아니라 상태와 호환성 정보를 반환한다.

## 6. V0.1 한계

1. `ctx_neighbors`는 graph-aware지만 완전한 proof가 아니다. SQLite가 있으면 conservative resolver edge와 unresolved record를 포함하고, 없으면 같은 파일, 같은 이름, 같은 디렉터리, ref 관련 문자열 기반 heuristic으로 degraded 응답을 만든다.

2. `ctx_test_plan`은 실행 도구가 아니다. 인덱싱된 test/package 항목, SQLite `TESTS` 후보 edge, `package.json` script를 보고 명령 후보를 제안하지만 실행하거나 성공을 보장하지 않는다.

3. `ctx_refresh_memory`는 compatibility/status shim이다. durable semantic memory, embeddings, 구조적 graph memory를 제공하지 않는다.

4. V0.1 인덱스는 `index.sqlite` 중심의 경량 graph/candidate evidence와 `index.jsonl` fallback으로 구성된다. 낮은 증거나 unknown은 `ctx_read`, `ctx_search`, targeted validation으로 확인해야 한다.

5. Resolver는 보수적이다. package dependency, relative import, exact endpoint candidate, test link를 주로 다루며 OpenAPI/gRPC/GraphQL/Kafka/Redis/DB semantic extraction은 제공하지 않는다.

## 7. 안전 원칙 요약

1. 증거 없는 요약은 ground truth가 아니다. 중요한 판단에는 ref, symbol, contract, tool output 같은 근거가 필요하다.

2. read-only 루트는 편집 대상으로 가정하지 않는다. 구현 전에는 루트 접근 권한을 확인한다.

3. 계약, DTO, schema, generated client, cache key, DB, topic 변경은 구현 전에 impact 분석을 거친다.

4. primary 에이전트는 조율을 맡고, 실제 구현은 준비된 컨텍스트와 영향 분석을 바탕으로 `ctx-builder`에 넘기는 흐름을 따른다.

5. 검증은 계획과 실행을 나눈다. `ctx-test-router`는 계획을 만들고, `ctx-validation-runner`는 승인된 범위를 실행하고 해석한다.
