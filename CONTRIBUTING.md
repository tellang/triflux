# triflux 기여

triflux는 Claude Code · Codex · Antigravity 를 라우팅하는 CLI-first 멀티모델
오케스트레이터다. 이 문서는 코드/문서 기여의 진입점이다. 결정의 "왜"는
[`docs/adr/`](docs/adr/README.md), 문서 배치 규칙은 [`docs/README.md`](docs/README.md),
프로세스 상세는 [`docs/process/`](docs/process/) 에 있다.

## 빌드와 설치

- **Node 20+** 필요(`package.json` `engines.node = ">=20"`). 의존성 `better-sqlite3` 12.x 가
  Node 20 이상을 요구한다. CI 는 Node 20, 릴리즈 워크플로는 Node 24 로 돈다.
- 의존성 설치:

```bash
npm ci --ignore-scripts
```

빌드 스텝은 따로 없다. triflux는 `.mjs` 소스를 그대로 실행한다.

## 테스트와 린트

변경 후에는 아래를 통과시킨다.

| 명령 | 검사 대상 |
| --- | --- |
| `npm test` | 유닛/통합 테스트 (`node:test`) + `lint:skills` |
| `npm run lint` | biome `check` = **lint + format** |
| `npm run lint:skills` | 스킬 문서(`skills/**/SKILL.md`) 규약 |

Biome `check`는 lint와 format을 함께 검사한다. 자동 정리는 `npm run lint:fix`로 실행한다.

패키지 배포에 영향을 주는 변경(루트 런타임 파일 수정 등)은 미러/동기화
게이트도 함께 확인한다.

```bash
npm run release:check-sync
npm run release:check-mirror
```

문서 변경은 관련 문서 테스트와 미러·동기화 검사를 실행한다. 스킬 변경은 `lint:skills`도 실행한다. 전체 통합 테스트는
Hub 서버를 띄우므로 macOS 에서 `node` 의 localhost 포트 수신을 묻는 방화벽 창이 뜰 수 있다.
Hub·팀·MCP 흐름을 실제로 시험할 때만 허용하면 된다.

## 패키지 경계

triflux 를 고치거나 디버깅할 때 아래 표면을 섞지 않는다.

| 표면 | 정본 | npm·플러그인에 포함? |
| --- | --- | --- |
| 공개 CLI·런타임 | `bin/`, `scripts/`, `hub/`, `hooks/`, `hud/`, `cto/`, `skills/` | 예 |
| 게시용 미러 | `packages/triflux/`, `packages/core/`, `packages/remote/` | 예. 루트와 맞아야 한다 |
| Claude 플러그인 메타데이터 | `.claude-plugin/` | 예. npm 패키지 내용을 가리킨다 |
| 호스트 로컬 Codex 실험 | `~/.codex/skills/*` | 아니요 |

호스트 로컬 Codex 하네스가 추천하는 흐름은 그 머신에서만 통하는 조언이다. 패키지 계약은 위의
CLI, 스킬, 훅, Hub 표면이다. Codex 로컬 실험은 패키지 경계를 일부러 바꾸는 경우가 아니면
`~/.codex/skills` 에 둔다.

## 미러·릴리즈 점검

`packages/triflux` 는 여러 루트 런타임 디렉터리의 npm 게시용 미러다. 미러 대상 파일을 고쳤으면
같은 변경 안에서 함께 맞춘다. 레이어별 규칙(core 는 바이트 동일, remote 는 import 경로 변환,
triflux 는 npm `files` 기준 바이트 동일)은
[`.claude/rules/tfx-mirror-policy.md`](.claude/rules/tfx-mirror-policy.md) 가 정본이다.

패키지 내용에 영향을 주는 변경은 출시 전에 아래를 돌린다.

```bash
npm run lint:skills
npm run release:check-sync
npm run release:check-mirror
npm run lint
```

릴리즈는 `/tfx-ship` 으로 시작한다. 버전을 올린 커밋이 `main` 에 머지되면 CI 통과 뒤
`release.yml` 이 태그, GitHub 릴리즈, npm 게시, 검증을 진행한다. npm 게시는 OIDC Trusted
Publishing 만 쓰므로 로컬 `npm login` 이나 `NPM_TOKEN` 이 필요 없다.

## 상태 스냅샷

Hub 를 보장(`hub-ensure`)할 때 `~/.codex/` 일부 상태를 git-ignore 된
`references/codex-snapshots/` 에 하루 한 번 꼴로 스냅샷한다. 실패해도 Hub 시작에는 영향이 없다.
수동 명령:

