# opencode-context-bridge

`opencode-context-bridge`는 OpenCode에서 여러 저장소와 여러 디렉터리 루트를 하나의 작업 컨텍스트로 다루기 위한 다중 루트 컨텍스트 브리지입니다.

- 패키지명: `opencode-context-bridge`
- 현재 버전: `0.1.0-draft.2`
- 패키지 상태: private package
- CLI 바이너리: `context-bridge` → `./dist/cli.js`
- 플러그인 export: `dist/index.js`

## 무엇을 해결하나

대부분의 실제 작업은 하나의 파일이나 하나의 저장소 안에서 끝나지 않습니다. 프론트엔드, 백엔드, 공유 타입, 문서, 마이그레이션, 테스트가 서로 다른 루트에 나뉘어 있으면 모델은 쉽게 관련 파일을 놓치거나 오래된 컨텍스트에 의존합니다.

Context Bridge는 다음을 목표로 합니다.

- 여러 루트를 OpenCode 작업 공간에 명시적으로 등록합니다.
- `backend:src/routes/orders.ts` 같은 루트 별칭 기반 참조로 파일을 다룹니다.
- 파일, 패키지, 심볼, 라우트, 계약 파일, 테스트 파일을 경량 인덱스로 기록합니다.
- 교차 루트 작업 전에 관련 증거를 모아 컨텍스트 팩을 만듭니다.
- DTO/API/schema/cache/topic/DB 같은 경계 변경 전에 영향 범위 힌트를 제공합니다.
- 읽기 전용 루트, secret-like 경로, 계약성 파일 편집을 더 조심스럽게 다룹니다.

## 현재 구현된 주요 기능

현재 구현은 V0.1 수준의 경량 다중 루트 컨텍스트 시스템입니다.

- **다중 루트 매니페스트**
  - 상태 파일: `.opencode/context-bridge/workspace.json`
  - 기본 루트 `primary`는 `rw`로 초기화됩니다.
  - 추가 루트는 기본적으로 `ro`입니다.

- **루트 별칭 참조**
  - 예: `shared:src/types/order.ts`
  - 루트 밖으로 벗어나는 unsafe ref는 거부됩니다.

- **경량 JSONL 증거 인덱스**
  - 상태 파일: `.opencode/context-bridge/index.jsonl`
  - 인덱스 종류: `file`, `package`, `symbol`, `route`, `contract`, `test`
  - 현재는 텍스트 기반 스캐너입니다. SQLite, tree-sitter, semantic memory, import resolver는 아직 구현되지 않았습니다.

- **검색과 읽기**
  - 인덱스 기반 검색
  - `root:path` 참조 기반 파일 읽기
  - `maxReadBytes` 기반 출력 제한
  - secret-like 경로 읽기 차단

- **컨텍스트 팩**
  - 작업 설명을 기준으로 관련 인덱스 증거와 위험 힌트를 묶습니다.
  - 생성된 팩은 `.opencode/context-bridge/packs/` 아래에 저장됩니다.

- **경량 영향도 힌트**
  - DTO, API, schema, cache, DB 등 변경 키워드를 바탕으로 위험 힌트를 제공합니다.
  - 구조적 API 그래프 분석은 로드맵 항목입니다.

- **안전 hook**
  - secret-like 경로 읽기/편집 차단
  - `ro` 루트 편집 차단
  - 계약성 파일 편집 경고 또는 차단
  - 편집된 루트 stale 처리

- **자동 라우팅 힌트**
  - 사용자 메시지에서 workspace, contract, impact, test, debug 성격을 감지합니다.
  - 적절한 Context Bridge 하위 에이전트 사용을 시스템 컨텍스트에 주입합니다.

- **세션/압축 유지 정보**
  - 작업 ledger: `.opencode/context-bridge/task-history.jsonl`
  - compaction 시 workspace 요약, touched refs, 최근 ledger를 컨텍스트에 보존합니다.

- **셸 환경 변수 주입**
  - `CTX_BRIDGE_STATE_DIR`
  - `CTX_BRIDGE_MANIFEST`
  - `CTX_BRIDGE_INDEX`

## 사용 가능한 에이전트

### `ctx-orchestrator`

기본 primary 에이전트입니다. 다중 루트 작업, 교차 저장소 변경, DTO/API/schema 경계 작업에서 Context Bridge Tools와 하위 에이전트를 사용하도록 조율합니다.

