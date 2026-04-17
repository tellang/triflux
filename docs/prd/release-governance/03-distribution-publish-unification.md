# PRD: npm 배포 + GitHub Release + Claude Code marketplace fan-out 통합

## 목표
하나의 release transaction에서 npm publish, Git tag/GitHub Release, Claude Code marketplace metadata sync/verification이 순차 수행되도록 설계한다.
운영자가 기억에 의존해 "이것도 했나?"를 확인하지 않아도 되는 runbook과 자동화 경계선을 만든다.

## 파일
- `docs/process/distribution-runbook.md` (신규, ~180줄)
- `.github/workflows/release.yml` (신규, ~180줄)
- `scripts/release/prepare.mjs` (신규, ~180줄)
- `scripts/release/publish.mjs` (신규, ~220줄)
- `scripts/release/verify.mjs` (신규, ~160줄)
- `docs/drafts/release-governance/distribution-pipeline-draft.md` (기존 draft 기준 구현)

## 인터페이스
```javascript
// scripts/release/prepare.mjs
export async function prepareRelease({ version, channel, ci })
// verifies clean git, synced versions, tests, pack dry run

// scripts/release/publish.mjs
export async function publishRelease({ version, channel, npmTag, createGithubRelease })
// fan-out: npm -> git tag/release -> marketplace metadata commit

// scripts/release/verify.mjs
export async function verifyRelease({ version, channel })
// checks npm metadata, tag existence, marketplace file sync, install smoke note
```

## 제약
- npm publish, GitHub Release, marketplace sync는 같은 version id를 사용해야 한다.
- partial success가 발생하면 rollback / retry 기준을 문서에 포함해야 한다.
- marketplace는 현재 npm source를 보므로, 최소한 `.claude-plugin/marketplace.json`과 `.claude-plugin/plugin.json`의 sync 및 repo commit 상태를 확인해야 한다.
- `.github/`가 현재 없으므로 workflow는 신규 생성이지만, 로컬 수동 실행 경로도 동일 runbook으로 유지해야 한다.
- publish step은 release branch 또는 tagged main commit에서만 실행 가능해야 한다.

## 의존성
- Release/versioning PRD의 version sync 보장
- GitHub CLI (`gh`)
- npm auth / `NPM_TOKEN`
- Claude marketplace metadata files

## 테스트 명령
```bash
node scripts/release/prepare.mjs --version 10.9.18 --dry-run
node scripts/release/publish.mjs --version 10.9.18 --dry-run
node scripts/release/verify.mjs --version 10.9.18 --dry-run
npm pack --dry-run
```

## Codex 실행 제약 (자동 삽입됨)
- stdin redirect 금지: `codex < file` → "stdin is not a terminal" 에러
- `codex exec "$(cat prompt.md)" --dangerously-bypass-approvals-and-sandbox` 사용
- `codex exec`는 `--profile` 미지원. config.toml 기본 모델 사용
- `--full-auto` CLI 플래그 금지 (config.toml sandbox와 충돌)
- 테스트 병렬 실행 시 `.test-lock/pid.lock` 충돌 가능 — 순차 실행 권장

## 완료 조건 (필수)
1. release fan-out 단계가 준비 → publish → verify 세 단계로 분리되어 문서화된다.
2. GitHub Actions workflow와 local manual command가 같은 순서를 공유한다.
3. npm publish 성공 후 GitHub Release 실패, 또는 marketplace sync 실패 시의 처리 기준이 문서에 있다.
4. release notes draft와 verification checklist가 함께 정의된다.
5. 변경 파일 검토 후 테스트 명령을 실행하고 결과를 확인한다.
