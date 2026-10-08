---
id: 0033
title: 계정 브로커 삭제
status: proposed
date: 2026-10-08
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0023, 0031]
pr: null
---

# ADR-0033: 계정 브로커 삭제

## 컨텍스트와 문제

`hub/account-broker.mjs`(1221줄)는 Codex 계정 여러 개를 번갈아 쓰기 위한 모듈이었다. 계정별 임대, 쿨다운, 회로 차단기, `~/.codex/auth.json` 과 계정별 캐시 사이의 인증 파일 동기화, `broker-state.json` 영속화를 맡았다.

이 모듈은 `~/.claude/cache/tfx-hub/accounts.json` 이 있을 때만 켜진다. 실제 사용 기기에는 이 파일이 없어서 브로커는 `null` 이었고, headless 어댑터는 임대 없이 기본 CLI 인증으로 실행됐다. 허브 제거(ADR-0023) 뒤에는 `reloadBroker()`, `publicSnapshot()` 을 부르는 곳도 없어졌다.

ADR-0031 은 이 모듈을 "다계정을 쓰지 않으면 삭제, 허브 제거 뒤에 판단"으로 미뤄 두었다. 허브 제거가 끝났고, 2026-10-08 사용자가 삭제를 결정했다.

## 결정

계정 브로커를 지운다. 여러 계정을 번갈아 쓸 일이 생기면 그때 새로 만든다.

- `hub/account-broker.mjs` 와 미러, 전용 테스트와 픽스처를 지운다.
- `cli-adapter-base.mjs` 의 실행 함수는 임대, 반납, 쿨다운 분기를 걷어내고 `executeWithAttempts` 로 이름을 바꾼다. preflight 와 재시도만 남는다.
- `codex-adapter.mjs` 는 임대 인증 검증, 임대용 spawn 환경, `getCircuitState()` 를 지운다. Codex 는 항상 기본 인증(`CODEX_HOME` 또는 `~/.codex`)으로 실행한다.
- `@triflux/core` 배럴에서 `accountBroker`, `getCodexCircuit` export 를 뺀다.
- setup 은 더 이상 `account-broker.mjs` 를 설치하지 않고, 이전 설치본에 남은 파일은 퇴역 파일 목록으로 지운다.
- 특정 계정을 강제로 쓰는 단일 경로인 `tfx-route.sh` 의 `TFX_CODEX_HOME`, `TFX_CODEX_AUTH_FILE` 은 남긴다.
- HUD 가 `accounts.json` 과 계정별 인증 캐시로 브로커 계정을 찾던 코드를 지운다. 로그아웃 판정, 사용량 갱신 조건, 프로브 대상은 `CODEX_HOME` 의 `auth.json` 계정 하나만 본다. 브로커 계정이 있을 때 교체된 사용량 창 판정을 끄던 옵션도 함께 뺀다.

## 검토한 대안

- **꺼진 채로 유지**: 지금 동작은 같다. 하지만 1200줄 모듈, 테스트 두 벌, 어댑터 분기, 문서 절을 쓰지 않는 기능 때문에 계속 유지해야 한다.
- **회로 차단기만 단일 계정용으로 남김**: 연속 실패 때 호출을 막는 기능은 남는다. 그러나 지금 경로에서도 회로 차단기는 동작하지 않았고, 재시도와 Claude 폴백이 이미 실패를 처리한다.
- **삭제(채택)**: 실행 경로가 지금 실제로 도는 "브로커 없음" 경로 하나로 줄어든다.

## 결과

- 동작 변화는 없다. 실행 경로는 `accounts.json` 이 없을 때와 같다.
- 실패 결과의 `failureMode` 에 `circuit_open`, `auth_sync` 가 더는 나오지 않는다.
- `@triflux/core` 의 공개 export 두 개가 빠지므로 릴리스 노트에 적는다.
- 사용자 HOME 의 `accounts.json`, `broker-state.json`, `codex-auth-*.json`, `codex-home/` 는 지우지 않는다. 읽는 코드가 없으니 남아 있어도 영향이 없다.
- `zod` 를 직접 import 하던 곳은 브로커뿐이었다. 의존성 정리는 lock 파일을 다시 만들어야 해서 이 변경에 넣지 않는다.

## 되돌리는 방법

- 삭제 PR 을 `git revert` 하면 모듈, 테스트, 어댑터 분기, setup 설치 목록이 함께 돌아온다. 퇴역 파일 목록의 항목도 같이 빠지므로 설치본에서 지워지지 않는다.
- 다계정을 새로 설계할 때는 이 ADR 을 대체하는 새 ADR 을 쓴다. 출발점은 계정마다 `CODEX_HOME` 을 따로 두고 `TFX_CODEX_HOME` 으로 고르는 방식이다. 인증 파일을 서로 복사하는 동기화는 되살리지 않는 편이 낫다.
