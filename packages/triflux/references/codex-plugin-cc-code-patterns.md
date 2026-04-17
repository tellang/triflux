# codex-plugin-cc 코드 패턴 — triflux에서 배울 점

> 소스: github.com/openai/codex-plugin-cc v1.0.3 전체 코드 리딩 (2026-04-17)
> 파일 50개, 스크립트 ~3,500줄 완독

---

## 1. App Server Protocol — JSON-RPC over stdio/Unix socket

triflux의 Hub(ndjson over named-pipe)와 유사하지만 더 정교한 부분이 있다.

### 핵심: Broker 패턴 (공유 런타임)

```js
// app-server.mjs — 두 가지 전송 모드
class SpawnedCodexAppServerClient extends AppServerClientBase {
  // 직접 모드: codex app-server를 spawn
  async initialize() {
    this.proc = spawn("codex", ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });
    // JSON-RPC initialize handshake
    await this.request("initialize", { clientInfo, capabilities });
    this.notify("initialized", {});
  }
}

class BrokerCodexAppServerClient extends AppServerClientBase {
  // 브로커 모드: Unix socket으로 공유 인스턴스에 연결
  async initialize() {
    this.socket = net.createConnection({ path: target.path });
    await this.request("initialize", { clientInfo, capabilities });
  }
}

// 팩토리: 브로커 → 직접 자동 폴백
static async connect(cwd, options = {}) {
  let brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
  if (!brokerEndpoint) {
    const session = await ensureBrokerSession(cwd);
    brokerEndpoint = session?.endpoint ?? null;
  }
  const client = brokerEndpoint
    ? new BrokerCodexAppServerClient(cwd, { brokerEndpoint })
    : new SpawnedCodexAppServerClient(cwd);
  await client.initialize();
  return client;
}
```

**배울 점**: triflux Hub도 named-pipe 기반이지만, "broker busy → direct fallback" 패턴이 없다.
Hub가 바쁘면 대기하는데, codex-plugin-cc는 자동으로 직접 연결로 폴백한다.

```js
// codex.mjs — withAppServer: broker busy 시 직접 모드 폴백
async function withAppServer(cwd, fn) {
  try {
    client = await CodexAppServerClient.connect(cwd);
    return await fn(client);
  } catch (error) {
    const shouldRetryDirect =
      (client?.transport === "broker" && error?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      (error?.code === "ENOENT" || error?.code === "ECONNREFUSED");
    if (shouldRetryDirect) {
      const directClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
      return await fn(directClient);
    }
    throw error;
  }
}
```

---

## 2. Turn Capture State Machine — 가장 인상적인 코드

triflux headless는 "프로세스 종료 → 파일 읽기"인데, codex-plugin-cc는 실시간 스트리밍 상태 머신이다.

```js
// codex.mjs — 턴 캡처 상태
function createTurnCaptureState(threadId, options = {}) {
  return {
    threadId,
    rootThreadId: threadId,
    threadIds: new Set([threadId]),         // 메인 + 서브에이전트 스레드
    threadTurnIds: new Map(),               // 스레드별 턴 ID 추적
    threadLabels: new Map(),                // 서브에이전트 이름
    turnId: null,
    bufferedNotifications: [],              // 턴 ID 확정 전 버퍼링
    finalAnswerSeen: false,
    pendingCollaborations: new Set(),       // 진행중인 collab tool call
    activeSubagentTurns: new Set(),         // 활성 서브에이전트 턴
    completionTimer: null,
    lastAgentMessage: "",
    reviewText: "",
    reasoningSummary: [],
    fileChanges: [],
    commandExecutions: [],
    onProgress: options.onProgress ?? null
  };
}
```

### 스마트 완료 감지 — 서브에이전트 drain 대기

```js
// 메인 스레드 final_answer 후 서브에이전트가 아직 돌고 있으면 250ms 대기
function scheduleInferredCompletion(state) {
  if (state.completed || !state.finalAnswerSeen) return;
  if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) return;

  state.completionTimer = setTimeout(() => {
    if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) return;
    completeTurn(state, null, { inferred: true });
  }, 250);
  state.completionTimer.unref?.();
}
```

