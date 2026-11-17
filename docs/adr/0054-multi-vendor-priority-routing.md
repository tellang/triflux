---
id: 0054
title: 역할군별 3사 모델 우선순위 라우팅과 쿼터 연동 및 Jev 조정 규칙을 도입한다
status: accepted
date: 2026-11-17
deciders: [tellang]
supersedes: [0004, 0039, 0053]
superseded_by: null
relates: [0004, 0037, 0039, 0048, 0049, 0050, 0051, 0053]
pr: null
---

# ADR-0054: 역할군별 3사 모델 우선순위 라우팅과 쿼터 연동 및 Jev 조정 규칙을 도입한다

## 목적

단일 벤더 고정 매핑(`hub/team/agent-map.json`)과 2자 간 하드코딩 폴백(`scripts/tfx-route.sh`)을 역할군별 3사(Claude, Codex, Antigravity) 우선순위 후보 배열로 통합한다. 쿼터 스냅샷과 Jev 판단 신호를 워커 시작 시점의 단일 우선순위 모듈에서 결합해 한도 소진, 역할별 품질 격차, 분산된 폴백 로직을 함께 해결한다. 상세 모듈 경계와 입출력 계약은 [설계 문서](../design/multi-vendor-priority-routing.md), 외부 근거는 [2026-11 리서치 보고서](../research/multi-vendor-role-allocation-2026-11.md)에 둔다.

## 결정

- **단일 우선순위 모듈 통합:** `scripts/lib/`에 단일 우선순위 모듈(`vendor-priority-policy.mjs`)과 읽기 전용 쿼터 스냅샷 모듈(`quota-snapshot.mjs`)을 신설한다. 역할, 쿼터 스냅샷, Jev 조정 신호, 환경 오버라이드를 입력받아 순서 있는 후보 배열 `[{ cli, tier, familyOrModel, effort, profile }]`을 반환하며, `scripts/tfx-route.sh`의 `apply_cli_mode`, `apply_cli_disable_policy`, `auto_reroute`와 `hub/team/retry-state-machine.mjs` 승격 체인, `hub/team/orchestrator.mjs`의 `judgeTaskAssignment`가 모두 이 모듈의 후보와 등급 기준을 공유한다.
- **수치 기준 3사 모델 4등급표와 Hydrogen 추가:** 제3자 성능 지표와 벤더 권고에 맞춰 모델 등급을 4단계로 정렬한다.
  - 최상(`top`): Claude `fable`(Fable 5.2), Antigravity `carbon`(Gemini 4 Carbon), Claude `opus`(Opus 5.5), Codex `astra`
  - 상(`high`): Codex `sol`(Sol 6.1), Claude `sonnet`(Sonnet 5.5), Antigravity `hydrogen`(Gemini 4 Hydrogen)
  - 중(`mid`): Codex `terra`(Terra 6.1), Antigravity `argon`(Gemini 4 Argon)
  - 하(`low`): Claude `haiku`(Haiku 5.5), Codex `luna`
  - `scripts/lib/model-family-resolver.mjs`와 `scripts/lib/gemini-profiles.mjs`에 `hydrogen_low`, `hydrogen`, `hydrogen_high` 프로필을 추가해 `AGY_CACHE_KEY`를 갱신하고, `agy models` 목록에 요청 가족이 없으면 `models.json` 고정 핀을 제외한 경우에 한해 `argon` 기본 가족으로 폴백한다. `hub/lib/jev-addon.mjs`의 `COMPLEXITY_ROUTE_MAP`도 이 등급표에 맞춰 교정한다.
