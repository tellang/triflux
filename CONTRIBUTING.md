# triflux에 기여하기

triflux는 Claude Code · Codex · Antigravity 를 라우팅하는 CLI-first 멀티모델
오케스트레이터다. 이 문서는 코드/문서 기여의 진입점이다. 결정의 "왜"는
[`docs/adr/`](docs/adr/README.md), 문서 배치 규칙은 [`docs/README.md`](docs/README.md),
프로세스 상세는 [`docs/process/`](docs/process/) 에 있다.

## 빌드 / 설치

- **Node 18+** 필요(`package.json` `engines.node = ">=18.0.0"`).
- 의존성 설치:

```bash
npm install
```

빌드 스텝은 따로 없다. triflux는 `.mjs` 소스를 그대로 실행한다.

## 테스트 / 린트

변경 후에는 아래를 통과시킨다.

| 명령 | 검사 대상 |
| --- | --- |
| `npm test` | 유닛/통합 테스트 (`node:test`) + `lint:skills` |
| `npm run lint` | biome `check` = **lint + format** |
| `npm run lint:skills` | 스킬 문서(`skills/**/SKILL.md`) 규약 |

> **주의: `npm run lint` 를 반드시 먼저 돌린다.** biome `check` 는 lint 와
> **format 을 함께** 본다. 로컬에서 `biome lint` 만 돌리면 format 위반을
> 놓쳐 CI 에서 걸린다. 자동 정리는 `npm run lint:fix`.

패키지 배포에 영향을 주는 변경(루트 런타임 파일 수정 등)은 미러/동기화
게이트도 함께 확인한다.

```bash
npm run release:check-sync
npm run release:check-mirror
```

## 브랜치 네이밍

```
feat|fix|docs|refactor/<issue>-<slug>
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

## 커밋 / PR 규칙

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
