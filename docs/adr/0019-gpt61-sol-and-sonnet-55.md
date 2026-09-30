---
id: 0019
title: Sol 레인을 GPT-6.1 Sol로 옮기고 sonnet 별칭은 Sonnet 5.5를 따른다
status: accepted
date: 2026-09-30
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0004, 0016, 0017]
pr: null
---

# ADR-0019: Sol 레인을 GPT-6.1 Sol로 옮기고 sonnet 별칭은 Sonnet 5.5를 따른다

## 컨텍스트와 문제 (Context)

OpenAI가 GPT-6.1 Sol을 내놨고, Anthropic이 Claude Sonnet 5.5를 냈다.

- GPT-6.1 Sol의 공식 설명은 "Astra에 근접한 성능을 Astra보다 싸게"이고, 코드와 앱과 문서에 걸친 반복적이고 오래 도는 작업에 권한다. 모델 ID는 `gpt-6.1-sol`이다. 롤아웃은 요금제별로 순차 진행 중이다. 로컬 Codex 0.159.2 카탈로그에는 `gpt-6.1-sol`이 low부터 ultra까지 effort와 함께 노출되어 있다.
- Anthropic 모델 개요(2026-09-30 확인)는 Sonnet 5.5(`claude-sonnet-5-5`)를 "속도와 지능의 최적 조합"으로 두고 Sonnet 5를 legacy로 내렸다. 컨텍스트 1M, 기본 effort high다.

ADR-0017이 정한 Sol 레인(`gpt6_sol_high`, `gpt6_sol_med`)은 아직 GPT-6 Sol을 가리킨다. 모델 ID를 프로필 이름이 대신 말해 주는 것이 이 저장소의 규칙이라, 프로필 이름은 그대로 두고 모델만 바꿀 수 없다.

## 결정 (Decision)

우리는 Sol 레인 두 개를 GPT-6.1 Sol로 옮기고, Claude 쪽은 코드를 바꾸지 않는다.

- 새 프로필 `gpt61_sol_high`, `gpt61_sol_med`를 만든다. effort는 ADR-0017 그대로 high와 medium이다.
- `gpt6_sol_high`, `gpt6_sol_med` 이름은 같은 effort의 `gpt61_sol_*`로 정규화한다. `gpt56_terra_*`를 옮긴 방식과 같다. setup은 기기에 남은 옛 프로필 파일을 지우지 않는다.
- 동적 라우팅 폴백의 기본 모델과 TUI 모델 선택 목록도 `gpt-6.1-sol`로 맞춘다.
- Astra 레인, Luna 레인, 재시도 최종 단계(`fable`)는 그대로 둔다.
- `sonnet` 별칭은 Claude CLI가 Sonnet 5.5로 해석하므로 라우팅 코드를 고치지 않는다. 대신 `.claude/rules/tfx-routing.md` 모델 배치표의 "현재 모델" 열과 HUD의 `claude-sonnet-5-5` 컨텍스트 한도(1M) 판정 테스트를 갱신한다.

## 검토한 대안 (Considered Options)

- **프로필 이름은 `gpt6_sol_*`로 두고 모델 ID만 바꾼다**: 변경 파일이 적다. 그러나 이름이 GPT-6인데 GPT-6.1이 돌면 "프로필 이름이 정본"이라는 규칙이 깨지고, 실행 기록에서 어떤 모델이 돌았는지 이름으로 알 수 없다. 기각한다.
- **Astra 레인도 GPT-6.1 Sol xhigh로 내린다**: 비용은 줄지만 공식 설명이 "Astra에 근접"이지 Astra와 같다는 뜻이 아니다. 설계, 디버그, 보안 작업에는 ADR-0016의 Astra 배치를 유지한다. 비용 문제가 실제로 나타나면 다시 본다.
- **Sonnet 5.5 모델 ID를 triflux에 고정한다**: 재현성은 늘지만 다음 모델이 나올 때마다 다시 고쳐야 한다. Claude는 별칭으로 호출한다는 기존 원칙을 따른다.
- **`token-snapshot.mjs` 가격표도 함께 갱신한다**: 이 표는 "보수적 추정"이고 Opus 5.5 가격도 옛 값이라 Sonnet만 고치면 표가 어긋난다. 이번 범위에서 뺀다.

## 결과 (Consequences)

구현, 리뷰, 검증 레인이 GPT-6 Sol보다 새 모델을 쓰고, 옛 프로필 이름을 쓰던 호출자는 그대로 동작한다.

`gpt61_sol_*` 프로필 파일은 setup이 만든다. 파일이 없는 기기에서는 설치 뒤 `setup --force`가 필요하다. setup은 관리 대상 프로필 파일을 내용이 다르면 덮어쓰므로, 파일을 직접 고쳐서 GPT-6 Sol에 묶어 두는 방법은 통하지 않는다.

롤아웃이 끝나지 않아 GPT-6.1 Sol이 아직 없는 계정에서는 Sol 레인이 실패한다. ChatGPT 계정이 모델을 거부하는 경우는 기존 tier 폴백(`gpt6_luna_low` 1회 재시도)이 받는다. 그 밖의 실패 문구는 실제로 겪은 뒤에 폴백 조건을 넓힌다.
