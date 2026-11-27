---
id: 0058
title: Windows 원격 피어 수신을 Claude 세션에 허용한다
status: proposed
date: 2026-11-27
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0056, 0057]
pr: null
---

# ADR-0058 Windows 원격 피어 수신

## 목적

ADR-0056의 Windows 발신 지원에 이어 등록된 Windows 호스트의 Claude 세션이 원격 피어 메시지와 회신을 받을 수 있게 한다.

## 결정

- 등록된 목적지 OS에 따라 고정 SSH 명령을 고른다. Windows에는 UTF-16LE `-EncodedCommand`로 PowerShell 7을 실행한다. npm 글로벌 설치 위치에서 `tfx-peer.mjs _receive`를 Node로 호출하고 원시 JSON stdin과 wire JSON stdout을 사용한다.
- Windows 목적지의 Codex와 agy는 SSH 전과 Windows 수신 시 거부한다. Claude의 ACL, 소유권, PID, 키, named pipe 검사는 기존 어댑터에서 수행한다. 수신자는 자기 호스트 등록 파일에서 발신 OS를 조회한다.
- Windows에서 받으면 PowerShell용 회신 예시를 표시한다. 원래 발신자가 Windows의 Claude 세션이면 회신 명령을 표시하며, Windows의 Codex 또는 agy 세션이면 Claude 대상으로만 회신할 수 있다고 안내한다.
- 사전 승인에 Windows 목적지임을 명시한다. 기존 POSIX 승인과 같은 주소, 사용자, 포트를 쓰는 Windows 목적지도 대화형 setup에서 새로 동의받는다.

## 검토한 대안

- sshd 기본 셸 변경은 호스트 전체 설정에 영향을 준다. 고정 PowerShell 명령은 기존 기본 셸에서 실행할 수 있다.
- 기본 npm 경로를 고정하면 사용자 지정 글로벌 prefix를 놓친다. `npm.cmd root --global`로 설치 위치를 조회한다.
- Windows를 기존 승인 목록에 자동으로 포함하면 동의 없이 새 수신 경로가 열린다. setup에서 확정한 목록을 사용한다.
