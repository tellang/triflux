# 업데이트 로직

| 도구 | 감지 | 갱신 방법 |
|------|------|----------|
| **triflux (자체)** | `tfx --version` vs `gh release list --repo tellang/triflux` | `npm i -g triflux` 또는 `claude plugin update triflux` |
| **OMC (oh-my-claudecode)** | 세션 시작 훅 `[OMC VERSION DRIFT]` / `[OMC UPDATE AVAILABLE]` | `omc update` — plugin/npm CLI/CLAUDE.md 3곳 동시 동기화 |
| **gstack** | `~/.gstack/last-update-check` 훅 / 세션 시작 배너 | `/gstack-upgrade` 스킬 (git install이면 `git merge --ff-only origin/main` + `./setup` + migrations) |
| **Codex CLI** | `codex --version` / `~/.codex/auth.json` mtime | `npm i -g @openai/codex` / 토큰 만료 시 `codex login` (인터랙티브) + 메시지 한 번 날려 refresh 트리거 |
| **Gemini CLI** | `gemini --version` | `npm i -g @google/gemini-cli` |
| **Hub MCP URL 동기화** | Hub 시작 시 hub.pid의 port vs settings의 tfx-hub.url | PR #82 자동화 (`scripts/sync-hub-mcp-settings.mjs`의 `syncHubMcpSettings({hubUrl})`를 server startup에서 호출) |
| **Codex auth 캐시** (pte1024 등) | 병렬 codex exec 시 `refresh_token_reused` | `cp ~/.codex/auth.json ~/.claude/cache/tfx-hub/codex-auth-<account>.json` 수동 (Issue #78 자동화 대기) |

## 주의

- `git reset --hard`는 safety-guard가 차단 → `git merge --ff-only`로 우회
- OMC drift 감지 시 plugin/npm/CLAUDE.md 3개 컴포넌트를 반드시 함께 갱신 (한쪽만 새 버전이면 훅/라우팅 호환성 깨짐)
- gstack 업그레이드 후 `~/.gstack/just-upgraded-from`을 체크해서 CHANGELOG 하이라이트 표시
- 원격 머신 업그레이드 전파는 `tfx-remote-spawn` + SSH scp로 수동 (자동화 예정)
