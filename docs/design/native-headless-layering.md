# Native Team + triflux headless 2계층 설계

> 상태: Draft (v9.x 로드맵)
> 작성일: 2026-03-26
> 관련 코드: `hub/team/headless.mjs`, `hub/team/psmux.mjs`, `hub/team/cli/`, `hub/team/tui-viewer.mjs`
> 관련 외부: OMC team skill (oh-my-claudecode Native Team 오케스트레이션)

---

## 1. 현재 아키텍처 분석

### 1.1 모듈 구조

현재 팀 오케스트레이션은 4가지 실행 모드가 `teamStart()`에서 분기된다:

```
hub/team/cli/commands/start/index.mjs (teamStart)
  ├── startHeadlessTeam()   → headless.mjs (psmux 기반)
  ├── startInProcessTeam()  → native-supervisor.mjs (직접 프로세스)
  ├── startMuxTeam()        → tmux 세션
  └── startWtTeam()         → Windows Terminal split-pane
```

### 1.2 headless.mjs 역할 (현재)

headless.mjs는 **의미론(팀 오케스트레이션)과 인프라(psmux 터미널 제어)**가 혼합되어 있다:

| 관심사 | 함수 | 역할 |
|---|---|---|
| **의미론** | `buildHeadlessCommand()` | CLI별 명령 빌드 (codex/gemini/claude 분기) |
| **의미론** | `resolveCliType()` | 에이전트 역할명 → CLI 타입 해석 |
| **의미론** | `collectResults()` | handoff 파이프라인, git diff 수집 |
| **인프라** | `dispatchProgressive()` | psmux pane 생성, split-window, 타이틀, 캡처 |
| **인프라** | `dispatchBatch()` | psmux 일괄 pane 생성 + dispatch |
| **인프라** | `awaitAll()` | psmux pane 폴링, 완료 대기 |
| **인프라** | `applyTrifluxTheme()` | psmux status bar, 색상 테마 |
| **인프라** | `ensureWtProfile()` | WT settings.json 프로필 관리 |
| **인프라** | `autoAttachTerminal()` | WT split-pane attach |
| **인프라** | `attachDashboardTab()` | WT + tui-viewer 실행 |
| **혼합** | `runHeadless()` | 세션 생성 → dispatch → 대기 → 결과 수집 |
| **혼합** | `runHeadlessInteractive()` | interactive handle (dispatch/capture/kill) |

### 1.3 psmux.mjs 역할 (현재)

psmux.mjs는 **순수 인프라 래퍼**로, psmux 바이너리에 대한 저수준 인터페이스를 제공한다:

- 세션 생성/종료 (`createPsmuxSession`, `killPsmuxSession`)
- pane 목록/해석 (`listPaneDetails`, `resolvePane`)
- 명령 dispatch (`dispatchCommand`, `sendKeysToPane`)
- 출력 캡처 (`capturePsmuxPane`, `startCapture`, `waitForCompletion`)
- 유틸리티 (`hasPsmux`, `psmuxExec`, `psmuxSessionExists`)

### 1.4 CLI 서비스 역할 (현재)

```
hub/team/cli/
  ├── commands/
  │   └── start/
  │       ├── index.mjs           → 모드 분기 + Hub 시작 + 상태 저장
  │       ├── start-headless.mjs  → headless 모드 진입점
  │       ├── start-in-process.mjs→ native 모드 진입점
  │       ├── start-mux.mjs       → tmux 모드 진입점
  │       └── start-wt.mjs        → WT 모드 진입점
  └── services/
      ├── native-control.mjs      → native supervisor CLI 빌드 + HTTP 제어
      ├── runtime-mode.mjs        → 모드 감지/정규화
      ├── state-store.mjs         → 팀 상태 저장/조회
      ├── hub-client.mjs          → Hub 데몬 통신
      └── task-model.mjs          → 태스크 모델 빌드
```

### 1.5 OMC Native Team과의 관계

OMC(oh-my-claudecode) team skill은 **의미론적 오케스트레이션** 계층으로 기능한다:
- 태스크 분해, 에이전트 배정, verify/fix 루프
- 의미론적 재배정 (예: 워커가 실패하면 다른 에이전트에 재배정)
- 팀 간 메시지 라우팅, 플랜 승인

