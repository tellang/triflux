# CLI Parameter Reference — Claude Code / Codex / Gemini

> 2026-04-16 기준. 공식 docs + --help + 소스코드에서 직접 수집.

---

## 비교 요약

| 항목 | Claude Code | Codex (Rust) | Gemini |
|------|------------|--------------|--------|
| 최상위 플래그 | ~55개 | ~18개 | ~20개 |
| 서브커맨드 | 10개 | 15개 | 5개 (슬래시 30+) |
| 설정 파일 | settings.json | config.toml | settings.json |
| 설정 키 | 100+ | 60+ | 200+ |
| 환경변수 | 120+ | 6개 | — |
| 비대화형 | `-p`/`--print` | `exec` 서브커맨드 | `-p`/`--prompt` |
| 샌드박스 | settings sandbox 섹션 | `-s` 플래그 (3단계) | `--sandbox` boolean |
| 자동승인 | `--permission-mode` | `--full-auto`/`--yolo` | `--yolo`/`--approval-mode` |
| MCP | `claude mcp` | `codex mcp` | `/mcp` 슬래시 |
| 모델 선택 | `--model sonnet` | `-m gpt-5.4` | `-m gemini-2.5-pro` |
| 세션 재개 | `-r`/`--resume` | `codex resume` | `-r`/`--resume` |
| 워크트리 | `-w`/`--worktree` | — | `-w`/`--worktree` |

---

## 1. Claude Code CLI

### 최상위 플래그 (주요)

| 플래그 | 타입 | 설명 |
|--------|------|------|
| `-p`/`--print` | bool | 비대화형 출력 후 종료 |
| `--model <model>` | string | 모델 선택 (sonnet, opus, haiku) |
| `--effort <level>` | enum | low/medium/high/max |
| `-c`/`--continue` | bool | 최근 대화 이어가기 |
| `-r`/`--resume` | string | 세션 ID로 재개 |
| `--permission-mode` | enum | default/acceptEdits/plan/auto/dontAsk/bypassPermissions |
| `--dangerously-skip-permissions` | bool | 모든 권한 확인 건너뜀 |
| `-w`/`--worktree` | string | Git worktree 생성 |
| `--system-prompt` | string | 시스템 프롬프트 지정 |
| `--append-system-prompt` | string | 기본 시스템 프롬프트에 추가 |
| `--mcp-config` | string[] | MCP 서버 JSON 설정 로드 |
| `--max-turns` | number | 에이전트 턴 제한 (print 모드) |
| `--max-budget-usd` | number | API 비용 상한 (print 모드) |
| `--output-format` | enum | text/json/stream-json |
| `--json-schema` | string | 구조화 출력 JSON Schema |
| `--tools` | string[] | 사용 가능 도구 제한 |
| `--allowedTools` | string[] | 허용할 도구 목록 |
| `--disallowedTools` | string[] | 거부할 도구 목록 |
| `--add-dir` | string[] | 추가 디렉토리 접근 허용 |
| `--agent` | string | 세션 에이전트 지정 |
| `--agents` | JSON | 커스텀 에이전트 정의 |
| `--bare` | bool | 최소 모드 (hooks/LSP/plugin 건너뜀) |
| `--fallback-model` | string | 오버로드 시 폴백 모델 |
| `--ide` | bool | IDE 자동 연결 |
| `--tmux` | bool | tmux 세션 생성 (--worktree 필요) |
| `--verbose` | bool | 상세 모드 |
| `-d`/`--debug` | string | 디버그 (카테고리 필터 가능) |
| `--teammate-mode` | enum | auto/in-process/tmux |
| `--remote` | string | claude.ai 웹 세션 생성 |
| `--teleport` | bool | 웹 세션을 로컬로 가져오기 |

### 서브커맨드

| 커맨드 | 설명 |
|--------|------|
| `claude plugin` | 플러그인 관리 (install/uninstall/enable/disable/update) |
| `claude mcp` | MCP 서버 설정 |
| `claude config` | 인터랙티브 설정 |
| `claude auth` | 인증 (login/logout/status) |
| `claude agents` | 에이전트 목록 |
| `claude doctor` | 상태 진단 |
| `claude update` | 업데이트 |
| `claude auto-mode` | 자동 모드 분류기 확인 |
| `claude setup-token` | CI용 장기 토큰 생성 |

