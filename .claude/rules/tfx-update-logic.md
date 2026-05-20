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

## Antigravity CLI 1.0.0 정밀 sanity matrix 발견 (2026-05-20)

agy CLI 1.0.0 의 prompt 전달 mechanism 정밀 검증 결과 (정밀 sanity matrix 10종 + context7 3개 출처 + 공식 docs verbatim):

- **`--print` 는 string value-taking flag** (Go flag library 기본): T1 `--print=hi` → "hi" ✅, T2 `--print` alone → "flag needs an argument" (exit 2). 즉 boolean flag 가 아님.
- **flag 순서 critical**: `--print` 가 먼저 + 다른 flag 가 뒤 = **timeout** (T6 `--print --add-dir /tmp 'prompt'`, T9 `--print --sandbox 'prompt'` 둘 다 exit 124 timeout — `--print` value 로 다음 flag 흡수). 정상 패턴 3가지:
  - `--dangerously-skip-permissions --print VALUE` (T10) — flag swap
  - `--print=VALUE` (T1) — `=` syntax (Go flag default)
  - `--print --dangerously-skip-permissions` + stdin pipe (T4/D) — wrapper Tier 2 (PR #296) 채택
- **CLI TUI 모델 = account-dependent** (사용자 직접 확인 2026-05-20):
  - **사내 계정 5개**: Gemini 3.1 Pro (High), Gemini 3.1 Pro (Low), **Gemini 3.5 Flash (default current)**, Gemini 3.5 Flash (Low), Gemini 3 Flash
  - 개인 계정 4개 (이전 메모): Gemini 3.5 Flash High/Med, Gemini 3.1 Pro High/Low
  - context7 `/llmstxt/sirius-red` 의 7개 (Gemini 3 Pro high/low/Flash, Claude Sonnet 4.5/thinking, Opus 4.5 thinking, GPT-OSS) 는 **IDE Antigravity 2.0 모델 리스트로 추정** (CLI TUI 와 별개)
- **`/model` slash command** (CLI 안에서) = default 모델 변경 + **persists across sessions** (공식 docs verbatim). settings 저장 위치 미확정 (`~/.gemini/antigravity-cli/settings.json` 에 model 항목 부재, 추정 in-memory 또는 hidden state — 사용자 직접 검증 필요).
- **모델 선택 sticky scope**: "The choice of reasoning model is sticky between user messages within a conversation" (공식 docs verbatim) — 새 conversation 시 default 적용.
- **CLI launch flag override 가능 항목**: `--sandbox`, `--dangerously-skip-permissions` **2개만** (verbatim). `-m`/`--model` flag 부재 = wrapper 가 헤드리스 호출 시 model 통제 불가 (drop-down UI 만 가능).
- **`/model` 외 주요 slash commands** (공식 docs verbatim): `/resume` (alias `/switch`), `/rewind` (alias `/undo`), `/rename <name>`, `/permissions`, `/keybindings`, `/statusline`, `/tasks`, `/skills`, `/mcp`, `/open <path>`, `/usage`, `/logout`.
- **agy subagents framework** (공식 docs verbatim): `/tasks` panel (monitor/view-logs/terminate background tasks) + `/agents` panel (running subagents UI, ctrl+j teleport, ctrl+k fast-approve) + asynchronous subagents (parallel work, background research, system tests). triflux hub/team_mode 와 **중복/통합 가능 영역** — 별도 분석 PRD `.triflux/plans/agy-subagents-integration-eval.md`.
- **MCP server config 위치 변경**: Gemini CLI 의 `~/.gemini/settings.json` (inline mcpServers) → Antigravity CLI 의 **`~/.gemini/antigravity-cli/mcp_config.json`** (별도 file) + workspace 는 `.agents/mcp_config.json`. **`serverUrl` field** (Gemini 의 `url`/`httpUrl` 대신).
- **workspace context 호환**: GEMINI.md + AGENTS.md 둘 다 읽음. Global rules `~/.gemini/GEMINI.md` (Gemini CLI 와 공유).
- **plugin import 명령 verbatim**: `agy plugin import gemini` — Gemini CLI extensions → Antigravity plugins 자동 변환 (`~/.gemini/antigravity-cli/plugins/<name>/skills/`).
- **wrapper Tier 2 (PR #296)** 의 antigravity stdin pipe 분기 + no-op 승격 skip + auto_reroute tri-lane 확장 = 위 mechanism 의 운영 적용. 회귀테스트 (PR #297) 의 5 test 가 mechanism lock-in.

후속 PRD:
- `.triflux/plans/agy-subagents-integration-eval.md` — triflux hub vs agy subagents 책임 매트릭스 + 통합 시나리오 3가지
- `.triflux/plans/node-cli-single-entry-migration.md` — wrapper 2609줄 Bash → Node 전환 plan (책임 16가지 매핑 + Phase 0~3)
