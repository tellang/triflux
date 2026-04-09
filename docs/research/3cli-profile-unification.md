# 3-CLI Profile Unification Research

> Date: 2026-04-09 | Target: Claude Code, Codex CLI, Gemini CLI
> Status: Expanded — actual config files verified (v2)

---

## 1. Config Comparison (Summary)

| Item | Claude | Codex | Gemini |
|------|--------|-------|--------|
| Config file | `~/.claude/settings.json` | `~/.codex/config.toml` | `~/.gemini/settings.json` |
| Profile config | none (triflux custom possible) | `[profiles.name]` TOML sections | `~/.gemini/triflux-profiles.json` (triflux custom) |
| Project config | `CLAUDE.md` | `CODEX.md`, `AGENTS.md` | `GEMINI.md` (global) |
| Model selection | `CLAUDE_CODE_EFFORT_LEVEL` env + API param | `model` in config + `--profile` flag | `--model` flag, `settings.json model.name` |
| Effort system | `CLAUDE_CODE_EFFORT_LEVEL` (low/medium/high/max) | `model_reasoning_effort` (low/medium/high/xhigh) | none |
| Sandbox | none | `sandbox = "elevated"` in `[windows]` | none |
| Approval mode | `permissions.defaultMode` in settings.json | `approval_mode = "full-auto"` in config | `--yolo` flag |
| MCP | `mcpServers` in settings.json | `[mcp_servers.*]` in config.toml | `mcpServers` in settings.json |
| Context window | 200K (default) | `model_context_window = 1000000` | 1M (fixed, model-dependent) |
| Project doc fallback | CLAUDE.md | CODEX.md → AGENTS.md | GEMINI.md |
| Auth | API key / OAuth | API key | OAuth personal (`oauth-personal`) |

---

## 2. Claude Code — 실제 설정 체계 상세

### 2.1 `~/.claude/settings.json` 실측 구조

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "CLAUDE_CODE_EFFORT_LEVEL": "max",
    "CLAUDE_CODE_GIT_BASH_PATH": "C:\\Program Files\\Git\\bin\\bash.exe",
    "DISABLE_AUTOUPDATER": "1"
  },
  "includeCoAuthoredBy": false,
  "permissions": {
    "defaultMode": "default"
  },
  "hooks": {
    "PreToolUse": [...],
    "PostToolUse": [...],
    "UserPromptSubmit": [...],
    "SessionStart": [...],
    "Stop": [...],
    "SubagentStop": [...]
  },
  "statusLine": { "type": "command", "command": "..." },
  "enabledPlugins": { ... },
  "mcpServers": {
    "tfx-hub": { "url": "http://127.0.0.1:27888/mcp" }
  },
  "language": "한국어",
  "skipDangerousModePermissionPrompt": true,
  "teammateMode": "auto",
  "remoteControlAtStartup": true
}
```

### 2.2 Claude 프로필 시스템 부재 — 상세

Claude Code에는 Codex의 `--profile` 플래그에 해당하는 네이티브 프로필 시스템이 없다.
모델 선택은 두 가지 경로로만 이루어진다:

1. **환경 변수**: `CLAUDE_CODE_EFFORT_LEVEL` — `low | medium | high | max`
   - 이 값은 API 요청의 `thinking budget`에 매핑됨
   - settings.json `env` 섹션에서 전역 기본값 설정 가능
   - 현재 실측값: `"max"` (전역 기본)

2. **API 파라미터**: 모델 ID를 직접 지정 (`claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`)
   - Claude Code CLI에서는 세션 시작 시 `--model` 플래그로 지정
   - headless/서브에이전트 모드에서는 지원 안 됨

### 2.3 Permission Modes

| 모드 | 설명 | triflux 사용 여부 |
|------|------|-----------------|
| `default` | 도구 사용 시 확인 요청 | 전역 기본 |
| `plan` | 실행 전 계획 수립 모드 | 미사용 |
| `auto` | 자동 승인 | 미사용 |
| `acceptEdits` | 파일 편집만 자동 | 미사용 |
| `bypassPermissions` | 모든 권한 자동 | headless 모드 전용 |

현재 triflux에서 Claude Code 네이티브 실행은 `explore` / `claude-native` 에이전트 타입으로만 호출되며, 이때 `bypassPermissions`는 사용하지 않는다.

### 2.4 Hook 구조

settings.json hooks 섹션은 triflux hook-orchestrator.mjs를 모든 이벤트에 연결한다:

- **PreToolUse**: hook-orchestrator (8s) + headless-guard-fast.sh (3s, Bash|Agent 한정) + tfx-gate-activate.mjs (2s, Skill 한정)
- **PostToolUse / PostToolUseFailure**: hook-orchestrator (8s)
- **UserPromptSubmit**: hook-orchestrator (10s)
- **SessionStart**: hook-orchestrator (15s)
- **Stop**: hook-orchestrator (35s)
- **SubagentStop**: hook-orchestrator (8s)

이 구조는 Claude Code에서 "프로필" 개념을 흉내 내는 한 방법이다. 예를 들어 SessionStart 훅에서 `CLAUDE_CODE_EFFORT_LEVEL`을 동적으로 설정할 수 있다. 하지만 현재 triflux는 이를 활용하지 않는다.

---

## 3. Codex CLI — 실제 설정 체계 상세

### 3.1 `~/.codex/config.toml` 최상위 필드 (실측)

```toml
notify = ["node", "path/to/notify-hook.js"]
model_reasoning_effort = "high"          # 전역 기본 effort
developer_instructions = "..."           # 전역 시스템 프롬프트
model_instructions_file = "path.md"      # 외부 시스템 프롬프트 파일

model_context_window = 1000000
model_auto_compact_token_limit = 900000

model = "gpt-5.4"                        # 전역 기본 모델
personality = "pragmatic"
approval_mode = "full-auto"
suppress_unstable_features_warning = true