### 환경변수 (주요)

| 변수 | 설명 |
|------|------|
| `ANTHROPIC_API_KEY` | API 키 |
| `ANTHROPIC_MODEL` | 모델 오버라이드 |
| `ANTHROPIC_BASE_URL` | API 엔드포인트 |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | 최대 출력 토큰 |
| `CLAUDE_CODE_EFFORT_LEVEL` | 노력 수준 |
| `CLAUDE_CODE_DISABLE_THINKING` | 사고 비활성화 |
| `CLAUDE_CODE_SUBAGENT_MODEL` | 서브에이전트 모델 |
| `CLAUDE_CODE_USE_BEDROCK` | Bedrock 사용 |
| `CLAUDE_CODE_USE_VERTEX` | Vertex 사용 |
| `CLAUDE_CODE_SHELL` | 셸 오버라이드 |
| `BASH_DEFAULT_TIMEOUT_MS` | Bash 타임아웃 (기본 120s) |
| `API_TIMEOUT_MS` | API 타임아웃 (기본 600s) |

---

## 2. Codex CLI (Rust)

### 최상위 플래그

| 플래그 | 단축 | 타입 | 설명 |
|--------|------|------|------|
| `[PROMPT]` | — | string | 초기 프롬프트 |
| `--model` | `-m` | string | 모델 (예: gpt-5.4) |
| `--image` | `-i` | path[] | 이미지 첨부 |
| `--sandbox` | `-s` | enum | read-only/workspace-write/danger-full-access |
| `--ask-for-approval` | `-a` | enum | untrusted/on-request/never |
| `--full-auto` | — | bool | workspace-write + 자동승인 |
| `--yolo` | — | bool | 모든 제한 해제 |
| `--profile` | `-p` | string | config.toml 프로필 |
| `--cd` | `-C` | path | 작업 디렉토리 |
| `--add-dir` | — | path[] | 추가 쓰기 허용 디렉토리 |
| `--search` | — | bool | 웹 검색 활성화 |
| `--oss` | — | bool | 로컬 LLM 사용 |
| `--config` | `-c` | key=value | config 인라인 오버라이드 |
| `--enable`/`--disable` | — | feature | 피처 플래그 토글 |

### 서브커맨드

| 커맨드 | 설명 |
|--------|------|
| `codex exec` | 비대화형 실행 |
| `codex review` | 코드 리뷰 (exec review 별칭) |
| `codex resume` | 세션 재개 (TUI) |
| `codex fork` | 세션 분기 |
| `codex apply` | Cloud diff 적용 |
| `codex mcp` | MCP 서버 관리 |
| `codex mcp-server` | Codex를 MCP 서버로 실행 |
| `codex login`/`logout` | 인증 |
| `codex sandbox` | 샌드박스 디버깅 |
| `codex completion` | 셸 자동완성 |
| `codex features` | 피처 플래그 관리 |

### codex exec 플래그

| 플래그 | 설명 |
|--------|------|
| `--json` | JSONL 이벤트 출력 |
| `--output-last-message` | 최종 메시지 파일 저장 |
| `--output-schema` | JSON Schema 검증 |
| `--ephemeral` | 디스크 저장 안 함 |
| `--skip-git-repo-check` | Git 외부 실행 허용 |
| `--color` | always/never/auto |

### codex review 플래그

| 플래그 | 설명 |
|--------|------|
| `--uncommitted` | staged+unstaged 리뷰 |
| `--base <branch>` | 브랜치 대비 diff 리뷰 |
| `--commit <SHA>` | 특정 커밋 리뷰 |
| `--title` | 리뷰 제목 |

### config.toml 키 (주요)

| 키 | 타입 | 설명 |
|----|------|------|
| `model` | string | 모델 |
| `model_reasoning_effort` | enum | minimal/low/medium/high/xhigh |
| `sandbox_mode` | enum | 샌드박스 정책 |
| `approval_policy` | enum/table | 승인 정책 |
| `shell_environment_policy.inherit` | enum | all/core/none |
| `web_search` | enum | disabled/cached/live |
| `mcp_servers.<id>.*` | table | MCP 서버 설정 |
| `profiles.<name>.*` | table | 프로필별 오버라이드 |
| `notify` | string[] | 완료 알림 명령 |
| `features.*` | bool | 피처 플래그 |
| `tui.*` | table | TUI 설정 |