**배울 점**: triflux headless 워커가 서브에이전트를 사용할 때 "언제 진짜 끝났는지" 판단하는 문제.
현재는 프로세스 종료에 의존하지만, 이 패턴으로 실시간 진행 상태 추적이 가능하다.

### 알림 라우팅 — 멀티스레드 처리

```js
// 알림이 현재 턴에 속하는지 판별
function belongsToTurn(state, message) {
  const messageThreadId = extractThreadId(message);
  if (!messageThreadId || !state.threadIds.has(messageThreadId)) return false;
  const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
  const messageTurnId = extractTurnId(message);
  return trackedTurnId === null || messageTurnId === null || messageTurnId === trackedTurnId;
}
```

---

## 3. Stop Review Gate — Claude Code "Stop" 훅

이건 triflux에 없는 기능. Claude Code가 멈추기 전에 Codex가 자동 리뷰하여 블로킹 가능.

```js
// hooks.json — Stop 이벤트 (SessionEnd가 아님!)
{
  "Stop": [{
    "hooks": [{
      "type": "command",
      "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/stop-review-gate-hook.mjs\"",
      "timeout": 900  // 15분
    }]
  }]
}
```

```js
// stop-review-gate-hook.mjs — 블로킹 로직
function main() {
  const config = getConfig(workspaceRoot);
  if (!config.stopReviewGate) return;  // 옵트인

  const review = runStopReview(cwd, input);
  if (!review.ok) {
    // Claude Code에게 "멈추지 마" 신호
    emitDecision({
      decision: "block",
      reason: review.reason
    });
  }
}
```

```js
// 리뷰 결과 파싱 — ALLOW/BLOCK 프로토콜
function parseStopReviewOutput(rawOutput) {
  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) return { ok: true, reason: null };
  if (firstLine.startsWith("BLOCK:")) {
    return { ok: false, reason: firstLine.slice("BLOCK:".length).trim() };
  }
  return { ok: false, reason: "Unexpected answer" };
}
```

**배울 점**: triflux의 cross-review-tracker가 커밋 전 검증을 하는데, Stop 훅으로 세션 종료 전
자동 리뷰를 강제하면 "검증 안 하고 끝내는" 패턴을 원천 차단할 수 있다.

---

## 4. Session Lifecycle — CLAUDE_ENV_FILE 패턴

```js
// session-lifecycle-hook.mjs — 세션 시작 시 환경변수 주입
function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE) return;
  fs.appendFileSync(
    process.env.CLAUDE_ENV_FILE,
    `export ${name}=${shellEscape(value)}\n`,
    "utf8"
  );
}

function handleSessionStart(input) {
  appendEnvVar("CODEX_COMPANION_SESSION_ID", input.session_id);
  appendEnvVar("CLAUDE_PLUGIN_DATA", process.env.CLAUDE_PLUGIN_DATA);
}
```

```js
// 세션 종료 시 정리
async function handleSessionEnd(input) {
  // 1. 브로커 셧다운
  await sendBrokerShutdown(brokerEndpoint);
  // 2. 고아 잡 정리 (세션에 속한 running/queued 잡 kill)
  cleanupSessionJobs(cwd, sessionId);
  // 3. 브로커 프로세스 정리
  teardownBrokerSession({ endpoint, pidFile, logFile, killProcess: terminateProcessTree });
}
```

**배울 점**: `CLAUDE_ENV_FILE`로 훅에서 환경변수를 주입하는 패턴. triflux SessionStart 훅에서도
사용 가능. 현재는 stdout에 추가 컨텍스트를 출력하는데, 환경변수가 더 persistent하다.

---

## 5. Background Job System — Detached Worker

```js
// codex-companion.mjs — 백그라운드 태스크 워커 spawn
function spawnDetachedTaskWorker(cwd, jobId) {
  const child = spawn(
    process.execPath,
    [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }
  );
  child.unref();
  return child;
}

// 잡 enqueue → detached worker가 실행
function enqueueBackgroundTask(cwd, job, request) {
  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    pid: child.pid ?? null,
    request  // 전체 요청을 직렬화하여 저장
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);
}
```

