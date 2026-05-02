# opencode-workspace-bridge-plugin

OpenCode 플러그인으로, 여러 디렉터리, 리포지토리, 모듈을 하나의 OpenCode 세션에 등록하고 다중 루트 컨텍스트 오케스트레이션 레이어를 제공한다. 워크스페이스 매니페스트, Basic Indexer V0.1, 안전성 훅, context pack, 영향 후보 분석, 자동 라우팅을 묶어 멀티 리포 작업을 지원한다.

---

## 1. 해결하려는 문제

OpenCode 자체는 시작 디렉터리 안의 read/edit/search 도구, `external_directory` 권한, 플러그인 SDK와 이벤트 훅을 제공한다. 하지만 멀티 리포 환경에서는 다음 운영 상태가 쉽게 사라진다.

1. 외부 디렉터리를 stable alias가 있는 workspace root로 다루는 상태.
2. 루트별 read-only/read-write 정책.
3. 여러 루트의 파일, 심볼, route 후보, package, test 후보를 함께 보는 evidence index.
4. 세션 compaction 뒤에도 복구 가능한 manifest, ledger, touched refs.
5. secret-like 경로, read-only root, contract file 편집에 대한 일관된 안전 게이트.

Context Bridge는 이 상태를 `.opencode/context-bridge/` 아래에 path-addressable하게 보존하고, `ctx_*` 도구로 접근하게 한다.

---

## 2. 목표

- `ctx_add_dir`로 외부 디렉터리를 workspace root에 등록한다.
- `backend:src/routes/orders.ts` 같은 `root:relPath` ref를 public 표기로 사용한다.
- `index.sqlite`를 primary store로 파일, package, symbol, route 후보, test 후보, 보수적 graph evidence를 저장한다.
- `index.jsonl`은 `readEntries()`, `searchIndex()`, degraded tool path를 위한 legacy fallback으로 유지한다.
- `ctx_pack`, `ctx_impact`, `ctx_neighbors`, `ctx_test_plan`이 SQLite-backed evidence와 JSONL fallback을 사용한다.
- safety hook이 secret-like path, read-only root, contract file 정책을 적용한다.
- compaction hook이 workspace summary, touched refs, 최근 ledger를 이어 준다.
- CLI와 글로벌 bootstrap이 OpenCode 설정과 agent stub 생성을 보조한다.

---

## 3. 런타임 개요

플러그인은 `opencode-context-bridge` 패키지이며 OpenCode가 로드할 때 `serverPlugin`을 호출한다. `PluginInput.directory`와 `PluginInput.worktree`를 기준으로 상태 디렉터리를 만든다.

흐름:

1. `serverPlugin(input, options)`가 호출된다.
2. `normalizeOptions`가 옵션을 정규화한다.
3. `globalBootstrap` 옵션이 켜져 있으면 글로벌 OpenCode 설정과 agent markdown을 갱신한다.
4. `createManagers`가 `WorkspaceStore`와 `SessionState`를 만든다.
5. `WorkspaceStore.init`이 `workspace.json`과 `primary` root를 준비하고, 옵션의 `roots`를 추가한다.
6. `autoIndex`가 켜져 있으면 stale 또는 미인덱스 root를 인덱싱한다. 실패해도 startup은 계속된다.
7. `createTools`가 `ctx_*` custom tools를 만든다.
8. `createHooks`가 event, shell env, auto-router, safety, compaction hook을 묶는다.
9. `createPluginInterface`가 hooks를 OpenCode SDK 형식으로 반환하고, config hook에서 agents와 commands를 주입한다.

디스크 상태에는 `workspace.json`, `index.sqlite`, `index.jsonl`, `task-history.jsonl`, `evidence/`, `diagnostics/`, `logs/`, `queue/`, `packs/`가 포함된다.

---

## 4. 기술 스택

- 런타임: Bun 기준. 패키지 bin은 `./dist/cli.js`이며 CLI는 빌드 산출물을 통해 실행된다.
- 언어: TypeScript, ES modules.
- 플러그인 SDK: `@opencode-ai/plugin`.
- 스키마와 검증: `zod`.
- SQLite store: `bun:sqlite`, 파일명 `index.sqlite`.
- SQLite diagnostics: WAL 시도, busy timeout, schema version check, degraded result.
- JSONC 편집: `jsonc-parser`.
- Legacy fallback: `index.jsonl`.
- Debug export: `evidence/nodes.jsonl`, `evidence/edges.jsonl`, `evidence/spans.jsonl`, `diagnostics/indexer.jsonl`, `logs/index-runs.jsonl`.

tree-sitter, ts-morph, LSP 기반 reference resolution, durable semantic memory, embeddings는 V0.1에 포함되지 않는다.