project_doc_fallback_filenames = ["CODEX.md", "AGENTS.md"]
service_tier = "fast"
```

### 3.2 Profiles 섹션 — 12개 실측

**5.4 시리즈** (에이전틱, 1M 컨텍스트, computer use)

| 프로필 | 모델 | Effort | 특성 |
|--------|------|--------|------|
| `gpt54_xhigh` | `gpt-5.4` | xhigh | 최고 품질, 최장 응답 |
| `gpt54_high` | `gpt-5.4` | high | 고품질 범용 |
| `gpt54_low` | `gpt-5.4` | low | 빠른 5.4 응답 |

**5.3-codex 시리즈** (SWE-Bench 72%, Terminal-Bench 77% — 순수 코딩 최강)

| 프로필 | 모델 | Effort | 특성 |
|--------|------|--------|------|
| `codex53_xhigh` | `gpt-5.3-codex` | xhigh | 코딩 최강, 최고 품질 |
| `codex53_high` | `gpt-5.3-codex` | high | 코딩 고품질 (기본) |
| `codex53_med` | `gpt-5.3-codex` | medium | 코딩 중간 |
| `codex53_low` | `gpt-5.3-codex` | low | 코딩 경량 |

**5.3-codex-spark 시리즈** (Cerebras 1000 tok/s, 린트/포맷 특화)

| 프로필 | 모델 | Effort | 특성 |
|--------|------|--------|------|
| `spark53_low` | `gpt-5.3-codex-spark` | low | 초고속 경량 |
| `spark53_med` | `gpt-5.3-codex-spark` | medium | 초고속 중간 |

**5.4-mini 시리즈** ($0.75/M 경량)

| 프로필 | 모델 | Effort | 특성 |
|--------|------|--------|------|
| `mini54_low` | `gpt-5.4-mini` | low | 최저 비용 |
| `mini54_med` | `gpt-5.4-mini` | medium | 경량 중간 |
| `mini54_high` | `gpt-5.4-mini` | high | 경량 고품질 |

### 3.3 Platform-specific 오버라이드

```toml
[windows]
sandbox = "elevated"
approval_mode = "full-auto"
```

이 섹션은 Windows에서만 적용된다. triflux의 `build_codex_base()` 함수가 이를 감지하여 CLI 중복 플래그를 방지한다:

```bash
# scripts/tfx-route.sh
_CODEX_HAS_SANDBOX=""
if [[ -f "$_CODEX_CONFIG" ]] && grep -qE '^\s*(sandbox|approval_mode)\s*=' "$_CODEX_CONFIG"; then
  _CODEX_HAS_SANDBOX="1"
fi

build_codex_base() {
  if [[ -n "$_CODEX_HAS_SANDBOX" ]]; then
    echo "--skip-git-repo-check"           # sandbox 중복 방지
  else
    echo "--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check"
  fi
}
```

### 3.4 Model Migration 테이블

config.toml의 `[notice.model_migrations]` 섹션이 구형 모델 이름을 자동으로 새 모델로 리디렉트한다:

```toml
[notice.model_migrations]
"gpt-5.1-codex-mini" = "gpt-5.3-codex"
"gpt-5.3-codex" = "gpt-5.4"
```

이는 통일 프로파일 설계에서 중요한 함의를 갖는다. 기존 프로필의 모델명이 자동으로 업그레이드될 수 있으므로, 통일 스키마도 동일한 migration 레이어를 가져야 한다.

### 3.5 Feature Flags

```toml
[features]
unified_exec = true
shell_snapshot = true
multi_agent = true
js_repl = true
apps = true
prevent_idle_sleep = true
child_agents_md = true
```

### 3.6 Agent 스레드 제한

```toml
[agents]
max_threads = 6
max_depth = 2
```

swarm 설계 시 이 제한이 병렬 실행 상한을 결정한다.

### 3.7 CLI 실행 패턴 (실측 — codex-adapter.mjs 기반)

```
codex [--profile <name>] exec \
  --dangerously-bypass-approvals-and-sandbox \
  --skip-git-repo-check \
  [--output-last-message <file>] \
  [--color never] \
  [--cwd <dir>] \
  [-c mcp_servers.<name>.enabled=false] \
  "<prompt>"
```

프로필이 지정되면 `model`, `model_reasoning_effort` 등 config.toml의 프로필 섹션 값이 자동으로 적용된다.

---

## 4. Gemini CLI — 실제 설정 체계 상세

### 4.1 `~/.gemini/settings.json` 실측 구조

```json
{
  "tools": {
    "shell": { "enableInteractiveShell": false }
  },
  "security": {
    "auth": { "selectedType": "oauth-personal" }
  },
  "mcpServers": {
    "tfx-hub": { "url": "http://127.0.0.1:27888/mcp" }
  },
  "general": {
    "sessionRetention": {
      "warningAcknowledged": true,
      "enabled": true,
      "maxAge": "30d"
    }
  },
  "model": {
    "name": "gemini-3-flash-preview"
  },
  "context": {
    "fileFiltering": {
      "respectGitIgnore": false,
      "respectGeminiIgnore": false
    }
  }
}
```

주목할 점: `model.name` 필드가 기본 모델을 설정하지만, CLI에서 `--model` 플래그로 항상 오버라이드할 수 있다.

### 4.2 `~/.gemini/triflux-profiles.json` 실측 구조

```json
{
  "model": "gemini-3.1-pro-preview",
  "profiles": {
    "pro31": {
      "model": "gemini-3.1-pro-preview",
      "hint": "3.1 Pro — 플래그십 (1M ctx, 멀티모달)"
    },
    "flash3": {
      "model": "gemini-3-flash-preview",
      "hint": "3.0 Flash — 빠른 응답, 비용 효율"
    },
    "pro25": {
      "model": "gemini-2.5-pro",
      "hint": "2.5 Pro — 안정 (추론 강화)"
    },
    "flash25": {
      "model": "gemini-2.5-flash",
      "hint": "2.5 Flash — 경량 범용"
    },
    "lite25": {
      "model": "gemini-2.5-flash-lite",
      "hint": "2.5 Flash Lite — 최경량"
    }
  }
}
```

### 4.3 Gemini CLI 실행 패턴 (실측 — gemini-adapter.mjs 기반)

```
gemini \
  [--model <model-id>] \
  --yolo \
  [--allowed-mcp-server-names <name1> <name2> ...] \
  --prompt "<prompt>" \
  --output-format text \
  > <result-file> 2> <result-file>.err