**배울 점**: triflux는 psmux 세션으로 백그라운드를 관리하는데, codex-plugin-cc는 자기 자신을
detached worker로 재실행한다. 더 가볍고 psmux 의존성이 없다. 요청을 JSON으로 직렬화하여
job 파일에 저장하고, worker가 읽어서 실행하는 패턴도 깔끔하다.

---

## 6. Process Tree Kill — 크로스 플랫폼

```js
// process.mjs — Windows와 Unix 양쪽 처리
export function terminateProcessTree(pid) {
  if (process.platform === "win32") {
    // taskkill /T /F로 프로세스 트리 전체 kill
    const result = runCommand("taskkill", ["/PID", String(pid), "/T", "/F"]);
    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill" };
    }
    // taskkill 없으면 process.kill fallback
    if (result.error?.code === "ENOENT") {
      process.kill(pid);
      return { attempted: true, delivered: true, method: "kill" };
    }
  }

  // Unix: 프로세스 그룹 kill (-pid)
  try {
    process.kill(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      // 그룹 kill 실패 → 단일 프로세스 kill
      process.kill(pid, "SIGTERM");
    }
  }
}
```

**배울 점**: triflux의 `terminateChild`(worker-utils.mjs)는 단일 프로세스 kill만 한다.
프로세스 트리 kill이 없어서 Windows에서 자식 프로세스가 고아로 남을 수 있다.

---

## 7. Command .md 프론트매터 — 도구 제한

```yaml
# review.md
---
description: Run a Codex code review against local git state
argument-hint: '[--wait|--background] [--base <ref>]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---
```

핵심 필드:
- `disable-model-invocation: true` — LLM이 자체 판단으로 도구를 호출하지 못하게 차단
- `allowed-tools` — 화이트리스트 방식. `Bash(node:*)` = node 명령만 허용
- `argument-hint` — 자동완성 힌트
- `context: fork` — rescue.md에서 사용. 서브에이전트 컨텍스트 분리

**배울 점**: triflux SKILL.md에는 이런 도구 제한이 없다. allowed-tools 패턴을 도입하면
스킬이 의도하지 않은 도구를 호출하는 문제를 방지할 수 있다.

---

## 8. Agent .md — 서브에이전트 정의

```yaml
# codex-rescue.md
---
name: codex-rescue
description: Proactively use when Claude Code is stuck
model: sonnet
tools: Bash
skills:
  - codex-cli-runtime
  - gpt-5-4-prompting
---

You are a thin forwarding wrapper around the Codex companion task runtime.
Your only job is to forward the user's rescue request to the Codex companion script.
```

핵심 설계:
- `model: sonnet` — 비싼 Opus 대신 Sonnet으로 포워딩 (포워더니까 경량 모델)
- `skills: [codex-cli-runtime, gpt-5-4-prompting]` — 스킬 참조
- "proactively use when Claude Code is stuck" — 프로액티브 트리거
- "thin forwarding wrapper" — 에이전트가 직접 작업하지 않고 위임만

**배울 점**: triflux의 에이전트는 `Agent()` 호출로 인라인 정의하는데,
.md 파일로 선언적 정의하면 재사용성과 가독성이 올라간다.

---

## 9. GPT-5.4 프롬프팅 스킬 — XML 블록 구조

```md
# 프롬프트 조립 체크리스트
1. <task>에 정확한 작업과 범위 정의
2. 최소한의 output contract 선택
3. Codex가 계속 진행할지 멈출지 결정
4. verification, grounding, safety 태그는 필요한 경우만
5. 중복 지시 제거 후 전송
```

핵심 원칙:
- "Prompt Codex like an operator, not a collaborator"
- `<task>`, `<structured_output_contract>`, `<verification_loop>`, `<grounding_rules>` 등 XML 태그
- "Prefer better prompt contracts over raising reasoning effort" — effort 올리기 전에 프롬프트 개선
- 태스크 유형별 필수 블록 지정 (코딩→verification_loop, 리뷰→grounding_rules)

**배울 점**: triflux의 headless 프롬프트가 자연어로만 작성되는데,
XML 블록 구조를 도입하면 Codex/Gemini가 더 정확하게 응답한다.

---

## 10. Adversarial Review 프롬프트 — 공격자 관점

