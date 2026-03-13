# #55 tfx-hub MCP 클라이언트 시작 실패

> 등록: 2026-03-13
> 상태: resolved
> 분류: bug
> 심각도: medium
> 관련: hub/server.mjs, Codex rmcp client

## 증상

Codex 세션에서 tfx-hub MCP 서버 연결 시 핸드셰이크 실패:

```
⚠ MCP client for `tfx-hub` failed to start: MCP startup failed:
  handshaking with MCP server failed: Send message error
  Transport [rmcp::transport::worker::WorkerTransport<
    rmcp::transport::streamable_http_client::StreamableHttpClientWorker<
      codex_rmcp_client::rmcp_client::StreamableHttpResponseClient
    >>] error: Client error: error sending request for url (http://127.0.0.1:27888/mcp),
  when send initialize request

⚠ MCP startup incomplete (failed: tfx-hub)
```

## 분석

- Codex의 rmcp 클라이언트(Rust)가 Hub의 Streamable HTTP 엔드포인트(`/mcp`)에 연결 시도
- Hub 서버가 미실행이거나, `/mcp` 엔드포인트의 Streamable HTTP 응답이 rmcp 클라이언트 기대와 불일치
- Hub가 실행 중이어도 발생할 수 있음 → Streamable HTTP 스펙 호환성 문제 가능성

## 재현

1. Hub 서버 미실행 상태에서 Codex 세션 시작
2. Codex MCP 설정에 `tfx-hub` 등록된 상태
3. 세션 시작 시 MCP 핸드셰이크 자동 시도 → 실패

## 조사 필요

- [ ] Hub 실행 중일 때도 동일 오류 발생하는지 확인
- [ ] `curl -sf http://127.0.0.1:27888/mcp` 직접 응답 확인
- [ ] rmcp 클라이언트의 Streamable HTTP 스펙 요구사항 vs Hub 구현 비교
- [ ] Hub 미실행 시 graceful 실패 처리 (Codex 세션 자체는 정상 진행되어야 함)

## 해결 방향

1. **단기**: Hub 미실행 시 Codex preflight에서 tfx-hub MCP를 비활성화하는 가드
2. **중기**: Hub `/mcp` 엔드포인트의 Streamable HTTP 응답을 rmcp 스펙에 맞게 조정
3. **장기**: Hub auto-start (기존 #18 이슈) 해결 시 자연 해소

## 해결 (2026-03-13)

**근본 원인**: Hub 미실행 상태에서 MCP 클라이언트가 `/mcp` 연결 시도 시 TCP 연결 자체가 실패.
`hub-ensure.mjs`가 Hub를 auto-start하지만 SessionStart 훅에 등록되어 있지 않았고,
기동 후 ready 대기 없이 즉시 반환하여 MCP 핸드셰이크 시점에 Hub가 아직 리스닝하지 않는 race condition.

**수정 내용**:
1. `scripts/hub-ensure.mjs`: Hub 기동 후 `waitForHubReady()` 폴링 추가 (250ms 간격, 최대 5초)
2. `hooks/hooks.json`: SessionStart에 `hub-ensure.mjs` 훅 추가 (preflight-cache 이전에 실행)
