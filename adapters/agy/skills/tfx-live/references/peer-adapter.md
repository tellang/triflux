# 선택적 전역 native peer 어댑터

Windows의 로컬 `send`는 Claude 대상 전달만 지원하고 자동 승인용 래퍼나 Codex 규칙을 설치하지 않는다. PowerShell에서 다음처럼 직접 실행한다.

```powershell
node "$env:APPDATA\npm\node_modules\triflux\bin\tfx-peer.mjs" send --to 'claude:<이름>' --message '<본문>'
```

npm의 `tfx-peer.cmd` shim은 cmd.exe가 본문을 다시 해석해 `%`, `&`, 줄바꿈을 깨뜨리므로 쓰지 않는다. `tfx-live start`로 띄운 Codex는 승인과 샌드박스를 끈 상태라 이 규칙 없이 실행할 수 있다. Windows의 로컬 Codex 대상 전달은 지원하지 않는다.

macOS/Linux는 `triflux setup`에서 별도 동의하면 `~/.claude/scripts/tfx-peer send --to 'codex:<정확한 이름>' --message '<본문>'`, `--to 'claude:<정확한 이름>'`, `--to 'agy:<정확한 이름>'`을 쓴다. `~`는 셸 예시이고 실제 호출과 회신 안내는 setup이 출력한 홈의 절대경로 래퍼 `send`를 쓴다. SKILL.md 의 `<홈 절대경로>`도 실제 값으로 바꾼다. `node`, `bash`, `tfx-live send`를 이 승인으로 실행하지 않는다. Claude끼리는 기존 native `SendMessage`를 우선 사용한다. native peer 실패는 사용자 입력으로 fallback하지 않는다.

macOS/Linux 설치는 현재 사용자 또는 root 소유이고 other-write가 없는 안정적인 package, Node, tmux 경로만 허용한다. group-write는 허용하지만 개발 checkout, symlink packageRoot, 바뀐 런타임 계약은 거부한다. Claude key/socket/auth의 0600 검사는 별도로 유지한다. setup이 확인한 tmux 디렉터리만 래퍼의 고정 PATH에 넣고 호출자 PATH나 PSMUX override를 받지 않는다. 거절·비대화형·CI·postinstall에서는 승인 파일을 쓰지 않으며 update는 미설정·거절·철회를 조용히 보존한다. 재승인은 `triflux setup`에서 명시적으로 선택한다.

`remote-send` 사전 승인은 `send` 승인과 별개 항목이다. `send` 승인이 되어 있으면 `triflux setup`이 이어서 묻고 기본값은 거절이다. 동의하면 Claude `Bash(<실제 절대경로>/tfx-peer remote-send:*)` allow, `~/.codex/rules/triflux-native-peer-remote.rules`, `~/.claude/scripts/tfx-peer-remote-consent.json`만 추가하고, 그 뒤로는 `hosts.json`에 등록한 모든 호스트로 확인 없이 보낸다. `_receive`, `node`, `bash`는 승인 대상이 아니다. update, 비대화형, CI, postinstall 은 이 승인을 쓰지 않는다. agy 는 `send` 와 마찬가지로 따로 쓰는 승인 파일이 없고 Windows 는 대상이 아니다.

Claude 수신은 collapsed native peer UI지만 UDS 또는 named pipe 쓰기 후 결과 `written`에는 같은 연결의 인증·거절 ACK가 없다. 수신이나 모델 완료로 읽지 않는다. Codex는 same-daemon `agent_message` raw injection과 non-user wake를 쓴다. `sent`는 유효한 turn ID와 `inProgress` 또는 `completed` wake 응답을 받은 상태이며 `turnId`, `turnStatus`를 반환한다. 모델 수신과 작업 완료는 뜻하지 않으며 `modelReceipt: false`를 유지한다. injection 뒤 wake가 실패하거나 턴 응답이 없으면 `partial`로 반환하고 자동 재전송하지 않는다. agy는 대화별 `.system_generated/messages/` 파일 저장소 쓰기(`written`)이고 `peer-wake` 패치가 적용된 로컬 세션은 유휴 중에도 바로 깨어난다. 로컬 `tfx-live start --cli codex`와 resume은 검사한 소켓의 realpath로 공유 app-server 데몬에 붙는다. `--remote` 세션의 셸은 데몬에서 돌아서 `-C`로 작업 디렉터리를 지정한다. 소켓이 없으면 `codex app-server daemon start` 안내와 함께 실패한다. 손으로 띄운 Codex는 `tfx-live adopt --session <tmux 대상>`으로 연결한다. 리드가 그 pane에 nonce 메시지를 tmux로 한 번 입력하고, 그 메시지를 받은 공유 데몬 thread를 pane에 기록한다. 이 한 번은 상대 기록에 사용자 발화로 남는다. `-c` 설정 덮어쓰기나 `--no-daemon`으로 띄운 Codex는 공유 데몬 밖에서 돌아 adopt가 실패하므로 `tfx-live start --cli codex --resume <thread>`로 다시 띄운다. 송신 socket은 일회성이므로 native `SendMessage` 회신은 지원하지 않는다(ENOENT 가능). 본문의 발신 머리말과 회신 안내를 따른다. macOS/Linux의 Claude, Codex, agy 발신은 홈의 실제 절대경로 래퍼 `tfx-peer`, unknown 발신은 `회신: 경로 불명(보낸 세션을 판별하지 못함)`을 안내한다. Windows에서 Claude 대상으로 회신할 때는 위 `node` 호출을 안내한다. `tfx-peer` 본문은 8000자까지 받으며 긴 본문은 파일 경로로 보낸다. 머리말과 회신 줄은 그 제한에 포함하지 않는다. `partial`/`unknown` 또는 timeout은 중복 가능성 때문에 자동 재시도하지 않는다.

철회할 때 Claude `settings.json`의 해당 `Bash(<실제 절대경로>/tfx-peer send:*)` allow, `~/.codex/rules/triflux-native-peer.rules`, `~/.claude/scripts/tfx-peer`, **`~/.claude/scripts/tfx-peer-consent.json`**을 확인해 이 어댑터 항목만 제거한다. partial 설치 충돌이면 같은 경로의 `tfx-peer-consent.json.lock`도 확인한다. 다른 설정이나 deny는 건드리지 않는다. 전역 승인 대신 기존 수동 `~/.codex/rules/tfx-live.rules`를 쓰더라도 이는 native peer 전송과 다르다. 원격 자동 권한 변경은 지원하지 않는다. `remote-send` 승인만 철회할 때는 `remote-send:*` allow, `triflux-native-peer-remote.rules`, `tfx-peer-remote-consent.json`을 제거한다. `send` 어댑터를 철회할 때도 이 세 항목을 함께 제거한다. 남겨 두면 어댑터를 다시 설치할 때 묻지 않고 원격 승인이 다시 적용된다.