```xml
<operating_stance>
Default to skepticism.
Assume the change can fail in subtle, high-cost, or user-visible ways.
Do not give credit for good intent, partial fixes, or likely follow-up work.
</operating_stance>

<attack_surface>
- auth, permissions, tenant isolation, trust boundaries
- data loss, corruption, irreversible state changes
- rollback safety, retries, partial failure, idempotency gaps
- race conditions, ordering assumptions, stale state, re-entrancy
- version skew, schema drift, migration hazards
</attack_surface>

<finding_bar>
Report only material findings.
Do not include style feedback, naming feedback, or speculative concerns.
A finding must answer:
1. What can go wrong?
2. Why is this code path vulnerable?
3. What is the likely impact?
4. What concrete change would reduce the risk?
</finding_bar>

<grounding_rules>
Every finding must be defensible from the provided context.
Do not invent files, lines, code paths, or attack chains.
If a conclusion depends on an inference, state that explicitly.
</grounding_rules>
```

**배울 점**: triflux tfx-deep-review의 Codex 프롬프트가 "보안/성능 전문가로서 분석하라"
수준인데, 이 수준의 structured prompt가 훨씬 정확한 결과를 낸다.
특히 `<grounding_rules>`(근거 없는 발견 금지)와 `<finding_bar>`(material findings만)가 핵심.

---

## 11. Windows Shell 처리 차이

```js
// codex-plugin-cc 방식
shell: process.platform === "win32" ? (process.env.SHELL || true) : false

// triflux 방식 (buildSpawnSpec)
if (/\.(cmd|bat)$/i.test(resolved)) {
  const line = [resolved, ...args].map(quoteWindowsCmdArg).join(" ");
  return { command: "cmd.exe", args: ["/d", "/s", "/v:off", "/c", line], shell: false };
}
```

codex-plugin-cc는 `shell: true`로 OS에 위임, triflux는 `shell: false`로 직접 제어.
triflux 방식이 더 안전하다 (CVE-2024-27980 대응). codex-plugin-cc도 v1.0.1-v1.0.3에서
Windows 이슈를 반복 수정한 걸 보면, `shell: true` 접근의 한계가 보인다.

---

## 12. 플러그인 디렉토리 구조 (Claude Code 표준)

```
.claude-plugin/
  marketplace.json    # 마켓플레이스 메타 (name, owner, plugins[])
plugins/{name}/
  .claude-plugin/
    plugin.json       # 플러그인 메타 (name, version, description)
  agents/             # 서브에이전트 .md
  commands/           # 슬래시 커맨드 .md (프론트매터로 도구 제한)
  hooks/
    hooks.json        # 라이프사이클 훅 (SessionStart, SessionEnd, Stop)
  prompts/            # 프롬프트 템플릿 .md
  schemas/            # JSON Schema (출력 구조 강제)
  scripts/            # 실행 스크립트 .mjs
    lib/              # 내부 라이브러리
  skills/             # 스킬 디렉토리 (SKILL.md + references/)
```

---

## triflux 적용 우선순위

| # | 패턴 | 난이도 | 영향도 | 적용 대상 |
|---|------|--------|--------|-----------|
| 1 | Adversarial review 프롬프트 구조 | 낮음 | 높음 | tfx-deep-review Codex 프롬프트 |
| 2 | XML 블록 프롬프팅 | 낮음 | 높음 | 모든 headless 프롬프트 |
| 3 | Stop review gate | 중간 | 높음 | 새 훅 추가 |
| 4 | Process tree kill | 낮음 | 중간 | worker-utils.mjs, safety-guard |
| 5 | CLAUDE_ENV_FILE 패턴 | 낮음 | 중간 | session-start 훅 |
| 6 | Broker busy → direct fallback | 중간 | 중간 | Hub 클라이언트 |
| 7 | Turn capture state machine | 높음 | 높음 | headless 결과 추적 시스템 |
| 8 | Command frontmatter (allowed-tools) | 중간 | 중간 | SKILL.md 표준 |
| 9 | Detached self-worker | 중간 | 낮음 | psmux 대안 |
| 10 | Declarative agent .md | 중간 | 낮음 | 에이전트 정의 표준화 |