- **6개 역할군과 기본 벤더 순서:** 에이전트 역할을 6개 묶음으로 나누고 쿼터 여유 시 기본 순서를 다음과 같이 정한다.
  - 탐색(`explore`, `spark`): 하 등급. `Claude Haiku`, `Codex Luna`, `agy Hydrogen (low)` 순.
  - 판단(`architect`, `planner`, `critic`, `analyst`, `debugger`, `deep-executor`, `scientist-deep`): 최상 등급. `Claude Opus`, `Codex Astra`, `agy Carbon` 순. `Fable`은 계획 검증과 승격 체인에 배치하고 `deep-executor`와 `scientist-deep`의 최상위 단독 `ultra` 규칙은 유지한다. `debugger`는 원인 추론 비중에 따라 판단군에 둔다.
  - 실행(`executor`, `codex`, `verifier`, `test-engineer`, `qa-tester`, `scientist`, `build-fixer`, `cleanup`, `deslop`): 상 등급. `Codex Sol`, `agy Hydrogen`, `Claude Sonnet` 순이며 `build-fixer`, `cleanup`, `deslop`은 effort를 낮춘다.
  - 검증(`code-reviewer`, `quality-reviewer`, `security-reviewer`): 작성자 이상 등급을 강제한다. 일반 리뷰(`code-reviewer`, `quality-reviewer`)는 `Codex Sol`, `Claude Opus`, `agy Hydrogen`에서 `TFX_REVIEW_AUTHOR` 벤더를 우선 제외하되 타 벤더가 모두 막히면 동일 벤더의 새 세션을 최후 후보로 허용한다. `security-reviewer`는 강등 금지(`NO_LOWER`) 최상 등급으로 `Claude Fable`, `Codex Astra`, `agy Carbon` 순을 쓴다.
  - 글쓰기와 디자인(`designer`, `writer`, `document-specialist`): `designer`는 `Claude Opus`, `agy Hydrogen`, `Codex Sol` 순으로 두고, `writer`와 `document-specialist`는 1M 문맥과 사람 선호 1위를 반영해 `agy Argon`, `Claude Opus`, `Codex Terra` 순으로 둔다.
  - 리드와 소통(`lead`, 상태 중계 소통, 사용자 대면 보고 소통): `lead`는 최상 등급(`Claude Opus`, `Codex Astra`, `agy Carbon`)에 두고 워커의 압축 요약만 전달한다. 상태 중계와 알림 소통은 하 등급(`Claude Haiku`, `Codex Luna`, `agy Hydrogen low`), 사용자 대면 보고 소통은 `Claude Opus`, `agy Argon` 순으로 연결한다.
- **쿼터 신호 연동과 전환 기준:** `quota-snapshot.mjs`는 Claude(`~/.claude/cache/claude-usage-cache.json`), Codex(`~/.claude/cache/codex-rate-limits-cache.json`), Antigravity(`~/.claude/cache/antigravity-quota-cache.json` 및 `$TFX_TMP/tfx-agy-quota-reset`)를 읽기 전용으로 조회한다.
  - 5시간 창과 주간 창 중 높은 사용률이 `95%`를 넘은 벤더는 모델 등급을 유지한 채 후보 순서에서 한 칸 뒤로 미룬다(기존 리뷰어 전용 Claude 80% 전환 대체).
  - 쿼터 소진(`>=100%`), 리셋 대기 쿨다운, CLI 미설치, `TFX_DISABLE_*` 상태인 벤더는 리셋 시각까지 후보에서 제외하고 리셋 시각이 지나면 자동 복구한다.
  - 실행 중 쿼터 초과 감지(`auto_reroute`)도 동일 후보 배열의 다음 가용 벤더로 넘기며, 인증 오류, 컨텍스트 초과, 정책 거부는 벤더 전환 사유에서 제외한다.
  - 가용 후보가 하나도 없으면 조용히 강등하지 않고 기존 계약대로 `exit 78`로 실패하며 `TFX_CLI_MODE` 명시 우선순위와 `claude-native` 암묵 강등 금지 규칙을 보존한다.
- **Jev 소폭 조정과 세션 고정:** Jev가 켜져 있고 신뢰도가 `0.85` 이상이면 작업 단계, 특성(시각 및 프런트엔드, 장문맥), 분해 가능 여부를 신호로 받아 기본 벤더 순서를 최대 한 칸만 조정한다. 벤더 선택은 워커 시작 시점에만 계산하며 세션 도중에는 바꾸지 않는다.

## 이유

