# Codex xhigh 세션 2: InProcessTeammateTask 생명주기 & 상태 주입 가능성

## 목표

`nc6` (InProcessTeammateTask) 객체의 전체 생명주기를 분석하고,
외부에서 `in_process_teammate` 상태를 주입할 수 있는 경로가 있는지 탐색한다.

## 배경

이전 세션에서 확인된 코드:
```js
nc6 = {
  name: "InProcessTeammateTask",
  type: "in_process_teammate",
  async spawn(A, q) { ... },
  async kill(A, q) { WT1(A, q.setAppState) },
  renderStatus(A) { ... },
  renderOutput(A) { ... }
}
```

관련 함수:
- `GT1`: appendTeammateMessage
- `LC8`: injectUserMessageToTeammate
- `EC8`: requestTeammateShutdown
- `R16`: findTeammateTaskByAgentId

## 조사 항목

### 1. tasks 상태 스토어 구조
```
n86() 초기화에서:
  tasks: {} → 여기에 in_process_teammate 엔트리가 동적 추가

- tasks는 React state? Zustand store? 커스텀 store?
- 외부에서 접근 가능한 API가 있는지?
- setAppState 콜백의 정확한 시그니처?
```

### 2. 상태 전이 다이어그램
```
pending → running → completed
                  → failed
                  → killed

각 전이 트리거:
- pending → running: spawn 성공
- running → completed: 자연 종료
- running → failed: 에러
- running → killed: kill 호출
```

### 3. idle 감지 메커니즘
```
- isIdle 플래그는 어떻게 설정?
- "Idle for Xs" 표시 로직
- idle 상태에서도 메시지 수신 가능 확인
```

### 4. 외부 상태 주입 가능성
```
탐색 대상:
a) process.env를 통한 teammate 등록 (환경변수)
b) 파일 watch를 통한 동적 로딩 (config.json 변경 감지)
c) IPC/socket을 통한 런타임 등록
d) Claude Code plugin API (있다면)
e) 커스텀 Task type 등록 메커니즘
```

### 5. `Dw` 함수 (state updater) 분석
```
EC8, GT1, LC8 모두 Dw(A, q, callback) 패턴 사용
→ Dw가 tasks store의 atomic updater?
→ 외부에서 Dw를 호출할 수 있는 경로?
```

## 실행 방법
```bash
codex exec --profile xhigh --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check \
  "이 프롬프트의 조사 항목을 수행하라. 대상: $APPDATA/npm/node_modules/@anthropic-ai/claude-code/cli.js"
```

## 기대 산출물
- InProcessTeammateTask 상태 전이 다이어그램
- tasks store의 구현 패턴 (React/Zustand/custom)
- 외부 주입 가능성 판정 (가능/불가 + 근거)
- Dw 함수 디컴파일
