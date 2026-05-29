# PRD — Codex app-server UDS daemon-attach (PoC) + tfx-live `orchestrate` verb

## 배경
`tfx-live`의 `uds-orchestrator`는 Claude는 daemon UDS(`control.sock`)로 붙지만 Codex는 `createCodexExecEndpoint`(=`codex exec` stdio one-shot stdout 긁기)로만 닿았다. 역공학(2026-05-29)으로 **Codex CLI(0.135.0) `app-server`가 Claude daemon과 동급의 UDS 제어평면**을 가진다는 사실, 그리고 **`--listen unix://`가 WebSocket-over-UDS**(HTTP Upgrade + RFC6455 text frame, client→server mask 필수)임을 실측 확정([[reference-codex-app-server-uds-wire]]). handshake+initialize+thread/start는 auth 불필요.

## 목표 (PoC 스파이크 — default 무변경)
1. **`JsonRpcWsUdsClient`** (`hub/workers/lib/jsonrpc-ws-uds.mjs`): AF_UNIX 위 WebSocket JSON-RPC 2.0 클라이언트. `JsonRpcStdioClient`와 동일 public API(`request/notify/onNotification/close/isOpen`), framing만 WS. zero-dep 손수 구현.
2. **`createCodexAppServerUdsEndpoint`** (`hub/team/uds-orchestrator.mjs`): 실행 중 codex app-server daemon socket에 attach(또는 자기 spawn-and-attach) → initialize→initialized→thread/start→turn/start → `turn/completed`에서 resolve. endpoint 계약 `{name, ask(prompt,meta)→{endpoint,text,done,...}}`. **flag 뒤 experimental; default는 `createCodexExecEndpoint` 유지.**
3. **`tfx-live orchestrate` verb** (`bin/tfx-live.mjs`): `runUdsOrchestration({mode,task,claude,codex})`를 정식 노출. `--mode codex-led|claude-led|peer`, Codex endpoint는 `--codex-transport exec|app-server-uds`(default exec).

## Acceptance
- AC1: `JsonRpcWsUdsClient`가 실제 `codex app-server --listen unix://`와 initialize 왕복(실측 프로브로 코덱 검증 완료).
- AC2: fake WS-UDS 서버 픽스처(`tests/fixtures/fake-codex-app-server-ws-uds.mjs`)로 endpoint round-trip 단위테스트(quota 0, CI 통과).
- AC3: 실 codex 라운드트립은 env-gate(`TFX_RUN_REAL_CODEX_APP_SERVER_UDS=1`)로 분리 — 기본 skip.
- AC4: default 경로(`createCodexExecEndpoint`, 기존 tfx-live verb) 무회귀.
- AC5: packages 미러(triflux/remote/core) + `npm run lint` + `npm test` green.
- AC6: Codex cross-review(Claude 작성 → Codex 검토) 통과 후 PR.

## 비목표 (후속)
- default를 app-server-uds로 전환. `JsonRpcStdioClient`/`WsUds` 공통 dispatch 추출 리팩터. `turn/steer`/approval round-trip. remote-control(ws://) 경로. 기존 stdio worker의 stale `--skip-git-repo-check` fix(별 PR).

## 리스크
- WS frame codec 손수 구현 정확성(masking/fragmentation/control frame) → 프로브로 핵심 검증, 단위테스트로 고정.
- daemon 수명주기(attach vs spawn). PoC는 self spawn-and-attach 기본, 기존 daemon attach는 `--sock` 경로 옵션.
