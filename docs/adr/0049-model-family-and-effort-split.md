---
id: 0049
title: 모든 CLI 에서 모델 가족과 effort 를 나눠 다룬다
status: accepted
date: 2026-10-28
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0037, 0038, 0048]
pr: null
---

# ADR-0049: 모든 CLI 에서 모델 가족과 effort 를 나눠 다룬다

## 결정

모델과 effort 를 이름 하나에 함께 담는 결합 이름(`sol_high`, `argon_high`)을 정책과 호출에서 걷어낸다. 지금은 Claude 워커의 effort 를 Codex 프로필 이름의 글자(`*high*`)에서 뽑고 있어, Codex 이름이 바뀌면 Claude effort 가 깨진다.

### 정책 형식

- 역할마다 CLI 별 항목을 둔다. 예: `writer: { codex: { family: "terra", effort: "high" }, antigravity: { family: "argon", effort: "medium" }, claude: { model: "opus", effort: "high" } }`.
- 역할에 어느 CLI 를 쓸지는 지금처럼 `hub/team/agent-map.json`, 작성 벤더별 리뷰 전환, `TFX_CLI_MODE`, agy 쿼터 폴백이 정한다. 정책 형식은 CLI 선택에 관여하지 않는다.
- effort 순서는 하나의 목록으로 둔다: `none < low < medium < high < xhigh < max < ultra`.

### CLI 별 호출

- Codex: 프로필 파일은 가족마다 하나(`~/.codex/<가족>.config.toml`)이고 해석기가 고른 `model`만 적는다. effort 는 `-c model_reasoning_effort="<effort>"`로 넘긴다. 손으로 `codex -p <가족>`을 쓸 수 있게 파일을 남긴다. `~/.codex/config.toml`에 전역 effort 가 있으므로 `-c`는 그 값을 의도적으로 덮어쓴다. `<codex-config>` 규칙 문구를 "프로필에는 model 만, effort 는 `-c` 로만"으로 고친다.
- Antigravity(agy): `--model <가족 ID> --effort <effort>`로 넘긴다(예: `--model gemini-4-argon --effort high`). 2026-10-28 m5 실측에서 agy 는 가족 ID 와 `--effort`를 받아 해당 effort 모델로 띄웠다. 모델 ID 의 effort 와 `--effort`가 어긋나거나(`gemini-4-argon-low --effort high`) 가족이 지원하지 않는 effort(`xhigh`, `max`)를 받으면 agy 는 경고만 남기고 Medium 으로 띄웠다. 그래서 triflux 가 호출 전에 지원 단계로 낮추고, effort 를 담은 모델 ID 는 넘기지 않는다. 지금처럼 표시 이름(`Gemini 4 Argon (High)`)을 넘기는 방식은 쓰지 않는다.
- Claude: `--model <별칭>`과 `--effort <effort>`. 역할별 Claude effort 표를 새로 만든다. 지금은 대부분 비어 있다.

### effort 가 맞지 않을 때

- 정책 제한과 기능 제한을 나눈다. `ultra`를 최상위 단독 실행에만 허용하는 것은 정책 제한으로 지금처럼 둔다. 가족이 그 effort 를 지원하지 않는 것은 기능 제한이다.
- 기능 제한이면 그 가족의 최신 모델을 쓰고 effort 를 지원하는 가장 가까운 아래 단계로 낮춘다(사용자 결정). 구버전 모델로 effort 를 지키지 않는다. 낮춘 사실은 stderr 에 남긴다. 더 낮은 단계가 없으면 오류로 끝낸다.
- 지원 목록은 Codex `models_cache.json`의 `supported_reasoning_levels`, agy `agy models`, Claude 는 CLI 가 받는 값(low ~ max)이다. 캐시가 없으면 낮추지 않고 그대로 넘긴다.
- 재시도 승격 단계가 낮춰져 기본 레인과 같아지면 승격한 것으로 보지 않고 실패로 보고한다.
- ChatGPT 계정 tier 거부는 지원 목록에 나타나지 않으므로 기존 tier 폴백을 남긴다. 폴백은 `-c model_reasoning_effort="low"`를 다시 붙인다.

### 호환과 전환

- 옛 결합 이름(`sol_high`, `astra_xhigh`, `argon_high`, `argon`, `gpt56_terra_high` 같은 옛 별칭 포함)은 `TFX_CODEX_PROFILE`, `--profile`, 재시도 스냅숏, `.triflux/config/escalation-chain.json`에서 계속 받아 가족과 effort 로 풀어 쓴다. 새 형식 스냅숏은 옛 이름도 함께 적어 옛 설치본(m2, ryzen)이 읽을 수 있게 한다.
- 한 릴리스 동안 setup 이 가족 파일과 결합 이름 파일을 함께 갱신한다. 손으로 `codex -p sol_high`를 쓰는 사람과 Codex 스킬 사본이 옛 모델로 굳지 않게 하기 위해서다. 그다음 릴리스에서 결합 이름 파일 갱신을 멈추고, 이미 있는 파일은 지우지 않는다.
- `tfx-route.sh`의 route 출력은 위치로 읽는 필드라 새 필드(`CLI_FAMILY`)는 맨 끝에 붙인다.

### 구현 순서

1. 결합 이름과 가족, effort 사이 양방향 변환 함수와 effort 순서 목록. 동작 변화 없음.
2. effort 를 프로필 파일에서 읽는 세 곳(재시도 프로필 해석, ultra 가드, 중첩 headless 프로필)을 변환 함수로 바꾸고, tier 폴백에 `-c low`를 붙인다.
3. 가족 파일 쓰기 시작, 결합 이름 파일도 함께 갱신.
4. route 출력에 `CLI_FAMILY`를 더하고 `CLI_EFFORT`를 effort 만 담게 바꾼다.
5. 재시도 스냅숏과 승격 체인을 새 형식으로, 옛 이름도 읽게.
6. Claude 역할별 effort 표, `get_claude_effort`가 Codex 이름을 읽지 않게.
7. agy 를 `--model <가족 ID> --effort` 로 옮긴다.
8. Codex 스킬 사본과 `<codex-config>` 문구 수정, 다음 릴리스에서 결합 이름 파일 갱신 중단.

## 검토한 대안

- 결합 이름 유지: Codex 는 프로필 파일 하나를 설정 묶음으로 고르므로 Codex 관례에는 맞는다. 하지만 모델이 하나 늘 때마다 effort 수만큼 파일이 늘고, Claude effort 가 Codex 이름에 묶인 문제가 남는다. 사용자가 나누기로 정했다.
- Codex 를 프로필 파일 없이 `-c model=... -c model_reasoning_effort=...`로만 호출: 해석기 기록에서 모델을 읽으면 ADR-0037 과도 맞고 파일이 필요 없다. 손으로 `codex -p`를 쓸 수 없어 버렸다.
- 통합 정책에 `cli` 필드를 두기: 역할의 CLI 선택은 agent-map 과 전환 규칙이 이미 맡고 있어 두 곳이 같은 결정을 하게 된다.
- Codex 만 먼저 나누기: Claude effort 가 Codex 이름에서 나오므로 Codex 이름을 바꾸는 순간 Claude 가 깨진다.
- effort 가 맞지 않으면 구버전 모델로 effort 를 지키기: 가족별 최신 버전을 쓴다는 ADR-0037 과 어긋난다.
