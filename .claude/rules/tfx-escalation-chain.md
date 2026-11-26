---
paths:
  - "scripts/tfx-route.sh"
  - "scripts/lib/agent-route-policy.mjs"
  - "hub/team/retry-state-machine.mjs"
  - "skills/tfx-auto/**/*"
  - ".triflux/config/escalation-chain.json"
---
# `--retry auto-escalate` 체인 규약

`/tfx-auto --retry auto-escalate` 가 사용하는 CLI 승격 체인.
각 단계에서 양수 `--max-iterations N`을 소진하면 다음 단계로 전이한다. 기본값 `0`이면 횟수에 따른 승격은 없고 동일 실패 3회 STUCK 규칙만 적용된다.

> 근거: [ADR-0037](../../docs/adr/0037-model-family-aliases.md), [ADR-0054](../../docs/adr/0054-multi-vendor-priority-routing.md). 이 문서가 실행 규칙의 정본이다.

## DEFAULT_ESCALATION_CHAIN

`hub/team/retry-state-machine.mjs` 의 `DEFAULT_ESCALATION_CHAIN` 상수.

| # | CLI | 모델 | profile | effort | 이유 |
|---|-----|------|---------|--------|------|
| 1 | codex | 프로필에서 해석 | astra_max | max | 최난도 단일 작업용 Codex 1차 복구 단계 |
| 2 | antigravity | 프로필에서 해석 | carbon_high | high | 이기종 벤더 상위 추론(Carbon high, 미보유 시 Neon high, 그다음 Hydrogen high 폴백) 2차 복구 단계 |
| 3 | claude | fable | 미지정 | high | Claude CLI가 최신 Fable tier로 해석하는 최종 수단, 복잡 아키텍처 및 합의 요구 시 |

체인 생성 시 비활성(`TFX_DISABLE_*=1`), 미설치(`TFX_*_OK=0`), 쿼터 `>=100%`, 쿨다운 중인 벤더 단계는 자동으로 건너뛰며, 가용한 단계가 하나도 없으면 빈 체인으로 즉시 `BUDGET_EXCEEDED` 처리한다. 체인 길이 소진 시 `BUDGET_EXCEEDED` with `reason: "escalation-chain-exhausted"`.

## 전이 규약

- 단계별 상한은 `--max-iterations N`(양수)으로 준다. 기본값 `0`은 상한과 횟수 승격이 없다(`retry-state-machine.mjs`의 `maxIterations` 기본값)
- 단계 전이 시 iterations / stuckCounter / lastFailureReason 리셋
- **동일 failureReason 3회 연속** 은 체인과 무관하게 `STUCK` 처리 후 즉시 중단

## 프로젝트 override

PRD 또는 프로젝트 별 체인 커스터마이즈 시 `.triflux/config/escalation-chain.json` 을 두면 `DEFAULT_ESCALATION_CHAIN` 대신 이 파일을 읽는다:

```json
{
  "version": 1,
  "chain": [
    { "cli": "codex", "profile": "astra_max", "effort": "max" },
    { "cli": "antigravity", "profile": "carbon_high", "effort": "high" },
    { "cli": "claude", "model": "fable", "effort": "high" }
  ]
}
```

체인 항목 필드:
- `cli` (codex|antigravity|claude)
- `model`: 프로필이 없는 단계에서 CLI가 해석하는 문자열. Codex 및 Antigravity 관리 프로필 단계에는 넣지 않는다.
- `profile` (optional): Codex(`luna_low` / `luna_high` / `sol_med` / `sol_high` / `astra_xhigh` / `astra_max`) 또는 Antigravity(`hydrogen_low` / `hydrogen` / `hydrogen_high` / `argon_low` / `argon` / `argon_high` / `carbon_low` / `carbon` / `carbon_high`) 프로필 이름. `astra_ultra`는 다른 오케스트레이터가 없는 최상위 단독 실행 전용이므로 retry chain에는 넣지 않는다.
- `family` (optional): 결합 이름이 없는 가족(예: Antigravity `neon`)은 `profile` 대신 `family`와 `effort`를 함께 적는다. 예: `{ "cli": "antigravity", "family": "neon", "effort": "xhigh" }`.
- `effort` (optional): 단계별 추론 수준(`low` / `medium` / `high` / `xhigh` / `max`).

기본 Claude 모델은 `fable` 별칭이며 Claude CLI가 최신 Fable tier로 해석한다. 기본값만 바꾸려면 `TFX_ESCALATION_CLAUDE_MODEL`을 설정할 수 있고, 프로젝트의 `.triflux/config/escalation-chain.json`은 그보다 우선한다.

## 사용 예시

```
# 기본 체인 (3단계: codex astra_max -> antigravity carbon_high -> claude fable)
/tfx-auto "복구" --retry auto-escalate

# 단계당 상한 2회
/tfx-auto "복구" --retry auto-escalate --max-iterations 2

# ralph 와 조합 불가: auto-escalate 가 우선
/tfx-auto "복구" --retry auto-escalate --retry ralph   # 마지막 값 사용
```

## Codex max / ultra 예외 레인

- `TFX_CODEX_PROFILE=max`는 `astra_max`를 명시적으로 선택한다.
- `TFX_CODEX_PROFILE=ultra`는 다른 오케스트레이터가 없는 최상위
  `deep-executor`/`scientist-deep` 실행에서만 `astra_ultra`로 해석한다.
- Team, worker, delegator sandbox 안의 ultra 요청과 ultra 비대상 역할은
  `astra_max`로 강등한다.
- headless Codex는 전역 `config.toml` effort를 상속하지 않고 역할 프로필을
  명시한다.
- retry snapshot은 `TFX_CODEX_PROFILE`보다 우선한다.

```bash
TFX_CODEX_PROFILE=max bash scripts/tfx-route.sh architect "review the system boundary" analyze
TFX_CODEX_PROFILE=ultra bash scripts/tfx-route.sh scientist-deep "research the alternatives" analyze
```

## 관련

- 구현: `hub/team/retry-state-machine.mjs` (STATES / MODES / createRetryStateMachine)
- Bridge: `hub/bridge.mjs retry-run --snapshot X --mode auto-escalate ...`
