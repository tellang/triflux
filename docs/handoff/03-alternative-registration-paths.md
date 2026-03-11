# Codex xhigh 세션 3: 대안적 teammate 등록 경로 탐색

## 목표

Agent spawn 없이 Shift+↑/↓ 네비게이션에 등록하는 **대안적 경로**를 탐색한다.
공식 API, 미문서 기능, 확장 포인트를 모두 조사한다.

## 배경

확인된 사실:
- 네비게이션 = `in_process_teammate` + `status === "running"` 필터
- config.json members 수동 등록 → 불가
- Agent spawn이 유일한 공식 경로

미탐색 영역:
- `tmuxPaneId` 필드: 비어있지만 존재 → tmux 통합 의도?
- `backendType` 필드: spawn 시 추가 옵션?
- `subscriptions` 배열: 이벤트 구독 시스템?
- Agent tool의 `isolation: "worktree"` 옵션: 다른 실행 모델?

## 조사 항목

### 1. `tmuxPaneId` 필드 용도
```
- config.json에 tmuxPaneId 필드가 존재하지만 항상 빈 문자열
- cli.js에서 tmuxPaneId를 읽거나 쓰는 코드가 있는지?
- tmux 기반 teammate가 한때 존재했거나 계획 중인지?
- tmuxPaneId를 설정하면 동작이 달라지는지?
```

### 2. `backendType` 필드
```
- spawn 경로에서 backendType 언급 확인
- "in_process" 외에 다른 backend type이 있는지?
- "external", "remote", "tmux" 같은 타입이 있다면 활용 가능?
```

### 3. Agent tool의 숨겨진 파라미터
```
- isolation: "worktree" → 별도 worktree에서 실행
- team_name + name → teammate로 등록
- 다른 미문서 파라미터가 있는지?
- subagent_type이 네비게이션 표시에 영향을 주는지?
```

### 4. Plugin/Extension API
```
- Claude Code에 플러그인 시스템이 있는지?
- hooks(UserPromptSubmit, PreToolUse 등) 외에 UI 확장 포인트?
- 커스텀 Tool 정의로 teammate-like 동작 구현 가능?
```

### 5. MCP 서버를 통한 teammate 시뮬레이션
```
- MCP 서버가 teammate처럼 동작할 수 있는지?
- MCP tool이 setAppState에 접근 가능한지?
- MCP를 통한 UI 렌더링 커스터마이징?
```

### 6. 최소 비용 Agent 래퍼 최적화
```
만약 대안이 없다면, Agent 래퍼의 최소 비용을 계산:
- 빈 prompt로 spawn 가능한지?
- Haiku 모델로 래퍼를 실행하면 비용은?
- spawn → Bash 1회 → complete의 최소 토큰 소비량?
- 래퍼가 tfx-route.sh를 실행하고 종료하는 최단 경로?
```

## 실행 방법
```bash
codex exec --profile xhigh --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check \
  "이 프롬프트의 조사 항목을 수행하라. 대상: $APPDATA/npm/node_modules/@anthropic-ai/claude-code/cli.js.
   특히 tmuxPaneId, backendType, subscriptions 키워드를 cli.js에서 검색하고 관련 코드를 추출하라."
```

## 기대 산출물
- 각 대안 경로의 가능/불가 판정표
- tmuxPaneId/backendType/subscriptions 관련 코드 추출
- Plugin API 존재 여부 확인
- 최소 비용 Agent 래퍼 비용 분석 (토큰 수치)
- 최종 권장 방안
