---
name: tfx-live
description: >
  Claude·Codex 세션을 실시간으로 생성·질의·대기·압축·종료하거나,
  tmux/daemon UDS 연결과 peer 중계를 운영할 때 사용한다.
argument-hint: "<start|ask|wait|compact|stop|rename|interrupt|probe|list-sessions|peer|converse|goal-driven|orchestrate> ..."
---

# tfx-live

## Codex 호스트 계약

Codex에서는 `$tfx-live`로 호출한다. CLI의 `--cli`는 현재 호스트가 아니라 대상 세션을 선택한다.

`tfx-live`는 Claude Code와 Codex 세션을 tmux 또는 daemon UDS로 제어한다.
`tfx-live --help`와 `tfx-live <동사> --help`로 사용법을 확인한다.

## 전송 경로

- Claude `--short` 또는 `--session-id`는 기본 `auto`로 UDS를 먼저 시도한다. `--session`이 있고 입력 미전송이 확인된 UDS 실패라면 tmux로 전환하고 `~/.claude/cache/triflux/tfx-live/bug-reports/uds-fallback-*.json`을 남긴다. 컨텍스트 가드 거부 시에는 전환하지 않는다.
- Codex와 daemon 참조가 없는 Claude는 tmux가 기본이다. 기존 Codex thread의 UDS 연결은 `--transport uds --thread <id|auto>`를 명시한다.
- UDS 결과는 `matchedCompletion === true`일 때만 `done: true`다. timeout이나 연결 종료는 완료가 아니다.
- bridge 선택 순서는 `--bridge`, `$TFX_BRIDGE`, `$TFX_REPO_ROOT/hub/bridge.mjs`, 번들된 `hub/bridge.mjs`다.

```bash
tfx-live start --cli codex --session cx1 --cwd ~/Projects --name "10.8 구현 검토"
tfx-live ask --cli codex --session cx1 --prompt "현재 변경사항을 요약해줘" --timeout 120
tfx-live stop --cli codex --session cx1
```

새 세션 이름은 `<월>.<일> <주제>`로 짓는다. `start --name`을 생략하면 자동으로 만들고 `nameGenerated: true`를 보고한다. `--resume` 또는 `--resume-last`는 `--name`을 명시한 경우에만 이름을 적용한다. 승계 세션에는 기존 이름 뒤에 ` 2`, 이후 ` 3`을 붙인다. 이름 적용을 요청한 경우 결과의 `nameApplied: false`는 적용 실패를 뜻한다. 기존 Codex UDS thread는 `tfx-live rename --cli codex --transport uds --thread ID --name "<이름>"`으로 이름을 바꾼다.

## 리드 운영

세션을 띄운 리드가 생성, 컨텍스트 관리, 수동 compact, 종료를 책임진다. 작업 연속성과 소유권을 먼저 판단하고 컨텍스트 비율은 개입 시점으로 쓴다. `--resume`은 이전 사용량을 유지하므로 재개 직후 compact 필요 여부를 확인한다.

| 동작 | 적용 조건과 실행 |
| --- | --- |
| compact | 같은 목표와 담당이 이어지고 파일과 git에서 상태를 복구할 수 있을 때. Claude는 `tfx-live compact` 또는 `/compact <보존 지침>`, Codex는 `/compact` 뒤 리드가 파일 경로와 검증 명령을 다시 전달한다. agy는 수동 compact가 없어 handoff한다. |
| clear | 무관한 작업으로 전환하거나 같은 문제를 두 번 넘게 고쳐도 실패할 때, 스펙에서 구현으로 또는 작성자에서 리뷰어로 바뀔 때. 미완료 상태를 정리한 뒤 Claude는 `/rename`과 `/clear`, Codex는 작업 종료 뒤 `/new <이름>`, agy는 `/clear`를 쓴다. |
| handoff | 담당·CLI·모델·소유자가 바뀌거나 긴 작업이 창을 넘길 때. 인계 파일에 목표, 완료 조건, 체크아웃과 변경 상태, 확정 결정, 증거 경로, PASS/FAIL/SKIP, 미완료 작업과 프로세스, 다음 행동과 소유자, `predecessorSessionId`를 적는다. 승계 세션이 경로를 확인하면 이전 세션을 닫는다. |
| close | 결과와 인계를 확인한 즉시 닫는다. Claude 백그라운드는 `claude stop <id>`, tmux는 `tfx-live stop --session`, Claude 팀원은 shutdown, Codex 서브에이전트는 `close_agent`, agy 서브에이전트는 `/agents` 패널의 K를 쓴다. |

두 번째 compact 전에는 handoff가 맞는지 점검한다. compact 횟수는 고정하지 않는다.

### 컨텍스트 판단

분모는 공식 모델 창이고 실행 한도가 더 작으면 그 한도 아래에서 운영한다. 아래 비율은 공식 권고가 아닌 **[추론] 운영값**이다. 모델 문서가 바뀌면 한도도 갱신한다.