---

## 3. Gemini CLI

### 최상위 플래그

| 플래그 | 단축 | 타입 | 설명 |
|--------|------|------|------|
| `[query]` | — | string | 초기 프롬프트 |
| `--prompt` | `-p` | string | 비대화형 모드 (deprecated) |
| `--prompt-interactive` | `-i` | string | 프롬프트 후 대화형 유지 |
| `--model` | `-m` | string | 모델 (gemini-2.5-pro 등) |
| `--sandbox` | `-s` | bool | 샌드박스 (Docker/Podman) |
| `--yolo` | `-y` | bool | 모든 도구 자동승인 |
| `--approval-mode` | — | enum | default/auto_edit/yolo/plan |
| `--debug` | `-d` | bool | 디버그 (F12 콘솔) |
| `--output-format` | `-o` | enum | text/json/stream-json |
| `--resume` | `-r` | string | 세션 재개 (latest/인덱스/UUID) |
| `--worktree` | `-w` | string | Git worktree 생성 |
| `--extensions` | `-e` | string[] | 활성화할 익스텐션 |
| `--include-directories` | — | string[] | 추가 디렉토리 (최대 5개) |
| `--allowed-tools` | — | string | 확인 없이 허용할 도구 |
| `--checkpointing` | — | bool | 파일 수정 전 스냅샷 |
| `--screen-reader` | — | bool | 접근성 모드 |
| `--acp` | — | bool | Agent Communication Protocol 모드 |
| `--policy` | — | string[] | 추가 정책 파일 |
| `--raw-output` | — | bool | ANSI 이스케이프 허용 |

### 슬래시 커맨드 (주요)

| 커맨드 | 설명 |
|--------|------|
| `/mcp list\|auth\|reload\|enable\|disable` | MCP 서버 관리 |
| `/extensions list\|install\|update\|enable\|disable` | 익스텐션 관리 |
| `/skills list\|enable\|disable\|reload` | 스킬 관리 |
| `/hooks list\|enable\|disable` | 훅 관리 |
| `/agents list\|enable\|disable\|config` | 에이전트 관리 |
| `/model set\|manage` | 모델 전환 |
| `/memory add\|list\|refresh` | GEMINI.md 메모리 |
| `/chat save\|resume\|list\|share` | 세션 관리 |
| `/compress` | 컨텍스트 압축 |
| `/restore` | 파일 복원 |
| `/settings` | 설정 에디터 |
| `/stats session\|model\|tools` | 통계 |

### settings.json 키 (주요 카테고리)

| 카테고리 | 주요 키 |
|---------|---------|
| `general` | preferredEditor, vimMode, defaultApprovalMode, checkpointing, plan |
| `model` | name, maxSessionTurns, compressionThreshold |
| `ui` | theme, inlineThinkingMode, compactToolOutput, footer, accessibility |
| `tools` | sandbox, shell.*, core, allowed, exclude, useRipgrep |
| `security` | disableYoloMode, disableAlwaysAllow, folderTrust, auth |
| `context` | fileName, includeDirectoryTree, fileFiltering, memoryBoundaryMarkers |
| `mcpServers` | command, args, env, url, trust, includeTools, excludeTools |
| `hooks` | BeforeTool, AfterTool, SessionStart, SessionEnd, BeforeModel |
| `skills` | enabled, disabled |
| `agents` | overrides, browser.* |
| `experimental` | enableAgents, worktrees, jitContext, memoryManager |

---

## triflux에서의 활용

| 용도 | Claude | Codex | Gemini |
|------|--------|-------|--------|
| 비대화형 실행 | `claude -p "prompt"` | `codex exec "prompt"` | `gemini -p "prompt"` |
| 자동승인 | `--permission-mode bypassPermissions` | `--yolo` | `-y` |
| JSON 출력 | `--output-format stream-json` | `--json` | `-o stream-json` |
| MCP 연결 | `--mcp-config file.json` | config.toml `[mcp_servers]` | settings.json `mcpServers` |
| 세션 재개 | `claude -r <id>` | `codex resume --last` | `gemini -r latest` |