---

## 5. 소스 트리

현재 주요 구조는 다음과 같다.

```
src/
├── agents/
│   └── agent-configs.ts
├── bootstrap/
│   └── global-bootstrap.ts
├── cli.ts
├── config.ts
├── create-hooks.ts
├── create-managers.ts
├── create-tools.ts
├── hooks/
│   ├── auto-router.ts
│   ├── compaction.ts
│   ├── events.ts
│   ├── safety.ts
│   └── shell-env.ts
├── index.ts
├── indexer/
│   ├── extractors/
│   ├── index-runner.ts
│   ├── light-index.ts
│   ├── resolver.ts
│   ├── scanner.ts
│   ├── schema.ts
│   └── sqlite-store.ts
├── install/
│   └── global-config.ts
├── plugin-interface.ts
├── shared/
│   ├── log.ts
│   └── path.ts
├── state/
│   ├── session-state.ts
│   └── workspace-store.ts
├── tools/
│   ├── context-tools.ts
│   └── index.ts
└── types.ts
```

책임 분리:

- `WorkspaceStore`는 manifest, ledger, state paths, ref resolution을 담당한다.
- `scanner.ts`는 deterministic 파일 목록, hash, language, generated 여부를 만든다.
- `index-runner.ts`는 SQLite index run, extractor 실행, resolver 재계산, debug export를 조율한다.
- `light-index.ts`는 legacy public API와 `index.jsonl` compatibility를 유지한다.
- `sqlite-store.ts`는 `bun:sqlite` storage, schema bootstrap, diagnostics, snapshot read를 담당한다.
- `resolver.ts`는 conservative graph edge와 unresolved record를 만든다.
- `context-tools.ts`는 SQLite snapshot 우선 도구 응답과 JSONL fallback을 구현한다.

---

## 6. 세부 구성

### 6.1 옵션과 기본값

주요 옵션:

- `stateDir`: 기본 `.opencode/context-bridge`.
- `defaultAccess`: 새 root의 기본 access, 기본 `ro`.
- `autoAgents`: config hook에서 agents와 commands를 주입.
- `autoDefaultAgent`, `defaultAgentName`: 기본 primary agent 지정.
- `globalBootstrap`, `globalInstallAgents`, `globalSetDefaultAgent`, `globalRegisterPlugin`, `globalPluginName`: 글로벌 설정 보조.
- `autoIndex`: startup과 도구 호출 시 stale root 자동 인덱싱.
- `maxSearchResults`, `maxReadBytes`: 응답 크기 제한.
- `secretGlobs`, `contractGlobs`, `enforceImpactBeforeContractEdit`: safety policy.
- `roots`: 플러그인 로드 시 자동 추가할 외부 root.

### 6.2 Workspace manifest

`workspace.json`은 다음 정보를 보관한다.

- `primary`: 현재 worktree 또는 directory.
- `roots`: 모든 root alias, path, absPath, access, role, tags, indexedAt, stale.
- `policies`: secret, contract, impact gate 정책.

새 root는 stale 상태로 시작한다. 편집 event와 tool after hook도 root/file을 stale로 표시한다.

### 6.3 Basic Indexer V0.1

V0.1 인덱서는 SQLite primary, JSONL fallback 구조다.

스캔:

- 정렬된 파일 순회.
- `.git`, `.opencode`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `target`, `__pycache__`, `.venv`, `venv` 제외.
- 파일별 sha256 hash, size, language, generated 여부 저장.

추출:

- TS/JS extractor.
- package metadata extractor.
- Python source/metadata extractor.
- contract/test 후보의 legacy entry 유지.

저장:

- `index.sqlite`에 roots, files, nodes, edges, spans, unresolved, index_runs 저장.
- `index.jsonl`에 legacy `IndexEntry` 저장.
- `evidence/*.jsonl`, `diagnostics/indexer.jsonl`, `logs/index-runs.jsonl`에 debug export 저장.

Resolver:

- 상대 import, package dependency, package import, 정확 endpoint 후보, test source 후보만 연결한다.
- 애매한 후보는 unresolved로 남긴다.

### 6.4 도구

구현된 주요 도구:

- `ctx_install_agents`
- `ctx_add_dir`
- `ctx_list_roots`
- `ctx_index`
- `ctx_search`
- `ctx_status`
- `ctx_symbols`
- `ctx_neighbors`
- `ctx_read`
- `ctx_pack`
- `ctx_test_plan`
- `ctx_refresh_memory`
- `ctx_impact`

도구 상세는 `docs/tools.md`에 있다. 중요한 공통점은 SQLite snapshot 우선, JSONL fallback, degraded diagnostics 노출이다.

