---
id: 0016
title: Codex 최상위 tier를 Astra로 하고 최종 승격을 Fable로 한다
status: accepted
date: 2026-09-22
deciders: [tellang]
supersedes: [0006]
superseded_by: null
relates: [0004, 0015]
pr: null
---

# ADR-0016: Codex 최상위 tier를 Astra로 하고 최종 승격을 Fable로 한다

## 컨텍스트와 문제 (Context)

Codex 0.155.1 모델 카탈로그는 `gpt-6-astra`를 1순위에 두고 복잡하고 까다로운 작업을 위한 최상위 모델로 설명한다. 기존 최상위 프로필은 모두 GPT-5.6 Sol에 묶여 있지만, Sol은 더 이상 카탈로그의 최상위 tier가 아니다. 재시도 체인의 마지막 Claude 단계도 현재 최신 Fable을 가리키는 안정 별칭으로 맞출 필요가 있다.

## 결정 (Decision)

우리는 Codex 최상위 canonical 프로필을 `gpt6_astra_xhigh`, `gpt6_astra_max`, `gpt6_astra_ultra`로 교체하고, 아래 세 곳이 이 프로필을 사용하도록 한다.

- 역할 기본값
- max/ultra 예외 레인
- 재시도 승격 1단계

기존 Sol 프로필 이름은 호환 입력으로 받아 새 이름으로 정규화하되 setup이 사용자 기기의 옛 프로필 파일을 삭제하지 않는다. `DEFAULT_ESCALATION_CHAIN`은 Codex `gpt6_astra_max` 다음 Claude `fable` 별칭으로 끝낸다. Terra와 Luna 레인은 유지한다.

## 검토한 대안 (Considered Options)

- **재시도와 max/ultra에만 Astra를 사용**: 사용량 증가를 제한할 수 있지만 xhigh 역할 기본값이 더 이상 최상위 모델을 쓰지 않아 tier 의미가 갈라진다.
- **현행 유지**: 변경 비용은 없지만 카탈로그와 내부 최상위 프로필 의미가 어긋나고 최종 승격도 이전 Claude tier에 머문다.

## 결과 (Consequences)

최난도 역할과 재시도 복구 단계의 품질 상한이 올라가는 대신 Astra 사용량과 비용 부담이 커질 수 있다. 구형 프로필 이름은 정규화되므로 기존 호출자는 계속 동작하고, 사용자 기기의 파일도 보존된다. 프로필 파일을 직접 읽는 실행 레인은 canonical 프로필 파일의 `model` 값만 바꿔 임시로 되돌릴 수 있다. 다만 setup은 파일을 canonical 값으로 다시 생성하고 max/ultra 안전 경로는 모델을 강제하므로, 정책 전체를 되돌릴 때는 canonical 프로필 정의, setup, 라우팅 guard를 함께 이전 값으로 복원해야 한다. 최종 Claude 단계는 `TFX_ESCALATION_CLAUDE_MODEL` 또는 프로젝트 override로 별도 되돌릴 수 있다.
