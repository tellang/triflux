---
id: 0017
title: Terra와 Luna 레인을 GPT-6 Sol과 Luna로 옮긴다
status: accepted
date: 2026-09-23
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0004, 0015, 0016]
pr: null
---

# ADR-0017: Terra와 Luna 레인을 GPT-6 Sol과 Luna로 옮긴다

## 컨텍스트와 문제 (Context)

2026-09-22 OpenAI가 GPT-6 Sol과 GPT-6 Luna를 내놨다. Codex 0.156.0 카탈로그는 Astra, Sol, Luna 순으로 GPT-6을 앞에 두고 GPT-5.6 세 모델을 "Older"로 내렸다. GPT-6에는 Terra가 없다. triflux의 구현, 리뷰, 검증 레인은 아직 `gpt56_terra_*`에, 경량 레인은 `gpt56_luna_low`에 묶여 있다.

같은 날 Anthropic이 Claude Opus 5.5를 냈다. 모델 개요 문서는 대부분의 작업을 Opus 5.5로 시작하고, 까다로운 추론과 긴 에이전트 작업이거나 Opus 5.5를 높은 effort로 돌려도 부족할 때 Fable 5.1을 쓰라고 한다.

OpenAI 공식 문서의 Codex 모델 선택 기준:

- Astra: 여러 단계와 도구에 걸쳐 가장 강한 능력이 필요한 작업. 시작 effort는 Light.
- Sol: 일상 작업과 복잡한 코딩, 에이전트 워크플로. 시작 effort는 Medium.
- Luna: 명확하고 반복 가능한 작업. 요약, 추출, 범위가 좁은 코딩. 시작 effort는 High.
- 세 모델 모두 계획과 분석이 더 필요하면 effort를 올리라고 한다.

## 결정 (Decision)

우리는 Codex 역할 기본값을 아래처럼 옮기기로 한다. Claude 쪽 호출은 바꾸지 않는다.

- Astra 레인(`gpt6_astra_xhigh`, `gpt6_astra_max`, `gpt6_astra_ultra`)은 ADR-0016 그대로 둔다.
- `gpt56_terra_high` 역할(executor, 리뷰, 검증, 테스트, scientist, document-specialist)은 `gpt6_sol_high`로 옮긴다.
- `gpt56_terra_med` 역할(cleanup, deslop)은 `gpt6_sol_med`로 옮긴다.
- build-fixer와 writer는 `gpt6_luna_high`로 옮긴다. 공식 시작 effort가 High다.
- 지연이 우선인 레인(spark, `TFX_NO_CLAUDE_NATIVE`의 explore 재매핑, ChatGPT 계정 tier 폴백)은 `gpt6_luna_low`를 쓴다.
- 옛 `gpt56_terra_high`, `gpt56_terra_med`, `gpt56_luna_low` 이름은 같은 effort의 GPT-6 이름으로 정규화한다. setup은 사용자 기기의 옛 프로필 파일을 지우지 않는다.
- 동적 라우팅 폴백의 기본 모델은 `gpt-6-sol`이다.
- 재시도 최종 단계는 ADR-0016대로 `fable` 별칭을 유지한다. `opus` 별칭은 Opus 5.5로, `sonnet`과 `haiku`는 현재 모델로 자동으로 따라간다.

## 검토한 대안 (Considered Options)

- **Sol 레인을 공식 시작점인 medium으로 낮춘다**: 비용이 줄지만 executor와 리뷰 레인은 복잡한 코딩과 분석에 해당해 공식 문서도 effort를 올리라고 한다. 기존 high를 유지해 모델 세대만 바꾼다.
- **Luna를 low 한 개로 유지한다**: 프로필 수가 늘지 않지만 공식 시작점(High)보다 낮고, 발표의 대표 운영점도 high다. 대신 지연이 중요한 레인만 low로 남긴다.
- **Astra 레인을 Sol xhigh로 내린다**: AutomationBench에서 Sol xhigh가 Astra low를 3.9배 싸게 앞선다. 그러나 Astra 역할은 여러 단계와 도구를 쓰는 설계, 디버그, 보안 작업이고 공식 문서가 이런 작업에 Astra를 권한다. 비용 문제가 실제로 나타나면 다시 본다.
- **재시도 최종 단계를 `opus`로 바꾼다**: Opus 5.5는 Anthropic 발표의 코딩 벤치마크에서 Fable 5.1을 앞서고 더 싸다. 그러나 모델 개요 문서는 Opus 5.5로 부족할 때 쓰는 단계로 Fable 5.1을 두고, 재시도 최종 단계가 바로 그 용도다. 기각한다.

## 결과 (Consequences)

구현과 리뷰 레인이 GPT-5.6 Terra보다 강한 모델을 쓰고, OpenAI 발표 기준 Sol과 Luna 단가는 GPT-5.6 대비 절반이다. build-fixer와 writer는 effort가 low에서 high로 올라 응답이 느려질 수 있다. 옛 프로필 이름은 정규화되므로 기존 호출자는 그대로 동작한다.

새 프로필 파일은 setup이 만든다. 파일이 없는 기기에서 `--profile gpt6_sol_high`는 실패하므로 설치 뒤 `setup --force`가 필요하다. Codex 레인 전체를 되돌릴 때는 canonical 프로필 정의, setup, `tfx-route.sh`의 검증 목록을 함께 복원해야 한다.
