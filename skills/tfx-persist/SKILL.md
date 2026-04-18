---
name: tfx-persist
description: >
  DEPRECATED — tfx-auto 로 통합됨. `/tfx-auto --retry ralph` 로 리다이렉트.
  Phase 3 부터 true ralph state machine (unlimited, stuck detector 3회 중단, state file 복원) 이 동작한다.
  Phase 5 (v11) 에 물리 삭제 예정.
deprecated: true
superseded-by: tfx-auto
triggers:
  - ralph
  - don't stop
  - 끝까지
  - until done
  - 멈추지 마
argument-hint: "<작업 설명 — tfx-auto 로 passthrough>"
---

# tfx-persist (DEPRECATED → tfx-auto alias)

> DEPRECATED. `/tfx-auto --retry ralph` 로 리다이렉트.
> Phase 3 부터 **true ralph state machine** — hub/team/retry-state-machine.mjs.

## 동작

1. stderr 에 1회 경고 출력:
   ```
   [deprecated] tfx-persist -> use: tfx-auto --retry ralph
   ```
2. ARGUMENTS 전체 앞에 `--retry ralph` 를 prepend 하여 `Skill("tfx-auto")` 호출.
3. 스킬 경유 시 기본 `--max-iterations 0` (unlimited) 로 진입. CLI 직접 호출 시 bounded 1 로 진입 (임시 합의안, Phase 3 Open question #2).

## 등가 플래그

`--retry ralph` (Phase 3)

deep mode 이 필요한 경우에만 `--mode deep --retry ralph`. 기존 `--mode deep` 강제는 제거 — ralph 의미는 plan/PRD 오버헤드와 독립.

## 이 alias 의 의미

tfx-persist 는 "끝까지, 멈추지 마" (ralph) 의미. Phase 2 까지는 bounded verify/fix 3회 루프로 degrade 되었으나, **Phase 3 에서 true state machine 도입으로 의미 회복**.

Phase 3 상태 전이:
```
PLANNING → EXECUTING → (VERIFY.fail) → DIAGNOSING → EXECUTING …
                    → (VERIFY.success) → DONE
                    → stuckCounter ≥ 3 → STUCK (동일 failureReason 3회 연속 시 중단)
                    → iterations ≥ max → BUDGET_EXCEEDED (max_iterations 0 이면 비활성)
```

상태는 `.omc/state/ralph-<sessionId>.json` 에 jsonl append 로 저장 — compaction survive. `resumeFromStateFile()` 로 재개 가능.

## 마이그레이션 가이드

| 기존 호출 | 새 호출 |
|----------|---------|
| `/tfx-persist "작업"` | `/tfx-auto "작업" --retry ralph` |
| `/tfx-persist "작업" --max 10` | `/tfx-auto "작업" --retry ralph --max-iterations 10` |
