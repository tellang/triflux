# RE 결과 종합: Claude Code teammate 네비게이션 메커니즘

> 3개 Codex xhigh 세션의 리버스 엔지니어링 결과를 통합 정리한다.
> 대상: `cli.js` v1.0.40+ (12MB 번들, ~13,000 lines)

## 1. 핵심 결론

**`in_process_teammate` 상태의 외부 주입은 불가능하다.**
Agent spawn(`xT6`)이 네비게이션 등록의 유일한 실용적 경로이다.

| 주입 경로 | 판정 | 근거 |
|----------|------|------|
| `process.env` | 불가 | 모드/실행환경 제어만, tasks 삽입 경로 없음 |
| `config.json` 변경 감지 | 불가 | `pX1`는 settings/toolPermissionContext만 갱신 |
| IPC/socket | 불가 | mailbox(`K9/pl/_U6`)는 메시지 전달용, task 생성 불가 |
| Plugin API | 부분적 | callback hooks에 `setAppState` 전달되나 실행 루프 없어 무용 |
| MCP 서버 | 불가 | 별도 프로세스, `setAppState` 접근 불가 |
| JS 호이스팅/Prototype | 불가 | `setAppState`가 closure로 보호 |
| `registerTaskType` | 불가 | 타입/핸들러 하드코딩 |

## 2. 아키텍처 개요

### 2.1 tasks store

```
패턴: Custom store (UX1) + React useSyncExternalStore
위치: cli.js:1150 (store 생성), cli.js:3810 (n86 초기화)

n86() → { tasks: {}, verbose: false, ... }
         ↓
  _T(task, setAppState)  — task 등록
  Dw(taskId, setAppState, mutator)  — task 업데이트
  NS(taskId, setAppState)  — task 제거 (completed/failed/killed + notified)
```

**setAppState 시그니처:**
```js
setAppState((prevState) => nextState)
```

**외부 접근:**
- 전역 공개 API 없음
- 내부 컨텍스트 훅 `A7()` / `Od8().setState` 경유만 가능

### 2.2 task 타입 레지스트리

```js
// cli.js:156 (Xf 함수)
t13 = {
  local_bash: "b",       // Bash 도구
  local_agent: "a",      // Agent 도구 (일반)
  remote_agent: "r",     // 원격 에이전트
  in_process_teammate: "t"  // 팀원 (네비게이션 대상)
}
```

### 2.3 teammate 컨텍스트 관리

```js
// AsyncLocalStorage 기반 격리
JT8 = new AsyncLocalStorage()  // cli.js:1103 부근

// Dynamic context (모듈 레벨 변수)
vE = null  // setDynamicTeamContext / clearDynamicTeamContext
```

## 3. xT6 함수 (teammate spawn) 디컴파일

### 3.1 위치 및 시그니처

```
위치: cli.js:2607 (idx 6980776)
```

### 3.2 Pseudo-code

```js
async function xT6(config, context) {
  const { name, teamName, prompt, color, planModeRequired, model } = config;
  const { setAppState } = context;

  // 1. agentId 생성: "{name}@{teamName}" 형태
  const agentId = hE(name, teamName);

  // 2. taskId 생성: "t" + 8자리 랜덤 (in_process_teammate prefix)
  const taskId = hk("in_process_teammate");

  try {
    // 3. AbortController 생성
    const abortController = I3();
    const parentSessionId = l1();

    // 4. teammate context 구성
    const identity = {
      agentId, agentName: name, teamName, color,
      planModeRequired, parentSessionId
    };
    const teammateContext = XX1({
      agentId, agentName: name, teamName, color,
      planModeRequired, parentSessionId,
      abortController
    });

    // 5. 팀 등록 (있으면)
    if (Jn()) rG1(agentId, name, parentSessionId);

    // 6. task 엔트리 구성
    const description = `${name}: ${prompt.substring(0, 50)}...`;
    const localTaskId = await NX1(teamName, {
      subject: name,
      description: prompt.substring(0, 100),
      status: "in_progress",
      blocks: [], blockedBy: [],
      metadata: { _internal: true }
    });

    const task = {
      ...Xf(taskId, "in_process_teammate", description, context.toolUseId),
      type: "in_process_teammate",
      status: "running",
      identity,
      prompt,
      model,
      abortController,
      awaitingPlanApproval: false,
      spinnerVerb: randomVerb(["Cooking", "Brewing", ...]),
      pastTenseVerb: randomVerb(["Cooked", "Brewed", ...]),
      permissionMode: planModeRequired ? "plan" : "default",
      isIdle: false,
      shutdownRequested: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
      pendingUserMessages: [],
      messages: [],
      localTaskId
    };

    // 7. cleanup 등록
    const unregisterCleanup = kq(async () => {
      abortController.abort();
    });
    task.unregisterCleanup = unregisterCleanup;

    // 8. state에 등록 → 이 시점에서 네비게이션에 표시됨
    _T(task, setAppState);

    return {
      success: true, agentId, taskId,
      abortController, teammateContext
    };
  } catch (e) {
    return { success: false, agentId, error: e.message };
  }
}
```

