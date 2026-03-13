# 리서치: Claude Code Agent 도구 접근 제한 방법

> 날짜: 2026-03-13
> 출처: Codex document-specialist (analyze 프로필, 306초)
> 문제: 슬림 래퍼 Agent가 tfx-route.sh 대신 Read/Edit/Grep 등 네이티브 도구를 직접 사용

---

## 핵심 결론

프롬프트만으로는 부족하다. 가장 현실적인 방법은 **custom agent + tools allowlist + dontAsk + PreToolUse hook** 조합이고, 가장 강한 격리는 **단일 MCP tool 래퍼**이다.

## 5가지 방법 비교

| # | 방법 | 실현 가능성 | 강제력 | 난이도 | 평가 |
|---|------|-----------|--------|--------|------|
| 1 | subagent_type 내장 제한 | 높음 | 낮음 | 낮음 | Explore/Plan은 read-only용이지 Bash-only 격리 아님 |
| 2 | 프롬프트 엔지니어링 | 높음 | 없음 | 낮음 | "유도"용이지 "차단"으로 믿으면 안 됨 |
| 3 | permission mode (dontAsk) | 중간 | 중간 | 중간 | 보조 수단으로 좋지만 단독 해법 아님 |
| 4 | **커스텀 Agent (.claude/agents/)** | **높음** | **높음** | **낮음-중간** | **1순위 해법** |
| 5 | MCP 서버 래퍼 | 높음 | 최고 | 중간-높음 | 최종 격리 해법 |

## 상세 분석

### 1. subagent_type별 도구 제한

- `Explore`, `Plan`은 Write/Edit 차단 (read-only)
- 하지만 Glob/Grep/Read + read-only Bash 사용 가능
- "Bash만 허용" 같은 초정밀 격리에 부적합
- 커뮤니티에서도 Explore가 예상 외 도구 사용 사례 보고

### 2. 프롬프트 엔지니어링

- fail-closed 프롬프트: "유일한 허용 도구는 Bash, 명령은 tfx-route.sh만, Read/Edit/Grep 절대 금지"
- **한계**: soft control → 우회/무시 사례 다수 보고
- CLAUDE.md나 지시문만으로는 도구 접근이 열려 있는 한 다른 경로로 돌아감

### 3. permission mode

- `dontAsk`: 사전 허용되지 않은 도구를 자동 거부
- `permissions.allow`로 `Bash(./tfx-route.sh:*)`만 허용 + `permissions.deny`로 나머지 차단
- **한계**: Bash 인자 단위 강제가 취약할 수 있음, hooks로 보강 필요

### 4. 커스텀 Agent (.claude/agents/) ★ 추천

```markdown
# .claude/agents/slim-wrapper.md
---
name: slim-wrapper
description: tfx-route.sh만 실행하는 제한된 워커
tools:
  - Bash
  - TaskUpdate
  - SendMessage
  - TaskGet
  - TaskList
disallowedTools:
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - Agent
permissionMode: dontAsk
---

너는 슬림 래퍼 워커이다. Bash(tfx-route.sh)만 사용해 작업을 수행하라.
Read, Edit, Grep, Glob 등 다른 도구는 사용할 수 없다.
```

- `tools` allowlist로 Bash + Task/SendMessage만 허용
- `disallowedTools`로 명시적 차단
- `permissionMode: dontAsk`로 미허용 도구 자동 거부
- **PreToolUse hook**으로 Bash 인자에서 `tfx-route.sh` prefix 강제

### 5. MCP 서버 래퍼

- `route()` tool 하나만 노출하는 MCP 서버
- 내부에서 tfx-route.sh 실행
- 모델이 Read/Edit/Bash 자체를 볼 수 없음
- **가장 강한 격리**이지만 구현/운영 비용 큼

## 추천 구현 순서

### Phase 1: 즉시 적용 (커스텀 Agent + hook)

1. `.claude/agents/slim-wrapper.md` 생성 (tools allowlist)
2. `PreToolUse` hook으로 Bash 명령에 `tfx-route.sh` prefix 강제
3. tfx-multi 스킬에서 `subagent_type: "slim-wrapper"` 사용

### Phase 2: 팀 차원 강제

4. managed settings에서 `disableBypassPermissionsMode` 설정
5. managed permission rules/hooks 배포

### Phase 3: 최종 격리 (필요 시)

6. 단일 MCP tool 래퍼 서버 구현
7. Claude에는 해당 tool만 노출

## 출처

- Anthropic Docs: Subagents, Permissions, Hooks, Settings
- GitHub Issues: #23307 (Explore behavior), #10708 (MCP collision), #7328 (tool filtering)
- Reddit: CLAUDE.md 라우팅 신뢰성, hooks 한계 사례