```

Codex와 달리:
- `--profile` 플래그 없음 → 모델 이름 직접 지정
- `--yolo` = full-auto (Codex의 `--dangerously-bypass-approvals-and-sandbox` 대응)
- MCP 서버는 allowlist 방식 (`--allowed-mcp-server-names`)
- Effort 개념 없음 → 모델 선택이 유일한 성능 레버

### 4.4 `resolve_gemini_profile()` 로직 (tfx-route.sh 실측)

```bash
resolve_gemini_profile() {
  local profile="$1"
  # 이미 gemini-* 형태면 그대로 반환
  if [[ "$profile" == gemini-* ]]; then
    echo "$profile"; return
  fi
  # triflux-profiles.json 캐시 로드
  # node로 JSON 파싱 → profiles[name].model 추출
  # 폴백: 하드코딩 defaults 딕셔너리
  # defaults = { pro31: 'gemini-3.1-pro-preview', flash3: 'gemini-3-flash-preview', ... }
}
```

이 함수가 중간 레이어 역할을 하지만, JSON 파싱에 node를 직접 호출하는 구조여서 프로세스 오버헤드가 있다.

### 4.5 `~/.gemini/` 디렉토리 전체 구조

```
~/.gemini/
├── settings.json           # 공식 설정 (auth, model, mcpServers, tools)
├── triflux-profiles.json   # triflux 커스텀 프로파일 레지스트리
├── GEMINI.md               # 전역 시스템 프롬프트 (Codex CODEX.md 대응)
├── google_accounts.json    # OAuth 계정 정보
├── gemini-credentials.json # API 자격증명
├── oauth_creds.json        # OAuth 토큰
├── trustedFolders.json     # 신뢰 폴더 목록
├── projects.json           # 프로젝트 등록
├── extension_integrity.json
├── extensions/             # 확장 디렉토리
├── skills/                 # 커스텀 스킬
├── commands/               # 커스텀 명령
├── history/                # 대화 이력
├── logs/                   # 실행 로그
├── tmp/                    # 임시 파일
└── backups/                # 설정 백업
```

---

## 5. 현재 라우팅 로직 상세 분석 (tfx-route.sh)

### 5.1 에이전트 → CLI 매핑 테이블 (실측)

`route_agent()` 함수가 에이전트 타입별로 `CLI_TYPE`, `CLI_ARGS`, `CLI_EFFORT`, `DEFAULT_TIMEOUT`을 설정한다:

| 에이전트 | CLI | 프로파일 | Timeout | RUN_MODE | Oversight |
|---------|-----|----------|---------|----------|-----------|
| executor | codex | codex53_high | 1080s | fg | false |
| build-fixer | codex | codex53_low | 540s | fg | false |
| debugger | codex | codex53_high | 900s | bg | false |
| deep-executor | codex | gpt54_xhigh | 3600s | bg | true |
| architect | codex | gpt54_xhigh | 3600s | bg | true |
| planner | codex | gpt54_xhigh | 3600s | fg | true |
| critic | codex | gpt54_xhigh | 3600s | bg | true |
| analyst | codex | gpt54_xhigh | 3600s | fg | true |
| code-reviewer | codex | codex53_high | 1800s | bg | false |
| security-reviewer | codex | codex53_high | 1800s | bg | true |
| quality-reviewer | codex | codex53_high | 1800s | bg | false |
| scientist | codex | codex53_high | 1440s | bg | false |
| scientist-deep | codex | gpt54_high | 3600s | bg | false |
| document-specialist | codex | codex53_high | 1440s | bg | false |
| designer | gemini | pro31 | 900s | bg | false |
| writer | gemini | flash3 | 900s | bg | false |
| explore | claude-native | n/a | 600s | fg | false |
| verifier | codex | codex53_high | 1200s | fg | false |
| test-engineer | codex | codex53_high | 1200s | bg | false |
| qa-tester | codex | codex53_high | 1200s | bg | false |
| spark | codex | spark53_low | 180s | fg | false |

### 5.2 TFX_CLI_MODE 오버라이드 로직

```
TFX_CLI_MODE = auto | codex | gemini
```

- **auto**: Codex 미설치 시 Gemini, 둘 다 없으면 claude-native 폴백
- **codex**: 모든 gemini 에이전트를 codex로 리매핑 (designer → gpt54_xhigh, writer → spark53_low)
- **gemini**: 모든 codex 에이전트를 gemini로 리매핑 (verifier/test-engineer 제외 — claude-native 유지)

### 5.3 현재 라우팅의 문제점 심층 분석

**문제 1: 프로파일 네임스페이스 충돌**

같은 "고품질 코딩" 의도를 표현하는 방법이 CLI마다 다르다:
- Codex: `--profile codex53_high`
- Gemini: `-m gemini-3.1-pro-preview`
- Claude: `CLAUDE_CODE_EFFORT_LEVEL=max`

`TFX_CLI_MODE=gemini`로 전환 시, `codex53_high` 에이전트를 `pro31`로 매핑하는 하드코딩이 tfx-route.sh에 존재한다. 이 매핑은 명시적 근거 없이 유지보수된다.

**문제 2: Effort 차원 누락**

Gemini에는 effort 레버가 없다. 현재 tfx-route.sh는 이를 `gemini_tier = "pro" | "flash"` 두 단계로 단순화하여 로깅한다. 실제로는 모델 선택이 effort와 품질을 동시에 결정한다.

**문제 3: 프로파일 저장 위치 3원화**

```
~/.codex/config.toml          [profiles.*]     → Codex 네이티브
~/.gemini/triflux-profiles.json                → triflux 커스텀
~/.claude/settings.json       env 섹션 (기본값) → Claude 간접 제어
```

새 모델 추가 시 3개 파일을 모두 편집해야 한다.

**문제 4: rate limit 폴백 매핑 수동 관리**

`apply_cli_mode()` 함수 내 매핑 로직이 하드코딩되어 있다. rate limit 발생 시 자동 폴백 경로가:
- Codex rate limit → Gemini로 전환 (TFX_CLI_MODE=gemini)
- 이때 적용되는 Gemini 모델은 case 문의 하드코딩 매핑에 의존

**문제 5: 버전 기반 기능 분기**

`cli-adapter-base.mjs`의 `FEATURES` 객체가 Codex 마이너 버전을 기반으로 기능 가용성을 판단한다:
- `execSubcommand`: >= 0.110
- `outputLastMessage`: >= 0.117
- `colorNever`: >= 0.110
- `pluginSystem`: >= 0.120

이 분기는 통일 스키마가 Codex 버전별로 다른 CLI 인자를 생성해야 함을 의미한다.

---

## 6. 통일 프로파일 스키마 설계

### 6.1 설계 원칙

1. **Intent-based**: CLI 이름이 아닌 "의도(tier + effort)"로 프로파일 정의
2. **CLI-independent**: 각 CLI의 구현 세부사항을 추상화
3. **Backward-compatible**: 기존 `codex53_high`, `pro31` 등 직접 참조 유지
4. **Single source of truth**: 하나의 파일에서 모든 CLI 설정 생성
5. **Extensible**: 새 모델/CLI 추가 시 스키마 변경 최소화

### 6.2 통일 프로파일 TOML 설계 (전체)

```toml
# ~/.config/triflux/profiles.toml
# 또는 <triflux-pkg>/config/profiles.toml

