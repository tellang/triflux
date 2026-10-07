---
paths:
  - "scripts/*update*"
  - "scripts/setup.mjs"
  - "scripts/sync-hub-mcp-settings.mjs"
  - "scripts/hub-ensure.mjs"
  - "bin/triflux.mjs"
  - "skills/tfx-setup/**/*"
---
# 업데이트 로직

| 도구 | 감지 | 갱신 방법 |
|------|------|----------|
| **triflux (자체)** | 설치 방식(plugin/npm/git)을 `tfx update`가 감지 | `tfx update`가 설치본을 갱신하고 새 버전의 `tfx setup`을 실행해 관리 파일·스킬·프로필·HUD를 동기화한다. npm global 갱신 전후의 Hub stop/start는 허브 제거 전까지 유지한다. |
| **OMC (oh-my-claudecode)** | 세션 시작 훅 `[OMC VERSION DRIFT]` / `[OMC UPDATE AVAILABLE]` | `omc update` — plugin/npm CLI/CLAUDE.md 3곳 동시 동기화 |
| **gstack** | `~/.gstack/last-update-check` 훅 / 세션 시작 배너 | `/gstack-upgrade` 스킬 (git install이면 `git merge --ff-only origin/main` + `./setup` + migrations) |
| **Codex CLI** | `codex --version` / `~/.codex/auth.json` mtime | `npm i -g @openai/codex` / 토큰 만료 시 `codex login` (인터랙티브) + 메시지 한 번 날려 refresh 트리거 |
| **Antigravity CLI** | `agy --version` | CLI: `curl -fsSL https://antigravity.google/cli/install.sh \| bash`. IDE Cask: `brew install --cask antigravity`. 인증: ChainedAuth (Mac Keychain → oauth_creds.json). 자세히는 memory:[[reference-antigravity-cli-sanity-matrix]] |
| **Hub MCP URL 동기화** | Hub 시작 시 `resolveHubTarget()` (env `TFX_HUB_PORT` 없으면 `HUB_DEFAULT_PORT=27888`) vs client configs의 `tfx-hub.url` | PR #82 auto sync + PR #158 port cascade fix. `scripts/sync-hub-mcp-settings.mjs`의 `syncHubMcpSettings({hubUrl})` + `syncProjectMcpJson({projectRoot: process.cwd()})`를 hub-ensure에서 호출. pid-file은 host 힌트 전용 (port 재사용 제거). 근거(why): [ADR-0007 — hub 기본 포트 27888 고정](../../docs/adr/0007-hub-default-port-27888.md) |
| **Codex auth 캐시** (pte1024 등) | 병렬 codex exec 시 `refresh_token_reused` | `cp ~/.codex/auth.json ~/.claude/cache/tfx-hub/codex-auth-<account>.json` 수동 (Issue #78 자동화 대기) |

## 주의

- git 설치본의 `tfx update`는 `git pull`을 사용한다. 로컬 변경이 있으면 먼저 상태를 확인하고 보존한다.
- OMC drift 감지 시 plugin/npm/CLAUDE.md 3개 컴포넌트를 반드시 함께 갱신 (한쪽만 새 버전이면 훅/라우팅 호환성 깨짐)
- gstack 업그레이드 후 `~/.gstack/just-upgraded-from`을 체크해서 CHANGELOG 하이라이트 표시
- 원격 머신 업그레이드 전파는 `tfx-remote` + SSH scp로 수동 (자동화 예정)
- Antigravity headless fallback readiness 는 `tfx-route.sh` 가 캐시가 없거나 오래됐을 때 `TFX_ANTIGRAVITY_OK` 를 갱신한다. `hub/team/preflight-cache.mjs` 코드 주석 참조.
- Antigravity CLI 인증은 ChainedAuth (Mac Keychain → oauth_creds.json 순) 기반. 별도 sign-in 일반적으로 불필요.