기본 이름은 `ctx-orchestrator`이며, `defaultAgentName` 옵션으로 바꿀 수 있습니다.

### 숨겨진 하위 에이전트

아래 에이전트는 숨겨진 subagent로 주입됩니다.

| 에이전트 | 역할 |
| --- | --- |
| `ctx-workspace-architect` | 루트, 패키지, 모듈, 서비스 경계 파악 |
| `ctx-context-curator` | 작업에 필요한 최소 증거 기반 컨텍스트 팩 구성 |
| `ctx-impact-analyst` | DTO/API/schema/cache/topic/DB 변경 영향 분석 |
| `ctx-test-router` | 변경 범위에 맞는 테스트와 빌드 체크 선택 |

## 사용 가능한 Commands

### OpenCode runtime Commands

현재 플러그인이 OpenCode config hook을 통해 주입하는 runtime Command는 다음 3개입니다. 이 Command들은 `/`로 시작하는 slash command가 아닙니다.

| Command | 설명 |
| --- | --- |
| `ctx-list` | 등록된 Context Bridge 루트 목록 확인 |
| `ctx-pack` | 작업 설명 기반 컨텍스트 팩 생성 |
| `ctx-impact` | 교차 루트 또는 계약 변경 영향도 확인 |

> 주의: `/ctx:add-dir`, `/ctx:read`, `/ctx:index` 같은 slash command 세트는 설계 문서에 있는 로드맵 성격의 UX이며, 현재 구현된 runtime Command가 아닙니다. 현재 실제로 구현된 인터페이스는 위 runtime Commands와 아래 `ctx_*` OpenCode Tools입니다.

### CLI Commands

패키지가 전역으로 설치되었거나 `bun link` 등으로 bin이 PATH에 연결된 경우 `context-bridge` 바이너리를 사용할 수 있습니다.

```bash
context-bridge install
context-bridge install --keep-default-agent
context-bridge install --no-default-agent
context-bridge doctor
```

| Command | 설명 |
| --- | --- |
| `context-bridge install` | OpenCode 전역 설정에 플러그인을 등록하고 기본 에이전트를 설정합니다. |
| `context-bridge install --keep-default-agent` | 기존 `default_agent`가 있으면 덮어쓰지 않습니다. |
| `context-bridge install --no-default-agent` | 플러그인만 등록하고 `default_agent`는 설정하지 않습니다. |
| `context-bridge doctor` | 설정 경로를 출력하고 플러그인 등록/agent stub 생성을 보조합니다. 현재 구현은 순수 read-only 점검이 아닙니다. |

## 사용 가능한 OpenCode Tools

현재 구현된 OpenCode Tool은 다음과 같습니다. `ctx_*` 항목은 모델이 호출하는 plugin Tool이며, `/ctx:*` 형태의 slash command가 아닙니다.

| Tool | 설명 |
| --- | --- |
| `ctx_install_agents` | Context Bridge 글로벌 bootstrap을 수동 재실행합니다. |
| `ctx_add_dir` | 외부 디렉터리나 저장소를 루트로 등록합니다. |
| `ctx_list_roots` | 활성 루트, 별칭, 접근 권한, 인덱스 상태를 표시합니다. |
| `ctx_index` | 하나의 루트 또는 모든 루트의 경량 증거 인덱스를 갱신합니다. |
| `ctx_search` | 다중 루트 인덱스를 검색합니다. |
| `ctx_read` | `root:path` 참조로 파일을 읽습니다. |
| `ctx_pack` | 작업별 컨텍스트 팩을 생성합니다. |
| `ctx_impact` | 대상 ref, 심볼, DTO, API, 검색어의 경량 영향도 힌트를 생성합니다. |

### `ctx_add_dir` Tool 인자

`ctx_add_dir`는 다음 인자를 받습니다.

| 인자 | 설명 |
| --- | --- |
| `path` | 현재 OpenCode 디렉터리 기준 상대 경로 또는 절대 경로 |
| `name` | 안정적인 루트 별칭 |
| `access` | `ro` 또는 `rw` |
| `role` | `primary`, `app`, `service`, `library`, `tooling`, `docs`, `unknown` |
| `tags` | 선택 태그 목록 |

## 설치

이 패키지는 private package이며, CLI bin은 `./dist/cli.js`를 가리킵니다. `dist`가 없는 로컬 clone에서는 먼저 빌드해야 합니다.

