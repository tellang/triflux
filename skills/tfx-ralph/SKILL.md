---
name: tfx-ralph
description: "작업이 완전히 끝날 때까지 멈추지 않고 반복 실행해야 할 때 사용한다. 'ralph', '끝까지 해', '멈추지 마', 'don't stop', '완료될 때까지', '다 될 때까지 계속' 같은 요청에 반드시 사용. 여러 기준을 모두 충족해야 하는 복잡한 구현 작업에 적극 활용."
triggers:
  - tfx-ralph
argument-hint: "<완료할 작업 설명>"
---

# tfx-ralph — Alias for tfx-persist

> **래퍼**: tfx-persist의 alias. 동일 기능.
> `tfx-ralph`는 `tfx-persist`의 alias이다. 동일한 Tri-Verified Persistence Loop을 실행한다.
> The boulder never stops — but it stops being wrong.

## 실행 계약

이 스킬은 `tfx-persist`와 **완전히 동일한 실행 흐름**을 공유한다:

1. **동일한 headless multi 경로** — `tfx multi --teammate-mode headless` 기반 3자 검증
2. **동일한 degradation 체인** — Tier 1 (전체 가용) → Tier 2 (부분 가용) → Tier 3 (Claude only)
3. **동일한 워크플로우** — Goal Definition → Execution Loop → Final Verification → Deslop Pass

## 전제조건 프로브 및 Tier Degradation

> **진입 즉시 실행** — 10초 내 가시적 출력을 보장한다. 빈 stdout + exit 0 **금지**.

### 환경 프로브

```bash
psmux --version 2>/dev/null && \
  curl -sf http://127.0.0.1:27888/status >/dev/null && \
  codex --version 2>/dev/null && \
  gemini --version 2>/dev/null
```

### Tier 판정

| Tier | 조건 | 실행 방식 |
|------|------|----------|
| **Tier 1** | psmux + Hub + Codex + Gemini 전부 정상 | 기존 headless multi (변경 없음) |
| **Tier 2** | 일부 CLI만 가용 (Codex 또는 Gemini 중 하나) | 가용 CLI + Claude Agent 조합 |
| **Tier 3** | headless 불가 또는 `claude -p` one-shot | Claude Agent only |

```
IF claude -p (one-shot 모드):
  → Tier 3 즉시 fallback

IF psmux 없음 OR Hub 미응답:
  → Tier 3

IF Codex 없음 AND Gemini 없음:
  → Tier 3

IF Codex 없음 OR Gemini 없음:
  → Tier 2

ELSE:
  → Tier 1
```

### Tier 3 진입 시 필수 출력

```
⚠ [Tier 3] headless multi 환경 미충족 — single-model 모드로 실행합니다 (consensus 미적용)
  누락: {missing_components}
  권장: psmux, Hub, Codex CLI, Gemini CLI 설치 후 재실행
```

Tier 3에서는 모든 headless dispatch(`tfx multi ...`)를 **Claude Agent**(subagent)로 대체한다.
Tier 2에서는 누락된 CLI만 Claude Agent로 대체한다.

## 라우팅

```
/tfx-ralph "{task}" → /tfx-persist "{task}" 로 내부 전달
```

전체 워크플로우, 토큰 예산, Anti-Stuck 메커니즘은 [tfx-persist/SKILL.md](../tfx-persist/SKILL.md)를 참조하라.