| CLI | 준비와 경고 | compact | 신규 배정 중지·handoff | 전송 거부 |
| --- | ---: | ---: | ---: | ---: |
| Claude Code 1M 모델 | 60% | 75% | 85% | 90% |
| Codex | 15% | 18% | 20% | 22% |
| agy | 12% | 없음 | 15% | 18% |

Claude는 85% 도달 시 바로 handoff를 지시한다. agy 행은 운영 지침이며 `tfx-live` 전송 대상이 아니다. `model_context_window`와 `model_auto_compact_token_limit`은 올리지 않는다.

결과에는 `estimatedContextTokens`, `contextLimitTokens`, `contextLimitSource`, `contextPct`가 포함된다. Claude 실행 한도는 `executionContextLimitTokens`로 별도 보고하며 `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`이면 200,000이다. 판정에는 공식 창과 실행 한도 중 작은 값을 쓴다. 한도를 모르면 비율은 `null`로 두고 경고만 한다. 사용량이 없는 `probe`는 `context: null`이다. 컨텍스트를 확인하려면 직접 `tfx-live probe`를 실행한다. `interrupt`, 자동 `ask`의 daemon probe, `stop --short`는 transcript를 읽지 않는다.

`ask`의 `--warn-context-pct`와 `--max-context-pct`는 경고·거부 비율을 덮어쓰며 0이면 해당 가드를 끈다. 기본값은 표의 경고·전송 거부 열이다. 거부 결과는 `status: "failed"`, `done: false`, `context-limit`와 컨텍스트 필드를 돌려준다. 자세한 근거와 실측은 [컨텍스트 정책 연구](../../docs/research/tfx-live-context-policy-2026-10.md)에 둔다.

### 수동 compact와 종료

```bash
tfx-live compact --cli claude --session cl1 --instructions "변경 파일과 검증 명령을 보존하라" --timeout 120
tfx-live stop --cli claude --short <8hex>
tfx-live stop --cli claude --session-id <id>
tfx-live stop --session cl1
```

`compact`는 로컬 Claude tmux `--session`에서 `/compact <instructions>`를 중계 표식 없이 보낸다. 기본 `--if-busy fail`이며 바쁜 세션에는 전송하지 않는다. 새 `compact_boundary`를 확인하면 `compacted: true`, `preTokens`, `postTokens`를 반환한다. 시간 안에 없으면 `compacted: false, timedOut: true`다. UDS compact는 지원하지 않는다.

`stop --short`와 `stop --session-id`는 `claude stop <id>`를 호출하고 `stopped: true, conversationKept: true`를 반환한다. `claude attach`로 대화를 재개할 수 있다. `/exit`, `←`, Ctrl+Z는 백그라운드 세션의 연결만 끊는다. macOS의 `sysctl -n kern.memorystatus_vm_pressure_level`이 2 이상이면 새 세션을 띄우기 전 정리한다. 원격 배정 전에는 `tfx-remote probe <host>`의 `ready`와 `warnings`를 확인한다.

## 요청과 완료 확인

```bash
tfx-live ask --cli claude --transport uds --short <8hex> --prompt "진행 상황을 보고해줘" --no-wait
tfx-live wait --cli claude --short <8hex> --request-id <requestId> --timeout 120 --poll-interval 500
```

`ask --no-wait`는 `status: "submitted"`, `inputSent: true`, `done: false`, `submittedAt`, `target`, `requestId`를 반환한다. `ask`, `peer`, `converse`, `goal-driven`은 `[tfx-live req=<requestId>]`를 프롬프트 앞에 붙인다. `--no-relay-tag`로 제거하면 `wait --request-id`가 해당 요청을 찾을 수 없다.

`wait`는 Claude transcript에서 표식을 user 메시지, `queue-operation`의 `enqueue` content, queued command attachment에서 찾는다. 표식이 소비된 턴이 끝난 뒤 마지막 assistant 텍스트를 응답으로 쓴다. 표식 없는 `wait`는 최신 user turn을 본다. `isSidechain`과 합성 API 오류 메시지는 정상 응답에서 제외한다. 요청을 소비한 턴에서 합성 오류가 나타나면 오류 문구와 `status: "failed"`를 반환한다. daemon의 `idle`만으로 완료를 단정하지 않는다. timeout은 `status: "working"`, `timedOut: true`, `done: false`다. Codex UDS `wait`는 지원하지 않는다.

명시한 `--config-dir`은 정확히 일치하는 daemon만 선택한다. `CLAUDE_CONFIG_DIR`도 해당 env 디렉터리로 제한한다. stale endpoint 복구는 같은 source configDir 안에서만 재시도한다. attach 전 예외는 `inputSent: false`이므로 `auto`의 tmux fallback이 가능하다. attach 뒤 전송 여부가 불명확하면 `status: "unknown"`으로 보고하고 재전송하지 않는다.

