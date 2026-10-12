---
id: 0037
title: Codex와 Antigravity 가족 별칭을 실행 때 최신 모델로 해석한다
status: accepted
date: 2026-10-12
deciders: [tellang]
supersedes: [0016, 0017, 0019]
superseded_by: null
relates: [0004, 0015]
pr: null
---

# ADR-0037: Codex와 Antigravity 가족 별칭을 실행 때 최신 모델로 해석한다

## 결정

Codex 프로필을 `sol_high`, `sol_med`, `astra_xhigh`, `astra_max`, `astra_ultra`, `luna_high`, `luna_low`로, Antigravity 프로필을 `flash_low`, `flash`, `flash_high`로 정한다. 옛 이름은 가족 별칭으로 정규화하고 기기의 옛 파일은 보존한다. ADR-0016/0017/0019의 버전별 이름과 고정 모델 결정을 대체한다. 이들이 정한 역할별 가족·effort 배치, 단독 실행에만 허용하는 ultra, 최종 Claude `fable` 단계는 유지한다. Claude 라우팅은 기존 별칭을 쓴다.

디스패치 직전에 공용 해석기가 같은 가족의 사용 가능한 후보 중 숫자 버전이 가장 높은 모델을 고르고 관리 프로필 파일을 갱신한다. Codex는 `models_cache.json`의 `visibility=list`와 `supported_reasoning_levels`를 확인하고, 파일이 없으면 `codex debug models`를 읽는다. agy는 `agy models`의 Flash slug와 display name을 사용하며 Pro는 자동 선택하지 않는다. setup과 update도 같은 해석을 쓴다.

평소에는 파일 상태와 작은 해석 기록만 읽는다. Codex 목록이 바뀌면 `fetched_at`을 비교하고, agy 목록은 하루에 한 번 갱신한다. 마지막 결과와 근거 시각은 triflux 사용자 상태 디렉터리에 남긴다. `models.json`의 가족별 고정이 자동 선택보다 우선한다. 목록이 없거나 읽기에 실패하면 마지막 결과, 그것도 없으면 내장 기본값을 사용한다. 상태 경로는 Unix의 `~/.config/triflux`(XDG 설정 존중), Windows의 `%APPDATA%\triflux`다.

재시도 체인의 Codex 단계는 `astra_max` 프로필만 보관해 오래된 model ID가 남지 않게 한다. 세션 컨텍스트 한도는 Codex 쪽을 바꾸지 않는다. Claude의 fable·opus·sonnet·haiku는 5세대 이상을 1M으로 판정하며 Haiku 4.5에는 적용하지 않는다.

## 이유

버전이 나올 때마다 코드·스킬·기기 프로필을 함께 바꾸면 계정별 출시 시차와 수동 작업 때문에 라우팅이 뒤처진다. 사용 가능한 목록을 실행 시점에 읽으면 가족과 effort를 유지하면서 새 버전을 반영할 수 있다. 명시적 가족 고정은 자동 갱신을 멈추거나 이전 버전으로 되돌리는 수단이고, 마지막 성공 결과는 목록 조회 장애가 디스패치 장애로 번지는 것을 막는다.

## 검토한 대안

- setup 때만 해석: 설치 사이에 나온 모델을 실행에 반영하지 못한다.
- 새 버전 알림만 제공: 프로필 변경과 확인에 계속 사람 손이 필요하다.
- Codex 컨텍스트 한도를 목록의 `context_window`(272K, 500K)로 교체: 지금 차단 비율 22%가 그대로면 Astra, Luna 는 약 6만 토큰에서 질의를 막는다. 비율을 다시 정하는 일은 이 결정과 따로 다룬다.
- 버전 고정 유지: 재현성은 쉽지만 계정별 사용 가능 여부와 모델 갱신을 자동으로 따라가지 못한다. 필요한 재현성은 가족별 고정 파일로 확보한다.
