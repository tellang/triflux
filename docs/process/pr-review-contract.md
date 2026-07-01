# PR 리뷰 계약 (PR review contract)

> PR을 열고 머지하기 전에 지켜야 하는 계약. 브랜치 규칙은 [브랜치 정책](branch-policy.md)에 있다.
> 정본(SSOT)은 [`CLAUDE.md`의 교차 검증 섹션](../../CLAUDE.md)과 [`.github/PULL_REQUEST_TEMPLATE.md`](../../.github/PULL_REQUEST_TEMPLATE.md)다. 이 문서는 그것을 사람이 읽는 형태로 정리한다.
> 근거는 [ADR-0002](../adr/0002-doc-and-devflow-architecture.md), 요구는 [PRD 01](../prd/release-governance/01-branch-issue-pr-governance.md).

## 1. 교차리뷰 계약

작성자와 리뷰어는 **서로 다른 모델**이어야 한다. 동일 모델이 자기 작업을 self-approve하지 않는다.

| 작성 | 리뷰 |
|---|---|
| Claude 작성 코드 | → Codex 리뷰 |
| Codex 작성 코드 | → Claude 리뷰 |

- 근거: [`CLAUDE.md`의 `<cross-review>` / 교차 검증 규칙](../../CLAUDE.md).
- 이유: 같은 모델·같은 컨텍스트의 self-approve는 독립 검증이 아니라 disagreement 신호를 잃는다.
- 저작 pass와 리뷰 pass는 분리한다. 작성한 컨텍스트 안에서 스스로 승인하지 않는다.
- git commit 전 미검증(리뷰 안 거친) 변경 파일이 감지되면 커밋을 멈추고 리뷰 pass를 먼저 돌린다.

## 2. 머지 전 검증 게이트

머지 전에 아래 명령을 돌리고 **실제 출력**을 PR에 붙인다. "tested" 같은 자유 텍스트만 남기지 않는다. 아래는 모두 `package.json`에 실재하는 스크립트다.

| 명령 | 하는 일 | 언제 필수 |
|---|---|---|
| `npm test` | 테스트 스위트 실행 + `lint:skills` 포함 | 모든 PR |
| `npm run lint` | `biome check` (lint **+ format**) | 코드/설정 변경 PR |
| `npm run lint:skills` | 스킬 frontmatter/작성 규칙 lint (`npm test`에 이미 포함) | 스킬(`skills/**`) 변경 시 |
| `npm run release:check-sync` | 버전/파일 sync 검증 | 릴리즈·버전 영향 PR |
| `npm run release:check-mirror` | `packages/{core,remote,triflux}` 미러 드리프트 검증 | `hub/`·`scripts/lib/`·`bin/` 등 미러 대상 변경 시 |

주의:
- CI의 `biome check`는 lint에 더해 **format**까지 본다. 로컬에서 `biome lint`만 돌리면 format 에러를 놓친다 — 반드시 `npm run lint`로 선검사한다.
- `npm test`가 `lint:skills`를 이미 포함하므로 스킬을 안 건드린 PR은 별도 실행이 불필요하다.
- 미러 정책 상세는 [`.claude/rules/tfx-mirror-policy.md`](../../.claude/rules/tfx-mirror-policy.md).
- 완료를 주장하기 전에 명령을 실제로 실행하고 출력을 확인한다. 통과 주장은 증거(출력) 뒤에 온다.

### docs-only PR vs code-changing PR

| PR 유형 | 필수 게이트 |
|---|---|
| docs only (`docs/**`, 마크다운) | `npm run lint:skills`가 스킬을 안 건드리면 생략 가능. 코드 스크립트 미실행 허용. |
| code / config 변경 | `npm test` + `npm run lint` 필수. 미러/릴리즈 대상이면 해당 `release:check-*` 추가. |

## 3. PR 템플릿 필수 기입

[`.github/PULL_REQUEST_TEMPLATE.md`](../../.github/PULL_REQUEST_TEMPLATE.md)의 섹션을 빈칸으로 두지 않는다. 특히:

- **Why** — 무엇을 왜 푸나(solves).
- **Scope** — 바뀐 것 / 안 바뀐 것.
- **Validation** — 위 §2 게이트 체크 + `Output summary`에 실제 명령 출력.
- **Release impact** — patch / minor / major / no release.
- **Docs / Templates** — 문서·템플릿 동기화 여부.
- **Risk / Rollback** — 위험과 되돌리는 법.
- **Cross-model review** — reviewer(누가/어느 모델), status(APPROVE/CONCERN 등), notes. §1 교차리뷰 결과를 여기에 남긴다.

## 4. AI attribution 금지

triflux는 커밋 메시지·PR 본문·릴리즈 노트에 AI 생성 표식을 넣지 않는다.

- `Co-Authored-By: ...` trailer 금지.
- `Generated with ...` / `🤖 ...` 류 footer 금지.
- 이 정책은 `/tfx-ship`·로컬 `/ship` 양쪽 모두에 적용된다.

## 관련 문서

- [브랜치 정책](branch-policy.md) — 브랜치 클래스·main 보호·릴리즈 경로
- [`CLAUDE.md`](../../CLAUDE.md) — 교차 검증 규칙(SSOT)
- [`.github/PULL_REQUEST_TEMPLATE.md`](../../.github/PULL_REQUEST_TEMPLATE.md) — PR 템플릿(SSOT)
- [`.claude/rules/tfx-mirror-policy.md`](../../.claude/rules/tfx-mirror-policy.md) — packages 미러 검증
- [PRD 01: 브랜치+Issue/PR 거버넌스](../prd/release-governance/01-branch-issue-pr-governance.md)
