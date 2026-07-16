# `--retry auto-escalate` 체인 규약

`/tfx-auto --retry auto-escalate` 가 사용하는 CLI 승격 체인.
각 단계에서 `--max-iterations` (기본 3) 소진 시 다음 단계로 전이.

> 근거(why): [ADR-0006 — 재시도 승격 체인 codex→claude opus 2단계](../../docs/adr/0006-escalation-chain-codex-to-claude-opus.md). 이 문서가 SSOT(어떻게), ADR은 결정 이력(왜).

## DEFAULT_ESCALATION_CHAIN

`hub/team/retry-state-machine.mjs` 의 `DEFAULT_ESCALATION_CHAIN` 상수.

| # | CLI | 모델 | profile | 이유 |
|---|-----|------|---------|------|
| 1 | codex | gpt-5.6-sol | gpt56_sol_max | 최난도 단일 작업용 Codex 복구 단계. |
| 2 | claude | opus-4-8 | 미지정 | 최종 수단, 복잡 아키텍처/합의 요구 시 |

체인 길이 소진 시 `BUDGET_EXCEEDED` with `reason: "escalation-chain-exhausted"`.

## 전이 규약

- 각 단계 default `max_iterations = 3` (사용자가 `--max-iterations N` 로 override)
- 단계 전이 시 iterations / stuckCounter / lastFailureReason 리셋
- **동일 failureReason 3회 연속** 은 체인과 무관하게 `STUCK` → 즉시 중단

## 프로젝트 override

PRD 또는 프로젝트 별 체인 커스터마이즈 시 `.triflux/config/escalation-chain.json` 을 두면 `DEFAULT_ESCALATION_CHAIN` 대신 이 파일을 읽는다:

```json
{
  "version": 1,
  "chain": [
    { "cli": "codex", "model": "gpt-5.6-sol", "profile": "gpt56_sol_max" },
    { "cli": "claude", "model": "opus-4-8" }
  ]
}
```

체인 항목 필드:
- `cli` (codex|antigravity|claude)
- `model` (CLI 가 해석하는 문자열)
- `profile` (optional): `gpt56_luna_low` / `gpt56_terra_med` / `gpt56_terra_high` / `gpt56_sol_xhigh` / `gpt56_sol_max` 같은 CLI profile 이름. `gpt56_sol_ultra`는 다른 오케스트레이터가 없는 최상위 단독 실행 전용이므로 retry chain에는 넣지 않는다.

## 사용 예시

```
# 기본 체인 (2단계)
/tfx-auto "복구" --retry auto-escalate

# 단계당 상한 2회
/tfx-auto "복구" --retry auto-escalate --max-iterations 2

# ralph 와 조합 불가 — auto-escalate 가 우선
/tfx-auto "복구" --retry auto-escalate --retry ralph   # 마지막 값 사용
```

## Codex max / ultra 예외 레인

- `TFX_CODEX_PROFILE=max`는 `gpt56_sol_max`를 명시적으로 선택한다.
- `TFX_CODEX_PROFILE=ultra`는 다른 오케스트레이터가 없는 최상위
  `deep-executor`/`scientist-deep` 실행에서만 `gpt56_sol_ultra`로 해석한다.
- Team, worker, delegator sandbox 안의 ultra 요청과 ultra 비대상 역할은
  `gpt56_sol_max`로 강등한다.
- headless Codex는 전역 `config.toml` effort를 상속하지 않고 역할 프로필을
  명시한다.
- retry snapshot은 `TFX_CODEX_PROFILE`보다 우선한다.

```bash
TFX_CODEX_PROFILE=max bash scripts/tfx-route.sh architect "review the system boundary" analyze
TFX_CODEX_PROFILE=ultra bash scripts/tfx-route.sh scientist-deep "research the alternatives" analyze
```

## 관련

- 설계 PRD: `.triflux/plans/phase3-lead-codex-ralph-escalate.md`
- 구현: `hub/team/retry-state-machine.mjs` (STATES / MODES / createRetryStateMachine)
- Bridge: `hub/bridge.mjs retry-run --snapshot X --mode auto-escalate ...`