```bash
npm run snapshot:codex
npm run snapshot:all
```

같은 시점에 legacy Gemini CLI 호환용으로 `~/.gemini/` 도 `references/gemini-snapshots/` 에
스냅샷한다(수동: `npm run snapshot:gemini`). 두 스냅샷 디렉터리는 `packages/triflux/package.json`
의 `files` 부정 패턴으로 npm 패키지에서 빠진다.

## 브랜치 네이밍

```
feat|fix|docs|refactor|chore/<issue>-<slug>
```

예: `fix/449-shim-entrypoint`, `docs/12-adr-foundation`. `<issue>` 는 관련
GitHub 이슈/PR 번호, `<slug>` 는 짧은 kebab-case 요약이다. `main` 에 직접
커밋하지 않는다.

## 개발 플로우

```
아이디어
  → (결정이 필요하면) ADR: docs/adr/  (proposed → accepted)
  → PRD / plan: docs/prd/ · .triflux/plans/
  → 구현 (기본 CLI = Codex)
  → 교차리뷰 (아래 계약 필수)
  → ship: /tfx-ship
  → CHANGELOG.md 갱신
```

- **결정(왜)** 이 필요하면 먼저 ADR 을 `proposed` 로 열고, 확정되면
  `accepted` 로 넘긴다. 규약은 [`docs/adr/CONVENTIONS.md`](docs/adr/CONVENTIONS.md).
- **요구/설계** 는 `docs/prd/`, **실행 계획** 은 `.triflux/plans/` 에 둔다.
- **구현의 기본 CLI 는 Codex** 다(라우팅 정책은
  [`.claude/rules/tfx-routing.md`](.claude/rules/tfx-routing.md)). Claude 는 메타
  라우팅/최종 수단, Antigravity 는 cross-check 레인이다.
- 각 단계의 상세 규칙은 [`docs/process/`](docs/process/) 를 따른다.

## 교차리뷰 계약 (필수)

triflux는 **동일 모델 self-approve 를 금지**한다. 작성 모델과 리뷰 모델을
분리한다.

| 작성 | 리뷰 |
| --- | --- |
| Claude 가 작성한 코드 | **Codex** 가 리뷰 |
| Codex 가 작성한 코드 | **Claude** 가 리뷰 |

같은 활성 컨텍스트에서 자기 코드를 승인하지 않는다. 근거와 게이트 상세는
[`docs/process/pr-review-contract.md`](docs/process/pr-review-contract.md) 를 따른다.

## 커밋과 PR 규칙

- **AI attribution 금지.** 커밋 메시지에 `Co-Authored-By`, `Generated with`,
  기타 AI 생성 표기(trailer/footer)를 넣지 않는다. 이는 triflux 릴리즈 정책이다.
- **커밋은 태스크 단위.** 변경한 파일만 스테이징한다. 워크트리에 무관한
  산출물이 섞일 수 있으므로 `git add -A` 는 피한다.
- **PR 은 [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md)
  를 따른다.** Why / Scope / Validation / Release impact / Cross-model review
  섹션을 채운다. 특히 `Validation` 체크(`npm test`, `npm run lint`,
  `release:check-sync`)와 `Cross-model review`(reviewer + status)는 비워 두지 않는다.

## 에이전트 정책

- **에이전트 실행 정책의 SSOT 는 [`.claude/rules/`](.claude/rules/) 다.**
  Claude Code 하니스가 이 디렉토리의 `*.md` 를 자동 로드한다. 라우팅, 실행
  스킬 맵, escalation, 미러 정책, 스택 공존 등이 여기에 산다.
- **Codex 는 `@import` 를 지원하지 않으므로 [`AGENTS.md`](AGENTS.md) 를 독립적으로
  유지**한다. 에이전트 정책을 바꿀 때는 두 표면의 정합성을 함께 본다.

## 문서 규칙

- **아키텍처/정책/횡단 결정은 ADR 로 남긴다.** 포맷·상태머신·필수 헤딩은
  [`docs/adr/CONVENTIONS.md`](docs/adr/CONVENTIONS.md) 를 따르고, 모든 ADR 은
  [상태보드](docs/adr/README.md)에 행이 있어야 존재로 인정된다.
- **문서를 어디에 둘지** 는 [`docs/README.md`](docs/README.md) 의 목적별 진입점
  맵과 공개/local/npm 분류를 따른다.
- **공개 안전.** 커밋되는 문서에 토큰·계정명·개인 호스트·IP·로컬 절대경로·
  비공개 고객 내용을 넣지 않는다. 그런 값은 git-ignore 되는 LOCAL 문서에만 둔다.
