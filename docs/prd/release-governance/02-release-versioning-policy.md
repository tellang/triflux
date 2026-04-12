# PRD: 릴리즈 전략 + 버저닝 single source of truth

## 목표
triflux의 버전 소스를 하나로 고정하고, npm/GitHub/Claude marketplace로 퍼지는 모든 아티팩트가 그 버전을 기준으로 동기화되도록 만든다.
현재 존재하는 버전 드리프트를 구조적으로 막는 정책과 검증 스크립트 명세를 제공한다.

## 파일
- `docs/process/release-policy.md` (신규, ~180줄)
- `docs/process/versioning-policy.md` (신규, ~120줄)
- `scripts/release/check-sync.mjs` (신규, ~180줄)
- `scripts/release/bump-version.mjs` (신규, ~220줄)
- `scripts/release/version-manifest.json` (신규, ~40줄)
- `docs/drafts/release-governance/release-versioning-draft.md` (기존 draft 기준 구현)

## 인터페이스
```javascript
// scripts/release/check-sync.mjs
export function loadVersionManifest()
export function collectVersionTargets()
export function assertVersionSync({ fix = false })
// returns: { ok: boolean, rootVersion: string, targets: Array<{file, found, expected}> }

// scripts/release/bump-version.mjs
export async function bumpVersion({ nextVersion, channel, write })
// updates: root package.json -> generated targets -> lockfile verification
```

## 제약
- single source of truth는 루트 `package.json.version` 하나만 허용한다.
- `packages/triflux/package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `package-lock.json`는 동기화 대상이다.
- 버저닝은 semver 유지. patch=bugfix/ops-safe change, minor=backward-compatible capability, major=breaking contract.
- canary 채널을 열더라도 stable 흐름을 깨면 안 된다. 예: `10.10.0-canary.1` + npm dist-tag `canary`.
- 새 외부 릴리즈 SaaS 도구는 도입하지 않는다. Node 스크립트와 GitHub CLI 범위에서 끝낸다.

## 의존성
- root `package.json`
- `packages/triflux/package.json`
- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- npm / gh CLI available in release environment

## 테스트 명령
```bash
node scripts/release/check-sync.mjs
node scripts/release/bump-version.mjs --next 10.9.18 --dry-run
npm pack --dry-run
npm test
```

## Codex 실행 제약 (자동 삽입됨)
- stdin redirect 금지: `codex < file` → "stdin is not a terminal" 에러
- `codex exec "$(cat prompt.md)" --dangerously-bypass-approvals-and-sandbox` 사용
- `codex exec`는 `--profile` 미지원. config.toml 기본 모델 사용
- `--full-auto` CLI 플래그 금지 (config.toml sandbox와 충돌)
- 테스트 병렬 실행 시 `.test-lock/pid.lock` 충돌 가능 — 순차 실행 권장

## 완료 조건 (필수)
1. 버전 정책 문서가 root source-of-truth, bump rule, release channel rule을 명시한다.
2. `check-sync`가 현재 드리프트를 에러로 보고하고, `--fix` 또는 bump flow로 고칠 수 있게 설계된다.
3. release 전 검증 명령에 `check-sync`, test, lint, `npm pack --dry-run`이 포함된다.
4. 후속 턴에서 `plugin.json` 버전이 marketplace/root와 어긋나지 않도록 정책이 명문화된다.
5. 변경 파일 검토 후 테스트 명령을 실행하고 결과를 확인한다.