[meta]
version = "1.0"
updated = "2026-04-09"

# ─────────────────────────────────────────────
# Tier: flagship — 최고 품질, 복잡한 아키텍처/설계 작업
# ─────────────────────────────────────────────
[profiles.flagship]
tier = "flagship"
effort = "xhigh"
description = "최고 품질 — 복잡한 설계, 아키텍처, 심층 분석"

[profiles.flagship.claude]
model = "claude-opus-4-6"
effort_level = "max"          # CLAUDE_CODE_EFFORT_LEVEL

[profiles.flagship.codex]
native_profile = "gpt54_xhigh"
model = "gpt-5.4"
reasoning_effort = "xhigh"

[profiles.flagship.gemini]
model = "gemini-3.1-pro-preview"
triflux_alias = "pro31"
# effort 없음 — 모델이 성능 레버

# ─────────────────────────────────────────────
# Tier: standard — 범용 고품질 (일반 구현, 코드 리뷰)
# ─────────────────────────────────────────────
[profiles.standard]
tier = "standard"
effort = "high"
description = "고품질 범용 — 구현, 리뷰, 분석"

[profiles.standard.claude]
model = "claude-sonnet-4-6"
effort_level = "high"

[profiles.standard.codex]
native_profile = "gpt54_high"
model = "gpt-5.4"
reasoning_effort = "high"

[profiles.standard.gemini]
model = "gemini-2.5-pro"
triflux_alias = "pro25"

# ─────────────────────────────────────────────
# Tier: coding — 순수 코딩 특화 (SWE-Bench 1위)
# ─────────────────────────────────────────────
[profiles.coding]
tier = "coding"
effort = "high"
description = "코딩 특화 — executor, build-fixer, verifier"

[profiles.coding.claude]
model = "claude-sonnet-4-6"
effort_level = "high"

[profiles.coding.codex]
native_profile = "codex53_high"
model = "gpt-5.3-codex"
reasoning_effort = "high"

[profiles.coding.gemini]
model = "gemini-2.5-pro"
triflux_alias = "pro25"
# Gemini에는 "coding-specialized" 모델 없음 — pro25가 최선

# ─────────────────────────────────────────────
# Tier: fast — 빠른 응답, 중간 품질
# ─────────────────────────────────────────────
[profiles.fast]
tier = "fast"
effort = "medium"
description = "중간 품질, 빠른 응답 — spark, 린트, 포맷"

[profiles.fast.claude]
model = "claude-sonnet-4-6"
effort_level = "medium"

[profiles.fast.codex]
native_profile = "codex53_med"
model = "gpt-5.3-codex"
reasoning_effort = "medium"

[profiles.fast.gemini]
model = "gemini-3-flash-preview"
triflux_alias = "flash3"

# ─────────────────────────────────────────────
# Tier: economy — 저비용 경량
# ─────────────────────────────────────────────
[profiles.economy]
tier = "economy"
effort = "low"
description = "경량 — build-fixer, 단순 변환, 요약"

[profiles.economy.claude]
model = "claude-haiku-4-5"
effort_level = "low"

[profiles.economy.codex]
native_profile = "codex53_low"
model = "gpt-5.3-codex"
reasoning_effort = "low"

[profiles.economy.gemini]
model = "gemini-2.5-flash"
triflux_alias = "flash25"

# ─────────────────────────────────────────────
# Tier: micro — 최저비용, 초고속 (Cerebras / mini)
# ─────────────────────────────────────────────
[profiles.micro]
tier = "micro"
effort = "low"
description = "최저 비용, 초고속 — spark, 린트 전용"

