---
name: tfx-codex
description: Codex-Only 오케스트레이터. tfx-auto 워크플로우를 Codex 전용으로 고정합니다.
triggers:
  - tfx-codex
argument-hint: "\"작업 설명\" | N:codex \"작업 설명\""
---

# tfx-codex — Codex-Only 오케스트레이터

> Codex CLI만 사용하여 모든 외부 CLI 작업을 라우팅합니다.
> Gemini CLI가 없는 환경에서 사용합니다.

## 사용법

```
/tfx-codex "작업 설명"
/tfx-codex N:codex "작업 설명"
```

## 동작 원리

`tfx-auto`와 동일한 워크플로우를 사용하되, `TFX_CLI_MODE=codex` 환경변수를 설정하여
모든 Gemini 에이전트(designer, writer)를 Codex로 리매핑합니다.

### 에이전트 라우팅

| 에이전트 | 원래 CLI | tfx-codex에서 |
|----------|---------|-------------|
| executor, build-fixer, debugger | Codex | Codex (변경 없음) |
| architect, planner, critic, analyst | Codex | Codex (변경 없음) |
| code-reviewer, security-reviewer | Codex | Codex (변경 없음) |
| scientist, document-specialist | Codex | Codex (변경 없음) |
| **designer** | ~~Gemini~~ | **Codex** (effort: high) — UI 코드 생성 |
| **writer** | ~~Gemini~~ | **Codex Spark** (effort: spark_fast) — 경량 문서 |
| explore | Claude Haiku | Claude Haiku (변경 없음) |
| verifier, test-engineer | Claude Sonnet | Codex (변경 없음) |

## 실행 규칙

**tfx-auto SKILL.md의 커맨드 숏컷 → 트리아지 → 멀티 태스크 라우팅 → 실행 → 결과 파싱 → 보고 섹션을 그대로 따릅니다.**

유일한 차이점:

1. **실행 섹션(CLI 에이전트) 수행 시** `TFX_CLI_MODE=codex`를 환경변수로 전달:
   ```bash
   TFX_CLI_MODE=codex bash ~/.claude/scripts/tfx-route.sh {agent} '{prompt}' {mcp_profile}
   ```

2. **트리아지 섹션에서** gemini 분류 결과를 codex로 강제 변환:
   - Codex 분류가 `gemini`를 반환하면 → `codex`로 교체
   - Opus 분해에서 designer/writer → Codex 에이전트 + implement/analyze MCP 프로필

3. **MCP 프로필 조정**:
   - designer: `implement` (코드 기반 UI 작업)
   - writer: `analyze` (문서 기반 리서치+작성)

## 필수 조건

- [Codex CLI](https://github.com/openai/codex): `npm install -g @openai/codex`
- Gemini CLI 불필요

## Troubleshooting

문제 발생 시 `/tfx-doctor` 실행. (`--fix` 자동 수정, `--reset` 캐시 초기화)
