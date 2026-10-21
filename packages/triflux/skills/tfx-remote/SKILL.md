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
| 세션 종료 | `--kill <session>`. 그 세션이 띄운 원격 프로세스만 정리한다. 원격 claude 데몬 전체를 멈추려면 `--stop-daemon` 을 더한다(같은 호스트의 다른 작업도 멈춘다). |

예를 들어 원격 세션을 시작하기 전에는 `node ~/.claude/scripts/remote-spawn.mjs --probe <host>`로 준비 상태를 확인한다. 세션 시작 시 `--dir`, `--name`, `--handoff`, `--transfer`, `--no-attach` 옵션을 추가할 수 있다. 스크립트의 실제 옵션과 실패 처리는 `scripts/remote-spawn.mjs`의 `parseArgs`와 `main`을 따른다.

`setup`과 `resume`은 구현된 명령이 아니다. 호스트 설정은 macOS/Linux의 `~/.config/triflux/hosts.json`, Windows의 `%APPDATA%\triflux\hosts.json`을 사용한다. `hub/lib/hosts-compat.mjs`가 호스트 이름과 alias를 해석한다. 호스트가 없거나 SSH가 실패하면 설정과 `--probe` 결과를 확인한다.

원격에서 Codex가 필요하면 원격 Claude Code 세션 안에서 Triflux 라우팅을 사용한다. SSH 너머로 Codex를 직접 실행하지 않는다.

## Windows 원격 수동 실행 대안

기본 경로는 `remote-spawn --host <host>`다. 지원 버전의 psmux가 있으면 원격 세션을 감싸고,
`--attach`로 다시 붙으며 `--kill`로 소유를 확인한 뒤 분리·종료·파일 정리를 한다.
psmux가 없거나 지원 버전 미만이면 기존 직접 실행 경로를 쓰며, SSH가 끊기면 Claude도 종료된다.

`remote-spawn`을 쓸 수 없지만 psmux 3.4.0 이상이 있는 경우에는 아래 수동 절차를 쓴다.
psmux도 없으면 Windows Terminal/PowerShell에서 Claude를 직접 실행한다.
원격 스크립트는 `scp`로 올리고, 공백·따옴표가 든 경로는 `pwsh -EncodedCommand` 안에서 호출한다.

```powershell
# start-worker.ps1 (ryzen 에서 실행). 세션 이름은 tfx- 접두사, 경로는 Windows 형식
psmux new-session -d -s tfx-1015-fulltest -c "$env:USERPROFILE\Desktop\Projects\triflux"
psmux send-keys -t tfx-1015-fulltest "claude -n '10.15 전체 테스트' --model sonnet" Enter
```

```bash
scp start-worker.ps1 ryzen:start-worker.ps1 && ssh ryzen pwsh -File start-worker.ps1
ssh ryzen psmux capture-pane -p -t tfx-1015-fulltest          # 확인
```

```powershell
# stop-worker.ps1. 연결을 먼저 끊고 2초 뒤 세션을 지운다(WT ConPTY 종료 경쟁 회피)
# detach-client 의 -t 는 클라이언트 이름이라 세션을 분리하지 못한다. 세션은 -s 로 지정한다
psmux detach-client -s tfx-1015-fulltest
if ($LASTEXITCODE -ne 0) { Write-Error "detach 실패. psmux list-clients 로 확인한 뒤 다시 실행"; exit 1 }
Start-Sleep -Seconds 2
psmux kill-session -t tfx-1015-fulltest
```

`send-keys` 로 보내는 명령은 PowerShell 문법이다. `&&`, `export`, `$(...)`, Unix 경로를 쓰지 않는다.

## 확인

규칙 파일 해시는 Windows PowerShell에서 `Get-FileHash .claude/rules/tfx-psmux.md`, macOS에서 `shasum -a 256 .claude/rules/tfx-psmux.md`, Linux에서 `sha256sum .claude/rules/tfx-psmux.md`로 확인한다.
