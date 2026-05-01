# oh-my-opencode — OpenCode Plugin

**Generated:** 2026-05-01 | **Branch:** main

## OVERVIEW

`opencode-context-bridge` is an opencode plugin harness for multi-root software projects.

The goal is to let opencode agents understand multiple repositories, modules, and services as one workspace, then safely perform:

1. root discovery
2. indexing
3. evidence-based search
4. context packing
5. impact analysis
6. edit safety checks
7. validation planning

This project is not only an `/add-dir` replacement. It is a multi-root context orchestration layer for opencode.

## STRUCTURE

```
./src
├── agents
│   ├── agent-install.ts          # 에이전트 추가
│   └── agent-configs.ts          # 에이전트 프롬프트 정의
├── bootstrap
│   └── global-bootstrap.ts       # 초기 .opencode 디렉터리, commands, agents 설치
├── commands
│   └── command-configs.ts        # slash command 정의
├── cli.ts                        # ctx index, ctx doctor 같은 CLI 진입점
├── config.ts                     # 플러그인 설정, 기본 경로, 제외 패턴
├── create-hooks.ts               # hook 등록
├── create-managers.ts            # store, indexer, session manager 생성
├── create-tools.ts               # opencode custom tools 등록
├── hooks
│   ├── auto-router.ts            # prompt/command routing, ctx alias 처리
│   ├── compaction.ts             # session compaction context 주입
│   ├── events.ts                 # session/file/tool event ledger
│   ├── index.ts
│   ├── safety.ts                 # read/edit/bash safety gate
│   └── shell-env.ts              # CTX_* env 주입
├── index.ts                      # plugin entry
├── indexer
│   ├── extractors                # 언어/프로토콜별 정보 추출기
│   │   ├── http.ts               # [NEW] HTTP 요청/응답 스키마 추출
│   │   ├── openapi.ts            # [NEW] OpenAPI Spec 정의 추출
│   │   ├── package-py.ts         # [NEW] Python 패키지 의존성 추출
│   │   ├── package-ts.ts         # [NEW] TS/JS 패키지 의존성 추출
│   │   ├── python.ts             # [NEW] Python AST 분석 및 심볼 추출
│   │   └── typescript.ts         # [NEW] TS AST 분석 및 심볼 추출
│   ├── light-index.ts            # indexing pipeline orchestrator
│   ├── resolvers                 # 관계 및 참조 해결
│   │   ├── contract-registry.ts  # [NEW] 인터페이스/컨트랙트 레지스트리
│   │   ├── endpoint-resolver.ts  # [NEW] API 엔드포인트-코드 연결
│   │   ├── import-resolver.ts    # [NEW] 모듈 임포트 경로 해석
│   │   └── test-resolver.ts      # [NEW] 코드-테스트 파일 매핑
│   └── scan                      # root scanner, file classifier
├── install
│   └── global-config.ts          # opencode.json, commands, agents 설치/갱신
├── plugin-interface.ts
├── shared
│   ├── log.ts
│   └── path.ts
├── state
│   ├── artifact-writer.ts        # [NEW] 생성된 산출물(docs 등) 파일 기록
│   ├── session-state.ts          # 세션별 active task, touched refs, pending checks
│   ├── sqlite-store.ts           # [NEW] 대규모 인덱스 및 메타데이터 DB
│   └── workspace-store.ts        # .opencode/context-bridge/workspace.yaml 관리
├── tools
│   ├── context-tools.ts          # ctx_* tool 구현
│   └── index.ts
└── types.ts
```

## Expected MVP Scope

Required MVP features:

Do not implement advanced microservice graph features before the MVP is stable.

Out of MVP scope:

```text
- full OpenAPI impact analysis
- gRPC
- GraphQL
- Kafka or Pub/Sub
- Redis cache graph
- DB migration graph
- Kubernetes or Backstage ingestion
- automatic cross-root edit workflow
```

## Repository Structure

Use a single plugin repository with internal modules.

```text
opencode-context-bridge/
  package.json
  README.md
  AGENT.md

  src/
    index.ts

    plugin/
      tools/
      hooks/
      commands/
      agents/

    core/
      workspace/
      graph/
      contracts/
      memory/
      packs/
      policy/

    indexer/
      cli.ts
      scan/
      extractors/
      resolvers/
      writers/
      diagnostics/

    rules/
      ast-grep/

  agents/
    workspace-architect.md
    context-curator.md
    impact-analyst.md
    test-router.md

  commands/
    ctx-init.md
    ctx-add-dir.md
    ctx-list.md
    ctx-index.md
    ctx-search.md
    ctx-read.md
    ctx-pack.md
    ctx-doctor.md

  fixtures/
    ts-basic/
    ts-workspace/
    ts-shared-dto/

  docs/
    architecture.md
    parser-design.md
    graph-schema.md
```

Keep `src/index.ts` as the plugin entry point only. Do not put business logic there.

## Design Rules

Follow these rules when editing this project.

