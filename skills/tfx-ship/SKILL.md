---
name: tfx-ship
description: >
  triflux 전용 릴리즈 자동화. **GitHub Actions(release.yml dispatch / npm-publish.yml) 기반 CI 릴리즈가 기본 경로 —
  npm publish 는 OIDC Trusted Publishing 으로 CI 가 수행하므로 로컬 npm login 불필요.** scripts/release/* 래퍼 +
  AskUserQuestion 기반 버전 선택 + CHANGELOG 편집 게이트 + Co-Authored-By/AI trailer 금지 강제. 'ship', '배포', '릴리즈',
  'release', 'tfx-ship', 'publish' 같은 요청에 반드시 사용.
argument-hint: "[patch|minor|major|<version>] [--skip-tests] [--no-publish] [--dry-run]"
---

# tfx-ship — triflux 릴리즈 자동화

> **ARGUMENTS 처리**: ARGUMENTS 가 있으면 첫 토큰을 version bump 타입 또는 명시 버전으로 해석.
> 플래그는 `--skip-tests`, `--no-publish`, `--dry-run` 지원.

> **하드 룰** (절대 위반 금지):
>
> 1. Commit 메시지에 `Co-Authored-By:` trailer 금지 (MEMORY: `feedback_no_coauthor_trailer.md`)
> 2. `🤖 Generated with Claude Code` / `AI-assisted` 등 AI 공저자 언급 금지
> 3. `--no-verify`, `--no-gpg-sign`, `--amend` 금지 (사용자 명시 요청 전까지)
> 4. `git reset --hard`, `git push --force`, `git clean -f` 는 사용자 명시 승인 후에만
> 5. 버전 동기화: `package.json` + `.claude-plugin/marketplace.json` 둘 다 갱신 (`release:check-sync` 가 강제)

## 배포 채널 (3개 현행 + 1개 future)

triflux 는 아래 3채널로 동시 배포. 각 채널의 버전은 반드시 동기화 상태 유지.

| # | 채널 | 명령 | 우선순위 |
|---|------|------|---------|
| 1 | **GitHub Releases** | `gh release create vX.Y.Z --notes-file <notes>` | 공지 + changelog 공식 소스 |
| 2 | **npm registry** | **CI `npm-publish.yml`** (`v*` 태그 push 자동 / OIDC Trusted Publishing, `NPM_TOKEN` secret) | primary distribution |
| 3 | **Claude Code marketplace** | `.claude-plugin/marketplace.json` (`source: npm` 참조) | `claude plugin add triflux` |
| 4 | **pypi** (future, 비활성) | 현재 `pyproject.toml` 없음 | 활성화 시 Step 10.5 신설 |

- **npm publish 는 로컬에서 하지 않는다** — `release.yml` dispatch 또는 `v*` 태그 push 시 `npm-publish.yml` 이 OIDC 로 발행한다. 로컬 `publish.mjs --execute` 는 CI 불가 시 폴백 전용.
- marketplace 는 자체 publish 명령이 없음. marketplace.json 의 version 만 갱신하면 git push 로 반영됨 (GitHub 호스팅).
- `release:check-sync` 가 package.json + marketplace.json + package-lock.json 3곳 version 일치를 강제한다.
- pypi 는 triflux 가 Python 모듈을 가지게 되면 활성화. 현 단계는 플레이스홀더.

자세한 채널 구조는 MEMORY `reference_triflux_distribution.md` 참조.

## 전제 조건

- `~/.claude/scripts/tfx-route.sh` 불필요 (CLI 워커 호출 없음)
- `gh` CLI 인증됨 (`gh auth status`) — `release.yml` dispatch / GitHub release 에 필요. 깨졌으면 웹 UI 대체
- **npm 인증 불필요** — npm publish 는 CI(`npm-publish.yml`)가 OIDC/`NPM_TOKEN` 으로 수행 (로컬 `npm login` 필요 없음)
- 릴리즈할 코드가 `origin/main` 에 있을 것 (CI 는 `--ref main` 으로 origin 을 checkout)

## 기본 경로 — CI 릴리즈 (권장)

> **npm publish 는 로컬에서 하지 않는다.** GitHub Actions 가 OIDC(Trusted Publishing)로 발행한다.
> 워크플로우: `.github/workflows/{release,npm-publish,ci}.yml`

- **`release.yml`** (`workflow_dispatch`, inputs: `version`, `channel`): 한 번의 dispatch 로 prepare(테스트/버전 bump) → 태그 + GitHub release(`publish.mjs --skip-npm`) → `npm-publish.yml` dispatch → npm publish 완료 대기 → `verify.mjs` 까지 전부 CI(ubuntu, node 24)에서 수행.
- **`npm-publish.yml`** (`on: push tags ['v*']` + dispatch): `v*` 태그가 push 되면 자동 npm publish (`--provenance --access public`, `NPM_TOKEN` secret). 루트/core/triflux 3패키지 각각, 이미 게시된 버전은 skip.

### 권장 실행 — release.yml 디스패치

```bash
gh workflow run release.yml --ref main -f version=<X.Y.Z> -f channel=stable
# 진행 관찰
gh run list --workflow release.yml -L1
gh run watch "$(gh run list --workflow release.yml -L1 --json databaseId -q '.[0].databaseId')"
```

- gh 인증이 없는 환경(예: SSH→m2, hosts.yml PAT 만료)이면 **gh 가 정상인 머신(m5)에서** dispatch 하거나 **GitHub 웹 UI**(Actions → release → Run workflow)로 대체.
- CHANGELOG 가 필요하면 dispatch 전에 main 에 별도 커밋으로 반영(아래 로컬 플로우 Step 4 양식 참조).

### 경량 경로 — 태그만 push

이미 검증된 hotfix 등 prepare/verify 없이 npm publish 만 트리거하려면:

```bash
# main 에서 bump 커밋(버전 3곳 동기화) 후
git tag v<X.Y.Z> && git push origin v<X.Y.Z>   # → npm-publish.yml 자동 발동
```

> ⚠️ 이 경로는 GitHub release / verify 를 건너뛴다. 버전 동기화(package.json + marketplace.json + lock)는 직접 보장.

---

## 로컬 수동 플로우 (폴백 — CI 불가 시에만)

> CI 가 정석이다. 아래는 Actions 가 막혔거나 로컬 디버깅 시의 수동 절차다.
> **Step 10 의 로컬 `npm publish` 는 CI 와 중복이므로 평상시 실행 금지.**

### Step 0 — 환경 확인

```bash
cd "$REPO_ROOT"
git rev-parse --abbrev-ref HEAD     # main 이어야 함
git status --porcelain              # uncommitted 있으면 경고
git log --oneline origin/main..HEAD # unpushed 커밋 목록
gh auth status                      # gh 인증
node --version                      # Node 18+ 확인
```

조건:
- main 이 아닌 브랜치 → **STOP**. 사용자에게 `git checkout main` 지시 또는 PR 플로우 안내
- uncommitted 있음 → **AskUserQuestion**: "먼저 커밋할까? / ship 에 포함 / 취소"
- behind origin → `git pull origin main` 먼저 실행

### Step 1 — 버전 선택

ARGUMENTS 에 version 있으면 그 값 사용. 없으면 AskUserQuestion:

```
현재: v{CURRENT}
어떤 버전으로 올릴까요?

A) patch (v{CURRENT +0.0.1}) — bug fix / small refactor
B) minor (v{CURRENT +0.1.0}) — 새 기능, backward compatible
C) major (v{CURRENT +1.0.0}) — breaking change
D) custom — 직접 입력
```

선택된 버전을 `TARGET_VERSION` 으로 저장.

### Step 2 — 버전 동기화 사전 체크

```bash
npm run release:check-sync
```

불일치 시:
- 자동 수정 제안: `npm run release:check-sync:fix`
- 사용자 승인 후 실행

### Step 3 — 버전 bump

```bash
npm run release:bump -- --version "$TARGET_VERSION" --write
```

이 스크립트가 `package.json` + `.claude-plugin/marketplace.json` + `package-lock.json` 을 갱신한다.

> **MANDATORY `--write`**: 플래그 없으면 dry-run 만 동작 (`scripts/release/bump-version.mjs:28` `if (write)` 분기). `--write` 누락 시 후속 Step 이 모두 이전 버전으로 진행되는 silent failure 가 된다.

### Step 4 — CHANGELOG 초안 생성

`git log --oneline <previous-tag>..HEAD` 로 범위 커밋 나열 후, Claude 가 아래 섹션 구조로 초안 작성:

```markdown
## [{TARGET_VERSION}] - {YYYY-MM-DD}

### Fixed
- **[#<issue>]** <commit subject 에서 추출>

### Added
- **[#<issue>]** <subject>

### Changed
- ...

### Tests
- ...
```

초안 → `CHANGELOG.md` 최상단 항목 위에 삽입 → **AskUserQuestion**:

```
CHANGELOG 초안 (미리보기)

A) 이대로 저장 후 계속
B) 편집하고 계속 (사용자가 에디터에서 수정 후 진행)
C) 취소
```

### Step 5 — 테스트 + 빌드 검증

```bash
npm run release:prepare -- --execute --version "$TARGET_VERSION" --allow-dirty
```

> **`--allow-dirty` 사실상 필수**: Step 3 의 `release:bump --write` 가 `package.json` / `marketplace.json` / `package-lock.json` 을 갱신해 working tree 를 dirty 상태로 만든다. `--allow-dirty` 없으면 prepare 가 `Working tree is dirty` 로 거부 (`scripts/release/prepare.mjs:56`). bump 와 prepare 사이에 commit 단계가 없으므로 항상 필수.

이 스크립트가 수행:
1. `assertVersionSync`
2. `ensureGitClean`
3. `npm test` (10분 timeout)
4. `npm run lint`
5. `npm pack --dry-run`
6. 릴리즈 노트 생성 → `.omx/plans/release-notes-v{VERSION}.md`

`--skip-tests` 플래그 있으면 npm test 건너뜀 (위험, stderr 경고 출력).

실패 시 → **STOP**. 사용자에게 에러 보여주고 재시도 옵션 제공.

### Step 6 — pack.mjs 미러

```bash
node scripts/pack.mjs all
```

주의 (MEMORY: `feedback_pack_crlf_issue.md`):
- CRLF→LF 변환 경고 대량 발생 가능
- `git status` 로 실제 변경 파일만 선별 스테이징
- 예: `git add packages/triflux/` (구체 경로 지정)

### Step 7 — Commit + Tag

커밋 메시지 (절대 Co-Authored-By 등 포함 금지):

```bash
git add package.json package-lock.json .claude-plugin/marketplace.json CHANGELOG.md packages/
git commit -m "chore(release): bump version to v${TARGET_VERSION}"
git tag "v${TARGET_VERSION}"
```

**MANDATORY**: HEREDOC 으로 커밋 메시지 전달. Co-Authored-By 트레일러 **절대 금지**. AI 공저자 언급 금지.

`.gitmessage` 템플릿이 AI trailer 를 자동 주입하는 경우 제거. `--no-edit` 으로 추가 편집 차단.

### Step 8 — Push

**AskUserQuestion** (릴리즈 전 마지막 확인):

```
준비 완료. push 하시겠습니까?

A) git push origin main --tags (권장)
B) tag 없이 push (수동 tag 후처리)
C) 중단 — 로컬에만 유지
```

선택 A 시:
```bash
git push origin main
git push origin "v${TARGET_VERSION}"
```

### Step 9 — GitHub Release

```bash
NOTES_PATH=".omx/plans/release-notes-v${TARGET_VERSION}.md"
gh release create "v${TARGET_VERSION}" \
  --title "v${TARGET_VERSION}" \
  --notes-file "$NOTES_PATH"
```

주의:
- 노트 본문 검증: Co-Authored-By / AI trailer 포함됐는지 grep 후 제거
- `--draft` 로 초안 생성 후 수동 publish 도 가능 (안전 모드)

### Step 10 — npm publish (= CI 가 수행, 로컬 금지가 기본)

> **평상시 로컬에서 `npm publish` 하지 않는다.** Step 8 에서 `git push origin v<X.Y.Z>` 로 태그가 올라가면 `npm-publish.yml` 이 OIDC 로 자동 발행한다.
> CI run 관찰: `gh run list --workflow npm-publish.yml -L1` → `gh run watch <id>`

CI 가 완전히 불가능한 비상시에만, npm 인증을 갖춘 환경에서 수동 폴백:

```bash
node scripts/release/publish.mjs --execute   # 비상 폴백 전용 — 중복 publish 주의
```

### Step 10.5 — pypi publish (future, 현재 비활성)

triflux 가 Python 모듈을 가지게 되면 이 단계를 활성화:

```bash
# pyproject.toml 존재 시에만 실행
if [ -f pyproject.toml ]; then
  python -m build
  twine upload dist/*
fi
```

현 단계는 `pyproject.toml` 없음 → skip. 플레이스홀더만 유지.

### Step 11 — 사후 검증 (3채널 전부)

```bash
npm run release:verify
```

확인 항목:
- GitHub tag 존재 (`git ls-remote --tags origin | grep "v${TARGET_VERSION}"`)
- npm registry 에 새 버전 게시됨 (`npm view triflux@${TARGET_VERSION} version`)
- marketplace.json version 일치 (`release:check-sync`)
- 릴리즈 노트 공개됨 (`gh release view v${TARGET_VERSION}`)
- (future) pypi 는 pyproject.toml 있을 때만 체크

### Step 12 — 사용자 알림

```
RELEASE COMPLETE ✓

version: v${TARGET_VERSION}
tag:     v${TARGET_VERSION}
npm:     published
github:  https://github.com/tellang/triflux/releases/tag/v${TARGET_VERSION}

다음:
- Claude Code 에서 plugin update: claude plugin update triflux
- 또는 npm: npm i -g triflux@${TARGET_VERSION}
```

## 에러 처리

| 단계 | 에러 | 복구 |
|------|------|------|
| Step 0 | 브랜치가 main 아님 | `git checkout main` 또는 PR 플로우 |
| Step 0 | unpushed 커밋 있음 (ship 전 확인) | 정상 — 릴리즈 대상 |
| Step 0 | uncommitted 변경 | 먼저 커밋 / ship 에 흡수 / 취소 선택 |
| Step 2 | 버전 동기화 실패 | `release:check-sync --fix` 실행 |
| Step 5 | 테스트 실패 | 수정 후 재시도. `--skip-tests` 는 위험 |
| Step 5 | lint 실패 | `npm run lint:fix` 후 재시도 |
| Step 7 | commit 메시지에 AI trailer 감지 | 하드 차단 + 재작성 요청 |
| Step 8 | push 거부 (remote 변경됨) | `git pull --rebase origin main` 후 재시도 |
| Step 9 | gh release create 실패 | `gh auth status` 확인, 수동 재시도 |
| Step 10 | npm publish(CI) 실패 | `gh run view <id> --log-failed` 로 `npm-publish.yml` 로그 확인. `NPM_TOKEN` secret / OIDC 설정 점검 |

## 플래그

| 플래그 | 동작 |
|--------|------|
| `--skip-tests` | Step 5 의 `npm test` 건너뜀. stderr 경고 출력. 긴급 hotfix 전용 |
| `--no-publish` | 태그를 push 하지 않아 `npm-publish.yml` 미발동. main 커밋 + (수동) GitHub release 만 |
| `--dry-run` | 모든 git push / publish 호출을 출력만 하고 skip. 검증 전용 |

## AI trailer 방지 상세

커밋 메시지 작성 시 **절대 포함하지 말 것**:

```
❌ Co-Authored-By: Claude <noreply@anthropic.com>
❌ 🤖 Generated with Claude Code
❌ AI-assisted by Claude
❌ Authored by AI
```

커밋 직전 `git log -1 --format=%B` 로 메시지 검증. 위 패턴 감지 시 `git reset HEAD~` 후 재작성.

`.gitmessage` / `.git/hooks/prepare-commit-msg` 에 AI trailer 자동 주입 훅이 있으면 해당 훅 제거 제안.

## 참고

- 기존 릴리즈 스크립트: `scripts/release/{bump-version,check-sync,prepare,publish,verify,lib}.mjs`
- version 동기화 manifest: `scripts/release/version-manifest.json`
- 이전 릴리즈 커밋 패턴: `git log --oneline | grep "chore(release): bump version"`
- MEMORY 참조: `feedback_no_coauthor_trailer.md`, `feedback_release_checklist.md`, `feedback_pack_crlf_issue.md`

## Troubleshooting

- 버전 불일치: `npm run release:check-sync --fix`
- pack CRLF 경고: 실제 변경 파일만 선별 `git add packages/triflux/...`
- gh CLI 미인증: `gh auth login` (또는 gh 정상인 머신/웹 UI 로 release.yml dispatch)
- npm publish 는 CI(`npm-publish.yml`, OIDC)가 수행 — 로컬 `npm login` 불필요. CI 실패 시 `gh run view <id> --log-failed`
- prepare.mjs stall: `scripts/release/prepare.mjs` 가 `stdio: ["ignore","pipe","pipe"]` + 10분 timeout 적용됨 (v10.9.32 fix 739da2d)
