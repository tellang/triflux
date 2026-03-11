# Codex xhigh 세션 1: teammate spawn 메커니즘 완전 분석

## 목표

Claude Code `cli.js`에서 `xT6` (teammate spawn) 함수의 전체 실행 경로를 디컴파일하여,
`in_process_teammate` 런타임 엔트리 생성의 **최소 필수 조건**을 도출한다.

## 배경

이전 세션에서 확인된 사항:
- Shift+↑/↓ 네비게이션은 `in_process_teammate` 런타임 상태 기반
- `config.json` members 수동 추가로는 네비게이션 불가
- `uj(A)` 함수: `A.type === "in_process_teammate"` 판별
- `nc6` (InProcessTeammateTask) 객체가 spawn/kill/renderStatus 담당
- spawn 시 `xT6(K, {setAppState: q.setAppState})` 호출

## 조사 항목

### 1. `xT6` 함수 전체 디컴파일
```
위치: cli.js 내 xT6 함수
방법: 함수 시작점(xT6)부터 return까지 추출
목표: 매개변수, 내부 호출 체인, 반환값 구조 파악
```

### 2. teammate spawn에 필요한 최소 매개변수
```
K = { name, teamName, prompt, color?, planModeRequired? }
→ 이 중 필수/옵션 판별
→ prompt가 빈 문자열이어도 spawn 가능한지?
→ color 미지정 시 자동 할당 로직?
```

### 3. spawn 후 프로세스 모델
```
- 별도 Node.js 프로세스? 같은 프로세스 내 worker?
- --agent-id, --agent-name, --team-name 인자가 어디로 전달되는지?
- child_process.spawn? fork? 아니면 in-process 실행?
```

### 4. `setAppState` 호출 분석
```
spawn 성공 시 state 업데이트 구조:
- tasks[taskId] = { type: "in_process_teammate", status: "running", ... }
- 이 state는 어디에 저장? 메모리만? 파일 동기화?
```

### 5. abort/kill 메커니즘
```
- Y.abortController?.abort() — AbortController 기반?
- WT1(A, q.setAppState) — kill 시 state cleanup 로직
```

## 실행 방법
```bash
codex exec --profile xhigh --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check \
  "이 프롬프트의 조사 항목을 수행하라. 대상: $APPDATA/npm/node_modules/@anthropic-ai/claude-code/cli.js"
```

## 기대 산출물
- xT6 함수의 디컴파일된 pseudo-code (readable)
- 최소 spawn 매개변수 목록
- 프로세스 모델 다이어그램
- state 업데이트 flow