```text
- Use Bun.
- Use TypeScript strict mode.
- Use Zod for runtime validation.
- Use kebab-case file and directory names.
- Prefer small modules with clear responsibility.
- Prefer factory functions named createXxx.
- Keep parser, resolver, policy, and opencode integration separated.
- Store durable state under .opencode/context-bridge.
- Treat Semantic Memory as derived data, not source of truth.
- Evidence Graph is the source of truth for extracted facts.
```

## Evidence First

All analysis should be evidence-backed.

When generating a context pack, impact report, or review, prefer this structure:

```text
Conclusion
Evidence
Unknowns
Risks
Suggested next steps
```

Do not claim a cross-root relationship unless it is backed by extracted evidence or clearly marked as low-confidence.

Good:

```text
frontend imports OrderDto from @acme/shared-types.
Evidence: frontend:src/api/orders.ts#L3, shared:package.json
```

Bad:

```text
The frontend probably uses the shared DTO.
```

## Parser Rules

The parser is a deterministic evidence extractor.

It should extract facts such as:

```text
- file defines symbol
- file imports package
- package exposes module
- root depends on package
- test file likely covers source file
```

The parser should not generate natural-language summaries. Summaries belong to the memory layer and must be anchored to evidence.

MVP extractor priority:

```text
1. file scanner
2. package.json extractor
3. pnpm workspace extractor
4. tsconfig paths extractor
5. TypeScript import/export extractor
6. TypeScript symbol extractor
7. test file heuristic extractor
```

Use `ripgrep` fallback when AST extraction is unavailable or fails.

## Root Access Policy

Default root policy:

```text
primary root: rw
added root: ro
added root with --rw: rw
```

Editing a read-only root must be blocked.

Contract-like files should require impact analysis before edit:

```text
**/openapi*.yaml
**/*.proto
**/schema.graphql
**/schema.prisma
**/migrations/**
**/contracts/**
**/generated/**
```

Secret-like files must not be read or edited:

```text
**/.env
**/.env.*
**/secrets/**
**/*secret*
**/*credential*
```

## Tool Guidelines

Implement tools as thin wrappers around core modules.

Required MVP tools:

```text
ctx_init
ctx_add_dir
ctx_list_roots
ctx_index
ctx_search
ctx_read
ctx_pack
ctx_doctor
```

Tool output must be concise and agent-readable.

Prefer root alias paths:

```text
backend:src/routes/orders.ts
shared:src/types/order.ts
frontend:src/api/orders.ts
```

Avoid absolute paths in user-facing output unless needed for debugging.

## Hook Guidelines

MVP hooks should be minimal.

Required behavior:

```text
tool.execute.before
  - block read-only root edits
  - block secret file access
  - warn or block contract-like file edits without impact analysis

tool.execute.after
  - mark edited files as stale
  - append validation or diagnostic logs when relevant

session.compacted
  - preserve active roots
  - preserve current task
  - preserve touched files
  - preserve pending validations
```

Do not add complex automation before the basic workspace flow is reliable.

## Agent Guidelines

MVP agents:

```text
workspace-architect
  - read-only
  - understands root structure and package layout

context-curator
  - read-only
  - creates task-specific context packs

impact-analyst
  - read-only
  - finds affected roots, files, contracts, and tests

test-router
  - read-only by default
  - suggests targeted test commands
```

Agents should not directly edit files unless explicitly assigned to a future builder role.

## Development Workflow

For implementation tasks, follow this order:

```text
1. Update or add schema types.
2. Implement core logic.
3. Add tool wrapper.
4. Add command prompt if needed.
5. Add tests.
6. Update docs only if behavior changed.
```

For parser work:

```text
1. Add fixture.
2. Add extractor.
3. Add resolver if cross-file linking is needed.
4. Store evidence in SQLite.
5. Add search/read output tests.
```

For policy work:

```text
1. Add policy rule.
2. Add unit tests.
3. Add hook integration.
4. Verify blocked and allowed cases.
```

## Commands

Use Bun commands.

```bash
bun install
bun test
bun run typecheck
bun run build
```

Add project-specific scripts as they become available, but do not assume npm or yarn.

## Anti-Patterns

Avoid the following:

```text
- putting business logic in src/index.ts
- creating catch-all files like utils.ts or helpers.ts
- using as any
- suppressing TypeScript errors
- treating summaries as facts
- editing read-only roots
- silently ignoring parser failures
- blocking the whole index because one file failed
- generating large context dumps instead of focused context packs
- adding v0.2 or v0.3 features before MVP stability
```

## Definition of Done for MVP

The MVP is done when the following scenario works:

```text
1. User runs /ctx:init.
2. User adds frontend, backend, and shared roots.
3. User runs /ctx:index --all.
4. User searches for a shared TypeScript type.
5. User reads a file by root alias path.
6. User generates a context pack for a DTO change.
7. The context pack lists relevant roots, files, symbols, risks, and next steps.
8. Editing a read-only root is blocked.
9. Active roots and current task survive session compaction.
```
