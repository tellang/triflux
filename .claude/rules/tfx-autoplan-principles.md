# tfx-autoplan 판단 원칙

출처:
- gstack `autoplan` 스킬 문서: `~/.claude/skills/autoplan/SKILL.md`
- triflux 교차검증 규칙: `CLAUDE.md`의 `## 교차 검증`

라이선스:
- gstack 관련 추출 규칙은 MIT 라이선스 문서에서 판단 규칙만 요약했다.

목적:
- triflux가 gstack runtime 없이도 `autoplan`의 자동 판단 규칙을 자체 정책 테이블로 재사용하기 위한 문서다.
- 실행 명령, telemetry, `CLAUDE.md` 자동 수정, 로그 기록 같은 부수효과는 가져오지 않는다.

## 6 Decision Principles

| 원칙명 | 한국어 정의 | triflux 적용 예시 |
|------|-----------|------------------|
| completeness | 부분 최적화보다 전체 완결을 우선한다. 같은 비용대면 edge case를 더 많이 덮는 선택을 택한다. | plan 검토에서 empty/loading/error 상태가 빠졌다면 축소하지 말고 포함한다. |
| lake-boil | blast radius 안에서 끝낼 수 있는 확장은 같이 처리한다. 다만 ocean급 재작성은 금지한다. | 수정 파일과 직접 importer 범위에서 끝나는 보완은 같이 승인하고, 신규 인프라나 대규모 재설계는 TODO로 민다. |
| pragmatic | 같은 문제를 풀면 더 깔끔하고 판단 비용이 낮은 쪽을 고른다. | 둘 다 동작하면 설명이 짧고 유지보수 쉬운 안을 택한다. |
| DRY | 기존 기능과 중복되면 새 경로를 만들지 않고 재사용한다. | 기존 helper/engine이 있는데 유사한 planner 분기를 하나 더 만들지 않는다. |
| explicit-over-clever | 축약된 영리함보다 신규 기여자가 30초 안에 읽을 수 있는 명시성을 택한다. | 200줄 추상화 대신 10줄 분기와 주석 1개로 끝나는 수정이 우선이다. |
| bias-toward-action | 우려는 남기되 멈추지 않는다. 검토 루프를 무한 반복하지 말고 진행 가능한 해법을 확정한다. | consensus 이견이 경미하면 경고를 기록하고 다음 phase로 넘긴다. |

## Phase별 우선순위

| Phase | 우선 원칙 | 적용 규칙 |
|------|---------|----------|
| CEO | completeness + lake-boil | 더 완전한 대안을 먼저 고른다. blast radius 안이고 1일 미만이면 확장 승인, 밖이면 defer 한다. |
| Design | explicit-over-clever + completeness | 빠진 상태, hierarchy, 접근성 같은 구조 문제를 먼저 메운다. 미감 차이는 taste decision으로 남긴다. |
| Eng | explicit-over-clever + pragmatic | 아키텍처는 명시적 선택을 우선한다. 같은 효과면 더 단순하고 읽기 쉬운 구현을 택한다. |
| DX | explicit-over-clever + completeness | fewer steps, guessable naming, problem+cause+fix 오류 메시지를 우선한다. 유연성 대 기본값 충돌은 taste decision으로 남긴다. |

## Phase별 세부 적용 규칙

| Phase | 규칙 |
|------|------|
| CEO | reasonable premise는 수용하고, 명백히 틀린 premise만 challenge 한다. premise 확인은 유일한 human judgment gate로 남긴다. |
| CEO | 대안 비교는 completeness 우선, 동률이면 simplest/explicit 쪽을 택한다. 근소 차이면 taste decision이다. |
| CEO | 중복 기능은 reject 한다. blast radius 경계가 3~5 파일 수준으로 애매하면 taste decision이다. |
| Design | relevant dimension은 전부 본다. 구조 결함은 auto-fix 대상이고, aesthetic/taste 이슈만 taste decision이다. |
| Design | `DESIGN.md`가 있고 정렬 방법이 명확하면 design system alignment는 자동 정렬한다. |
| Eng | scope는 줄이지 않는다. eval은 관련 suite를 모두 포함한다. |
| Eng | 아키텍처 선택은 explicit-over-clever를 우선 적용한다. Codex가 타당한 이견을 내면 taste decision으로 승격한다. |
| Eng | 두 모델이 함께 scope 변경을 요구하면 auto-decide 하지 않고 user challenge로 올린다. |
| DX | persona는 README/docs에서 가장 일반적인 개발자 유형으로 고른다. |
| DX | getting started friction은 단계 수를 줄이는 쪽으로, API/CLI naming은 consistency가 cleverness보다 우선이다. |
| DX | error message는 항상 problem + cause + fix를 포함해야 한다. benchmark는 가능하면 실제 검색, 아니면 문서화된 기준값을 쓴다. |

## 충돌 해소 순서

| 순서 | 규칙 |
|------|------|
| 1 | 현재 phase의 우선 원칙 쌍을 먼저 적용한다. CEO는 completeness/lake-boil, Design은 explicit/completeness, Eng는 explicit/pragmatic, DX는 explicit/completeness 순이다. |
| 2 | 중복이면 DRY로 즉시 reject 한다. |
| 3 | 진행 가능하고 안전한 선택이면 bias-toward-action으로 확정한다. |
| 4 | 둘 다 합리적인 근접 해법이면 taste decision으로 분류하고 마지막 gate에 남긴다. |
| 5 | 두 모델이 모두 사용자의 원래 방향을 바꾸자고 합의하면 user challenge다. 자동 확정하지 않는다. 기본값은 사용자 원안 유지다. |

## 적용 시점

| 상황 | 적용 |
|------|------|
| `tfx-plan`에서 선택지가 2개 이상 남을 때 | 이 문서의 6원칙으로 중간 질문을 자동 해소한다. |
| `tfx-auto --mode consensus`에서 경미한 disagreement를 정리할 때 | phase 우선순위와 충돌 해소 순서를 적용해 mechanical 또는 taste로 분류한다. |
| triflux가 gstack `autoplan` 없이 자체 consensus gate를 만들 때 | 이 문서를 dependency-free policy table로 직접 참조한다. |

## 안티패턴

| 안티패턴 | 금지 이유 | 대체 규칙 |
|---------|----------|----------|
| same model + same context self-approval | 독립 검증이 아니므로 disagreement 신호를 잃는다. triflux 교차검증 규칙과 충돌한다. | Claude 작성물은 Codex가, Codex 작성물은 Claude가 검토한다. 동일 모델 self-approve는 금지한다. |
| ocean boiling | blast radius 밖 대규모 재작성까지 한 번에 끌어오면 판단 원칙이 아니라 scope drift가 된다. | lake만 같이 끓이고, ocean은 TODO 또는 별도 PRD로 분리한다. |
| clever abstraction first | 설명 비용이 크고 신규 기여자 온보딩을 악화시킨다. | explicit branch, 작은 함수, 재사용 가능한 기존 경로를 우선한다. |

## 메모

- 이 문서는 정책 추출본이다. 실행 절차, 하위 에이전트 호출, telemetry, review log, artifact path 규칙은 포함하지 않는다.
- taste decision은 기록 후 최종 gate로 넘기고, mechanical decision은 바로 적용한다.
