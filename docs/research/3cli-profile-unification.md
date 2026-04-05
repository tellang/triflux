# 3-CLI 프로파일 통일 리서치 보고서

> **작성일**: 2026-04-05
> **범위**: Claude CLI, Codex CLI, Gemini CLI 설정 체계 비교 분석 및 통일 프로파일 설계
> **상태**: 리서치 완료 (코드 변경 없음)

---

## 목차

1. [요약](#1-요약)
2. [Claude CLI 설정 체계](#2-claude-cli-설정-체계)
3. [Codex CLI 설정 체계](#3-codex-cli-설정-체계)
4. [Gemini CLI 설정 체계](#4-gemini-cli-설정-체계)
5. [3-CLI 비교 매트릭스](#5-3-cli-비교-매트릭스)
6. [통일 프로파일 스키마 설계](#6-통일-프로파일-스키마-설계)
7. [라우팅 변환 로직 설계](#7-라우팅-변환-로직-설계)
8. [마이그레이션 계획](#8-마이그레이션-계획)
9. [리스크 및 제약 사항](#9-리스크-및-제약-사항)
10. [결론 및 다음 단계](#10-결론-및-다음-단계)

---

## 1. 요약

### 현황

triflux는 3개 CLI를 사용하며 각각 독립된 설정 체계를 가진다:

| CLI | 설정 형식 | 프로파일 시스템 | 설정 파일 경로 |
|-----|----------|---------------|---------------|
| Claude | JSON | 없음 | `~/.claude/settings.json` |
| Codex | TOML | **있음** (`[profiles.NAME]`) | `~/.codex/config.toml` |
| Gemini | JSON | 없음 (triflux 커스텀) | `~/.gemini/settings.json` |

### 핵심 발견

1. **Codex만 네이티브 프로파일 시스템 보유** — `--profile` 플래그로 사전 정의된 설정 묶음 전환
2. **Claude/Gemini는 프로파일 개념 부재** — 모델 전환만 지원 (`--model` / `-m`)
3. **설정 형식 불일치** — Codex는 TOML, Claude/Gemini는 JSON
4. **승인 모드 명칭 불일치** — 동일 기능이 CLI마다 다른 이름
5. **MCP 설정 위치 불일치** — Codex는 config.toml, Claude/Gemini는 settings.json
6. **Codex config.toml 플래그 충돌** — config.toml에 이미 설정된 값을 CLI 플래그로 중복 지정 시 에러

### 제안

TOML 기반 통일 프로파일 스키마를 설계하고, `tfx-route.sh`가 이를 각 CLI 네이티브 설정으로 변환하는 어댑터 패턴을 적용한다.

---

## 2. Claude CLI 설정 체계

### 2.1 설정 파일 경로 및 형식

| 파일 | 경로 | 형식 | 용도 | Git 추적 |
|------|------|------|------|---------|
| 사용자 전역 설정 | `~/.claude/settings.json` | JSON | 모든 프로젝트 기본값 | X |
| 사용자 로컬 설정 | `~/.claude/settings.local.json` | JSON | 개인 전역 오버라이드 | X |
| 프로젝트 설정 | `.claude/settings.json` | JSON | 팀 공유 프로젝트 설정 | O |
| 프로젝트 로컬 설정 | `.claude/settings.local.json` | JSON | 개인 프로젝트 오버라이드 | X |
| 관리자 설정 | `/etc/claude-code/managed-settings.json` | JSON | 엔터프라이즈 정책 | - |
| MCP 설정 | `.mcp.json` | JSON | 프로젝트 MCP 서버 | O |
| 전역 지시 | `~/.claude/CLAUDE.md` | Markdown | 전역 에이전트 지시 | X |
| 프로젝트 지시 | `CLAUDE.md` | Markdown | 프로젝트 에이전트 지시 | O |
| 인증 정보 | `~/.claude/.credentials.json` | JSON | API 키/토큰 | X |

**우선순위 (높은 순)**:
1. 관리자 설정 (managed-settings.json)
2. 프로젝트 로컬 설정 (.claude/settings.local.json)
3. 프로젝트 설정 (.claude/settings.json)
4. 사용자 로컬 설정 (~/.claude/settings.local.json)
5. 사용자 전역 설정 (~/.claude/settings.json)
6. 환경변수
7. CLI 플래그

**주의**: 배열 값(allow, deny, hooks 등)은 **병합**되며 대체되지 않는다.

### 2.2 모델 선택

| 방법 | 예시 | 우선순위 |
|------|------|---------|
| CLI 플래그 | `claude --model claude-opus-4-6` | 최고 |
| 환경변수 | `ANTHROPIC_MODEL=claude-opus-4-6` | 높음 (시작 시) |
| settings.json | `"model": "claude-opus-4-6"` | 중간 |
| 인터랙티브 | `/model` 명령어 | 세션 내 |
| 기본값 | claude-sonnet-4-6 | 최저 |

**확장 컨텍스트**: 모델 ID에 `[1m]` 접미사 — `claude-opus-4-6[1m]`

**사용 가능 모델** (2026-04):
- `claude-opus-4-6` (Opus 4.6)
- `claude-sonnet-4-6` (Sonnet 4.6)
- `claude-haiku-4-5-20251001` (Haiku 4.5)

**관련 환경변수**:
- `ANTHROPIC_MODEL` — 기본 모델 오버라이드
- `ANTHROPIC_SMALL_FAST_MODEL` — Haiku 모델 오버라이드
- `ANTHROPIC_DEFAULT_OPUS_MODEL` — Opus 버전 고정
- `ANTHROPIC_DEFAULT_SONNET_MODEL` — Sonnet 버전 고정
- `ANTHROPIC_DEFAULT_HAIKU_MODEL` — Haiku 버전 고정

### 2.3 승인/권한 모드

| 모드 | CLI 플래그 | 동작 |
|------|----------|------|
| acceptEdits | `--permission-mode acceptEdits` | 파일 편집 자동 승인, 명령 실행은 프롬프트 |
| default | `--permission-mode default` | 대부분 작업 프롬프트 |
| plan | `--permission-mode plan` | 읽기 전용, 실행 없음 |
| auto | `--permission-mode auto` | 분류기 자동 판단, 불확실 시 프롬프트 |
| dontAsk | `--permission-mode dontAsk` | 명시적 allow 외 자동 거부 |
| bypassPermissions | `--dangerously-skip-permissions` | 모든 권한 검사 우회 (위험) |

**권한 규칙 구문**:
```json
{
  "permissions": {
    "allow": ["Bash(npm:*)", "ReadEdit(path:/src/**)"],
    "deny": ["Bash(rm:*)"],
    "ask": ["Bash(curl:*)"],
    "defaultMode": "acceptEdits"
  }
}
```

### 2.4 MCP 서버 설정

**설정 위치**: `~/.claude/settings.json` 또는 `.mcp.json`

```json
{
  "mcpServers": {
    "server-name": {
      "command": "node",
      "args": ["path/to/server.js"],
      "env": { "TOKEN": "{env:TOKEN}" }
    }
  }
}
```

**관리 명령어**:
- `claude mcp add <name> <url>` — HTTP MCP 서버 추가
- `claude mcp add <name> -- <command>` — stdio MCP 서버 추가
- `claude mcp list` — 목록 조회
- `claude mcp remove <name>` — 삭제

**서버 승인 설정**:
- `enableAllProjectMcpServers: true` — 모든 .mcp.json 서버 자동 승인
- `enabledMcpjsonServers: [...]` — 화이트리스트
- `disabledMcpjsonServers: [...]` — 블랙리스트

### 2.5 프로파일 시스템

**상태: 없음**

Claude CLI는 네이티브 프로파일 시스템을 제공하지 않는다.

**현재 우회 방법**:
1. 환경변수 기반 — 셸 alias로 `ANTHROPIC_MODEL` 설정 후 실행
2. 다중 settings.json — 파일 교체로 설정 전환
3. triflux tfx-profile — 인터랙티브 TUI로 모델/설정 관리

### 2.6 Effort Level (Opus 4.6+)

```json
{ "effortLevel": "high" }
```
또는 환경변수: `CLAUDE_CODE_EFFORT_LEVEL=max|high|medium|low`

### 2.7 Hooks 시스템

Claude 고유 기능. 라이프사이클 이벤트에 셸 명령을 바인딩:

**지원 이벤트**: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `SessionStart`, `Stop`, `SubagentStop`

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "*",
      "hooks": [{ "type": "command", "command": "node hook.mjs", "timeout": 8 }]
    }]
  }
}
```

### 2.8 주요 설정 키 (settings.json)

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "model": "claude-opus-4-6",
  "effortLevel": "high",
  "env": {
    "CLAUDE_CODE_EFFORT_LEVEL": "max",
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "MAX_THINKING_TOKENS": "8000",
    "BASH_DEFAULT_TIMEOUT_MS": "30000"
  },
  "permissions": { "allow": [], "deny": [], "defaultMode": "acceptEdits" },
  "hooks": {},
  "mcpServers": {},
  "includeCoAuthoredBy": true,
  "cleanupPeriodDays": 7,
  "apiKeyHelper": "~/.claude/helper.sh"
}
```

---

## 3. Codex CLI 설정 체계

### 3.1 설정 파일 경로 및 형식

| 파일 | 경로 | 형식 | 용도 | Git 추적 |
|------|------|------|------|---------|
| 사용자 전역 설정 | `~/.codex/config.toml` | TOML | 모든 프로젝트 기본값 | X |
| 프로젝트 설정 | `.codex/config.toml` | TOML | 신뢰 프로젝트 오버라이드 | O |
| 시스템 설정 | `/etc/codex/config.toml` | TOML | 시스템 정책 | - |
| 백업 | `~/.codex/config.toml.bak` | TOML | 자동 백업 | X |

**우선순위 (높은 순)**:
1. CLI 플래그 (`--model`, `--profile`, `-c key=value`)
2. 프로파일 오버라이드 (`--profile <name>`)
3. 프로젝트 설정 (`.codex/config.toml`, 신뢰 프로젝트만)
4. 사용자 전역 설정 (`~/.codex/config.toml`)
5. 시스템 설정 (`/etc/codex/config.toml`)
6. 내장 기본값

### 3.2 프로파일 시스템 (네이티브)

Codex는 **유일하게 네이티브 프로파일을 지원**하는 CLI이다.

**정의**: `config.toml`의 `[profiles.<name>]` 섹션

```toml
[profiles.codex53_high]
model = "gpt-5.3-codex"
reasoning_effort = "high"

[profiles.gpt54_xhigh]
model = "gpt-5.4"
reasoning_effort = "xhigh"

[profiles.spark53_low]
model = "gpt-5.3-codex-spark"
reasoning_effort = "low"
```

**사용법**:
```bash
codex --profile codex53_high "구현해줘"
codex -p gpt54_xhigh "아키텍처 설계"
```

**현재 triflux 프로파일** (config.toml):

| 프로파일 | 모델 | reasoning_effort | 용도 |
|---------|------|-----------------|------|
| `gpt54_xhigh` | gpt-5.4 | xhigh | 아키텍처, 심층 분석 |
| `gpt54_high` | gpt-5.4 | high | 복잡 로직 |
| `gpt54_low` | gpt-5.4 | low | 빠른 수정 |
| `codex53_xhigh` | gpt-5.3-codex | xhigh | SWE-Bench 최적, 심층 |
| `codex53_high` | gpt-5.3-codex | high | 표준 코딩 (tfx-route 기본값) |
| `codex53_med` | gpt-5.3-codex | medium | 루틴 작업 |
| `codex53_low` | gpt-5.3-codex | low | 빠른 반환 |
| `spark53_low` | gpt-5.3-codex-spark | low | 1000tok/s, 린팅/포맷 |
| `mini54_*` | gpt-5.4-mini | low~high | 경량 서브에이전트 |

### 3.3 모델 선택

| 방법 | 예시 | 우선순위 |
|------|------|---------|
| CLI 플래그 | `codex --model gpt-5.4` | 최고 |
| 프로파일 | `codex --profile codex53_high` | 높음 |
| config 오버라이드 | `codex -c model='"gpt-5.4"'` | 높음 |
| config.toml 전역 | `model = "gpt-5.4"` | 중간 |
| 인터랙티브 | `/model` 명령어 | 세션 내 |
| 내장 기본값 | gpt-5-codex | 최저 |

**사용 가능 모델** (2026-04):
- `gpt-5.4` — 프론티어, 1M 컨텍스트, reasoning_effort 지원
- `gpt-5.3-codex` — SWE-Bench 72%, Terminal-Bench 77%
- `gpt-5.3-codex-spark` — Cerebras 1000tok/s
- `gpt-5.4-mini` — 경량, $0.75/M

### 3.4 승인/샌드박스 모드

**승인 정책** (approval_policy):

| 모드 | 동작 | 안전도 |
|------|------|--------|
| `never` | 모든 작업 무조건 실행 | 낮음 |
| `on-request` | 신뢰할 수 없는 명령만 승인 요청 | 중간 |
| `untrusted` | 모든 변경/의심 명령 승인 요청 | 높음 |

**샌드박스 모드** (sandbox_mode):

| 모드 | 파일 접근 | 네트워크 |
|------|----------|---------|
| `read-only` | 읽기만 | 차단 |
| `workspace-write` | 리포+임시 쓰기 | 기본 차단 |
| `danger-full-access` | 전체 디스크 | 전체 |

**CLI 플래그 단축키**:
- `--full-auto` = `on-request` + `workspace-write`
- `--dangerously-bypass-approvals-and-sandbox` = 모든 검사 우회

**치명적 제약**: config.toml에 `sandbox`/`approval_mode`가 이미 설정되어 있으면, CLI 플래그로 중복 지정 시 **에러 발생**.

```bash
# 에러: config.toml에 sandbox="elevated"가 있는 상태에서
codex exec --full-auto "task"  # CONFLICT ERROR

# 올바른 패턴: config.toml에 위임하거나 --profile만 사용
codex exec --profile codex53_high "task"
```

### 3.5 MCP 서버 설정

**설정 위치**: `config.toml`의 `[mcp_servers.<name>]` 섹션

```toml
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp@latest"]
enabled = true
startup_timeout_sec = 5
env = { "DEBUG" = "mcp:" }

[mcp_servers.tfx-hub]
url = "http://127.0.0.1:27888/mcp"
```

**전송 유형**:
- **Stdio**: `command` + `args` (로컬 프로세스)
- **HTTP**: `url` (원격 서버)

**관리 명령어**:
- `codex mcp add <name> -- <command>` — 추가
- `codex mcp list` — 목록
- `codex mcp get <name>` — 상세
- `codex mcp remove <name>` — 삭제

### 3.6 환경변수

| 변수 | 용도 |
|------|------|
| `OPENAI_API_KEY` | OpenAI 인증 |
| `CODEX_CONFIG_PATH` | config.toml 위치 오버라이드 |
| `CODEX_API_KEY` | OPENAI_API_KEY 대체 |
| `OLLAMA_BASE_URL` | 로컬 Ollama 엔드포인트 |

**셸 환경 정책**:
```toml
[shell_environment_policy]
inherit = "all"
exclude = ["AWS_", "AZURE_"]
set = { CI = "1" }
```

### 3.7 신뢰 프로젝트

```toml
[projects.'C:\Users\SSAFY\Desktop\Projects\triflux']
trust_level = "trusted"
```

신뢰되지 않은 프로젝트의 `.codex/config.toml`은 무시된다.

---

## 4. Gemini CLI 설정 체계

### 4.1 설정 파일 경로 및 형식

| 파일 | 경로 | 형식 | 용도 | Git 추적 |
|------|------|------|------|---------|
| 전역 설정 | `~/.gemini/settings.json` | JSON | 전역 기본값 | X |
| 프로젝트 환경 | `.gemini/.env` | Key=Value | 프로젝트 변수 | X |
| triflux 프로파일 | `~/.gemini/triflux-profiles.json` | JSON | 커스텀 모델 프로파일 | X |
| 컨텍스트 파일 | `GEMINI.md` | Markdown | 에이전트 지시 | O |
| 무시 패턴 | `.geminiignore` | Glob | 파일 제외 | O |
| OAuth 인증 | `~/.gemini/oauth_creds.json` | JSON | 토큰 | X |
| 계정 정보 | `~/.gemini/google_accounts.json` | JSON | 계정 메타 | X |
| 상태 | `~/.gemini/state.json` | JSON | 런타임 상태 | X |

**우선순위 (높은 순)**:
1. CLI 플래그 (`-m`, `--model`, `--yolo`)
2. 환경변수 (`GEMINI_API_KEY`, `GOOGLE_CLOUD_PROJECT`)
3. 프로젝트 `.gemini/.env`
4. `~/.gemini/settings.json`
5. 하드코딩된 기본값 (`gemini-2.5-pro`)

**알려진 버그**: settings.json의 `model.name`이 하드코딩된 기본값에 의해 무시되는 경우가 있음 (Issue #5373). `-m` 플래그 사용 권장.

### 4.2 모델 선택

| 방법 | 예시 | 우선순위 |
|------|------|---------|
| CLI 플래그 | `gemini -m gemini-3.1-pro-preview` | 최고 |
| 인터랙티브 | `/model` 명령어 | 세션 내 |
| triflux 프로파일 | `resolve_gemini_profile pro31` | tfx-route 내 |
| settings.json | `"model": { "name": "..." }` | 낮음 (버그) |
| 하드코딩 기본값 | `gemini-2.5-pro` | 최저 |

**사용 가능 모델** (2026-04):
- `gemini-3.1-pro-preview` — 최신 프로
- `gemini-3-flash-preview` — 균형형
- `gemini-2.5-pro` — 안정판
- `gemini-2.5-flash` — 경량
- `gemini-2.5-flash-lite` — 최소

### 4.3 승인 모드

| 모드 | 플래그/설정 | 동작 |
|------|-----------|------|
| default | (없음) | 도구 실행마다 승인 요청 |
| auto_edit | `general.defaultApprovalMode` | 파일 편집 자동, 명령 실행 프롬프트 |
| yolo | `--yolo` 또는 `Ctrl+Y` | 모든 작업 자동 승인 |
| plan | `--approval-mode plan` | 읽기 전용, 변경 없음 |

### 4.4 MCP 서버 설정

**설정 위치**: `~/.gemini/settings.json`의 `mcpServers` 키

```json
{
  "mcpServers": {
    "tfx-hub": {
      "url": "http://127.0.0.1:27888/mcp"
    },
    "local-server": {
      "command": "node",
      "args": ["server.js"]
    }
  }
}
```

**관리 명령어**:
- `gemini mcp add` — 인터랙티브 등록
- `gemini mcp list` — 목록 조회
- `gemini mcp remove <name>` — 삭제
- `/mcp reload` — 기능 재조회

**제약**: `--mcp-server` CLI 플래그 없음. settings.json으로만 설정.

### 4.5 프로파일 시스템

**네이티브 프로파일: 없음**

triflux는 커스텀 프로파일 파일로 이를 보완:

**`~/.gemini/triflux-profiles.json`**:
```json
{
  "model": "gemini-3.1-pro-preview",
  "profiles": {
    "pro31": { "model": "gemini-3.1-pro-preview", "hint": "flagship" },
    "flash3": { "model": "gemini-3-flash-preview", "hint": "fast" },
    "pro25": { "model": "gemini-2.5-pro", "hint": "stable" },
    "flash25": { "model": "gemini-2.5-flash", "hint": "lightweight" },
    "lite25": { "model": "gemini-2.5-flash-lite", "hint": "minimal" }
  }
}
```

**tfx-route.sh 해석 로직** (`resolve_gemini_profile`):
1. `gemini-`로 시작하면 전체 모델 ID로 취급
2. `triflux-profiles.json`에서 프로파일명 검색
3. `settings.json`에서 폴백 검색
4. 하드코딩 기본값으로 폴백 (`gemini-3.1-pro-preview`)

### 4.6 환경변수

| 변수 | 용도 |
|------|------|
| `GEMINI_API_KEY` | Google AI Studio API 키 |
| `GOOGLE_API_KEY` | Vertex AI API 키 |
| `GOOGLE_APPLICATION_CREDENTIALS` | 서비스 계정 JSON 경로 |
| `GOOGLE_CLOUD_PROJECT` | GCP 프로젝트 ID |
| `GOOGLE_CLOUD_LOCATION` | GCP 리전 |
| `GOOGLE_GENAI_USE_VERTEXAI` | Vertex AI 백엔드 사용 (`true`) |

**triflux 확장 변수**:
- `TFX_GEMINI_OK` — Gemini CLI 가용 여부
- `GEMINI_BIN` — gemini 바이너리 경로
- `GEMINI_PROFILES_PATH` — triflux-profiles.json 경로
- `GEMINI_BIN_ARGS_JSON` — 추가 인자 JSON 배열

---

## 5. 3-CLI 비교 매트릭스

### 5.1 설정 체계 비교

| 항목 | Claude | Codex | Gemini |
|------|--------|-------|--------|
| **설정 파일 형식** | JSON | TOML | JSON |
| **전역 설정 경로** | `~/.claude/settings.json` | `~/.codex/config.toml` | `~/.gemini/settings.json` |
| **프로젝트 설정** | `.claude/settings.json` | `.codex/config.toml` | `.gemini/.env` |
| **네이티브 프로파일** | X | O (`[profiles.NAME]`) | X |
| **모델 선택 플래그** | `--model` | `--model`, `--profile` | `-m`, `--model` |
| **에이전트 지시 파일** | `CLAUDE.md` | 없음 | `GEMINI.md` |
| **MCP 설정 위치** | settings.json / .mcp.json | config.toml | settings.json |
| **Hooks 시스템** | O (7가지 이벤트) | X | X |
| **Effort/Reasoning** | `effortLevel` | `reasoning_effort` | 없음 |
| **확장 컨텍스트** | `[1m]` 접미사 | 기본 지원 | 없음 |
| **환경 정책** | `env` in settings | `shell_environment_policy` | `.gemini/.env` |

### 5.2 승인 모드 대응 관계

| 의미 | Claude | Codex | Gemini |
|------|--------|-------|--------|
| 모든 것 자동 실행 | `bypassPermissions` | `never` | `yolo` |
| 편집 자동, 명령 프롬프트 | `acceptEdits` | `on-request` | `auto_edit` |
| 모든 것 프롬프트 | `default` | `untrusted` | `default` |
| 읽기 전용 | `plan` | 없음 (sandbox=read-only) | `plan` |
| 명시적 허용만 실행 | `dontAsk` | 없음 | 없음 |
| 분류기 자동 판단 | `auto` | 없음 | 없음 |

### 5.3 모델 카테고리 대응 관계

| 역할 | Claude | Codex | Gemini |
|------|--------|-------|--------|
| **프론티어** | claude-opus-4-6 | gpt-5.4 | gemini-3.1-pro-preview |
| **표준 코딩** | claude-sonnet-4-6 | gpt-5.3-codex | gemini-3-flash-preview |
| **경량/빠른** | claude-haiku-4-5 | gpt-5.3-codex-spark | gemini-2.5-flash |
| **최소** | — | gpt-5.4-mini | gemini-2.5-flash-lite |
| **Effort 지원** | O (max/high/medium/low) | O (xhigh/high/medium/low) | X |

### 5.4 CLI 플래그 vs Config 우선순위 비교

| CLI | CLI 플래그 우선순위 | Config 파일 우선순위 | 충돌 시 |
|-----|------------------|-------------------|--------|
| Claude | 모델/모드: 플래그 > 파일 | 배열: 병합 | 정상 (병합) |
| Codex | 플래그 > 프로파일 > 전역 | 프로젝트 > 전역 > 시스템 | **에러** (중복 설정) |
| Gemini | 플래그 > 환경변수 > 파일 | — | 정상 (무시) |

---

## 6. 통일 프로파일 스키마 설계

### 6.1 설계 원칙

1. **CLI별 네이티브 설정을 래핑** — 각 CLI의 기존 설정 체계를 유지하면서 상위 추상화
2. **Codex 프로파일 구조 기반** — 유일한 네이티브 프로파일 시스템을 기반으로 확장
3. **TOML 형식 채택** — Codex와 일관성, 사람이 읽기 쉬움
4. **선택적 오버라이드** — 프로파일은 기본값만 제공, CLI 플래그가 항상 최종 우선

### 6.2 스키마 정의

**파일 경로**: `~/.triflux/profiles.toml`

```toml
# triflux 통일 프로파일 스키마 v1.0
schema_version = "1.0"

# ── 기본 프로파일 ──
default_profile = "standard"

# ── 프로파일 정의 ──

[profiles.frontier]
description = "프론티어 모델 — 아키텍처, 심층 분석, 복잡 설계"
claude_model = "claude-opus-4-6"
claude_effort = "max"
codex_model = "gpt-5.4"
codex_effort = "xhigh"
codex_profile = "gpt54_xhigh"        # Codex 네이티브 프로파일명
gemini_model = "gemini-3.1-pro-preview"
gemini_profile = "pro31"              # triflux-profiles.json 키
approval_mode = "supervised"          # 통일 승인 모드
timeout_sec = 3600
opus_oversight = true

[profiles.standard]
description = "표준 코딩 — 구현, 리뷰, 테스트"
claude_model = "claude-sonnet-4-6"
claude_effort = "high"
codex_model = "gpt-5.3-codex"
codex_effort = "high"
codex_profile = "codex53_high"
gemini_model = "gemini-3-flash-preview"
gemini_profile = "flash3"
approval_mode = "auto"
timeout_sec = 1080
opus_oversight = false

[profiles.fast]
description = "빠른 작업 — 린팅, 포맷, 간단 수정"
claude_model = "claude-haiku-4-5-20251001"
claude_effort = "low"
codex_model = "gpt-5.3-codex-spark"
codex_effort = "low"
codex_profile = "spark53_low"
gemini_model = "gemini-2.5-flash"
gemini_profile = "flash25"
approval_mode = "auto"
timeout_sec = 180
opus_oversight = false

[profiles.lightweight]
description = "경량 서브에이전트 — 비용 최적화"
claude_model = "claude-haiku-4-5-20251001"
claude_effort = "low"
codex_model = "gpt-5.4-mini"
codex_effort = "medium"
codex_profile = "mini54_med"
gemini_model = "gemini-2.5-flash-lite"
gemini_profile = "lite25"
approval_mode = "auto"
timeout_sec = 300
opus_oversight = false

[profiles.deep]
description = "심층 분석 — 3자 합의, 교차 검증"
claude_model = "claude-opus-4-6[1m]"
claude_effort = "max"
codex_model = "gpt-5.4"
codex_effort = "xhigh"
codex_profile = "gpt54_xhigh"
gemini_model = "gemini-3.1-pro-preview"
gemini_profile = "pro31"
approval_mode = "supervised"
timeout_sec = 3600
opus_oversight = true

# ── 사용자 커스텀 프로파일 예시 ──

[profiles.custom_codex_only]
description = "Codex 전용 고성능"
codex_model = "gpt-5.4"
codex_effort = "xhigh"
codex_profile = "gpt54_xhigh"
approval_mode = "auto"
timeout_sec = 1800
```

### 6.3 통일 승인 모드 매핑

```toml
# 통일 승인 모드 → CLI별 변환
[approval_modes]

[approval_modes.auto]
description = "편집 자동, 명령 프롬프트"
claude = "acceptEdits"
codex = "on-request"
gemini = "auto_edit"

[approval_modes.full_auto]
description = "모든 작업 자동 실행"
claude = "bypassPermissions"
codex = "never"
gemini = "yolo"

[approval_modes.supervised]
description = "모든 작업 프롬프트"
claude = "default"
codex = "untrusted"
gemini = "default"

[approval_modes.readonly]
description = "읽기 전용, 변경 없음"
claude = "plan"
codex_sandbox = "read-only"
gemini = "plan"
```

### 6.4 에이전트-프로파일 매핑

```toml
# agent_type → 기본 프로파일
[agent_defaults]

# 구현 레인
executor = "standard"
build-fixer = "fast"
debugger = "standard"
deep-executor = "frontier"

# 설계/분석 레인
architect = "frontier"
planner = "frontier"
critic = "frontier"
analyst = "frontier"

# 리뷰 레인
code-reviewer = "standard"
security-reviewer = "standard"
quality-reviewer = "standard"

# 리서치 레인
scientist = "standard"
scientist-deep = "deep"
document-specialist = "standard"

# UI/문서 레인
designer = "standard"   # Gemini 선호
writer = "fast"         # Gemini 선호

# 탐색 (Claude native)
explore = "fast"

# 검증
verifier = "standard"
test-engineer = "standard"
qa-tester = "standard"

# 경량
spark = "fast"
```

---

## 7. 라우팅 변환 로직 설계

### 7.1 아키텍처 개요

```
┌──────────────────────────────────────────────┐
│              tfx-route.sh v3.0               │
│                                              │
│  1. 프로파일 로드                              │
│     ~/.triflux/profiles.toml                 │
│                                              │
│  2. 에이전트 → 프로파일 해석                    │
│     agent_defaults[agent_type]               │
│     + TFX_PROFILE 오버라이드                   │
│                                              │
│  3. CLI별 변환                                │
│     ┌─────────────┐                          │
│     │ profile_to_  │                          │
│     │  claude_args │→ --model, --permission   │
│     │  codex_args  │→ --profile, exec         │
│     │  gemini_args │→ -m, --yolo              │
│     └─────────────┘                          │
│                                              │
│  4. 실행                                      │
│     CLI_CMD + CLI_ARGS + PROMPT               │
└──────────────────────────────────────────────┘
```

### 7.2 변환 함수 설계

#### profile_to_claude_args(profile)

```bash
profile_to_claude_args() {
  local profile_name="$1"
  local model effort permission_mode

  model=$(read_profile_key "$profile_name" "claude_model")
  effort=$(read_profile_key "$profile_name" "claude_effort")
  approval=$(read_profile_key "$profile_name" "approval_mode")

  # Claude는 프로파일 플래그 없음 → 개별 플래그로 변환
  local args=""

  if [[ -n "$model" ]]; then
    args="--model $model"
  fi

  # 승인 모드 매핑
  local claude_mode
  case "$approval" in
    auto)       claude_mode="acceptEdits" ;;
    full_auto)  claude_mode="bypassPermissions" ;;
    supervised) claude_mode="default" ;;
    readonly)   claude_mode="plan" ;;
    *)          claude_mode="acceptEdits" ;;
  esac
  args="$args --permission-mode $claude_mode"

  echo "$args"
}
```

#### profile_to_codex_args(profile)

```bash
profile_to_codex_args() {
  local profile_name="$1"
  local codex_profile codex_base

  codex_profile=$(read_profile_key "$profile_name" "codex_profile")
  codex_base="$(build_codex_base)"  # config.toml 충돌 방지

  # Codex는 네이티브 프로파일 → --profile 직접 사용
  if [[ -n "$codex_profile" ]]; then
    echo "exec --profile $codex_profile $codex_base"
  else
    # 프로파일 미지정 시 모델/effort 직접 설정
    local model effort
    model=$(read_profile_key "$profile_name" "codex_model")
    effort=$(read_profile_key "$profile_name" "codex_effort")

    local args="exec $codex_base"
    [[ -n "$model" ]] && args="$args -c model='\"$model\"'"
    [[ -n "$effort" ]] && args="$args -c reasoning_effort='\"$effort\"'"
    echo "$args"
  fi
}
```

#### profile_to_gemini_args(profile)

```bash
profile_to_gemini_args() {
  local profile_name="$1"
  local gemini_profile gemini_model approval

  gemini_profile=$(read_profile_key "$profile_name" "gemini_profile")
  gemini_model=$(read_profile_key "$profile_name" "gemini_model")
  approval=$(read_profile_key "$profile_name" "approval_mode")

  # Gemini는 프로파일 없음 → -m 플래그로 모델 직접 지정
  local resolved_model
  if [[ -n "$gemini_profile" ]]; then
    resolved_model=$(resolve_gemini_profile "$gemini_profile")
  elif [[ -n "$gemini_model" ]]; then
    resolved_model="$gemini_model"
  else
    resolved_model="gemini-3.1-pro-preview"
  fi

  local args="-m $resolved_model"

  # 승인 모드 매핑
  case "$approval" in
    auto|full_auto) args="$args -y" ;;       # yolo
    supervised)     ;;                        # default (프롬프트)
    readonly)       args="$args --approval-mode plan" ;;
    *)              args="$args -y" ;;
  esac

  args="$args --prompt"
  echo "$args"
}
```

### 7.3 프로파일 로더

```bash
# TOML 파서 (Node.js 위임 — 순수 bash로 TOML 파싱은 비현실적)
TFX_PROFILES_PATH="${TFX_PROFILES_PATH:-$(eval echo ~)/.triflux/profiles.toml}"

read_profile_key() {
  local profile="$1" key="$2"
  "$NODE_BIN" -e "
    const fs = require('fs');
    const toml = require('./lib/toml-parser');  // 또는 인라인 파서
    const cfg = toml.parse(fs.readFileSync(process.argv[1], 'utf8'));
    const val = cfg?.profiles?.[process.argv[2]]?.[process.argv[3]] ?? '';
    process.stdout.write(String(val));
  " "$TFX_PROFILES_PATH" "$profile" "$key" 2>/dev/null
}

resolve_unified_profile() {
  local agent_type="$1"

  # 1. 환경변수 오버라이드
  if [[ -n "${TFX_PROFILE:-}" ]]; then
    echo "$TFX_PROFILE"
    return
  fi

  # 2. agent_defaults 테이블에서 조회
  local default_profile
  default_profile=$("$NODE_BIN" -e "
    const fs = require('fs');
    const toml = require('./lib/toml-parser');
    const cfg = toml.parse(fs.readFileSync(process.argv[1], 'utf8'));
    const val = cfg?.agent_defaults?.[process.argv[2]] ?? cfg?.default_profile ?? 'standard';
    process.stdout.write(val);
  " "$TFX_PROFILES_PATH" "$agent_type" 2>/dev/null)

  echo "${default_profile:-standard}"
}
```

### 7.4 route_agent v3 (통일 프로파일 기반)

```bash
route_agent_v3() {
  local agent="$1"

  # 1. 에이전트 → CLI 타입 (agent-map.json, 기존 로직 유지)
  resolve_cli_type "$agent"

  # 2. 에이전트 → 통일 프로파일
  local profile
  profile=$(resolve_unified_profile "$agent")

  # 3. CLI 타입에 따라 변환
  case "$CLI_TYPE" in
    codex)
      CLI_ARGS=$(profile_to_codex_args "$profile")
      CLI_EFFORT=$(read_profile_key "$profile" "codex_profile")
      ;;
    gemini)
      CLI_ARGS=$(profile_to_gemini_args "$profile")
      CLI_EFFORT=$(read_profile_key "$profile" "gemini_profile")
      ;;
    claude-native)
      # Claude native는 CLI 실행 안 함 — 프로파일에서 메타데이터만 추출
      CLI_EFFORT="n/a"
      ;;
  esac

  DEFAULT_TIMEOUT=$(read_profile_key "$profile" "timeout_sec")
  OPUS_OVERSIGHT=$(read_profile_key "$profile" "opus_oversight")
  DEFAULT_TIMEOUT="${DEFAULT_TIMEOUT:-600}"
  OPUS_OVERSIGHT="${OPUS_OVERSIGHT:-false}"
}
```

### 7.5 환경변수 인터페이스

| 변수 | 용도 | 예시 |
|------|------|------|
| `TFX_PROFILE` | 통일 프로파일 강제 지정 | `TFX_PROFILE=frontier` |
| `TFX_PROFILES_PATH` | profiles.toml 경로 오버라이드 | `~/.triflux/profiles.toml` |
| `TFX_CLI_MODE` | CLI 강제 지정 (기존) | `codex`, `gemini`, `auto` |
| `TFX_CODEX_PLAN` | Codex 요금제 (기존) | `pro`, `plus`, `free` |

---

## 8. 마이그레이션 계획

### 8.1 Phase 0: 준비 (변경 없음)

1. `~/.triflux/profiles.toml` 파일 생성 (기본 프로파일 포함)
2. TOML 파서 의존성 확인 (`@iarna/toml` 또는 인라인 파서)
3. 기존 프로파일 매핑 문서화

### 8.2 Phase 1: 병렬 실행

1. `tfx-route.sh`에 `route_agent_v3` 추가 (기존 `route_agent`와 공존)
2. `TFX_USE_UNIFIED_PROFILES=1` 환경변수로 전환
3. 기존 동작과 결과 비교 테스트

**기존 → 통일 프로파일 매핑**:

| 기존 (route_agent) | 통일 프로파일 |
|-------------------|-------------|
| `codex53_high` | `standard` |
| `gpt54_xhigh` | `frontier` |
| `spark53_low` | `fast` |
| `codex53_low` | `fast` (+ codex_effort override) |
| `gpt54_high` | `deep` |
| `pro31` (Gemini) | `standard` (gemini_profile=pro31) |
| `flash3` (Gemini) | `fast` (gemini_profile=flash3) |

### 8.3 Phase 2: 전환

1. `route_agent` → `route_agent_v3`로 기본 전환
2. 기존 `route_agent`를 `route_agent_legacy`로 리네임 (폴백)
3. `TFX_USE_LEGACY_ROUTING=1`로 레거시 활성화 가능

### 8.4 Phase 3: 정리

1. 레거시 라우팅 코드 제거
2. `codex53_high` 등 하드코딩된 프로파일명 참조 제거
3. `triflux-profiles.json` → `profiles.toml`로 통합

### 8.5 하위 호환성

- **Codex config.toml 프로파일은 유지** — 통일 프로파일의 `codex_profile` 키가 네이티브 프로파일을 참조
- **triflux-profiles.json은 유지** — `gemini_profile` 키가 기존 Gemini 프로파일을 참조
- **환경변수 우선** — `TFX_CLI_MODE`, `TFX_CODEX_PLAN` 등 기존 변수는 계속 동작

---

## 9. 리스크 및 제약 사항

### 9.1 기술적 리스크

| 리스크 | 영향 | 완화 |
|--------|------|------|
| **TOML 파서 의존성** | Node.js TOML 파서 필요 (bash 네이티브 불가) | 인라인 경량 파서 또는 `@iarna/toml` |
| **Codex config.toml 충돌** | 통일 프로파일과 네이티브 config.toml 설정 불일치 | `codex_profile` 키로 네이티브 프로파일 직접 참조 |
| **Gemini settings.json 버그** | model.name 설정이 무시됨 | `-m` 플래그 직접 사용 (현행 유지) |
| **승인 모드 불완전 매핑** | Claude의 `dontAsk`/`auto`는 Codex/Gemini에 대응 없음 | `supervised` + CLI별 추가 설정으로 보완 |
| **프로파일 파싱 성능** | TOML 파싱이 라우팅마다 발생 | 캐싱 (`_PROFILE_CACHE`) + 워밍업 |

### 9.2 운영 리스크

| 리스크 | 영향 | 완화 |
|--------|------|------|
| **설정 3곳 동기화** | profiles.toml, config.toml, triflux-profiles.json 간 불일치 | profiles.toml을 단일 소스로, 나머지는 참조만 |
| **모델 명 변경** | CLI 벤더가 모델명을 변경하면 프로파일 업데이트 필요 | 모델 alias 테이블 + 마이그레이션 알림 |
| **원격 환경 동기화** | 원격 머신의 profiles.toml이 로컬과 다를 수 있음 | `tfx-remote-spawn`에서 profiles.toml scp 전송 |
| **멀티유저 환경** | 사용자마다 다른 프로파일 원할 수 있음 | `~/.triflux/profiles.local.toml` 오버라이드 |

### 9.3 설계 제약

1. **Claude CLI에 프로파일 시스템이 없으므로** 통일 프로파일의 Claude 부분은 개별 플래그/환경변수로만 변환 가능
2. **Gemini CLI의 MCP 설정은 settings.json 전용**이므로 프로파일에서 MCP 설정을 동적 전환하기 어려움
3. **Codex의 config.toml 중복 설정 에러**는 `build_codex_base` 가드로만 우회 가능 — 프로파일 설계에서도 이 제약을 반영해야 함
4. **Effort level 지원 여부가 CLI마다 다름** — Claude(O), Codex(O, xhigh 포함), Gemini(X)

### 9.4 고려하지 않은 범위

- **인증 통합** — API 키/OAuth는 CLI별로 독립 유지 (보안상 통일 불필요)
- **Hooks 통합** — Claude 전용 기능, 통일 프로파일 범위 밖
- **CLAUDE.md/GEMINI.md 통합** — 에이전트 지시 파일은 CLI 특성에 맞게 분리 유지

---

## 10. 결론 및 다음 단계

### 핵심 결론

1. **통일 프로파일은 가능하며 필요하다** — 현재 3곳에 분산된 설정을 단일 `profiles.toml`로 통합하면 유지보수 부담이 크게 줄어든다.

2. **어댑터 패턴이 최적** — 각 CLI의 네이티브 설정 체계를 건드리지 않고, `tfx-route.sh`에서 변환하는 방식이 리스크가 가장 낮다.

3. **Codex 프로파일은 그대로 유지** — 통일 프로파일이 Codex 네이티브 프로파일을 참조하는 형태가 config.toml 충돌을 피하면서도 기존 동작을 보장한다.

4. **점진적 마이그레이션** — Phase 0~3의 단계별 전환으로 안전하게 이행 가능.

### 다음 단계

| 단계 | 작업 | 예상 규모 |
|------|------|---------|
| 1 | `~/.triflux/profiles.toml` 초기 파일 생성 + TOML 파서 선정 | 소 |
| 2 | `read_profile_key`, `resolve_unified_profile` 구현 | 중 |
| 3 | `profile_to_{claude,codex,gemini}_args` 변환 함수 구현 | 중 |
| 4 | `route_agent_v3` 구현 + 기존 route_agent와 A/B 테스트 | 대 |
| 5 | `tfx-profile` TUI에 통일 프로파일 편집 기능 추가 | 중 |
| 6 | 레거시 라우팅 제거 + 문서 업데이트 | 소 |

### 파일 구조 (구현 시)

```
~/.triflux/
├── profiles.toml           # 통일 프로파일 (신규)
├── profiles.local.toml     # 개인 오버라이드 (신규, 선택)
└── cache/
    └── profiles-parsed.json  # 파싱 캐시 (자동 생성)

~/.codex/
└── config.toml             # 기존 유지 (Codex 네이티브 프로파일)

~/.gemini/
├── settings.json           # 기존 유지
└── triflux-profiles.json   # Phase 3에서 profiles.toml로 통합

scripts/
├── tfx-route.sh            # route_agent_v3 추가
└── lib/
    └── profile-resolver.mjs  # 프로파일 해석 로직 (Node.js)
```

---

## 부록 A: 현재 tfx-route.sh 에이전트-프로파일 매핑 (as-is)

| 에이전트 | CLI 타입 | 현재 프로파일/모델 | RUN_MODE | OPUS_OVERSIGHT |
|---------|---------|-----------------|----------|----------------|
| executor | codex | codex53_high | fg | false |
| build-fixer | codex | codex53_low | fg | false |
| debugger | codex | codex53_high | bg | false |
| deep-executor | codex | gpt54_xhigh | bg | true |
| architect | codex | gpt54_xhigh | bg | true |
| planner | codex | gpt54_xhigh | fg | true |
| critic | codex | gpt54_xhigh | bg | true |
| analyst | codex | gpt54_xhigh | fg | true |
| code-reviewer | codex | codex53_high (review) | bg | false |
| security-reviewer | codex | codex53_high (review) | bg | true |
| quality-reviewer | codex | codex53_high (review) | bg | false |
| scientist | codex | codex53_high | bg | false |
| scientist-deep | codex | gpt54_high | bg | false |
| document-specialist | codex | codex53_high | bg | false |
| designer | gemini | pro31 | bg | false |
| writer | gemini | flash3 | bg | false |
| explore | claude | n/a | fg | false |
| verifier | codex | codex53_high (review) | fg | false |
| test-engineer | codex | codex53_high | bg | false |
| qa-tester | codex | codex53_high (review) | bg | false |
| spark | codex | spark53_low | fg | false |

## 부록 B: Codex config.toml 전체 스키마 (확인된 키)

```toml
# 최상위 설정
model = "gpt-5.4"
approval_mode = "full-auto"
sandbox = "elevated"
profile = "codex53_high"          # 기본 프로파일

# 프로파일 정의
[profiles.NAME]
model = "gpt-5.3-codex"
reasoning_effort = "high"         # xhigh, high, medium, low

# MCP 서버
[mcp_servers.NAME]
command = "npx"
args = ["-y", "package"]
url = "http://..."                # HTTP 전송
enabled = true
startup_timeout_sec = 5
env = { "KEY" = "value" }
bearer_token_env_var = "TOKEN"

# 셸 환경 정책
[shell_environment_policy]
inherit = "all"                   # all, core, none
exclude = ["AWS_"]
include_only = ["PATH", "HOME"]
set = { CI = "1" }
ignore_default_excludes = false

# 샌드박스 상세
[sandbox_workspace_write]
network_access = true
writable_roots = ["/extra/path"]

# 신뢰 프로젝트
[projects.'PATH']
trust_level = "trusted"

# 모델 마이그레이션
[notice.model_migrations]
"gpt-5.3-codex" = "gpt-5.4"
```

## 부록 C: 참고 자료

- Claude Code 공식 문서: code.claude.com (Settings, CLI Reference, Permissions)
- Codex CLI 문서: OpenAI Codex CLI GitHub (config.toml, Profiles, MCP)
- Gemini CLI 문서: Google Gemini CLI docs (Settings, Model Selection, MCP)
- triflux 기존 코드: `scripts/tfx-route.sh`, `bin/tfx-profile.mjs`
- 관련 이슈: Gemini settings.json model.name 버그 (#5373)