반면 triflux headless는 **인프라 실행** 계층으로 기능한다:
- CLI 프로세스 dispatch, psmux pane 관리
- 인프라 에러 복구 (쿼타 초과, CLI crash, 타임아웃)
- 출력 캡처, 완료 감지

현재 이 두 관심사가 명확히 분리되어 있지 않아, 인프라 장애 시 의미론적 판단이 불가능하고, 의미론적 재배정 시 인프라 제약을 인식하지 못하는 문제가 있다.

### 1.6 현재 아키텍처의 문제점

1. **관심사 혼합**: headless.mjs가 "어떤 CLI를 실행할지(의미론)"와 "psmux를 어떻게 제어할지(인프라)"를 동시에 담당
2. **모드별 코드 중복**: `start-headless.mjs`와 `start-in-process.mjs`가 assignment 빌드, 결과 수집, handoff 처리를 각각 구현
3. **WT 로직 침투**: headless.mjs 안에 `ensureWtProfile()`, `autoAttachTerminal()`, `attachDashboardTab()` 등 WT 전용 로직이 포함
4. **테스트 어려움**: 의미론 테스트를 위해 psmux가 설치되어야 하고, 인프라 테스트를 위해 CLI가 있어야 함
5. **확장 제약**: 새 터미널 백엔드(예: SSH 원격, Docker exec) 추가 시 headless.mjs 전체를 수정해야 함
6. **복구 책임 모호**: 인프라 에러(쿼타, CLI 크래시)와 의미론 에러(잘못된 결과, 불완전 작업)의 복구 주체가 불분명

---

## 2. 제안 2계층 구조

### 2.1 설계 원칙

```
Layer 1: Native Team (의미론 계층)
  "무엇을 실행할지, 어떤 순서로, 결과를 어떻게 조합할지"
  우월 영역: 의미론적 재배정, verify/fix 루프, 태스크 분해

Layer 2: triflux headless (인프라 계층)
  "명령을 어디서, 어떻게 실행하고, 출력을 어떻게 캡처할지"
  우월 영역: 인프라 에러 복구, 쿼타 관리, CLI 재시작, pane 관리
```

**복구 책임 분리 원칙**:
- **인프라 에러** (쿼타 초과, CLI crash, 타임아웃, pane 사망) → Layer 2가 자체 복구 시도 후, 복구 불가 시 Layer 1에 `CompletionResult.sessionDead=true`로 에스컬레이션
- **의미론 에러** (잘못된 결과, 불완전 작업, 재배정 필요) → Layer 1이 handoff 분석 후 재dispatch 또는 다른 에이전트에 재배정

### 2.2 Layer 1 — Native Team (의미론)

팀 오케스트레이션의 **비즈니스 로직**을 담당한다. 터미널 백엔드에 대해 알지 못한다.

```
hub/team/orchestration/
  ├── assignment-builder.mjs   → CLI 해석, 프롬프트 빌드, MCP 프로필
  ├── dispatch-planner.mjs     → progressive/batch 전략 결정
  ├── result-collector.mjs     → handoff 파싱, git diff, 결과 조합
  ├── team-session.mjs         → 세션 라이프사이클 (create → run → collect → cleanup)
  └── agent-map.json           → 역할 → CLI 매핑 (기존 위치 유지)
```

**핵심 책임:**
- `resolveCliType()` — 에이전트 역할명 → CLI 타입 해석
- `buildHeadlessCommand()` — CLI별 명령 생성 (codex/gemini/claude 분기)
- `collectResults()` — handoff 파이프라인, git diff, 결과 어셈블리
- Assignment 빌드 — `--assign` 또는 `agents+subtasks` → 통합 assignment 배열
- 진행 이벤트 — `session_created`, `worker_added`, `dispatched`, `progress`, `completed`
- 세션 정책 — 타임아웃, idle 자동정리, AbortSignal

### 2.3 Layer 2 — triflux headless (인프라)

명령의 **물리적 실행과 출력 캡처**를 담당한다. 팀 의미론을 알지 못한다.

