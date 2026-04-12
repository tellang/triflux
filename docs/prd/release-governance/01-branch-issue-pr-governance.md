# PRD: 브랜치 전략 + Issue/PR 거버넌스 재정의

## 목표
triflux에 맞는 운영 브랜치 계약을 정의한다.
단일 maintainer + 다중 에이전트(worktree/swarm/remote) 환경에서도 리뷰가 가능한 입력 형식을 강제하고, 후속 구현 턴에서 `.github/` 템플릿과 정책 문서를 Claude Code가 바로 생성할 수 있게 한다.

## 파일
- `.github/PULL_REQUEST_TEMPLATE.md` (신규, ~80줄)
- `.github/ISSUE_TEMPLATE/bug.yml` (신규, ~80줄)
- `.github/ISSUE_TEMPLATE/feature.yml` (신규, ~80줄)
- `.github/ISSUE_TEMPLATE/release.yml` (신규, ~70줄)
- `.github/ISSUE_TEMPLATE/config.yml` (신규, ~30줄)
- `docs/process/branch-policy.md` (신규, ~140줄)
- `docs/process/pr-review-contract.md` (신규, ~120줄)
- `docs/drafts/release-governance/branch-issue-pr-draft.md` (기존 draft 기준 구현)

## 인터페이스
```md
Branch classes:
- main                     # always releasable, direct push 금지
- feat/<issue>-<slug>      # user-facing or system feature
- fix/<issue>-<slug>       # bug fix
- docs/<issue>-<slug>      # docs only
- refactor/<issue>-<slug>  # behavior-preserving cleanup
- release/<version>        # short-lived stabilization branch, optional
- spike/<date>-<slug>      # throwaway investigation, merge 금지 unless promoted

PR required sections:
- Why / Problem
- What changed
- Validation commands + output summary
- Release impact
- Docs / templates touched
- Risk / rollback
- Cross-model review status
```

## 제약
- main은 항상 배포 가능 상태를 목표로 한다.
- 에이전트 생성 브랜치는 issue id 또는 explicit intent가 없으면 merge 금지로 둔다.
- 템플릿은 유지비가 낮아야 한다. YAML form은 3종 이하로 제한한다.
- PR 템플릿은 실제 검증 명령을 강제해야 한다. “tested” 같은 자유 텍스트만 남기지 않는다.
- 브랜치 전략은 지금 규모에 맞게 trunk-first여야 한다. Git Flow 같은 장기 지원 브랜치 모델은 도입하지 않는다.

## 의존성
- GitHub issue forms / PR template
- 현행 CLAUDE.md의 cross-review 규칙
- 후속 release/versioning PRD

## 테스트 명령
```bash
npm test
npm run lint
node --check scripts/release/check-sync.mjs
```

## Codex 실행 제약 (자동 삽입됨)
- stdin redirect 금지: `codex < file` → "stdin is not a terminal" 에러
- `codex exec "$(cat prompt.md)" --dangerously-bypass-approvals-and-sandbox` 사용
- `codex exec`는 `--profile` 미지원. config.toml 기본 모델 사용
- `--full-auto` CLI 플래그 금지 (config.toml sandbox와 충돌)
- 테스트 병렬 실행 시 `.test-lock/pid.lock` 충돌 가능 — 순차 실행 권장

## 완료 조건 (필수)
1. `.github/ISSUE_TEMPLATE/*`와 `PULL_REQUEST_TEMPLATE.md`가 draft와 동일한 의미 체계로 생성된다.
2. `docs/process/branch-policy.md`에 branch class, naming rule, merge rule, release exception이 문서화된다.
3. PR 템플릿이 validation, risk, release impact, docs sync를 필수 섹션으로 포함한다.
4. docs-only PR과 code-changing PR의 필수 체크 차이가 문서에 반영된다.
5. 변경 파일 검토 후 테스트 명령을 실행하고 결과를 확인한다.
