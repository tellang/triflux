---
name: tfx-remote
description: >
  SSH 호스트의 Claude Code 세션을 시작하고 조회하거나 이어서 작업할 때 사용한다.
  원격 호스트 준비 상태, 세션 목록, 재부착, 메시지 전송, 모니터링, 종료 요청을
  scripts/remote-spawn.mjs의 구현된 옵션으로 처리한다.
argument-hint: "<host|list|attach|send|probe|monitor|kill> ..."
---

# tfx-remote 원격 Claude Code 세션

`tfx-remote`는 Claude Code 스킬이다. 현재 `bin/triflux.mjs`에는 `tfx remote` 하위 명령이 없다. 실행은 설치된 `~/.claude/scripts/remote-spawn.mjs` 또는 이 저장소의 `scripts/remote-spawn.mjs`를 `node`로 호출한다. 다른 저장소에서 작업하면 설치된 스크립트를 쓴다.

## 실행 옵션

| 요청 | 스크립트 옵션 |
| --- | --- |
| 호스트 세션 시작 | `--host <host> --prompt "<요청>"` |
| 로컬 세션 시작 | `--local --prompt "<요청>"` |
| 세션 목록 | `--list` |
| 세션 재부착 | `--attach <session>` |
| 후속 메시지 | `--send <session> "<메시지>"` |
| 호스트 준비 상태 | `--probe <host>` |
| 화면 캡처 | `--capture <session>` |
| 준비 완료 대기 | `--wait <session>` |
| 화면 상태 관찰 | `--monitor <session>` |
| 세션 종료 | `--kill <session>` |

예를 들어 원격 세션을 시작하기 전에는 `node ~/.claude/scripts/remote-spawn.mjs --probe <host>`로 준비 상태를 확인한다. 세션 시작 시 `--dir`, `--name`, `--handoff`, `--transfer`, `--no-attach` 옵션을 추가할 수 있다. 스크립트의 실제 옵션과 실패 처리는 `scripts/remote-spawn.mjs`의 `parseArgs`와 `main`을 따른다.

`setup`과 `resume`은 구현된 명령이 아니다. 호스트 설정은 macOS/Linux의 `~/.config/triflux/hosts.json`, Windows의 `%APPDATA%\triflux\hosts.json`을 사용한다. `hub/lib/hosts-compat.mjs`가 호스트 이름과 alias를 해석한다. 호스트가 없거나 SSH가 실패하면 설정과 `--probe` 결과를 확인한다.

원격에서 Codex가 필요하면 원격 Claude Code 세션 안에서 Triflux 라우팅을 사용한다. SSH 너머로 Codex를 직접 실행하지 않는다.

## 확인

규칙 파일 해시는 Windows PowerShell에서 `Get-FileHash .claude/rules/tfx-psmux.md`, macOS에서 `shasum -a 256 .claude/rules/tfx-psmux.md`, Linux에서 `sha256sum .claude/rules/tfx-psmux.md`로 확인한다.
