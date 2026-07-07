# `--retry auto-escalate` 체인 규약

`/tfx-auto --retry auto-escalate` 가 사용하는 CLI 승격 체인.
각 단계에서 `--max-iterations` (기본 3) 소진 시 다음 단계로 전이.

> 근거(why): [ADR-0006 — 재시도 승격 체인 codex→claude opus 2단계](../../docs/adr/0006-escalation-chain-codex-to-claude-opus.md). 이 문서가 SSOT(어떻게), ADR은 결정 이력(왜).

## DEFAULT_ESCALATION_CHAIN

`hub/team/retry-state-machine.mjs` 의 `DEFAULT_ESCALATION_CHAIN` 상수.

| # | CLI | 모델 | profile | 이유 |
|---|-----|------|---------|------|
| 1 | codex | gpt-5.5 | 미지정 | 코드/추론/비용에서 gpt-5.4-mini / gpt-5.3-codex 중간 단계를 대체. profile 미지정 시 `config.toml` 기본값 사용. |
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
    { "cli": "codex", "model": "gpt-5.5", "profile": "gpt55_high" },
    { "cli": "claude", "model": "opus-4-8" }
  ]
}
```

체인 항목 필드:
- `cli` (codex|antigravity|claude)
- `model` (CLI 가 해석하는 문자열)
- `profile` (optional): `gpt55_low` / `gpt55_med` / `gpt55_high` / `gpt55_xhigh` 같은 CLI profile 이름. 지정되면 파싱/전달만 하며, 없으면 기존 동작과 동일하게 각 CLI/config 기본값을 따른다.

## 사용 예시

```
# 기본 체인 (2단계)
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
