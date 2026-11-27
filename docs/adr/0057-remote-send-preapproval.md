---
id: 0057
title: remote-send 사전 승인을 send 승인과 별개의 선택 항목으로 둔다
status: proposed
date: 2026-11-27
deciders: [tellang]
supersedes: []
superseded_by: null
relates: []
pr: null
---

# ADR-0057: remote-send 사전 승인을 send 승인과 별개의 선택 항목으로 둔다

## 컨텍스트와 문제 (Context)

`tfx-peer remote-send`는 로컬 `send` 승인 범위에서 일부러 뺐다. 로컬 승인이 원격 실행까지 넓어지지 않게 하려는 것이었다. 그 결과 원격 전송은 매번 실행 권한을 받아야 하고, 무인으로 도는 세션은 회신을 보내지 못한다.

## 결정 (Decision)

우리는 `remote-send` 사전 승인을 `triflux setup`의 별개 선택 항목으로 둔다.

- `send` 승인이 되어 있을 때만 이어서 묻고 기본값은 거절이다. 래퍼는 `send` 승인이 설치한 것을 함께 쓴다.
- 승인 대상은 홈 절대경로 래퍼의 `remote-send` verb 하나다. Claude allow 항목, Codex 규칙 파일, 동의 파일을 `send` 것과 따로 둔다.
- `send` 동의의 내용은 바꾸지 않아 기존 사용자는 다시 동의하지 않아도 된다. update, 비대화형, CI, postinstall 은 승인을 쓰지 않는다.

## 검토한 대안 (Considered Options)

- **`send` 승인에 `remote-send`를 합치기**: 질문이 하나로 줄지만, 기존 동의의 뜻이 원격 전송까지 넓어지고 승인 계약이 바뀌어 모든 사용자가 다시 동의해야 한다.
- **`send` 승인 없이 `remote-send`만 승인**: 래퍼 설치와 소유를 두 승인이 나눠 가져야 한다. 원격 전송이 로컬 전송보다 넓은 권한이라 이 조합이 필요한 경우가 드물다.
- **목적지 호스트마다 허용 규칙 만들기**: 범위가 좁지만 인자 순서에 의존하는 접두 규칙이라 `--from`이 앞에 오면 맞지 않고, 호스트를 바꿀 때마다 다시 승인해야 한다.

## 결과 (Consequences)

- 승인한 세션은 `hosts.json`에 등록한 모든 호스트로 확인 없이 본문을 보낸다. 승인 범위는 verb 이고 목적지를 제한하지 않는다. 등록 파일 위치를 바꾸는 `TFX_HOSTS_USER_STATE`는 세션 환경에서 그대로 상속된다.
- `send` 어댑터를 철회할 때 원격 승인 항목을 함께 지우지 않으면, 어댑터를 다시 설치할 때 원격 승인이 다시 적용된다.
- Windows 는 래퍼가 없어 대상이 아니다.