- **역할별 비용 대비 품질 최적화:** 분해와 판단 계층에 상위 추론 모델을 두고 실행과 탐색 계층에 빠르고 경제적인 모델을 둘 때 위임 용량 확대 이득이 약 4배 높다. 실행군에 `Codex Sol`과 `agy Hydrogen`을 앞세우면 `Opus`나 `Sonnet` 단독 실행보다 구독 쿼터 소모와 비용을 크게 줄이면서도 정확도를 유지한다.
- **등급 불일치 해소:** 제3자 측정(Artificial Analysis v5.0.1, Terminal-Bench 4.1)에서 `Opus 5.5`는 최상 등급이고 `Hydrogen`은 코딩 성능과 작업 속도 모두 `Argon`보다 앞선 상 등급이다. 기존처럼 Antigravity 전체를 `Argon`에만 묶거나 `Carbon`을 명시 지정 전용으로만 가두면 역할군별 적정 배치가 불가능하다.
- **쿼터 소진 전 선제 분산과 자동 복구:** 한 벤더가 100% 막힌 뒤에야 프로세스를 실패시키고 재실행하면 지연과 토큰 낭비가 발생한다. 95% 구간에서 순서를 한 칸만 미루면 등급 강등 없이 부하를 옆 벤더로 분산할 수 있고, 리셋 시각 기반 제외는 만료 즉시 원래 우선순위로 복구된다.
- **리뷰 독립성과 가용성 양립:** 약한 모델 리뷰어는 정답률을 떨어뜨리고, 타 벤더 강제만 고집하면 두 벤더가 막혔을 때 리뷰 전체가 멈춘다. 작성자 이상 등급을 강제하면서 타 벤더 전멸 시에만 동일 벤더 새 세션을 허용하면 자기 출력 편향을 피하면서도 가용성을 지킨다.
- **폴백 파편화 제거:** 셸 스크립트, 재시도 상태머신, 팀 오케스트레이터가 서로 다른 하드코딩 대안을 쓰던 구조를 단일 모듈로 합쳐 예측 불가능한 전환을 없앤다.

## 검토한 대안

- **기존 단일 벤더 맵(`agent-map.json`) 유지 및 2자 하드코딩 폴백 보수:** 수정 범위는 작지만 3사 구독 한도를 함께 활용하지 못하고 역할마다 2순위와 3순위 등급이 일관되지 않는다.
- **프롬프트 분류기(Jev)가 역할표 없이 벤더와 모델을 전권 선택:** 외부 사례에서 프롬프트 단독 라우터는 오판율이 높고 사용자 의도를 덮어쓰는 문제가 반복 확인되었다. 규칙표가 기본 순서를 쥐고 Jev는 고신뢰(`>=0.85`) 신호에서만 최대 한 칸 조정하는 편이 안전하다.
- **쿼터 80~90% 구간에서 같은 벤더의 하위 모델로 등급 하향:** Hydra 같은 사례가 있으나 판단이나 보안 리뷰에서 모델 등급을 낮추면 오탐과 설계 결함이 급증한다. 등급은 유지하고 벤더 순서만 한 칸 미루는 방식을 택했다.
- **실행 중인 워커 세션 도중 타 벤더로 실시간 인계:** 프롬프트 캐시가 깨지고 도구 호출 형식 차이로 파싱 실패가 발생하므로 워커 시작 시점 선택과 쿼터 오류 시 새 워커 재시작만 허용한다.
- **타 벤더 불능 시 리뷰 즉시 실패 유지(ADR-0039 현행):** 두 벤더 쿼터가 동시에 찬 상황에서 작업 마감이 막힌다. 사전등록 연구에서 새 세션 분리만으로도 상당한 검증 효과가 확인되었으므로 타 벤더 전멸 시에 한해 동일 벤더 새 세션을 최후 후보로 허용한다.

## 결과

- 구현 단계에서 `scripts/lib/quota-snapshot.mjs`와 `scripts/lib/vendor-priority-policy.mjs`가 추가되고 `scripts/lib/model-family-resolver.mjs`, `scripts/lib/gemini-profiles.mjs`, `scripts/lib/agent-route-policy.mjs`, `scripts/lib/machine-profile.mjs`, `scripts/tfx-route.sh`, `hub/bridge.mjs`, `hub/lib/jev-addon.mjs`, `hub/team/agent-map.json`, `hub/team/retry-state-machine.mjs`, `hub/team/orchestrator.mjs`, `hub/team/lead-launch.mjs`, `hub/team/iterm-layout.mjs`가 단일 후보 규칙으로 정렬된다.
- 변경 대상 모듈은 `packages/core`, `packages/triflux`, `packages/remote` 3계층 미러 규칙(ADR-0005)에 따라 동기화되어야 한다.
- 본 ADR이 `accepted`로 전환될 때 대체 대상인 ADR-0004, ADR-0039, ADR-0053의 상태를 `superseded`(`superseded_by: 0054`)로 갱신하고 `docs/_archive/adr/` 보관 절차를 밟는다.