[profiles.micro.claude]
model = "claude-haiku-4-5"
effort_level = "low"

[profiles.micro.codex]
native_profile = "spark53_low"
model = "gpt-5.3-codex-spark"
reasoning_effort = "low"

[profiles.micro.gemini]
model = "gemini-2.5-flash-lite"
triflux_alias = "lite25"
```

### 6.3 스키마 필드 정의

| 필드 | 타입 | 설명 |
|------|------|------|
| `tier` | string | 의도 계층 (flagship/standard/coding/fast/economy/micro) |
| `effort` | string | 추상 effort (xhigh/high/medium/low) |
| `description` | string | 사람이 읽는 설명 |
| `*.model` | string | 각 CLI의 실제 모델 ID |
| `*.native_profile` | string | Codex config.toml의 네이티브 프로필 이름 (Codex 전용) |
| `*.reasoning_effort` | string | Codex model_reasoning_effort 값 |
| `*.effort_level` | string | Claude CLAUDE_CODE_EFFORT_LEVEL 값 |
| `*.triflux_alias` | string | Gemini triflux-profiles.json의 키 이름 |

---

## 7. 라우팅 변환 로직 설계

### 7.1 profile-resolver.mjs — 핵심 변환기

```javascript
// hub/profile-resolver.mjs (신규 파일)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PROFILES_PATH = join(import.meta.dirname, '../config/profiles.toml');

// TOML 파싱 — 외부 의존성 없이 직접 파싱 (단순 구조이므로)
function parseProfilesToml(text) {
  // 실제 구현: @iarna/toml 또는 smol-toml 사용
  // 여기서는 구조만 설명
}

let _cache = null;
function loadProfiles() {
  if (_cache) return _cache;
  _cache = parseProfilesToml(readFileSync(PROFILES_PATH, 'utf8'));
  return _cache;
}

/**
 * 통일 프로파일 이름 → 각 CLI에서 사용할 파라미터 반환
 *
 * @param {string} profileName - 통일 프로파일 이름 (flagship/standard/coding/fast/economy/micro)
 * @param {'codex'|'gemini'|'claude'} cli
 * @returns {{ model?: string, profile?: string, effortLevel?: string, reasoning_effort?: string }}
 */
export function resolveProfileForCli(profileName, cli) {
  const profiles = loadProfiles();

  // 패스스루: 기존 CLI 네이티브 프로파일 이름 직접 사용
  // 예: "codex53_high" → Codex에서 --profile codex53_high
  if (isNativeCodexProfile(profileName)) {
    return { profile: profileName };
  }
  if (isNativeGeminiModel(profileName)) {
    return { model: profileName };
  }

  const profile = profiles[profileName];
  if (!profile) throw new Error(`Unknown profile: ${profileName}`);

  switch (cli) {
    case 'codex':
      return {
        profile: profile.codex.native_profile,
        model: profile.codex.model,
        reasoning_effort: profile.codex.reasoning_effort,
      };
    case 'gemini':
      return {
        model: profile.gemini.model,
        triflux_alias: profile.gemini.triflux_alias,
      };
    case 'claude':
      return {
        model: profile.claude.model,
        effortLevel: profile.claude.effort_level,
      };
    default:
      throw new Error(`Unknown CLI: ${cli}`);
  }
}

/**
 * 에이전트 타입에서 권장 통일 프로파일 이름 반환
 */
export function agentToUnifiedProfile(agentType) {
  const map = {
    'executor':           'coding',
    'build-fixer':        'economy',
    'debugger':           'coding',
    'deep-executor':      'flagship',
    'architect':          'flagship',
    'planner':            'flagship',
    'critic':             'flagship',
    'analyst':            'flagship',
    'code-reviewer':      'coding',
    'security-reviewer':  'coding',
    'quality-reviewer':   'coding',
    'scientist':          'coding',
    'scientist-deep':     'standard',
    'document-specialist':'coding',
    'designer':           'flagship',    // Gemini에서는 flagship = pro31
    'writer':             'fast',        // Gemini에서는 fast = flash3
    'explore':            null,          // claude-native, 프로파일 불필요
    'verifier':           'coding',
    'test-engineer':      'coding',
    'qa-tester':          'coding',
    'spark':              'micro',
  };
  return map[agentType] ?? 'coding';  // 기본값 coding
}

/**
 * 통일 프로파일 간 폴백 체인
 * tier 내에서 성능/비용 트레이드오프 기반
 */
export function getFallbackChain(profileName) {
  const chain = {
    'flagship':  ['standard', 'coding', 'fast'],
    'standard':  ['coding',   'fast',   'economy'],
    'coding':    ['fast',     'economy'],
    'fast':      ['economy',  'micro'],
    'economy':   ['micro'],
    'micro':     [],
  };
  return chain[profileName] ?? [];
}

function isNativeCodexProfile(name) {
  const codexProfiles = [
    'gpt54_xhigh', 'gpt54_high', 'gpt54_low',
    'codex53_xhigh', 'codex53_high', 'codex53_med', 'codex53_low',
    'spark53_low', 'spark53_med',
    'mini54_low', 'mini54_med', 'mini54_high',
  ];
  return codexProfiles.includes(name);
}

function isNativeGeminiModel(name) {
  return name.startsWith('gemini-');
}
```

### 7.2 tfx-route.sh 확장 방안 (쉘 레이어)

현재 tfx-route.sh는 에이전트별 CLI 파라미터를 `route_agent()` case 문에 하드코딩한다. 통일 프로파일 도입 후:

```bash
# 현재 (하드코딩)
executor)
  CLI_ARGS="exec --profile codex53_high ${codex_base}"
  CLI_EFFORT="codex53_high" ;;

