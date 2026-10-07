# 합의 출력 계약

합의 모드의 실행 주체는 참여자 결과를 수집하고 아래 스키마에 맞춰 보고서와 산출물을 직접 작성한다. `--mode consensus`는 합의 작업, `--shape`는 출력 형식을 고른다.

- `--mode consensus --shape consensus`: 세 CLI findings 합의/충돌 판정
- `--mode consensus --shape debate`: 옵션 비교 + ranking/recommendation
- `--mode consensus --shape panel`: 전문가 역할 시뮬레이션

호출 형식:

```text
/tfx-auto \
  "<task or topic>" \
  --mode consensus \
  --shape consensus|debate|panel \
  --cli-set triad|no-antigravity|custom \
  [--experts "..."] \
  [--options "..."] \
  [--criteria "..."] \
  [--analysis-prompt-file <path>]
```

shape 의미:

| `--shape` | 의미 | orchestration 차이 |
|-----------|------|-------------------|
| `consensus` | 세 CLI findings 합의/충돌 판정 | 리더가 발견사항을 종합 |
| `debate` | 옵션 비교 + ranking/recommendation | 리더가 옵션과 기준을 종합 |
| `panel` | 전문가 역할 시뮬레이션 | 리더가 패널 관점을 종합 |

`--cli-set` 규약:

| 값 | 의미 | 비고 |
|----|------|------|
| `triad` | Claude 반론 레인 + Codex + Antigravity | 기본값 |
| `no-antigravity` | Claude 반론 레인 + Codex | Antigravity 미가용 degrade |
| `custom` | 기존 3 CLI 내부 subset/repetition 만 허용 | 신규 provider 추가 금지 |

shape 입력 정규화:

```json
{
  "mode": "consensus",
  "shape": "consensus|debate|panel",
  "topic": "...",
  "cli_set": "triad",
  "participants": ["claude", "codex", "antigravity"],
  "context": "...",
  "analysis_prompt": "...",
  "shape_input": {}
}
```

shape 별 `shape_input`:

```json
{
  "consensus": {
    "analysis_prompt_file": "optional-path",
    "resolution_threshold": 70
  },
  "debate": {
    "options": ["A", "B", "C"],
    "criteria": ["latency", "complexity", "operability"]
  },
  "panel": {
    "experts": {
      "claude": ["Martin Fowler", "Kent Beck"],
      "codex": ["Sam Newman", "Gregor Hohpe"],
      "antigravity": ["Michael Porter", "Karl Wiegers"]
    }
  }
}
```

공통 실행 순서:

1. ARGUMENTS + 플래그 파싱
2. `--mode consensus` 확인
3. `--shape` 기본값 보정 (`consensus`)
4. shape 별 payload 정규화
5. Claude, Codex, Antigravity 참여자에게 dispatch
6. 결과 수집
7. 공통 `meta_judgment` 생성
8. shape에 맞춰 markdown/json 작성
9. 실행 주체가 산출물 저장

공통 메타 및 출력 계약:

- 공통 `meta_judgment` 스키마:

```json
{
  "severity_classification": { "p1": [], "p2": [], "p3": [] },
  "consensus_vs_dispute": { "agreements": [], "conflicts": [] },
  "recommended_action": "merge|FIX_FIRST|close|defer|split",
  "followup_issues": [],
  "mode_specific_meta": {}
}
```

- 공통 root 메타:

```json
{
  "mode": "consensus",
  "shape": "consensus|debate|panel",
  "topic": "...",
  "cli_set": "triad",
  "participants": [
    { "name": "claude", "status": "success" },
    { "name": "codex", "status": "success" },
    { "name": "antigravity", "status": "timeout" }
  ],
  "status": "complete|partial|needs_user_input"
}
```

- 필수 markdown 섹션:
  - `shape=consensus`: `합의 결과`, `Consensus Score`, `합의 항목`, `disputed items`, `resolved items`, `user decision needed`, `meta judgment`
  - `shape=debate`: `토론 결과`, `비교 대상`, `평가 기준`, `합의 사항`, `최종 추천`, `리스크 및 완화 방안`, `meta judgment`
  - `shape=panel`: `전문가 패널 보고서`, `패널 구성`, `패널 합의`, `소수 견해`, `핵심 추천`, `미해결 쟁점`, `다음 단계`, `meta judgment`

