# 업데이트 로직

| 도구 | 감지 | 갱신 방법 |
|------|------|----------|
| **triflux (자체)** | `tfx --version` vs `gh release list --repo tellang/triflux` | `npm i -g triflux` 또는 `claude plugin update triflux` |
| **OMC (oh-my-claudecode)** | 세션 시작 훅 `[OMC VERSION DRIFT]` / `[OMC UPDATE AVAILABLE]` | `omc update` — plugin/npm CLI/CLAUDE.md 3곳 동시 동기화 |
| **gstack** | `~/.gstack/last-update-check` 훅 / 세션 시작 배너 | `/gstack-upgrade` 스킬 (git install이면 `git merge --ff-only origin/main` + `./setup` + migrations) |
| **Codex CLI** | `codex --version` / `~/.codex/auth.json` mtime | `npm i -g @openai/codex` / 토큰 만료 시 `codex login` (인터랙티브) + 메시지 한 번 날려 refresh 트리거 |
| **Gemini CLI** | `gemini --version` (현재 0.42.0) | `npm i -g @google/gemini-cli`. **2026-06-18 deadline** (Google I/O 2026, 2026-05-19 발표): AI Pro/Ultra + 무료 OAuth 인증 lane 끊김. Enterprise (Code Assist Standard/Enterprise license) 또는 유료 Gemini/Enterprise Agent Platform API key 보유자만 계속 사용 가능. 실측 OAuth 인증 (`~/.gemini/oauth_creds.json`) 환경은 영향 대상. |
| **Antigravity CLI** (신규, 2026-05-19 발표) | `agy --version` (macOS Cask IDE) / `antigravity --version` (Linux apt / CLI distribution) | **두 distribution 분리**: ① **IDE** (VS Code fork, 1.23.2 = Antigravity 2.0) — `brew install --cask antigravity` (macOS) / `apt install antigravity` (Ubuntu, repo `us-central1-apt.pkg.dev/projects/antigravity-auto-updater-dev/`). GUI desktop. macOS는 `agy chat` subcommand가 GUI 패널 launcher (headless 부재). ② **CLI** (TUI, 1.0.0 initial release) — `curl -fsSL https://antigravity.google/cli/install.sh \| bash` (Mac/Linux) / `irm https://antigravity.google/cli/install.ps1 \| iex` (Win). Terminal-first, SSH 최적화. 인증: system keyring + Google Sign-In fallback, `/logout` 명령. Enterprise: GCP project 연결. |
| **Hub MCP URL 동기화** | Hub 시작 시 `resolveHubTarget()` (env `TFX_HUB_PORT` 없으면 `HUB_DEFAULT_PORT=27888`) vs client configs의 `tfx-hub.url` | PR #82 auto sync + PR #158 port cascade fix. `scripts/sync-hub-mcp-settings.mjs`의 `syncHubMcpSettings({hubUrl})` + `syncProjectMcpJson({projectRoot: process.cwd()})`를 hub-ensure에서 호출. pid-file은 host 힌트 전용 (port 재사용 제거) |
| **Codex auth 캐시** (pte1024 등) | 병렬 codex exec 시 `refresh_token_reused` | `cp ~/.codex/auth.json ~/.claude/cache/tfx-hub/codex-auth-<account>.json` 수동 (Issue #78 자동화 대기) |

## 주의

- `git reset --hard`는 safety-guard가 차단 → `git merge --ff-only`로 우회
- OMC drift 감지 시 plugin/npm/CLAUDE.md 3개 컴포넌트를 반드시 함께 갱신 (한쪽만 새 버전이면 훅/라우팅 호환성 깨짐)
- gstack 업그레이드 후 `~/.gstack/just-upgraded-from`을 체크해서 CHANGELOG 하이라이트 표시
- 원격 머신 업그레이드 전파는 `tfx-remote` + SSH scp로 수동 (자동화 예정)
- **Gemini CLI → Antigravity CLI dual-lane 정책** (사용자 결정 2026-05-20): triflux 헤드리스 lane (`gemini -p`, `tfx-route.sh` gemini agent)은 **진짜 Antigravity CLI (TUI, `curl install.sh`)** 만 대체 가능. macOS Cask의 `agy chat` 은 GUI 패널 launcher라 headless 아님. 6/18 deadline 까지 두 lane 병행, 진짜 Antigravity CLI 설치 후 `agy --help` / `antigravity --help` 출력으로 마이그레이션 명령을 1차 검증한 뒤 `tfx-route.sh` lane 어댑테이션.
- **Antigravity CLI 마이그레이션은 자동** (1차 binary 검증 2026-05-20, `~/.gemini/antigravity-cli/cli.log` verbatim `gemini_extensions.go:98] Successfully migrated 4 extensions`, 27ms 소요). `curl install.sh` 설치 → 첫 `agy` 실행 시 onboarding UI 끝나면 `~/.gemini/extensions/` 의 모든 extension 을 `~/.gemini/antigravity-cli/plugins/<name>/skills/` 로 자동 변환하고 `import_manifest.json` 에 기록. **수동 `agy plugin import` 명령 불필요** (단, 명령 자체는 존재 — `agy plugin help` verbatim: `import [source]   Import plugins from gemini or claude`. source 인자는 `gemini` 또는 `claude` 둘 다 지원).
- **Antigravity CLI 헤드리스 옵션 verbatim** (`agy --help` 1차 출처): `--print`/`-p`/`--prompt` (= Gemini CLI `-p`), `--dangerously-skip-permissions` (= Gemini CLI `--yolo`), `--sandbox`, `--continue`/`-c`, `--conversation <ID>`, `--add-dir`. Subcommands: `changelog`, `help`, `install`, `plugin`/`plugins`, `update`. **`agy chat` subcommand 부재** (그건 IDE Cask 의 `/opt/homebrew/bin/agy` 가 만든 GUI 패널 launcher — 동명이몸 binary 와 혼동 금지).
- **인증 lane 공유**: `~/.gemini/oauth_creds.json` 을 Antigravity CLI 가 그대로 재사용 (1차 검증: `agy --print "ok"` smoke test 성공, 별도 sign-in 불필요). 단 2026-06-18 deadline 시 OAuth 자체가 끊기면 Antigravity CLI 도 영향 받음 (별도 우회 lane 미확정).
- **PATH 우선순위 충돌 주의**: macOS 에서 Cask IDE 의 `/opt/homebrew/bin/agy` (VS Code launcher) 와 CLI 의 `~/.local/bin/agy` (TUI 1.0.0) 가 모두 PATH 에 존재. 기본 PATH 순서 (`~/.local/bin` 우선) 면 CLI 가 호출되지만, `which -a agy` 로 우선순위 확인 필수. `/opt/homebrew/bin/agy` 를 명시 호출하면 IDE GUI 가 뜬다.
- **Antigravity 경로 규약** (출처별 정정, 2026-05-20 실측):
  - **CLI 1.0.0 실측 base** (`agy` binary 가 실제로 쓰는 경로): `~/.gemini/antigravity-cli/{brain,cache,conversations,implicit,knowledge,log,plugins,updater}/` + `import_manifest.json` + `installation_id` + `settings.json` (mode 600) + `keybindings.json` (mode 600) + `last_check.timestamp`. 마이그레이션된 plugin skills 는 `~/.gemini/antigravity-cli/plugins/<plugin>/skills/<skill>/`.
  - **IDE Cask (Antigravity 2.0) 경로** (Google Codelab 출처): 글로벌 skills `~/.gemini/antigravity/skills/` · 글로벌 workflows `~/.gemini/antigravity/global_workflows/` · 워크스페이스 `.agents/{rules,workflows,skills}/` (복수형 `s`).
  - **공통**: 글로벌 rules `~/.gemini/GEMINI.md` (Gemini CLI · Antigravity CLI · Antigravity IDE 가 모두 같은 path 공유).
  - **주의**: `~/.gemini/antigravity-cli/` (CLI 전용) 와 `~/.gemini/antigravity/` (IDE 전용) 는 **별개** path. third-party docs 의 `.agent/` (단수) 는 잘못된 경로.