```
hub/team/runtime/
  ├── backend.mjs              → RuntimeBackend 인터페이스 정의
  ├── psmux-backend.mjs        → psmux 구현 (현재 headless 인프라 코드)
  ├── native-backend.mjs       → in-process 구현 (현재 native-supervisor)
  ├── wt-backend.mjs           → WT split-pane 구현
  └── theme.mjs                → 시각 테마 (psmux status bar, WT 프로필)
```

**핵심 책임:**
- 세션 생성/종료 — 물리적 터미널 세션 관리
- 명령 dispatch — 특정 pane/프로세스에 명령 전달
- 출력 캡처 — pane 캡처, 파일 기반, stdout 수집
- 완료 감지 — 폴링, exit code, 토큰 매칭
- 시각 표현 — 테마, 타이틀, 레이아웃

### 2.4 계층 관계도

```
┌─────────────────────────────────────────────────┐
│                    CLI Layer                     │
│  tfx multi "task" --teammate-mode headless       │
│  (hub/team/cli/commands/start/)                  │
└────────────────────┬────────────────────────────┘
                     │ 파라미터 전달
                     ▼
┌─────────────────────────────────────────────────┐
│           Layer 1: Native Team (의미론)          │
│                                                  │
│  assignment-builder ─→ dispatch-planner           │
│         │                     │                  │
│         ▼                     ▼                  │
│  team-session.run(assignments, backend)           │
│         │                     │                  │
│         ▼                     ▼                  │
│  result-collector ←── progress events            │
│                                                  │
│  인터페이스: RuntimeBackend                       │
└────────────────────┬────────────────────────────┘
                     │ RuntimeBackend 호출
                     ▼
┌─────────────────────────────────────────────────┐
│        Layer 2: triflux headless (인프라)         │
│                                                  │
│  ┌──────────────┐ ┌──────────────┐              │
│  │ psmux-backend│ │native-backend│  ...          │
│  │              │ │              │              │
│  │ psmux.mjs   │ │ supervisor   │              │
│  │ (저수준)     │ │ (직접 exec)  │              │
│  └──────────────┘ └──────────────┘              │
│                                                  │
│  theme.mjs (시각 테마, WT 프로필)                 │
└─────────────────────────────────────────────────┘
```

---

## 3. Layer 1 <-> Layer 2 인터페이스 정의

### 3.1 RuntimeBackend 인터페이스

```javascript
/**
 * Layer 2 런타임 백엔드 인터페이스
 * 모든 백엔드(psmux, native, wt)가 이 계약을 구현한다.
 */
interface RuntimeBackend {
  /** 백엔드 이름 */
  readonly name: string;  // "psmux" | "native" | "wt"

  /** 백엔드 사용 가능 여부 */
  available(): boolean;

  /** 세션 생성 */
  createSession(sessionName: string, opts: SessionOpts): SessionHandle;

  /** 명령 dispatch — 지정 슬롯에 명령을 전달하고 추적 토큰 반환 */
  dispatch(handle: SessionHandle, slotId: string, command: string): DispatchResult;

  /** 완료 대기 — 지정 슬롯의 명령 완료를 폴링 */
  waitForCompletion(handle: SessionHandle, slotId: string, token: string,
                    timeoutSec: number, opts?: WaitOpts): Promise<CompletionResult>;

  /** 출력 캡처 — 지정 슬롯의 현재 출력 */
  capture(handle: SessionHandle, slotId: string, lines?: number): string;

  /** 세션 종료 */
  destroy(handle: SessionHandle): void;

  /** 시각 표현 (선택) — WT attach, 테마 적용 등 */
  attachVisual?(handle: SessionHandle, opts: VisualOpts): boolean;
}
```

### 3.2 데이터 타입