artifact 경로:

- markdown: `.omc/artifacts/consensus/<session-id>/<shape>.md`
- json: `.omc/artifacts/consensus/<session-id>/<shape>.json`

shape 별 orchestration 정책:

## `shape=consensus`

정책:

- 목적: 각 participant 의 findings 를 합의/충돌 항목으로 압축하고 `FIX_FIRST` / `merge` / `defer` 같은 실행 결정을 빠르게 내린다.
- 수집 단위: 옵션 비교가 아니라 finding/assertion 단위다. 동일 결론이라도 근거가 다르면 separate evidence 로 보존한다.
- 합의 판정: 3자 중 2자 이상이 같은 수정안 또는 위험 평가를 지지하면 provisional agreement 로 분류하고, Claude 반론 레인이 반론을 제공하고 lead가 최종 `resolved_items` 승격 여부를 결정한다.
- 충돌 승격: P1/P2 급 충돌은 score 와 무관하게 `user_decision_needed` 또는 `FIX_FIRST` 로 승격한다. score 가 높아도 안전 이슈를 묻지 않는다.
- degrade: `no-antigravity` 또는 partial timeout 시 2자 합의를 허용하되 root meta 의 `status=partial` 과 누락 participant 이유를 반드시 남긴다.
- cleanup 요청: 대상(최근 변경분 / 디렉토리 / 전체)을 먼저 확정하고, 각 participant 가 슬롭 카테고리(단일 용도 추상화, 중복 코드, 발생 불가 에러 처리, 코드를 되풀이하는 주석, 과잉 타입, 미사용 코드, 디버그 로깅)를 독립 감지한다. 2자 이상 합의한 항목만 제거하고 제거 후 lint/test 로 회귀를 확인한다.

## `shape=debate`

정책:

- 목적: 2개 이상 옵션을 criteria 기반으로 비교하고 최종 추천안 1개를 만든다.
- 수집 단위: option x criterion matrix 다. participant 자유서술을 그대로 합치지 말고 각 옵션의 장단점/score 를 정규화한다.
- 라운드 운영: 1차 독립 평가 후 상위 2개 옵션 간 반론 라운드 1회를 허용한다. 기본은 2라운드 이하로 제한한다.
- 추천 규칙: 단순 다수결이 아니라 weighted ranking 을 사용하되, P1 risk 가 있는 옵션은 총점이 높아도 최종 추천에서 제외 가능하다.
- criteria 누락: 사용자가 criteria 를 주지 않으면 latency, implementation complexity, operability, migration risk 를 기본 축으로 채운다.

## `shape=panel`

정책:

- 목적: 전문가 roster 기반으로 관점이 다른 조언을 구조화하고 majority/minority view 를 명시한다.
- roster 규칙: `--experts` 미지정 시 기본 roster 를 채우되 각 CLI 가 서로 다른 전문성을 대표하도록 배분한다. 동일 전문가를 중복 배정하지 않는다.
- 발언 구조: participant raw answer 를 그대로 이어붙이지 말고 `expert -> thesis -> supporting evidence -> concern -> recommendation` 구조로 정리한다.
- 합의 규칙: panel 은 unanimity 보다 "majority view + minority view + open questions" 보존이 중요하다. minority 가 P1/P2 를 제기하면 별도 `open_questions` 로 승격한다.
- moderator 역할: Claude 반론 레인은 moderator 로서 panel synthesis 를 담당하지만, 자기 의견을 추가 participant 처럼 중복 집계하지 않는다.
- 코드/아키텍처 분석 roster: `--experts` 가 없으면 Claude=아키텍처(레이어, SOLID, 결합도, 확장성, 테스트 용이성), Codex=구현·보안(복잡도, 성능, OWASP, 기술 부채), Antigravity=DX·문서(네이밍, 문서화, 접근성)로 나눈다. 1라운드는 서로의 결과를 보지 않고 독립 분석하고, 발견사항은 3/3 CONFIRMED · 2/3 LIKELY · 1/3 UNVERIFIED 로 표기한다. 보고서에는 관점별 health score(0-100)와 우선순위(P0~) 개선 로드맵을 넣는다.