# 변경 후 (통일 프로파일 경유)
executor)
  _unified_profile="coding"
  _resolved=$(resolve_unified_profile "$_unified_profile" "$CLI_TYPE")
  CLI_ARGS="exec --profile ${_resolved} ${codex_base}"
  CLI_EFFORT="${_resolved}" ;;
```

`resolve_unified_profile()` 쉘 함수:

```bash
# 통일 프로파일 → CLI 네이티브 프로파일/모델 변환
resolve_unified_profile() {
  local unified="$1"
  local cli_type="$2"

  "$NODE_BIN" -e "
    import { resolveProfileForCli } from '${TFX_PKG_ROOT}/hub/profile-resolver.mjs';
    const r = resolveProfileForCli(process.argv[1], process.argv[2]);
    if (process.argv[2] === 'codex') process.stdout.write(r.profile || '');
    if (process.argv[2] === 'gemini') process.stdout.write(r.model || '');
    if (process.argv[2] === 'claude') process.stdout.write(r.effortLevel || '');
  " "$unified" "$cli_type" 2>/dev/null
}
```

단, Node.js ESM import를 bash에서 직접 호출하기 위해서는 `--input-type=module` 또는 CJS 래퍼가 필요하다. 실용적 구현에서는 node 인라인 스크립트 대신 별도 CLI 스크립트(`profile-resolve.cjs`)를 두는 것이 더 안정적이다.

### 7.3 apply_cli_mode() 재설계

현재 `TFX_CLI_MODE=gemini`에서 `case "$AGENT_TYPE"` 로 하드코딩된 부분을 통일 프로파일 기반으로 교체:

```bash
# 현재 (하드코딩)
executor|debugger|deep-executor|...)
  CLI_ARGS="-m $(resolve_gemini_profile pro31) -y --prompt"
  CLI_EFFORT="pro31" ;;

# 변경 후 (통일 프로파일 경유)
executor|debugger|deep-executor|...)
  _unified=$(agentToUnifiedProfile "$AGENT_TYPE")
  _model=$(resolve_unified_profile "$_unified" "gemini")
  CLI_ARGS="-m ${_model} -y --prompt"
  CLI_EFFORT="${_unified}" ;;
```

이렇게 하면 새 에이전트 추가 시 `apply_cli_mode()` 수정이 필요 없어진다.

---

## 8. 마이그레이션 계획

### Phase 1: 기반 구축 (1일)

**목표**: 통일 프로파일 정의 파일 생성 + 매핑 테이블 확정

```
tasks:
  1. packages/triflux/config/profiles.toml 생성 (섹션 6.2 기준)
  2. 기존 → 통일 프로파일 매핑 테이블 확정 (섹션 9 참조)
  3. packages/triflux/hub/profile-resolver.mjs 기초 구현
  4. unit test: resolveProfileForCli() 12개 프로파일 × 3 CLI = 36 케이스
```

**기존 프로파일 → 통일 프로파일 완전 매핑**:

| 기존 식별자 | CLI | 통일 프로파일 | 근거 |
|-----------|-----|-------------|------|
| `gpt54_xhigh` | Codex | `flagship` | GPT-5.4 최고 effort |
| `gpt54_high` | Codex | `standard` | GPT-5.4 고품질 |
| `gpt54_low` | Codex | `fast` | GPT-5.4 저 effort |
| `codex53_xhigh` | Codex | `flagship` (coding) | 코딩 최강 xhigh |
| `codex53_high` | Codex | `coding` | 코딩 표준 high (가장 빈번) |
| `codex53_med` | Codex | `fast` | 코딩 중간 |
| `codex53_low` | Codex | `economy` | 코딩 경량 |
| `spark53_low` | Codex | `micro` | Cerebras 초고속 |
| `spark53_med` | Codex | `fast` (micro+) | Cerebras 중간 |
| `mini54_low` | Codex | `micro` | 최저 비용 |
| `mini54_med` | Codex | `economy` | 경량 중간 |
| `mini54_high` | Codex | `fast` | 경량 고품질 |
| `pro31` | Gemini | `flagship` | 최신 Gemini 플래그십 |
| `flash3` | Gemini | `fast` | Gemini 빠른 응답 |
| `pro25` | Gemini | `standard` | Gemini 안정 고품질 |
| `flash25` | Gemini | `economy` | Gemini 경량 |
| `lite25` | Gemini | `micro` | Gemini 최경량 |

> **주의**: `codex53_xhigh`와 `gpt54_xhigh` 둘 다 `flagship`에 매핑되지만,
> 역방향 변환 시(통일 → Codex) flagship의 Codex 네이티브 프로필은
> `gpt54_xhigh`를 기본으로 한다. Codex 전용 코딩 작업에서 `codex53_xhigh`가
> 필요한 경우 `coding-xhigh` 등 별도 tier를 추가하거나 직접 네이티브 프로필을
> 지정하는 escape hatch가 필요하다.

### Phase 2: 변환기 구현 (2일)

```
tasks:
  1. hub/profile-resolver.mjs 완성
     - TOML 파싱 (smol-toml 사용 권장, zero-dep)
     - resolveProfileForCli() 구현
     - agentToUnifiedProfile() 구현
     - getFallbackChain() 구현
  2. scripts/tfx-route.sh에 resolve_unified_profile() 추가
  3. 기존 route_agent() case 문 하드코딩 → 통일 프로파일 경유로 교체
  4. 기존 apply_cli_mode() 교체
  5. 통합 테스트: 각 에이전트 타입별 CLI 인자 검증
```

### Phase 3: 어댑터 연동 (1일)

```
tasks:
  1. hub/codex-adapter.mjs
     - execute() opts.profile → resolveProfileForCli() 경유
     - 기존 profile 직접 참조 유지 (패스스루 레이어)
  2. hub/gemini-adapter.mjs
     - execute() opts.model → resolveProfileForCli() 경유
     - opts.unifiedProfile 파라미터 추가 (선택적)
  3. hub/conductor.mjs (존재한다면)
     - 통일 프로파일 기반 fallback 체인 자동 적용