### 3.3 최소 spawn 매개변수

| 매개변수 | 필수 | 기본값 | 설명 |
|---------|------|--------|------|
| `name` | **필수** | - | 에이전트 표시 이름 |
| `teamName` | **필수** | - | 팀 이름 (task list 네임스페이스) |
| `prompt` | **필수** | - | 빈 문자열 가능하나 description이 비게 됨 |
| `color` | 옵션 | `undefined` | 미지정 시 `Wi(agentId)` 자동 할당 |
| `planModeRequired` | 옵션 | `false` | plan 모드 강제 여부 |
| `model` | 옵션 | `YF8()` (세션 기본 모델) | 모델 오버라이드 |

### 3.4 프로세스 모델

**In-process 실행 (child_process 아님)**:
- `xT6`는 같은 Node.js 프로세스 내에서 실행
- `AsyncLocalStorage.run(teammateContext, callback)`으로 컨텍스트 격리
- 별도 프로세스 fork/spawn 없음
- `--agent-id`, `--agent-name` 등은 CLI 인자가 아닌 내부 상태

## 4. InProcessTeammateTask 상태 전이

```
[xT6 호출]
    ↓
[pending] (Xf 베이스, 즉시 override)
    ↓
[running, isIdle:false] ── 네비게이션 등록 ──
    ↓
[crY 실행 루프]
    ├── 턴 처리 중 → [running, isIdle:false]
    ├── 턴 완료 대기 → [running, isIdle:true]
    │     ├── onIdleCallbacks 실행
    │     ├── idle_notification 발송 (h8q → OU6 → FrY/K9)
    │     └── 새 메시지 수신 (drY) → [running, isIdle:false]
    ├── 정상 종료 → [completed, notified:true]
    ├── 예외 발생 → [failed, notified:true]
    └── WT1 kill → [killed, notified:true]
         ↓
[NS: tasks store에서 제거]
```

## 5. Dw 함수 (state updater)

```js
function Dw(taskId, setAppState, mutateTask) {
  setAppState((state) => {
    const task = state.tasks?.[taskId];
    if (!task) return state;
    return {
      ...state,
      tasks: {
        ...state.tasks,
        [taskId]: mutateTask(task),
      },
    };
  });
}
```

### 래퍼 함수

| 함수 | 동작 | 위치 |
|------|------|------|
| `EC8` | `shutdownRequested = true` | cli.js:2607 |
| `GT1` | `messages.push(newMessage)` | cli.js:2607 |
| `LC8` | terminal이면 drop, 아니면 `pendingUserMessages` + `messages` append | cli.js:2607 |
| `ex` | 범용 task 업데이터 (crY 루프에서 사용) | cli.js:2827 |

## 6. Shift+Down 네비게이션 조건

네비게이션에 표시되려면:
1. `tasks[id].type === "in_process_teammate"` (uj 타입 가드)
2. `tasks[id].status === "running"` (PX1 필터)
3. viewingAgentTaskId 기반 토글

Shift+Up은 존재하나 동작 조건이 Down과 비대칭 — Claude Code 내부 이슈.

## 7. 두 가지 spawn 경로

| 경로 | 함수 | 용도 |
|------|------|------|
| `xT6` | 표준 in-process spawn | Agent 도구 호출 시 |
| `TAq` | tmux pane 기반 spawn | tmux teammate 등록 시 (abort → kill-pane) |

## 8. Plugin callback hooks의 setAppState 접근

```js
// cli.js 내부: nvz 함수 (callback hook 실행)
let $ = _ ? { getAppState: _.getAppState, setAppState: _.setAppState } : void 0;
var O = await q.callback(Y, A, z, w, $);
```

**이론적으로 callback hook에서 setAppState 호출 가능하나:**
- callback hooks는 JS 플러그인 전용 (셸 hooks 불가)
- `in_process_teammate` 엔트리 주입 가능하나 실행 루프(`crY`) 없어 기능 무용
- UI에 표시는 되나 메시지 처리/응답 불가

## 9. 최종 권장: 슬림 래퍼 (Option D)

Agent spawn이 유일한 실용적 경로이므로:
- 최소 프롬프트 (~100 토큰)의 Agent를 spawn
- Agent 내부에서 `Bash(tfx-route.sh)` 1회 실행
- 완료 후 `TaskUpdate + SendMessage`로 보고
- 예상 총 비용: 워커당 ~180 토큰 (v2의 ~800 대비 77% 절감)