```bash
bun install
bun run build
```

빌드 후 로컬 clone에서 바로 실행할 때는 built CLI 파일을 직접 실행합니다.

```bash
bun run dist/cli.js install
bun run dist/cli.js install --keep-default-agent
bun run dist/cli.js install --no-default-agent
bun run dist/cli.js doctor
```

`context-bridge` 명령을 직접 쓰려면 패키지 bin을 PATH에 연결해야 합니다. 예를 들어 clone 안에서 다음을 실행합니다.

```bash
bun link
```

그 다음 전역 OpenCode 설정을 패치할 수 있습니다.

```bash
context-bridge install
```

기존 기본 에이전트를 유지하려면 다음을 사용합니다.

```bash
context-bridge install --keep-default-agent
```

기본 에이전트를 설정하지 않으려면 다음을 사용합니다.

```bash
context-bridge install --no-default-agent
```

설정 경로와 등록 보조 동작은 다음으로 확인합니다.

```bash
context-bridge doctor
```

`doctor`는 이름과 달리 완전한 read-only 점검이 아닙니다. 현재 구현은 설치 로직을 호출하므로 플러그인 등록이나 agent stub 생성으로 설정 파일을 변경할 수 있습니다.

설치 후 OpenCode를 재시작해야 새 플러그인과 에이전트 설정이 반영됩니다.

## 설정

플러그인은 OpenCode plugin options로 설정할 수 있습니다.

```jsonc
{
  "plugin": [
    ["opencode-context-bridge", {
      "stateDir": ".opencode/context-bridge",
      "defaultAccess": "ro",
      "autoAgents": true,
      "autoDefaultAgent": true,
      "autoIndex": true,
      "defaultAgentName": "ctx-orchestrator"
    }]
  ]
}
```

### 주요 옵션

| 옵션 | 설명 |
| --- | --- |
| `stateDir` | Context Bridge 상태 파일 디렉터리 |
| `defaultAccess` | 새로 추가하는 루트의 기본 접근 권한, 기본값 `ro` |
| `autoAgents` | 런타임 config hook으로 Context Bridge 에이전트를 주입 |
| `autoDefaultAgent` | `ctx-orchestrator`를 기본 에이전트로 설정 |
| `globalBootstrap` | 플러그인 시작 시 글로벌 bootstrap 실행 |
| `globalInstallAgents` | 글로벌 agent markdown 파일 작성 |
| `globalSetDefaultAgent` | 글로벌 OpenCode 설정의 `default_agent` 패치 |
| `globalRegisterPlugin` | 글로벌 OpenCode 설정의 plugin 목록에 패키지 등록 |
| `globalPluginName` | 글로벌 등록에 사용할 플러그인 이름 |
| `defaultAgentName` | primary 에이전트 이름 |
| `autoIndex` | 시작 시 stale 또는 미인덱스 루트 자동 인덱싱 |
| `commandPrefix` | 스키마에 존재하는 옵션입니다. 현재 runtime Command 이름은 `ctx-list`, `ctx-pack`, `ctx-impact`로 하드코딩되어 있으며 `/`로 시작하는 slash command를 생성하지 않습니다. |
| `maxSearchResults` | 검색 결과 기본 제한 |
| `maxReadBytes` | 파일 읽기 최대 바이트 |
| `secretGlobs` | secret-like 경로 차단 패턴 |
| `contractGlobs` | 계약성 파일 패턴 |
| `enforceImpactBeforeContractEdit` | 계약성 파일 편집 전 영향도 확인 강제 여부 |
| `roots` | 시작 시 등록할 루트 목록 |

### 기본값에서 주의할 점

소스 기준 기본값은 다음과 같습니다.

```json
{
  "defaultAccess": "ro",
  "autoAgents": true,
  "autoDefaultAgent": true,
  "autoIndex": true,
  "defaultAgentName": "ctx-orchestrator",
  "globalBootstrap": false,
  "globalInstallAgents": false,
  "globalSetDefaultAgent": false,
  "globalRegisterPlugin": false
}
```

즉 글로벌 설정 파일 쓰기는 기본적으로 꺼져 있습니다. 전역 설정 패치가 필요하면 CLI `context-bridge install`을 사용하거나 관련 옵션을 명시적으로 켜야 합니다.

## 사용 예시

### 1. 루트 등록