직접 `tmux capture-pane`과 `tmux send-keys`를 쓸 때는 전송·pane 진단에 한정한다. Claude pane에 `C-c`를 보내지 않는다. 자동 세션 탐색에는 `tmr ls --json`을 사용한다.

## 세션 탐색과 연결

`tfx-live probe`는 Claude daemon을 찾는다. `tfx-live list-sessions --cli codex [--cwd DIR]`는 기존 Codex tmux pane을 찾고 `target`, `cwd`, `command`, `threadId`, `name` 등을 보고한다. `--cwd`는 pane 경로와 정확히 일치해야 한다. `tfx-live list-sessions --cli claude [--cwd DIR]`는 살아 있는 Claude pane만 찾는다. `--remote`와 `--transport uds`는 Claude tmux 탐색에 쓸 수 없다.

`ask`와 tmux `interrupt`는 세션명, `name:window`, `name:window.pane`을 받는다. `start`와 tmux `stop --session`은 세션명만 받는다. `stop`은 pane·window 대상과 `%12`, `@3` 같은 ID를 거부한다. `--remote HOST`는 대상을 그대로 원격에 전달한다.

`ask`는 pane의 작업 상태와 Codex `model: loading`을 확인한다. tmux의 `--if-busy wait|fail|interrupt` 기본값은 `wait`다. `--busy-timeout` 기본값은 `--timeout`이고 `--poll-interval`은 밀리초다. timeout이면 프롬프트를 보내지 않는다. `interrupt`는 Escape 후 idle을 기다린다. 기존 입력 초안이 있으면 붙여넣기와 합쳐질 수 있으므로 전송 전 pane을 확인한다.

### Codex UDS 스레드

공유 daemon 소켓 기본값은 `$CODEX_HOME/app-server-control/app-server-control.sock`이며 `CODEX_HOME`이 없으면 `~/.codex` 아래를 쓴다. `--codex-socket PATH|default`로 기존 소켓을 선택한다. 없으면 `codex app-server daemon start`로 시작한다.

```bash
tfx-live list-sessions --cli codex --transport uds --cwd ~/Projects/my-worktree
tfx-live ask --cli codex --transport uds --thread auto --cwd ~/Projects/my-worktree --prompt "현재 변경사항을 요약해줘" --if-busy wait --timeout 120
```

`--thread auto`는 선택 조건에 맞는 로드된 thread가 정확히 하나일 때만 쓴다. 여러 개면 목록에서 ID를 골라 `--thread ID`를 지정한다. UDS의 `--if-busy wait|fail|steer` 기본값은 `wait`다. `thread/resume`으로 알림을 구독한 뒤 `turn/start`를 호출하고 반환된 turn ID의 완료만 인정한다. 완료 응답은 `final_answer`를 우선하고 중간 commentary는 따로 반환한다. `--max-turn`은 활동 연장 상한을 지정한다. Codex UDS `interrupt`는 지원하지 않으므로 tmux pane이 있으면 `interrupt --session <target>`을 쓴다.

## peer와 orchestrate

```bash
tfx-live peer --cli-a codex --cli-b claude --session-a cx-peer --session-b cl-peer --cwd ~/Projects --mode freeform --seed "변경을 함께 검토해줘" --rounds 2 --timeout 180
tfx-live peer --cli-a codex --transport-a uds --thread-a <id|auto> --cli-b claude --transport-b uds --short-b <8hex> --cwd ~/Projects/my-worktree --mode freeform --seed "변경을 검토해줘"
tfx-live orchestrate --task "이 변경의 위험을 한 줄로" --mode peer
```

`peer`는 이전 응답을 반대쪽의 다음 프롬프트로 전달한다. 기존 tmux pane은 `--attach-a`·`--attach-b`로 연결하며 종료하지 않는다. UDS 쪽도 기존 세션으로 취급한다. `--if-busy-a`·`--if-busy-b`로 각 쪽의 정책을 정한다. 소유한 세션을 실제 종료한 경우에만 `stoppedA`·`stoppedB`가 참이다.

`orchestrate`의 `--mode`는 `peer|codex-led|claude-led`다. Claude 쪽은 살아 있는 daemon이 필요하다. Codex는 기본 `exec` 경로 또는 실험적 `--codex-transport app-server-uds`를 쓴다. `--codex-socket PATH|default`는 기존 app-server daemon에 연결하고 새 임시 thread를 만든다.

## 진단

```bash
tfx-live --help
tfx-live probe
tfx-live list-sessions --cli codex
```

`auto`가 tmux로 전환되면 `~/.claude/cache/triflux/tfx-live/bug-reports/uds-fallback-*.json`을 확인한다. 테스트에서는 `$TFX_LIVE_BUG_REPORT_DIR`로 위치를 바꿀 수 있다.
