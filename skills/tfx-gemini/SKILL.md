---
name: tfx-gemini
description: Gemini-Only 오케스트레이터. tfx-auto 워크플로우를 Gemini 전용으로 고정합니다.
triggers:
  - tfx-gemini
argument-hint: "\"작업 설명\" | N:gemini \"작업 설명\""
---

# tfx-gemini — Gemini-Only 오케스트레이터

> Gemini CLI만 사용하여 모든 외부 CLI 작업을 라우팅합니다.
> Codex CLI가 없는 환경에서 사용합니다.

## 사용법

```
/tfx-gemini "작업 설명"
/tfx-gemini N:gemini "작업 설명"
```

## 동작 원리

`tfx-auto`와 동일한 워크플로우를 사용하되, `TFX_CLI_MODE=gemini` 환경변수를 설정하여
모든 Codex 에이전트를 Gemini로 리매핑합니다.

### 에이전트 라우팅

| 에이전트 | 원래 CLI | tfx-gemini에서 |
|----------|---------|--------------|
| **executor, debugger, deep-executor** | ~~Codex~~ | **Gemini Pro** |
| **build-fixer** | ~~Codex~~ | **Gemini Flash** |
| **architect, planner, critic, analyst** | ~~Codex~~ | **Gemini Pro** |
| **code-reviewer, security-reviewer, quality-reviewer** | ~~Codex~~ | **Gemini Pro** |
| **scientist, scientist-deep** | ~~Codex~~ | **Gemini Pro/Flash** |
| **document-specialist** | ~~Codex~~ | **Gemini Flash** |
| designer | Gemini | Gemini (변경 없음) |
| writer | Gemini | Gemini (변경 없음) |
| explore | Claude Haiku | Claude Haiku (변경 없음) |
| verifier, test-engineer | Claude Sonnet | Claude Sonnet (변경 없음) |

### 모델 분기

| 복잡도 | Gemini 모델 | 대상 에이전트 | 근거 |
|--------|------------|-------------|------|
| 높음 | `gemini-3.1-pro-preview` | executor, debugger, deep-executor | 구현/분석 깊이 필요 |
| 높음 | `gemini-3.1-pro-preview` | architect, planner, critic, analyst | 설계 품질 |
| 높음 | `gemini-3.1-pro-preview` | code-reviewer, security-reviewer, quality-reviewer | 리뷰 품질 |
| 높음 | `gemini-3.1-pro-preview` | scientist-deep | 심층 리서치 |
| 낮음 | `gemini-3-flash-preview` | build-fixer, spark | 빠른 수정/린트 |
| 낮음 | `gemini-3-flash-preview` | scientist, document-specialist | 일반 검색+요약 |
| 낮음 | `gemini-3-flash-preview` | writer | 문서/가이드 생성 |

## 실행 규칙

**tfx-auto SKILL.md의 모든 Phase(1~6) 워크플로우를 그대로 따릅니다.**

유일한 차이점:

1. **Phase 3 CLI 실행 시** `TFX_CLI_MODE=gemini`을 환경변수로 전달:
   ```bash
   TFX_CLI_MODE=gemini bash ~/.claude/scripts/cli-route.sh {agent} '{prompt}' {mcp_profile}
   ```

2. **Phase 2 트리아지에서** codex 분류 결과를 gemini로 강제 변환:
   - Codex 분류가 `codex`를 반환하면 → `gemini`로 교체
   - Opus 분해에서 모든 Codex 에이전트 → Gemini 모델 매핑

3. **Phase 2a Codex 분류 단계를 건너뜀**:
   - Codex CLI가 없으므로 Opus가 직접 분류+분해 수행

4. **Windows 안정화 자동 적용**:
   - 모든 Gemini 워커에 `--timeout 60` + health check
   - hang 감지 시 자동 재시도

## 필수 조건

- [Gemini CLI](https://github.com/google-gemini/gemini-cli): `npm install -g @google/gemini-cli`
- Codex CLI 불필요
