# 원격 native peer 발신과 회신

- 목적지는 Darwin과 POSIX Linux 이고 같은 원격 peer 프로토콜을 지원하는 `tfx-peer` 래퍼가 설치되어 있어야 한다. 발신 호스트는 Darwin, POSIX Linux, Windows 다. 등록 OS 값은 대소문자만 정규화하여 `Darwin`, `macOS`, `Linux`를 허용하고, `Windows`는 수신 호스트가 발신 호스트를 찾는 항목에서만 허용한다. 미상 OS와 Windows 목적지는 전송 전에 거부한다.
- Windows 발신은 PowerShell 7.3 이상에서 `node`로 직접 실행한다. 자동 세션 탐색이 없으므로 `TFX_LIVE_FROM`이 없으면 `--from`으로 발신자를 명시한다. `tfx-peer.cmd` shim과 Windows PowerShell 5.1은 본문의 특수 문자를 바꿀 수 있다. 본문은 작은따옴표나 `@'` 와 `'@` 사이의 here-string으로 쓴다. 발신 호스트의 `%APPDATA%\triflux\hosts.json`에 목적지를, 수신 호스트의 `hosts.json`에 이 호스트를 `"os": "windows"`로 등록한다. `PATH`의 `ssh`가 비밀번호 입력 없이 접속할 수 있어야 한다. 수신 호스트의 triflux가 Windows 발신을 지원하지 않는 버전이면 `rejected`로 끝난다. Windows 호스트로는 `remote-send` 회신을 보낼 수 없고, 수신 본문의 마지막 줄이 이를 알린다.
- 발신 호스트에서 `remote-send --host m5 --reply-host m2 --to 'codex:<이름 또는 UUID>' --message '<본문>'`을 실행한다. `m5`는 목적지, `m2`는 수신 호스트에서 발신 호스트를 찾을 등록 별명이다. 발신 호스트의 사용자 상태 `hosts.json`에는 목적지 `m5`, 수신 호스트에는 회신 목적지 `m2`가 호스트 이름 또는 `aliases`로 등록되어 있어야 한다. 각 호스트의 자기 항목은 필요 없다. 송신은 실제 SSH 목적지만 조회하고, 수신은 역방향 회신 목적지만 조회한다. 원본 저장소의 legacy hosts로 폴백하거나 설정을 자동 복사하지 않는다.
- `--from 'claude:<이름 또는 UUID>'`, `--from 'codex:<이름 또는 UUID>'`, `--from 'agy:<이름 또는 UUID>'`을 명시할 수 있다. 우선순위는 `--from`, `TFX_LIVE_FROM`, 발신 호스트의 자동 탐색이다. 발신 세션을 판별하지 못하면 SSH 전에 `--from`을 요구한다. `remote-send`에는 `--host`와 `--reply-host`가 모두 필요하다. 로컬 `send`에는 `--remote`, `--host`, `--reply-host`를 붙일 수 없으며 `self`도 원격 플래그를 거부한다.
- 수신 본문은 원래 발신 CLI, 표시 이름, `origin` 호스트와 가능한 대화 UUID를 보존한다. 회신 안내의 `--host`는 원래 발신 호스트, `--reply-host`는 원래 목적지다. UUID가 있으면 표시 이름보다 정확한 대화 UUID로 회신한다. 수신 환경을 발신 환경처럼 바꾸지 않는다.
- 원격 사전 승인을 받았다면 setup이 출력한 절대경로의 `tfx-peer-remote remote-send`를 쓴다. 사전 승인 범위 밖의 목적지는 대화형 setup에서 다시 승인하거나 기존 `tfx-peer remote-send` 호출의 실행 권한을 따로 요청한다.
- 사전 승인 경로는 시스템 OpenSSH에 등록 주소와 SSH 사용자, 포트를 명시하고 호스트 이름 정규화 옵션과 기존 연결 재사용을 끈다. `HostName`으로 별명을 실제 주소에 연결했다면 그 주소를 등록한다. 프록시, DNS, 인증과 호스트 키 검증에는 사용자의 SSH 연결 정책이 적용된다.
- SSH 대상은 등록된 주소와 사용자만 쓴다. 원격 명령은 고정된 `_receive` 진입점이고 본문과 메타데이터는 크기 제한 JSON stdin으로 전달한다. `remote-send`는 기존 `send` 자동 승인 범위에 포함하지 않는다. `triflux setup`의 별도 사전 승인이 없으면 실행 권한을 따로 받는다. `_receive`는 어떤 승인에도 포함하지 않는다. 전송 명령은 전역 allow, 동의 파일과 설정을 바꾸지 않는다. `_receive`는 내부 수신용이다. 발신 표시와 호스트 별명은 인증 신원이나 권한 근거가 아니다. 기존 수신 세션의 소유권, PID, socket, thread, conversation 검사를 그대로 적용한다.
- SSH는 한 번만 실행한다. 기록 전 확정 거부는 `rejected`, 기록 후 응답 유실과 timeout은 `unknown`, adapter의 부분 기록은 `partial`로 반환한다. `retrySafe:false`, `modelReceipt:false`와 발신 호스트의 `correlationId`를 유지하며 adapter의 `msgId`도 보존한다. 자동 재전송과 tmux 또는 사용자 턴 폴백은 없다. `sent`와 `written`도 모델 수신이나 완료를 뜻하지 않는다.
- 같은 호스트 Claude끼리는 기존 `SendMessage`를 쓴다. 원격 peer 수신은 목적지의 기존 native adapter로 전달하고, `tfx-live ask`의 사용자 입력 경로와 구분한다. 기존 `tfx-live send`의 원격 미지원 계약은 그대로다.

```bash
"$HOME/.claude/scripts/tfx-peer" remote-send --host m5 --reply-host m2 --to 'codex:10.30 구현' --message '변경사항을 공유합니다'
"$HOME/.claude/scripts/tfx-peer" remote-send --from 'agy:10.30 발신' --host m5 --reply-host m2 --to 'claude:10.30 리드' --message '결과 파일을 확인해 주세요'
# m5의 수신 본문에 표시되는 회신 예시
"$HOME/.claude/scripts/tfx-peer" remote-send --host m2 --reply-host m5 --to 'codex:<원래 발신 UUID>' --message '확인했습니다'
```

```powershell
# Windows 발신(ryzen 은 m5 의 hosts.json 에 등록한 이 호스트의 별명)
node "$env:APPDATA\npm\node_modules\triflux\bin\tfx-peer.mjs" remote-send --from 'claude:11.27 발신' --host m5 --reply-host ryzen --to 'claude:11.27 리드' --message '결과 파일을 확인해 주세요'
```