```typescript
/** Layer 1 → Layer 2: 세션 생성 옵션 */
interface SessionOpts {
  slotCount: number;          // 필요한 실행 슬롯(pane) 수
  layout: "2x2" | "1xN" | "Nx1";
  progressive: boolean;       // 슬롯을 점진적으로 추가할지
}

/** Layer 2 → Layer 1: 세션 핸들 */
interface SessionHandle {
  sessionName: string;
  slots: SlotInfo[];          // 생성된 슬롯 목록
  alive(): boolean;
}

/** Layer 2 내부: 슬롯 정보 */
interface SlotInfo {
  slotId: string;             // "worker-1", "worker-2" 등
  backendId: string;          // psmux paneId, native PID 등
}

/** Layer 2 → Layer 1: dispatch 결과 */
interface DispatchResult {
  slotId: string;
  token: string;              // 완료 감지용 토큰
  logPath?: string;           // 캡처 로그 경로
}

/** Layer 2 → Layer 1: 완료 결과 */
interface CompletionResult {
  matched: boolean;           // 완료 토큰 매칭 여부
  exitCode: number | null;
  sessionDead: boolean;
}

/** Layer 1 → Layer 2: 시각 옵션 */
interface VisualOpts {
  autoAttach: boolean;
  dashboard: boolean;
  workerCount: number;
}
```

### 3.3 Layer 1 호출 흐름

```javascript
// team-session.mjs (Layer 1)
export async function runTeamSession(assignments, backend, opts) {
  // 1. 세션 생성 (Layer 2)
  const handle = backend.createSession(sessionName, {
    slotCount: assignments.length,
    layout: opts.layout,
    progressive: opts.progressive,
  });

  // 2. 시각 attach (Layer 2, 선택)
  if (opts.autoAttach && backend.attachVisual) {
    backend.attachVisual(handle, {
      autoAttach: true,
      dashboard: opts.dashboard,
      workerCount: assignments.length,
    });
  }

  // 3. 명령 빌드 + dispatch (Layer 1 빌드, Layer 2 실행)
  const dispatches = [];
  for (const assignment of assignments) {
    const command = buildHeadlessCommand(assignment.cli, assignment.prompt, ...);
    const result = backend.dispatch(handle, assignment.slotId, command);
    dispatches.push({ ...assignment, ...result });
  }

  // 4. 완료 대기 (Layer 2)
  const completions = await Promise.all(
    dispatches.map(d => backend.waitForCompletion(handle, d.slotId, d.token, opts.timeoutSec))
  );

  // 5. 결과 수집 (Layer 1)
  const results = collectResults(dispatches, completions, backend);

  // 6. 정리 (Layer 2)
  backend.destroy(handle);

  return { sessionName, results };
}
```

---

## 4. 마이그레이션 단계 (v9.x 로드맵)

### Phase 1: 인터페이스 추출 (v9.0)

**목표**: RuntimeBackend 인터페이스 정의 + psmux 백엔드 추출

1. `hub/team/runtime/backend.mjs` 생성 — 인터페이스 + 팩토리
2. headless.mjs에서 인프라 코드를 `hub/team/runtime/psmux-backend.mjs`로 이동:
   - `dispatchProgressive()`, `dispatchBatch()` → `PsmuxBackend.dispatch()`
   - `awaitAll()` → `PsmuxBackend.waitForCompletion()`
   - `applyTrifluxTheme()`, WT 관련 함수 → `PsmuxBackend.attachVisual()`
3. headless.mjs를 Layer 1 래퍼로 축소 — `runHeadless()`가 `PsmuxBackend`를 주입받음
4. 기존 API 시그니처 유지 (하위 호환)

**검증**: 기존 테스트 전부 통과, `tfx multi` 동작 동일

### Phase 2: 의미론 통합 (v9.1)

**목표**: headless + in-process의 공통 의미론을 Layer 1로 통합

1. `hub/team/orchestration/` 디렉토리 생성
2. `assignment-builder.mjs` — `resolveCliType()`, `buildHeadlessCommand()`, assignment 빌드 로직 통합
3. `result-collector.mjs` — `collectResults()`, handoff 처리 통합
4. `team-session.mjs` — `runTeamSession()` 구현 (백엔드 주입)
5. `start-headless.mjs`와 `start-in-process.mjs`가 `runTeamSession()`을 공유

**검증**: headless/in-process 모두 동일 결과, handoff 형식 통일

### Phase 3: 추가 백엔드 (v9.2)

**목표**: native-backend + wt-backend 구현

1. `hub/team/runtime/native-backend.mjs` — native-supervisor를 RuntimeBackend로 래핑
2. `hub/team/runtime/wt-backend.mjs` — WT split-pane을 RuntimeBackend로 래핑
3. `runtime-mode.mjs`가 백엔드 팩토리를 통해 적절한 RuntimeBackend를 반환
4. `start-*.mjs` 파일들을 단일 진입점으로 통합

