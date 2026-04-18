# `--retry auto-escalate` 체인 규약

`/tfx-auto --retry auto-escalate` 가 사용하는 CLI 승격 체인.
각 단계에서 `--max-iterations` (기본 3) 소진 시 다음 단계로 전이.

## DEFAULT_ESCALATION_CHAIN

`hub/team/retry-state-machine.mjs` 의 `DEFAULT_ESCALATION_CHAIN` 상수.

| # | CLI | 모델 | 이유 |
|---|-----|------|------|
| 1 | codex | gpt-5-mini | 비용 최저, 단순 태스크 대부분 해결 |
| 2 | codex | gpt-5 | Codex 상위 효과성, 여전히 Anthropic 보다 저렴 |
| 3 | claude | sonnet-4-6 | 도구 사용 + 장문 추론 필요 시 승격 |
| 4 | claude | opus-4-7 | 최종 수단, 복잡 아키텍처/합의 요구 시 |

체인 길이 소진 시 `BUDGET_EXCEEDED` with `reason: "escalation-chain-exhausted"`.

## 전이 규약

- 각 단계 default `max_iterations = 3` (사용자가 `--max-iterations N` 로 override)
- 단계 전이 시 iterations / stuckCounter / lastFailureReason 리셋
- **동일 failureReason 3회 연속** 은 체인과 무관하게 `STUCK` → 즉시 중단

## 프로젝트 override

PRD 또는 프로젝트 별 체인 커스터마이즈 시 `.triflux/config/escalation-chain.json` 을 두면 `DEFAULT_ESCALATION_CHAIN` 대신 이 파일을 읽는다 (구현 예정, Step F 에서 노출):

```json
{
  "version": 1,
  "chain": [
    { "cli": "codex", "model": "gpt-5" },
    { "cli": "claude", "model": "opus-4-7" }
  ]
}
```

체인 항목 필드: `cli` (codex|gemini|claude), `model` (CLI 가 해석하는 문자열).

## 사용 예시

```
# 기본 체인 (4단계)
/tfx-auto "복구" --retry auto-escalate

# 단계당 상한 2회
/tfx-auto "복구" --retry auto-escalate --max-iterations 2

# ralph 와 조합 불가 — auto-escalate 가 우선
/tfx-auto "복구" --retry auto-escalate --retry ralph   # 마지막 값 사용
```

## 관련

- 설계 PRD: `.triflux/plans/phase3-lead-codex-ralph-escalate.md`
- 구현: `hub/team/retry-state-machine.mjs` (STATES / MODES / createRetryStateMachine)
- Bridge: `hub/bridge.mjs retry-run --snapshot X --mode auto-escalate ...`