```

### Phase 4: TUI / HUD 연동 (1일)

```
tasks:
  1. hub/team/tui.mjs
     - 에이전트별 통일 프로파일 이름 표시
     - tier 색상 코딩 (flagship=purple, standard=blue, coding=green, ...)
  2. hub/hud/ (있는 경우)
     - qos 상태에 통일 프로파일 정보 포함
  3. tfx-profile 스킬 업데이트
     - 통일 프로파일 목록 표시
     - 에이전트별 기본 프로파일 조회
```

### 하위 호환성 보장 방침

통일 프로파일 도입 후에도 다음은 계속 작동해야 한다:

```bash
# 기존 방식 그대로 작동
codex exec --profile codex53_high "..."       # Codex 네이티브 직접 참조
gemini -m gemini-2.5-pro --yolo --prompt "..." # Gemini 모델 직접 지정
tfx-route.sh executor "..."                    # 에이전트 타입 → 자동 해석

# 새로운 방식
TFX_PROFILE=coding tfx-route.sh executor "..." # 통일 프로파일 오버라이드
```

패스스루 레이어 구현:

```javascript
// profile-resolver.mjs 내부
export function resolveProfileForCli(profileName, cli) {
  // 네이티브 식별자 직접 전달 (패스스루)
  if (cli === 'codex' && isNativeCodexProfile(profileName)) {
    return { profile: profileName };
  }
  if (cli === 'gemini' && isNativeGeminiModel(profileName)) {
    return { model: profileName };
  }
  // 통일 프로파일 변환
  ...
}
```

---

## 9. 리스크 및 제약 사항

### 9.1 기술적 리스크

| 리스크 | 심각도 | 세부 내용 | 완화 방안 |
|--------|--------|----------|---------|
| config.toml 이중 관리 | 중 | 통일 프로파일과 config.toml 프로파일이 동기화 안 될 수 있음 | config.toml 자동 생성 스크립트 + CI 검증 |
| TOML 파서 의존성 | 중 | smol-toml/iarna 추가 시 bundle size 증가, node_modules 오염 | zero-dep 수동 파서 또는 JSON 포맷으로 전환 |
| 쉘-Node 경계 오버헤드 | 낮 | `resolve_unified_profile()` 호출당 node 프로세스 생성 | profile-resolve.cjs 캐시 또는 preflight에서 env export |
| Gemini 모델 매핑 손실 | 낮 | Codex의 coding-specialized 특성이 Gemini에서 재현 불가 | 문서화 + 사용자 경고 |
| 기존 직접 참조 파손 | 중 | `codex exec --profile codex53_high` 패턴이 다른 곳에 하드코딩된 경우 | Grep 조사 후 패스스루 확인 |
| model migration 레이어 불일치 | 낮 | config.toml의 migration이 통일 프로파일에 반영 안 될 수 있음 | 통일 프로파일에도 동일한 migration 섹션 추가 |

### 9.2 운영 리스크

| 리스크 | 심각도 | 세부 내용 | 완화 방안 |
|--------|--------|----------|---------|
| 통일 프로파일 캐시 stale | 중 | profiles.toml 수정 후 캐시가 갱신되지 않으면 구 프로파일 사용 | file mtime 기반 캐시 무효화 |
| 원격 호스트 동기화 | 중 | hosts.json 기반 원격 머신에 profiles.toml 미배포 | remote-spawn setup 시 profiles.toml 자동 scp |
| swarm 환경 일관성 | 중 | worktree별 다른 프로파일이 적용될 수 있음 | TFX_PROFILE 환경변수 swarm 전체에 전파 |

### 9.3 설계 제약

**Gemini effort 부재 — 근본적 제약**

Gemini CLI에는 `model_reasoning_effort` 같은 effort 파라미터가 없다. 통일 스키마의 `effort` 필드는 Gemini에서는 모델 선택으로만 표현된다:

```
effort=xhigh → gemini-3.1-pro-preview  (플래그십 모델 = 암묵적 최고 effort)
effort=high  → gemini-2.5-pro          (안정 고품질)
effort=medium → gemini-3-flash-preview  (빠른 flash)
effort=low   → gemini-2.5-flash        (경량)
```

이 매핑은 근사치이며, 같은 `effort=high`라도 Codex 5.4의 `high`와 Gemini 2.5 Pro의 실제 추론 깊이가 다를 수 있다.

**Claude 프로파일 시스템 부재 — 우회 경로**

Claude Code에 `--profile` 플래그가 없으므로, 통일 프로파일에서 Claude로의 변환은 두 파라미터로만 이루어진다:
1. `model` (API 파라미터)
2. `effortLevel` (CLAUDE_CODE_EFFORT_LEVEL 환경변수)

Claude Code를 headless로 실행하는 triflux의 경우, 현재 `explore`/`claude-native` 에이전트에서만 Claude를 사용하므로 이 제약의 실질적 영향은 낮다. 향후 Claude headless 실행이 추가된다면 SessionStart 훅을 통한 effort 주입이 필요하다.

**Windows sandbox 중복 플래그 문제**

`~/.codex/config.toml`의 `[windows]` 섹션에 `sandbox = "elevated"` 설정이 있을 때, CLI에서 `--dangerously-bypass-approvals-and-sandbox`를 중복 지정하면 Codex가 오류를 던진다. 이 동작은 `build_codex_base()` 함수로 현재 처리되고 있으며, profile-resolver.mjs의 출력에는 영향을 주지 않는다. 단, tfx-route.sh가 통일 프로파일 기반으로 CLI 인자를 조립할 때 이 체크가 여전히 수행되어야 한다.

---

## 10. 결론 및 다음 단계

### 10.1 통일 접근법 요약

통일 프로파일은 CLI별 세부 설정 위에 올라가는 **추상 레이어**다. 기존 설정을 대체하지 않는다.

```
[사용자/에이전트]
     ↓ 의도 (flagship / coding / fast ...)