**검증**: 4개 모드 모두 RuntimeBackend 경유, 모드 전환 테스트

### Phase 4: 정리 + 확장 (v9.3)

**목표**: 레거시 코드 제거, 원격 백엔드 준비

1. headless.mjs를 Layer 1 facade로 축소 (하위 호환 re-export만)
2. 미사용 start-*.mjs 개별 파일 제거
3. `RuntimeBackend` 문서화 + 써드파티 백엔드 가이드
4. SSH 원격 백엔드 프로토타입 (v10.x 준비)

---

## 5. 리스크 및 대안

### 5.1 리스크

| 리스크 | 영향 | 완화 |
|---|---|---|
| **API 호환 파괴** | start-headless.mjs 등 외부 참조가 깨짐 | Phase 1에서 기존 시그니처 유지, re-export facade |
| **성능 간접비** | 추상 계층이 psmux 호출에 오버헤드 추가 | 인터페이스가 동기 호출을 허용, 프록시 아닌 직접 위임 |
| **psmux 전용 최적화 손실** | progressive split의 300ms 딜레이 같은 psmux 특수 로직 | 백엔드별 opts 확장 허용 (SessionOpts.backendHints) |
| **테스트 리그레션** | 리팩토링 중 기존 동작 변경 | Phase별 기존 테스트 통과 필수, 인터페이스 계약 테스트 추가 |
| **마이그레이션 중단** | Phase 2 이후 우선순위 변경으로 중간 상태 고착 | Phase 1만으로도 가치 있도록 설계 (인프라 분리 자체가 이득) |

### 5.2 대안 검토

**대안 A: 단순 파일 분리 (headless를 2개 파일로)**

headless.mjs를 `headless-orchestration.mjs` + `headless-runtime.mjs`로 분리만 하고 인터페이스는 도입하지 않는다.

- 장점: 작업량 최소, 즉시 적용 가능
- 단점: in-process/wt와의 공통 추상이 없어 코드 중복 유지

**대안 B: 이벤트 기반 아키텍처**

Layer 1이 이벤트를 emit하고 Layer 2가 이벤트를 subscribe하는 EventEmitter 기반 설계.

- 장점: 느슨한 결합, 플러그인 확장 용이
- 단점: 디버깅 어려움, 현재 동기 호출 패턴과 충돌, 오버엔지니어링

**대안 C: 설정 기반 (선언적 파이프라인)**

JSON/YAML로 팀 세션을 선언하고, 런타임이 이를 해석하여 실행.

- 장점: 선언적, 재현 가능
- 단점: 현재 코드베이스와 거리가 멀어 마이그레이션 비용 과다

### 5.3 권장

**제안 구조(인터페이스 기반 2계층)를 권장한다.**

대안 A는 즉시 적용 가능하지만 장기적 확장성이 없다. 대안 B/C는 현재 코드베이스 규모에 비해 과도하다. 제안 구조는 Phase 1만으로도 headless.mjs의 관심사 분리 효과를 얻으며, Phase 2~4는 점진적으로 진행할 수 있다.

---

## 부록: 현재 코드 의존성 그래프

```
start/index.mjs
  ├── start-headless.mjs
  │     └── headless.mjs
  │           ├── psmux.mjs (인프라)
  │           ├── handoff.mjs (의미론)
  │           └── agent-map.json (의미론)
  ├── start-in-process.mjs
  │     └── native-control.mjs
  │           └── orchestrator.mjs (의미론)
  ├── start-mux.mjs
  │     └── (tmux 직접 호출)
  └── start-wt.mjs
        └── session.mjs (WT 감지)
```

> 2계층 분리 후 목표 의존성:

```
start/index.mjs
  └── team-session.mjs (Layer 1 통합)
        ├── assignment-builder.mjs (의미론)
        ├── result-collector.mjs (의미론)
        ├── handoff.mjs (의미론)
        └── RuntimeBackend (Layer 2 인터페이스)
              ├── psmux-backend.mjs → psmux.mjs
              ├── native-backend.mjs → native-supervisor.mjs
              └── wt-backend.mjs → WT CLI
```
