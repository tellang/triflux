---
id: 0056
title: 원격 피어의 Windows 지원을 발신부터 단계로 넓힌다
status: proposed
date: 2026-11-27
deciders: [tellang]
supersedes: []
superseded_by: null
relates: []
pr: null
---

# ADR-0056: 원격 피어의 Windows 지원을 발신부터 단계로 넓힌다

## 컨텍스트와 문제 (Context)

`tfx-peer remote-send`는 macOS와 Linux 호스트 사이에서만 동작한다. Windows 세션은 다른 호스트의 세션에 결과를 보낼 수 없다. 발신은 `ssh` 실행과 JSON stdin 만 있으면 되지만, 수신 명령은 POSIX 래퍼 `exec "$HOME/.claude/scripts/tfx-peer" _receive`로 고정되어 있고 Windows 에는 이 래퍼를 설치하지 않는다.

## 결정 (Decision)

우리는 Windows 발신을 먼저 지원하고 Windows 수신은 별도 단계로 둔다.

- Windows 호스트는 `node`로 `tfx-peer.mjs remote-send`를 직접 실행해 macOS, Linux 호스트의 Claude, Codex, agy 세션에 보낸다.
- 수신 호스트는 자기 `hosts.json`에 `os: windows`로 등록한 발신 호스트를 받아들인다. 이 값은 회신 상대 조회에서만 허용한다. SSH 목적지로는 계속 거부한다.
- 발신 호스트의 OS 는 수신 호스트의 등록 값으로 판정한다. Windows 발신 메시지의 회신 줄은 회신 명령 대신 지원하지 않는다는 문장으로 바꾼다.

## 검토한 대안 (Considered Options)

- **발신과 수신을 한 번에 지원**: Windows 수신 진입점과 PowerShell 인용이 필요해 범위가 커지고, 그동안 Windows 발신도 쓸 수 없다.
- **envelope 에 발신 OS 를 넣기**: 수신 쪽 설정이 필요 없다. 하지만 모르는 키를 거부하는 프로토콜이라 이전 버전 수신자와 어긋나고, 발신자가 적은 값을 믿게 된다.
- **회신 명령을 그대로 안내**: 코드가 줄지만 실행하면 반드시 실패하는 명령을 모델에게 보여 준다.

## 결과 (Consequences)

- 수신 호스트가 Windows 발신을 지원하는 버전이어야 한다. 이전 버전은 `rejected`로 끝나고 전달하지 않는다.
- Windows 로 보내는 회신은 수신 지원 전까지 없다.
- 결과 상태와 재전송 금지, 수신 세션 검사는 바뀌지 않는다.
