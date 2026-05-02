# Plugin Test Scenarios

이 문서는 `opencode-context-bridge` 플러그인을 수동 또는 자동으로 검증할 때 사용할 3개의 기본 시나리오를 정리한다. 각 시나리오는 현재 V0.1 구현이 제공하는 실제 인터페이스만 사용한다.

## 실행 방법

```bash
bun test
bun test tests/workspace-store.test.ts
bun test tests/ctx-tools.integration.test.ts
bun test tests/impact.shared-interface.test.ts
```

전체 타입/빌드 확인은 다음 순서로 실행한다.

```bash
bun run typecheck
bun run build
bun test
```

## 시나리오 1. 워크스페이스 매니페스트와 정책 검증

목표는 `WorkspaceStore`가 다중 루트 상태의 기본 단일 출처로 동작하는지 확인하는 것이다.

- 테스트 파일: `tests/workspace-store.test.ts`
- 주요 코드: `src/state/workspace-store.ts`, `src/types.ts`, `src/shared/path.ts`
- setup: 임시 primary 루트와 shared 루트를 만들고, shared 루트에 `src/types/order.ts`와 `.env`를 둔다.
- action: `WorkspaceStore.init()`, `addRoot()`, `resolveRef()`, `isSecretPath()`, `isContractPath()`, `markIndexed()`를 호출한다.
- expected: `shared:src/types/order.ts`가 루트 내부 절대 경로로 해석되고, `shared:../outside.ts`는 거부된다. `.env`는 secret-like path로 감지되고, `src/types/order.ts`는 테스트 정책에서 contract-like path로 감지된다. 인덱싱 상태와 ledger도 갱신된다.

이 시나리오는 플러그인의 기본 저장소 상태가 안전하게 만들어지고 루트 별칭이 루트 밖 경로를 허용하지 않는지 확인한다.

## 시나리오 2. `ctx_*` 도구 통합 검증

목표는 OpenCode tool surface에서 루트 추가, 자동 인덱싱, 검색, ref 읽기, 테스트 계획 제안이 이어지는지 확인하는 것이다.

- 테스트 파일: `tests/ctx-tools.integration.test.ts`
- 주요 코드: `src/tools/context-tools.ts`, `src/indexer/light-index.ts`, `src/state/workspace-store.ts`
- setup: 임시 backend 루트에 `package.json`, `src/routes/orders.ts`, `tests/orders.test.ts`를 만든다.
- action: `ctx_add_dir`로 backend를 등록하고, `ctx_search`, `ctx_read`, `ctx_test_plan`을 호출한다.
- expected: `autoIndex`가 켜져 있으면 backend 루트가 즉시 인덱싱된다. 인덱스에는 `package`, `symbol`, `route`, `test` 엔트리가 생긴다. `ctx_search`는 `OrderDto` evidence를 반환하고, `ctx_read`는 지정 라인만 반환한다. `ctx_test_plan`은 `bun test tests/orders.test.ts`처럼 좁은 검증 명령을 제안한다.

이 시나리오는 모델이 raw filesystem 탐색 대신 Context Bridge 도구로 멀티 루트 evidence를 수집할 수 있는지 확인한다.

## 시나리오 3. 공유 인터페이스 변경 영향 검증

목표는 여러 작업영역이 공유하는 DTO/interface를 수정해야 할 때, 플러그인이 관련 루트와 위험 힌트를 찾아내는지 확인하는 것이다.

- 테스트 파일: `tests/impact.shared-interface.test.ts`
- 픽스처: `fixtures/ts-shared-dto/`
- 주요 코드: `src/tools/context-tools.ts`, `src/indexer/light-index.ts`
- setup: primary 작업영역 밖의 외부 fixture 디렉터리에 `shared`, `backend`, `frontend` 세 루트를 만들고 등록한다. `shared`는 `OrderDto`를 정의하고, `backend`와 `frontend`는 같은 타입을 import해서 사용한다.
- action: read-only `shared` 루트의 DTO 파일을 편집하려는 도구 호출이 safety hook에서 차단되는지 확인한다. 그 다음 승인된 외부 변경을 시뮬레이션해 `OrderPatch.billingAddress`를 추가하고 stale 상태로 표시한 뒤, `ctx_impact`, `ctx_read`, `ctx_pack`을 호출한다.
- expected: read-only 루트 직접 편집은 거부된다. 이후 impact 호출은 stale shared 루트를 다시 인덱싱하고, 결과 roots에는 `shared`, `backend`, `frontend`가 모두 포함된다. risks에는 `shared DTO/schema change; check all consumers`가 포함된다. `ctx_read`는 변경된 shared DTO 내용을 확인하고, context pack은 `.opencode/context-bridge-test/packs/` 아래에 저장된다.

이 시나리오는 "공유 인터페이스 수정 → read-only/edit gate 확인 → provider/consumer evidence 확인 → impact gate → 테스트 라우팅" 흐름의 출발점을 자동화한다. V0.1은 import graph나 LSP 기반 분석이 아니라 경량 텍스트 evidence를 사용하므로, 결과는 direct proof가 아니라 후보 영향 범위로 해석해야 한다.

## 산출물 위치

- `docs/plugin-test-scenarios.md`: 사람이 읽는 시나리오 설명
- `tests/`: Bun 기반 starter tests
- `tests/utils/plugin-test-utils.ts`: OpenCode 런타임 없이 store/tool을 호출하기 위한 테스트 헬퍼
- `fixtures/ts-shared-dto/`: 공유 DTO가 frontend/backend/shared 루트에 걸쳐 쓰이는 최소 예제