[profile-resolver.mjs]  ← 통일 프로파일 TOML
     ↓ CLI 네이티브 파라미터
[codex-adapter / gemini-adapter / claude]
     ↓
[~/.codex/config.toml / ~/.gemini/settings.json / ~/.claude/settings.json]
```

### 10.2 도입 전후 비교

| 지표 | 현재 | 통일 후 |
|------|------|---------|
| 관리 포인트 | 3개 파일 + tfx-route.sh case 문 | profiles.toml 1개 |
| 새 모델 추가 | tfx-route.sh + 각 어댑터 + 각 config 파일 | profiles.toml만 |
| CLI 전환 시 매핑 | tfx-route.sh apply_cli_mode() 하드코딩 | 자동 (resolveProfileForCli) |
| 폴백 체인 | 수동 (TFX_CLI_MODE=gemini 전환) | 자동 (getFallbackChain) |
| 에이전트 추가 | route_agent() case + apply_cli_mode() case | agentToUnifiedProfile() 1줄 |
| 디버그 가시성 | CLI_EFFORT 변수 | tier + effort + 각 CLI 파라미터 |

### 10.3 즉시 실행 가능한 다음 단계

1. `packages/triflux/config/` 디렉토리 확인 및 `profiles.toml` 생성
2. `hub/profile-resolver.mjs` 기초 구현 (TOML 없이 JSON 대안으로 시작 가능)
3. `scripts/tfx-route.sh`의 `route_agent()` 중 `executor` 한 케이스를 통일 프로파일로 파일럿 전환
4. 파일럿 전환 후 `tfx-route.sh test-tfx-route-no-claude-native.mjs` 기존 테스트 통과 확인
5. 전체 에이전트로 확대 적용

---

## Appendix A: 기존 → 통일 프로파일 완전 참조표

| 기존 식별자 | CLI | 통일 tier | effort | 역방향 (통일→CLI) |
|-----------|-----|----------|--------|-----------------|
| `gpt54_xhigh` | Codex | flagship | xhigh | flagship → gpt54_xhigh |
| `gpt54_high` | Codex | standard | high | standard → gpt54_high |
| `gpt54_low` | Codex | fast | low | — (fast=codex53_med 우선) |
| `codex53_xhigh` | Codex | flagship* | xhigh | *coding-xhigh 별도 tier 권장 |
| `codex53_high` | Codex | coding | high | coding → codex53_high |
| `codex53_med` | Codex | fast | medium | fast → codex53_med |
| `codex53_low` | Codex | economy | low | economy → codex53_low |
| `spark53_low` | Codex | micro | low | micro → spark53_low |
| `spark53_med` | Codex | fast* | medium | *fast tier와 구분 필요 |
| `mini54_low` | Codex | micro | low | — (micro=spark53_low 우선) |
| `mini54_med` | Codex | economy | medium | — (economy=codex53_low 우선) |
| `mini54_high` | Codex | fast | high | — (fast=codex53_med 우선) |
| `pro31` | Gemini | flagship | xhigh | flagship → gemini-3.1-pro-preview |
| `flash3` | Gemini | fast | medium | fast → gemini-3-flash-preview |
| `pro25` | Gemini | standard | high | standard → gemini-2.5-pro |
| `flash25` | Gemini | economy | low | economy → gemini-2.5-flash |
| `lite25` | Gemini | micro | low | micro → gemini-2.5-flash-lite |

## Appendix B: 에이전트별 통일 프로파일 할당

| 에이전트 | 현재 Codex 프로파일 | 통일 프로파일 | 비고 |
|---------|----------------|-------------|------|
| executor | codex53_high | coding | 가장 빈번한 에이전트 |
| build-fixer | codex53_low | economy | 단순 빌드 오류 수정 |
| debugger | codex53_high | coding | |
| deep-executor | gpt54_xhigh | flagship | |
| architect | gpt54_xhigh | flagship | |
| planner | gpt54_xhigh | flagship | |
| critic | gpt54_xhigh | flagship | |
| analyst | gpt54_xhigh | flagship | |
| code-reviewer | codex53_high | coding | |
| security-reviewer | codex53_high | coding | |
| quality-reviewer | codex53_high | coding | |
| scientist | codex53_high | coding | |
| scientist-deep | gpt54_high | standard | |
| document-specialist | codex53_high | coding | |
| designer | pro31 (Gemini) | flagship | Gemini 네이티브 |
| writer | flash3 (Gemini) | fast | Gemini 네이티브 |
| explore | claude-native | n/a | 프로파일 불필요 |
| verifier | codex53_high | coding | |
| test-engineer | codex53_high | coding | |
| qa-tester | codex53_high | coding | |
| spark | spark53_low | micro | Cerebras 전용 |

## Appendix C: 검색 패턴 (기존 코드베이스 영향 범위 조사용)

통일 프로파일 마이그레이션 전 아래 패턴으로 기존 하드코딩을 파악한다:

```bash
# Codex 네이티브 프로파일 직접 참조
grep -r "codex53_\|gpt54_\|spark53_\|mini54_" --include="*.{mjs,sh,ts,json}"

# Gemini 네이티브 프로파일 직접 참조
grep -r "pro31\|flash3\|pro25\|flash25\|lite25" --include="*.{mjs,sh,ts,json}"

# resolve_gemini_profile 호출 위치
grep -r "resolve_gemini_profile" --include="*.sh"

# --profile 플래그 사용 위치
grep -r "\-\-profile" --include="*.{mjs,sh}"
```
