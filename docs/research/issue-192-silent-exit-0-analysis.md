# Issue #192 — release:prepare silent EXIT 0 회귀 분석

분석 시점: 2026-04-30, HEAD `5501c25`

본 문서는 reproduce 미확보 상태에서 진행된 **코드 분석 + 가설 갱신 + 재현 방법론** 설계물이다.
fix 시도는 포함하지 않는다 — `feedback_no_fix_without_root_cause.md` iron law 준수.

## 1. 컨텍스트

`npm run release:prepare -- --execute --version X --allow-dirty` 가 `[prepare] step=npm-test t=N(50~70)ms`
직후 silent exit 0 으로 종료, lint/pack/release-notes step log 미출력. timing 비결정 (12-24초).

진단 환경: Windows 11, Node 24.11.0, npm 11.6.1.

이전 fix 이력:
- F1 (commit `4f8076e`): test-lock.mjs spawn stdio split + close stdin → 부분 완화, 회귀 재발
- F2 (제안만): try/catch + unhandledRejection 핸들러 — handlers visibility만 확보, native kill은 못 막음
- **F3 (PR #221, commit `e9168d6`)**: prepare.mjs npm-test step 의 invocation 을 `npm test` 에서
  `process.execPath ["scripts/test-lock.mjs", "--test", ...]` 로 변경. cmd.exe shim → npm-cli.js → spawn 3 layers
  중 첫 2 layer 제거. 5 시나리오 reproduce 결과: silent EXIT 0 (24s) → EXIT 124 timeout (30s). silent kill
  사라짐. CI 3291 tests pass. **F3 는 trigger 약화 fix 이고 root cause 확정 아님**.

## 2. 가설 매트릭스 (K1-K4)

| 코드 | 가설 | 상태 | 메모 |
|------|------|------|------|
| K1 | npm test 자손이 부모 prepare.mjs PID 를 force kill — `killProcessTree`/`killProcessTreeSnapshot` protectedPids 누락 | **partial-falsified** | 호출처 매핑 결과 tests/는 100% mock(DI), 실제 비-테스트 caller 는 hub/conductor/psmux/bin 만. 테스트 중 kill path 부재 |
| K2 | Windows ConPTY race — npm wrapper context 에서 child 종료 시 stdio handle 변환 race 로 부모 abort | **unverified, F3 와 consistent** | F3 가 npm wrapper layer 1단 제거로 silent kill 사라진 사실과 부합 |
| K3 | Node 24 + Windows + execFileSync({shell:true}) + nested npm wrapper 알려진 bug | **unverified, F3 와 consistent** | K2 와 분리 어려움. native trace 없이 구별 불가 |
| K4 | Hub server `cleanupOrphanNodeProcesses` 5분 timer 가 prepare.mjs PID 청소 | **low probability** | 12-24s 윈도 vs 5min cycle mismatch. 타이밍 불일치. shutdown handler 도 동일 |

### K1 falsification 근거

`hub/lib/process-utils.mjs` 의 kill API 시그니처:

| API | `getProtectedPids({includeAncestorScan})` 기본값 | 실제 보호 범위 |
|------|------|---------------|
| `killProcessTree` | **false** (생략) | self.pid + self.ppid + hub.pid + caller-passed |
| `killProcessTreeSnapshot` | n/a (자기 protectedPids 만) | caller-passed only |
| `cleanupOrphanRuntimeProcesses({legacy:false})` | **false** | self.pid + self.ppid + hub.pid + caller-passed. **단 bun.exe/conhost.exe 만 kill 대상** — node.exe 미포함 |
| `cleanupOrphanRuntimeProcesses({legacy:true})` = `cleanupOrphanNodeProcesses` | **true** | self.pid + 조상 chain 전체 + hub.pid + caller-passed. node.exe kill 대상 |
| `cleanupShardProcesses` | **true** | 동일 + worktreePath/shardName commandLine match 필요 |

K1 시나리오 ("test 가 prepare.mjs PID 를 kill") 가 성립하려면:
1. test 코드가 실제 (mocked 가 아닌) `cleanupOrphanNodeProcesses` 또는 `killProcessTree(prepareMjsPid)` 호출
2. prepare.mjs 가 protectedSet 에 미포함

매핑 결과:
- `tests/unit/process-utils.test.mjs`: 호출하지만 100% mocked spawnSyncFn + killFn (실제 kill 없음)
- `tests/unit/conductor.test.mjs`: dependency injection 으로 procUtils.killProcessTree mock
- 다른 test 들: 직접 호출 안 함

→ **K1 narrow form (test code → real kill) 은 falsified**

K1 broad form ("어떤 actor 가 prepare.mjs PID 를 kill") 은 여전히 가능하지만 actor 가 test 가 아니다. 후보:
- **A. hub timer/shutdown** (K4) — 5min cycle mismatch
- **B. session-stale-cleanup hook** — SessionStart 훅, npm test 중 fire 안 함
- **C. 외부 도구** (Windows Defender, watchdog 등) — unverified
- **D. cmd.exe Job Object / ConPTY** — K2/K3 영역

### K2/K3 의 F3 fix 부합성

F3 는 prepare.mjs 에서 spawn 시 chain 을 5 layer → 4 layer 로 단축:

```
pre-F3:  shell → cmd.exe(npm) → node(npm-cli) → node(prepare.mjs) → cmd.exe(npm) → node(npm-cli) → node(test-lock) → node(--test) → tests
post-F3: shell → cmd.exe(npm) → node(npm-cli) → node(prepare.mjs) → node(test-lock) → node(--test) → tests
```

차이는 prepare.mjs 가 spawn 하는 child 의 직접 자식이 cmd.exe(npm) 이냐 node(test-lock) 이냐.
post-F3 에서 silent kill 이 사라진다는 사실은 trigger 가 prepare.mjs 직속 cmd.exe(npm) layer 와 관련됨을 시사.

K2 (ConPTY race) / K3 (Node 24 nested npm wrapper bug) 양쪽 모두 이 패턴과 부합. 구별하려면
native level event tracing 필요.

## 3. Reproduce 방법론

iron law: reproduce 미확보면 fix 금지. 본 세션은 reproduce 도구 setup 만 하고, 실제 실행은 별도 세션.

### 3.1 Pre-F3 commit checkout

```
git stash                             # working tree 보호
git log --oneline | grep -i 'F3\|npm-test bypass\|192'
git checkout 547a082                  # PR #220 머지 직후, F3 직전 (예시)
node --version                        # 24.11.0 확인
npm --version                         # 11.6.1 확인
```

### 3.2 자체 모니터 wrapper (Node, ETW 불필요)

별도 디렉토리에 `monitor-prepare.mjs` 작성 (commit 안 함, 일회용):

```javascript
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const startedAt = Date.now();
const snapshots = [];
const events = [];

// 1. prepare.mjs 를 npm wrapper 경유로 spawn
const child = spawn("npm", ["run", "release:prepare", "--", ...args], {
  shell: true,
  stdio: ["ignore", "pipe", "pipe"],
});
const childPid = child.pid;
events.push({ t: 0, event: "spawn", pid: childPid });
console.error(`[monitor] child PID=${childPid}`);

// 2. 200ms 마다 Win32_Process scan
const pollMs = 200;
const interval = setInterval(() => {
  const t = Date.now() - startedAt;
  let snapshot;
  try {
    const raw = execFileSync(
      "powershell",
      ["-NoProfile", "-Command",
       "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    snapshot = JSON.parse(raw);
  } catch (e) {
    snapshot = null;
  }
  snapshots.push({ t, snapshot });

  // 자식 PID 사라졌는지
  if (snapshot && !snapshot.find(p => p.ProcessId === childPid)) {
    events.push({ t, event: "child_disappeared", pid: childPid });
    // 다음 1~2 snapshot 까지 capture 후 종료
  }
}, pollMs);

// 3. stdout/stderr 캡처
let stdout = "", stderr = "";
child.stdout.on("data", d => { stdout += d; });
child.stderr.on("data", d => { stderr += d; });

child.on("exit", (code, signal) => {
  const t = Date.now() - startedAt;
  events.push({ t, event: "exit", code, signal });
  clearInterval(interval);

  const report = { args, childPid, events, snapshots, stdout, stderr };
  writeFileSync(`./monitor-${Date.now()}.json`, JSON.stringify(report, null, 2));
  console.error(`[monitor] exit code=${code} signal=${signal} t=${t}ms`);
  process.exit(code || 0);
});
```

실행:
```
node monitor-prepare.mjs --execute --version 10.18.0 --allow-dirty
```

### 3.3 분석 step

monitor-*.json 파일에서:

1. `events` 에서 `child_disappeared` 시점 t (예: t=14200ms)
2. 직전 snapshot (t=14000ms) → 살아있던 모든 process + parent chain
3. `child_disappeared` 시점 snapshot (t=14200ms) → 추가로 사라진 process (자식 트리 전체 포함)
4. 함께 사라진 cmd.exe / npm-cli node 패턴 확인 → K2/K3 vs K4 구별

### 3.4 추가 instrumentation (선택)

만약 자체 wrapper 로 부족하면:

A. `process-utils.mjs` 에 debug-only logger 패치:
```javascript
const DEBUG_KILL = process.env.TFX_DEBUG_KILL === "1";
function logKillAttempt(action, pid, reason) {
  if (!DEBUG_KILL) return;
  appendFileSync(join(homedir(), ".claude/logs/tfx-kill.log"),
    `${new Date().toISOString()} ${action} pid=${pid} caller=${process.pid} reason=${reason}\n`);
}
// killProcessTree, cleanupOrphan*, killProcessTreeSnapshot 시작점에 호출
```
패치 후 `TFX_DEBUG_KILL=1 npm run release:prepare -- ...` 실행. 로그에 prepare.mjs PID 가 나오면 어느 함수가
호출했는지 확인.

B. Windows Performance Recorder (xperf):
```
xperf -on PROC_THREAD+LOADER -minbuffers 32 -maxbuffers 256 -BufferSize 1024
node monitor-prepare.mjs --execute --version 10.18.0 --allow-dirty
xperf -d kill-trace.etl
xperf -i kill-trace.etl -o kill-trace.csv
```
Process Terminate 이벤트의 ImageFileName + ParentPID 확인. 가장 강력한 native trace.

## 4. 가설별 reproduce 시 기대 신호

| 가설 | monitor.json 에서 보일 패턴 |
|------|--------------------------|
| K1 broad (외부 actor) | prepare.mjs PID 만 사라지고 직속 자식 일부는 남음 (자식 자체는 다른 부모로 reparent 또는 종료) |
| K2 ConPTY race | prepare.mjs + 그 직속 cmd.exe(npm) 가 동시에 사라짐. node(npm-cli) 도 동반 |
| K3 Node 24 bug | prepare.mjs 자체가 갑자기 종료 + uncaughtException 핸들러 미발화 (이미 확인됨). monitor 가 sec-by-sec snapshot 으로 child 종료 직전 stack/handle 상태 추정 가능 |
| K4 hub timer | hub.log 에 `hub.orphan_cleanup` 로그 + `prepare.mjs` 가 killedProcesses 에 포함. (가능성 매우 낮음) |

## 5. 다음 세션 액션 시퀀스

1. **Pre-F3 commit checkout** + working tree 백업
2. **Monitor wrapper 작성** (위 코드 또는 변형) — repo commit 안 함
3. **3-5 회 reproduce** — silent EXIT 0 trigger 확인 (timing 비결정이므로 N>1)
4. **monitor.json 분석** — 가설별 신호 매칭
5. **K2/K3 구별 필요 시 xperf** 사용
6. **확정된 root cause** 에 기반한 fix PR (별도 PR. F3 는 유지하고 K1+ 보강)
7. **회귀 가드** 추가:
   - 기존 mock 가드 유지
   - 가능하면 integration 가드 (실제 prepare.mjs 가 npm wrapper context 에서 모든 step 완주하는지) 추가
8. **메모리 업데이트** — `feedback_release_prepare_silent_npm_test_return.md` 에 root cause 확정 기록 + K2/K3 결과

## 6. 회귀 가드 보강 후보 (root cause 확정 후)

본 세션은 가드 추가 없이 분석만 수행. 다음 세션 reproduce 후 가드 후보:

| 가드 | 위치 | 검출 대상 |
|------|------|----------|
| Step sequence 가드 (기존) | `tests/regression/release-prepare-completes-all-steps.test.mjs` | prepare.mjs for-loop 단락 회귀 |
| Subprocess 분리 invariant | 신규 `tests/regression/release-prepare-spawn-isolation.test.mjs` | npm-test step 의 spawn 옵션 (`shell: false`, `detached`?) drift |
| Integration 완주 가드 | 신규 `tests/integration/release-prepare-full-run.test.mjs` | 실제 npm wrapper context 에서 prepare.mjs 가 lint/pack/release-notes 까지 도달 (long-running, optional CI) |
| Visible exit code | prepare.mjs main + 신규 가드 | silent EXIT 0 → 명시적 EXIT 1 (root cause 확정 후 F2 도 적용 가능) |

## 7. 본 세션 산출물

- 본 분석 문서 (`docs/research/issue-192-silent-exit-0-analysis.md`)
- 코드 변경 없음 (iron law 준수)
- 다음 세션 entry surface: § 5 Action sequence

## 8. 참고

- Memory: `feedback_release_prepare_silent_npm_test_return.md`
- Memory: `feedback_no_fix_without_root_cause.md`
- Memory: `feedback_codex_exec_recovery_guard.md` (4-fixture 가드 패턴, 본 분석에 직접 적용 안 됨)
- PR #220: 회귀 가드 step sequence
- PR #221: F3 fix npm wrapper bypass
- 코드: `scripts/release/prepare.mjs:64-94` (npm-test step 정의)
- 코드: `hub/lib/process-utils.mjs:407-434` (`getProtectedPids` 시그니처)
- 코드: `hub/lib/process-utils.mjs:589-655` (`killProcessTree`)
- 코드: `hub/server.mjs:1956-1999` (5min orphan cleanup timer)
