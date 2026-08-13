# Codex app-server same-thread dual-client gating 실측

실측 대상은 로컬 Codex CLI 0.147.0의 private `codex app-server --listen unix://PATH` 한 인스턴스다. Controller A는 기존 `JsonRpcWsUdsClient`로 연결했고, TUI는 tmux에서 `codex resume "$THREAD_ID" --remote "unix://$SOCK"`로 같은 thread에 연결했다. Canonical run의 thread는 `019ff9e3-b69d-7821-af93-7731dcfbb634`다.

Raw event, RPC action, pane capture, `thread/read(includeTurns:true)` snapshot은 `codex-app-server-dual-client-gating-latest-report.json`에 있다. 모든 controller event에는 가능한 범위에서 `threadId`, `turnId`, `clientUserMessageId`/`clientUserMessageIds`를 명시했다. TUI 입력이 server에 수락되지 않은 경우에는 `turnId`와 `clientUserMessageId`가 `null`이며, 이것 자체가 상관관계 실패 증거다.

## 선행 조건

`thread/start(ephemeral:false)` 직후에는 응답에 durable path가 있어도 rollout 파일이 아직 없었다(`rolloutBeforeSeed: "missing"`). 이 상태에서 TUI `thread/resume`는 `no rollout found`(-32600)로 실패했다. 최소 P0 turn `019ff9e3-b72a-77d3-b77d-810b5cb30325`를 완료하자 같은 path가 `file`이 되었고 TUI attach가 성공했다. 따라서 0.147.0에서는 빈 durable thread에 TUI가 바로 붙을 수 없고, 먼저 적어도 한 turn을 materialize해야 한다.

## 6개 gate 판정

| Gate | 판정 | 실측 증거 |
| --- | --- | --- |
| 1. 양방향 입력이 같은 history에 들어가는가 | **반증됨** | A의 P1 `P1_ca9872de`는 turn `019ff9e3-d36a-70a0-b195-58f8846958bc`, `clientUserMessageId=program-P1_ca9872de`, history item `item-3`으로 저장됐고 TUI에도 보였다. 그러나 TUI의 H1 `H1_5e3a4cfe`는 pane composer에 남아 `tab to queue message`가 표시됐으며, A에는 `turn/started`, user item, `turn/completed`가 모두 0건이었다. 최종 history에도 H1 turn/item이 없어서 `turnId=null`, `clientUserMessageId=null`이다. |
| 2. Program `turn/interrupt`가 human turn을 끊는가 | **미확인** | TUI에 `H_PROGRAM_INTERRUPT_eb503eb1`을 입력했지만 human turn 자체가 생성되지 않아 history correlation과 `turnId`가 모두 null이었다. 끊을 대상 turn이 없었으므로 interrupt 동작을 판정할 수 없다. |
| 3. Human ESC가 program turn을 끊는가 | **확인됨** | A가 시작한 turn `019ff9e4-feb0-7151-a7aa-9147c515a8f7`에 TUI가 ESC를 보냈고, A의 `turn/completed` 및 history status가 모두 `interrupted`였다. Probe의 cleanup interrupt는 사용되지 않았다. |
| 4. 거의 동시 제출의 충돌 정책은 결정적인가 | **확인됨 — reject** | 두 trial 모두 A request와 TUI key 전송 timestamp 차이가 0ms였다. Trial 1 program turn은 `019ff9e5-0c44-7f42-81db-33488cea072d`, trial 2는 `019ff9e5-2ecd-7a51-95da-5012b0b3c24a`였다. 두 경우 모두 human nonce는 composer에 보였지만 history correlation과 human turnId가 없었다. 결과는 2/2 동일한 reject이며 queue/steer는 관찰되지 않았다. |
| 5. Approval request는 어느 client로 가는가 | **확인됨 — A와 TUI 양쪽에 노출, 응답 소유자는 A** | Program turn `019ff9e5-5024-7c90-a940-123701a2a7e9`에서 A가 request id `0`, method `item/commandExecution/requestApproval`을 받았다. TUI도 같은 `printf APPROVAL_5f0090cf` dialog와 선택지를 표시했다. A가 `{decision:"decline"}`로 응답한 뒤 turn은 `completed`됐다. 승인하지 않았고 지속 mutation은 없었다. |
| 6. Detach → re-attach에 중복 입력이나 event 누락이 없는가 | **반증됨** | TUI가 분리된 동안 A의 `P_DETACHED_ac936fe6` turn `019ff9e5-75a9-77f0-92a7-9e96209b84ae`는 정상 완료됐고, re-attach 화면과 history에 정확히 1회 보였다. 과거 item event replay도 0건이라 중복은 없었다. 그러나 re-attach 후 입력한 `H_REATTACHED_f7d1c50e`는 history count 0, human turnId null, A item/completion event null이었다. 즉 중복은 없지만 새 human 입력과 lifecycle이 누락됐다. |

## 해석

`canAcceptDirectInput: true`와 program-originated content의 TUI 표시만으로 dual writer가 되지는 않는다. 실측에서는 controller turn의 내용은 TUI로 전달됐지만, TUI가 이후 human input을 same-thread turn으로 제출하지 못했다. Detach/re-attach도 이전 program history는 복구했으나 새 human input 수락을 복구하지 못했다. 충돌 정책은 결정적 reject였지만, 성공 기준의 첫 절반인 양방향 same-history가 반증됐으므로 안전한 공존 조건을 충족하지 않는다.

## Cleanup 및 재실행

Canonical run이 만든 tmux session 8개는 모두 wrapper로 종료됐고 `remainingSessions=[]`이다. Private app-server는 정상 종료됐으며 UDS socket과 temp dir는 모두 `missing`으로 확인됐다. Fatal error는 없었다.

```bash
TFX_RUN_REAL_CODEX_DUAL_CLIENT_GATE=1 \
TFX_CODEX_DUAL_CLIENT_TIMEOUT_MS=60000 \
node experiments/native-bridge-feasibility/codex-app-server-dual-client-gating-probe.mjs
```

## 최종 판정

**불가능 — Codex CLI 0.147.0 private app-server에서는 persistent controller A와 사람 TUI가 같은 thread의 양방향 writer로 공존하지 못한다. Program→TUI 표시는 되지만 human→same history가 수락되지 않으므로 triflux 이관 gate는 FAIL이다.**