OpenCode에서 `ctx_add_dir` Tool을 호출해 루트를 등록합니다.

예시 개념:

```text
path: ../backend
name: backend
access: rw
role: service
tags: ["api"]
```

읽기 전용 공유 타입 저장소는 다음처럼 등록할 수 있습니다.

```text
path: ../shared
name: shared
access: ro
role: library
tags: ["types"]
```

### 2. 루트 목록 확인

runtime Command:

```text
ctx-list
```

또는 Tool:

```text
ctx_list_roots
```

### 3. 인덱스 갱신

모든 루트를 갱신하려면 `ctx_index` Tool을 사용합니다.

특정 루트만 갱신할 수도 있습니다.

```text
root: backend
```

### 4. 검색

`ctx_search` Tool로 다중 루트 인덱스를 검색합니다.

예시 검색어:

```text
OrderDto
POST /orders
schema.prisma
```

### 5. 루트 참조로 파일 읽기

`ctx_read` Tool은 `root:path` 형식의 ref를 받습니다.

```text
shared:src/types/order.ts
backend:src/routes/orders.ts
```

필요하면 `startLine`, `endLine`으로 범위를 제한합니다.

### 6. 작업 컨텍스트 팩 생성

runtime Command:

```text
ctx-pack Add billingAddress to OrderDto
```

또는 `ctx_pack` Tool에 작업 설명을 전달합니다.

```text
task: Add billingAddress to OrderDto
roots: ["shared", "backend", "frontend"]
```

### 7. 영향도 힌트 확인

runtime Command:

```text
ctx-impact OrderDto
```

또는 `ctx_impact` Tool을 사용합니다.

```text
target: shared:src/types/order.ts
```

## 개발 워크플로

### 의존성 설치

```bash
bun install
```

### 타입 검사

```bash
bun run typecheck
```

### 빌드

```bash
bun run build
```

### 정리

```bash
bun run clean
```

### 로컬 확인 순서

```bash
bun install
bun run typecheck
bun run build
bun run dist/cli.js doctor
```

`context-bridge`는 `dist/cli.js`를 사용하므로 CLI를 확인하기 전에 빌드가 필요합니다. 로컬 clone에서 `context-bridge` 명령을 직접 쓰려면 `bun link` 등으로 bin을 PATH에 연결하세요.

## 개발 계획

아래 항목은 현재 구현이 아니라 계획입니다.

### v0.2 — REST/API graph + contract registry

- 프론트엔드 client call과 백엔드 route handler 연결
- OpenAPI operation/schema 추출
- REST endpoint resolver
- 초기 Contract Boundary Registry
- 더 정식화된 impact report
- contract-reviewer, service-boundary-analyst 계열 에이전트

### v0.3 — microservice graph

- gRPC/proto 추출
- GraphQL schema/query/resolver 추출
- Kafka/PubSub/RabbitMQ topic 추출
- Redis/cache key 패턴 추출
- Prisma/SQL migration 분석
- docker-compose, Kubernetes, Helm, Backstage metadata 기반 service map
- validation-runner, security-boundary-auditor 계열 에이전트

### v0.4 — workflow automation

- change/debug/contract-change/review 워크플로 자동화
- 승인 기반 multi-root edit flow
- targeted validation 실행과 결과 기록
- evidence-backed final report
- verifier 분리와 평가 harness

## 현재 한계와 주의사항

- 현재 인덱서는 JSONL 기반 경량 텍스트 스캐너입니다.
- SQLite, tree-sitter, ast-grep 기반 그래프, semantic memory, import resolution은 아직 구현되지 않았습니다.
- CLI는 현재 `install`과 `doctor`만 구현되어 있습니다.
- OpenCode runtime Command는 현재 `ctx-list`, `ctx-pack`, `ctx-impact`만 주입됩니다. `/ctx:*` slash command는 현재 제공하지 않습니다.
- 숨겨진 하위 에이전트는 사용자 직접 진입점이라기보다 자동 라우팅과 내부 작업 조율을 위한 구성입니다.
- safety hook은 실수 방지 장치이지 완전한 보안 경계가 아닙니다.
- `context-bridge doctor`도 내부적으로 설치 로직을 호출하므로 설정 파일이 변경될 수 있습니다.
- `dist`가 없는 환경에서는 CLI가 동작하지 않을 수 있습니다. 먼저 `bun run build`를 실행하세요.