### 6.5 Hooks

사용하는 OpenCode hook:

- `event`: session과 file edit 이벤트를 ledger와 stale 처리에 사용.
- `shell.env`: `CTX_BRIDGE_STATE_DIR`, `CTX_BRIDGE_MANIFEST`, `CTX_BRIDGE_INDEX` 주입.
- `chat.message`와 system transform: 자동 라우팅 힌트 주입.
- `tool.execute.before`: secret, read-only, contract gate.
- `tool.execute.after`: touched ref 기록, stale marking, reindex queue 호환 흐름.
- `experimental.session.compacting`: workspace summary, touched refs, recent ledger 보존.

Hook은 가능하면 OpenCode 본 흐름을 깨지 않도록 설계되어 있다. 의도적 차단이 필요한 safety case에서만 Error를 던진다.

### 6.6 Agents와 commands

`ctx-orchestrator`는 primary agent다. 숨겨진 subagent는 workspace, context curation, impact, test routing, validation, build, summary 역할을 나눈다.

에이전트와 command 기대치는 `docs/agents.md`를 따른다. V0.1에서 agent는 SQLite-backed evidence와 fallback 출력을 근거로 사용해야 하며, semantic memory가 있다고 가정하면 안 된다.

### 6.7 Global bootstrap과 CLI

글로벌 bootstrap은 옵션이 켜진 경우 `~/.config/opencode` 계열 설정과 agent markdown을 보조한다. CLI는 사용자가 직접 실행하는 경로다.

명령:

```bash
context-bridge install
context-bridge install --keep-default-agent
context-bridge install --no-default-agent
context-bridge doctor
```

`dist`가 없는 local clone에서는 먼저 빌드가 필요하다.

```bash
bun run build
```

### 6.8 Safety model

세 가지 gate가 있다.

1. Secret-like path 차단.
2. `access: "ro"` root 편집 차단.
3. Contract file 편집 경고 또는 옵션 기반 차단.

Safety hook은 실수 방지 장치이며 완전한 보안 경계가 아니다.

---

## 7. 현재 상태

현재 코드베이스는 Basic Indexer V0.1 구현을 포함한다.

구현된 항목:

- `workspace.json` 생성과 root 관리.
- SQLite primary index `index.sqlite`.
- Legacy fallback `index.jsonl`.
- deterministic scanner와 hash 기반 file records.
- TS/JS, package metadata, Python extractor.
- conservative resolver와 unresolved records.
- graph-aware `ctx_neighbors`, `ctx_pack`, `ctx_impact`, `ctx_test_plan`.
- SQLite missing, locked, corrupt, schema 문제에 대한 degraded fallback.
- debug artifacts: `evidence/*.jsonl`, `diagnostics/indexer.jsonl`, `logs/index-runs.jsonl`.
- stale marking, reindex queue 호환 흐름.
- safety hooks, auto-router, compaction 유지 정보.
- smoke harness `tests/indexer-v0-1.smoke.test.ts`.

범위 밖:

- OpenAPI/gRPC/GraphQL/Kafka/Redis/DB semantic extraction.
- Contract registry YAML 승격.
- LSP 기반 정밀 reference graph.
- durable semantic memory, embeddings.
- 테스트 자동 실행. `ctx_test_plan`은 계획만 만든다.

---

## 8. 운영 흐름 요약

전형적인 흐름:

1. 사용자는 `context-bridge install` 또는 프로젝트 설정으로 플러그인을 등록한다.
2. OpenCode 세션 시작 시 `workspace.json`과 `primary` root가 준비된다.
3. 사용자는 `ctx_add_dir`로 외부 root를 추가한다.
4. `autoIndex` 또는 `ctx_index`가 `index.sqlite`와 `index.jsonl`을 갱신한다.
5. `ctx_status`로 SQLite availability와 stale root를 확인한다.
6. `ctx_pack`, `ctx_search`, `ctx_symbols`, `ctx_neighbors`, `ctx_impact`로 evidence를 모은다.
7. 편집이 일어나면 safety hook이 정책을 적용하고, 성공한 편집은 stale/touched로 기록된다.
8. 검증 전에는 `ctx_test_plan`으로 후보 명령을 고른다. 실행은 별도 runner나 명시 명령이 담당한다.
9. 세션 compaction 시 workspace summary, touched refs, recent ledger가 continuation context에 들어간다.

---

## 9. 개발 검증

구현 smoke harness와 기본 검증 명령:

```bash
bun test tests/indexer-v0-1.smoke.test.ts
bun run test
bun run typecheck
bun run build
```

`package.json`의 `test` script는 `bun test tests/indexer-v0-1.smoke.test.ts`로 매핑된다.
