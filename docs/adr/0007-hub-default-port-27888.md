---
id: 0007
title: hub 기본 포트를 27888로 고정한다
status: accepted
date: 2026-04-17
deciders: [tellang]
supersedes: []
superseded_by: null
relates: [0002]
pr: "#82"
---

# ADR-0007: hub 기본 포트를 27888로 고정한다

## 컨텍스트와 문제 (Context)
tfx-hub는 로컬 MCP·에이전트 조율 데몬이고, 클라이언트(Claude·Gemini `settings.json`, 프로젝트 `.mcp.json`)가 `tfx-hub.url`로 이 데몬을 가리킨다. 초기엔 포트가 사용 중이면 다음 포트로 넘어가는 cascade 방식이었는데, 이 때문에 hub가 재시작될 때마다 포트가 바뀌고 클라이언트 config가 stale해져(예: `:27888` → `:27889`) MCP 연결이 조용히 끊겼다. 데몬 위치의 single source of truth가 필요했다.

## 결정 (Decision)
우리는 hub 기본 포트를 **27888로 단일 고정**한다.

- `resolveHubTarget()`은 env `TFX_HUB_PORT`가 없으면 `HUB_DEFAULT_PORT = 27888`을 쓴다. env가 유일한 override source다.
- **port cascade 제거** — 포트 재사용 로직을 없애 데몬 위치를 결정적으로 만든다.
- hub 시작 시 `hub-ensure`가 클라이언트 config(gemini/claude `settings.json`, 프로젝트 `.mcp.json`)의 `tfx-hub.url`을 27888로 auto-sync한다(`syncHubMcpSettings` / `syncProjectMcpJson`).
- pid-file은 host 힌트 전용이며 포트 결정에 쓰지 않는다.

## 검토한 대안 (Considered Options)
- **A안: 고정 27888 + env override (채택)** — 장점: MCP url 안정, config drift 원천 차단, 단일 override 경로. 단점: 27888 충돌 시 env 지정 필요(드묾).
- **B안: 동적 포트 cascade** — 장점: 포트 충돌 자동 회피. 단점: 재시작마다 포트 변동 → 클라이언트 config stale → 연결 단절(실제 발생한 회귀).
- **C안: 사용자가 매번 포트 수동 지정** — 장점: 완전 제어. 단점: 온보딩 마찰, 자동 sync 불가.

## 결과 (Consequences)
긍정: MCP url이 안정되고 hub 재시작이 클라이언트 연결을 깨지 않는다. config auto-sync로 수동 편집 불필요. 부정/리스크: 27888이 다른 프로세스와 충돌하면 `TFX_HUB_PORT` env override 필요. 관련 PR: #82(포트 고정 + Gemini/Claude settings auto-sync), #158(port cascade 제거 + env single source of truth). 참고 SSOT는 `.claude/rules/tfx-update-logic.md`의 "Hub MCP URL 동기화" 절.
