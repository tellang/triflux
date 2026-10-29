import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ADAPTERS, waitForTmuxIdle } from "../../bin/tfx-live.mjs";
import { main as runBridgeMain, readTailSafe } from "../../hub/bridge.mjs";
import {
  executionFlagsForCli,
  isJevEnabled,
  judgeBusyAction,
  judgeComposerState,
  judgeHandoffQuality,
  judgeInboxPriority,
  judgeInstructionAck,
  judgeMcpSelection,
  judgePeerConvergence,
  judgeReviewGate,
  judgeSameFailureCause,
  judgeTargetSession,
  judgeTaskAssignment,
  judgeTaskRouting,
  judgeWorkerHealth,
  queryJev,
  queryJevBatch,
  summarizeJevStats,
} from "../../hub/lib/jev-addon.mjs";
import {
  evaluateReviewGateWithJev,
  processHandoffWithJev,
} from "../../hub/team/handoff.mjs";
import { createHeadlessIntervention } from "../../hub/team/headless.mjs";
import { assignTasksWithJev } from "../../hub/team/orchestrator.mjs";
import { submitPromptWithJevVerification } from "../../hub/team/pane.mjs";
import { createResultsIndex } from "../../hub/team/results-index.mjs";
import { createRetryStateMachine } from "../../hub/team/retry-state-machine.mjs";
import { buildMcpPolicyWithJev } from "../../scripts/lib/mcp-filter.mjs";

describe("jev-addon: opt-in 및 fail-open 검증", () => {
  it("API 키와 CLI가 모두 없으면 isJevEnabled가 false이고 모든 판단 함수가 즉시 null을 반환한다", async () => {
    const emptyEnv = { PATH: "" };
    assert.equal(isJevEnabled(emptyEnv), false);

    assert.equal(
      await judgeSameFailureCause("err A", "err B", { env: emptyEnv }),
      null,
    );
    assert.equal(
      await judgeHandoffQuality(
        { rawText: "done", handoff: { status: "ok", summary: "ok" } },
        { env: emptyEnv },
      ),
      null,
    );
    assert.equal(
      await judgePeerConvergence(
        {
          seed: "topic",
          previousResponse: "plan A",
          currentResponse: "plan A agreed",
          hopIndex: 2,
          participantsCount: 2,
        },
        { env: emptyEnv },
      ),
      null,
    );
    assert.equal(
      await judgeBusyAction(
        { prompt: "잠깐 멈추고 방향 바꿔" },
        { env: emptyEnv },
      ),
      null,
    );
    assert.equal(
      await judgeWorkerHealth(
        { stdoutTail: "Proceed? [y/N]", elapsedSec: 90 },
        { env: emptyEnv },
      ),
      null,
    );
  });

  it("TFX_JEV=0 이면 키가 있어도 비활성화된다", () => {
    assert.equal(
      isJevEnabled({ TFX_JEV: "0", JEV_API_KEY: "test-key" }),
      false,
    );
    assert.equal(isJevEnabled({ TFX_JEV: "1", JEV_API_KEY: "test-key" }), true);
  });

  it("인자 없는 기본 호출에서 process.env의 JEV_API_KEY를 정상 감지한다", () => {
    const prevKey = process.env.JEV_API_KEY;
    const prevFlag = process.env.TFX_JEV;
    try {
      process.env.JEV_API_KEY = "sk-env-default-test";
      delete process.env.TFX_JEV;
      assert.equal(isJevEnabled(), true);
      assert.equal(isJevEnabled({ minConfidence: 0.8 }), true);
    } finally {
      if (prevKey === undefined) delete process.env.JEV_API_KEY;
      else process.env.JEV_API_KEY = prevKey;
      if (prevFlag === undefined) delete process.env.TFX_JEV;
      else process.env.TFX_JEV = prevFlag;
    }
  });

  it("신뢰도가 누락, 비수치, 범위 밖이거나 임계값보다 낮거나 오류가 나면 null로 폴백한다 (fail-open)", async () => {
    const resLow = await judgeSameFailureCause("err A", "err B", {
      minConfidence: 0.7,
      client: async () => ({ answer: true, confidence: 0.4 }),
    });
    assert.equal(resLow, null);

    for (const badConf of [
      undefined,
      null,
      "",
      "1",
      "invalid",
      true,
      false,
      [1],
      [],
      {},
      -0.1,
      1.2,
      NaN,
      Infinity,
    ]) {
      const resBad = await judgeSameFailureCause("err A", "err B", {
        client: async () => ({ answer: true, confidence: badConf }),
      });
      assert.equal(resBad, null);
    }

    const resBadHttp = await judgeWorkerHealth(
      { stdoutTail: "worker output" },
      {
        env: { JEV_API_KEY: "dummy" },
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({ choice: "looping_error", confidence: [1] }),
        }),
      },
    );
    assert.equal(resBadHttp, null);

    const resErr = await judgeSameFailureCause("err A", "err B", {
      client: async () => {
        throw new Error("network timeout");
      },
    });
    assert.equal(resErr, null);
  });

  it("HTTP fetchImpl과 CLI execFileImpl 경로를 모두 지원한다", async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ choice: "steer", confidence: 0.91 }),
    });
    const httpRes = await queryJev(
      { kind: "choice", query: "끼어들지 판단", options: ["steer", "wait"] },
      {
        env: { JEV_API_KEY: "sk-test" },
        fetchImpl: mockFetch,
      },
    );
    assert.deepEqual(httpRes, {
      choice: "steer",
      confidence: 0.91,
    });

    const mockExecFile = async () => ({
      stdout: JSON.stringify({ answer: true, confidence: 0.88 }),
      stderr: "",
    });
    const cliRes = await queryJev(
      { kind: "noul", query: "같은 원인인지 판단" },
      {
        env: { TFX_JEV: "1", TFX_JEV_CLI: "/usr/local/bin/jev" },
        execFileImpl: mockExecFile,
      },
    );
    assert.deepEqual(cliRes, {
      value: true,
      confidence: 0.88,
    });

    const systemOneNoul = await queryJev(
      { kind: "noul", query: "동일 원인 여부", context: "err1 vs err2" },
      {
        env: { TYPESAFE_API_KEY: "sk-typesafe" },
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({
            model: "typesafe/jev-1.13",
            answers: { q: { type: "noul", noul: 0.96 } },
          }),
        }),
      },
    );
    assert.deepEqual(systemOneNoul, { value: true, confidence: 0.96 });

    const systemOneChoice = await queryJev(
      {
        kind: "choice",
        query: "끼어들기 판단",
        options: ["steer", "wait"],
        context: "busy thread",
      },
      {
        env: { TYPESAFE_API_KEY: "sk-typesafe" },
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({
            model: "jev-latest",
            answers: {
              q: {
                type: "choice",
                choice: "steer",
                probabilities: { steer: 0.92, wait: 0.08 },
                confidence: 0.89,
              },
            },
          }),
        }),
      },
    );
    assert.deepEqual(systemOneChoice, { choice: "steer", confidence: 0.89 });
  });
});

describe("jev-addon: 5대 훅 도메인 동작 검증", () => {
  it("Hook 1: retry-state-machine reportVerifyFailAsync가 다른 문구의 같은 원인을 stuckCounter에 누적한다", async () => {
    const sm = createRetryStateMachine({ maxIterations: 5 });
    sm.startIteration();
    await sm.reportVerifyFailAsync(
      "TypeError: Cannot read properties of undefined (reading 'id')",
      {
        client: async () => ({ answer: true, confidence: 0.95 }),
      },
    );
    assert.equal(sm.serialize().stuckCounter, 1);

    sm.startIteration();
    await sm.reportVerifyFailAsync(
      "UnhandledRejection: user.id is undefined at auth.mjs:42",
      {
        client: async () => ({ answer: true, confidence: 0.92 }),
      },
    );
    assert.equal(sm.serialize().stuckCounter, 2);
  });

  it("Hook 2: processHandoffWithJev가 부실한 완료 보고를 needs_read 또는 retry로 보정한다", async () => {
    const rawText = [
      "수정을 마쳤습니다.",
      "--- HANDOFF ---",
      "status: ok",
      "lead_action: accept",
      "verdict: 모든 테스트 통과 및 구현 완료",
      "files_changed:",
      "  - hub/index.mjs",
    ].join("\n");

    const needsRead = await processHandoffWithJev(
      rawText,
      { exitCode: 0, gitDiffFiles: ["hub/index.mjs"] },
      {
        client: async () => ({ choice: "needs_read", confidence: 0.89 }),
      },
    );
    assert.equal(needsRead.handoff.lead_action, "needs_read");
    assert.equal(needsRead.handoff._jev.lead_action, "needs_read");

    const retryVerdict = await processHandoffWithJev(
      rawText,
      { exitCode: 0, gitDiffFiles: ["hub/index.mjs"] },
      {
        client: async () => ({ choice: "retry", confidence: 0.93 }),
      },
    );
    assert.equal(retryVerdict.handoff.status, "partial");
    assert.equal(retryVerdict.handoff.lead_action, "retry");

    const emptyFilesText = [
      "조사만 마쳤습니다.",
      "--- HANDOFF ---",
      "status: ok",
      "lead_action: accept",
      "verdict: 조사 완료",
      "files_changed: none",
    ].join("\n");
    const blockedAccept = await processHandoffWithJev(
      emptyFilesText,
      { exitCode: 0, gitDiffFiles: [] },
      {
        client: async () => ({ choice: "accept", confidence: 0.98 }),
      },
    );
    assert.equal(blockedAccept.handoff.lead_action, "needs_read");

    const blockedEmptyDiff = await processHandoffWithJev(
      rawText,
      { exitCode: 0, gitDiffFiles: [] },
      {
        client: async () => ({ choice: "accept", confidence: 0.98 }),
      },
    );
    assert.equal(blockedEmptyDiff.handoff.lead_action, "needs_read");
  });

  it("Hook 3: judgePeerConvergence가 합의 수렴 여부를 판정한다", async () => {
    const res = await judgePeerConvergence(
      {
        seed: "API 캐시 전략",
        mode: "consensus",
        previousResponse:
          "Redis TTL 60초와 stale-while-revalidate 조합을 제안합니다.",
        currentResponse:
          "동의합니다. 추가 이견 없이 Redis TTL 60초 + SWR로 확정합시다.",
        hopIndex: 2,
        participantsCount: 2,
      },
      {
        client: async () => ({ output: true, confidence: 0.94 }),
      },
    );
    assert.equal(res?.converged, true);
    assert.equal(res?.confidence, 0.94);
  });

  it("Hook 4: judgeBusyAction이 긴급 방향 수정 프롬프트를 steer로 분류한다", async () => {
    const res = await judgeBusyAction(
      {
        prompt:
          "잠깐 멈추고 DB 스키마를 PostgreSQL 대신 SQLite로 바꿔서 작업해",
        threadSummary: "현재 PostgreSQL 마이그레이션 파일 작성 중",
      },
      {
        client: async () => ({ output: "steer", confidence: 0.91 }),
      },
    );
    assert.equal(res?.action, "steer");
  });

  it("Hook 5: judgeWorkerHealth가 대화형 프롬프트 대기를 waiting_input으로 판정하고 readTailSafe가 파일 끝 바이트만 읽는다", async () => {
    const res = await judgeWorkerHealth(
      {
        stdoutTail: "? Overwrite existing configuration file? (y/N)",
        stderrTail: "",
        elapsedSec: 120,
      },
      {
        client: async () => ({ choice: "waiting_input", confidence: 0.96 }),
      },
    );
    assert.equal(res?.status, "waiting_input");

    const dir = mkdtempSync(join(tmpdir(), "jev-tail-"));
    try {
      const logFile = join(dir, 'strange"name.log');
      writeFileSync(logFile, `${"A".repeat(5000)}TAIL_MARKER_END`, "utf8");
      const tail = readTailSafe(logFile, 64);
      assert.equal(tail.length, 64);
      assert.equal(tail.endsWith("TAIL_MARKER_END"), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("queryJevBatch가 다중 질의를 단일 /v1/systemone 요청으로 묶고 summarizeJevStats가 5대 훅 통계를 집계한다", async () => {
    const batchRes = await queryJevBatch(
      {
        state: "worker finished with exit 0",
        questions: {
          action: {
            kind: "choice",
            query: "Choose action",
            criteria: { accept: "ok", needs_read: "read" },
          },
          converged: {
            kind: "noul",
            query: "Did peers converge?",
          },
        },
      },
      {
        env: { JEV_API_KEY: "sk-batch" },
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({
            model: "jev-1.14.0",
            answers: {
              action: {
                type: "choice",
                choice: "needs_read",
                confidence: 0.95,
              },
              converged: {
                type: "noul",
                noul: 0.91,
              },
            },
          }),
        }),
      },
    );
    assert.deepEqual(batchRes, {
      action: { choice: "needs_read", confidence: 0.95 },
      converged: { value: true, confidence: 0.91 },
    });

    const dir = mkdtempSync(join(tmpdir(), "jev-stats-"));
    const statsFile = join(dir, "jev-stats.jsonl");
    try {
      await judgeSameFailureCause("err 1", "err 2", {
        statsFile,
        client: async () => ({ answer: true, confidence: 0.9 }),
      });
      await judgeBusyAction(
        { prompt: "잠깐 멈춰" },
        {
          statsFile,
          client: async () => ({ choice: "steer", confidence: 0.4 }),
        },
      );
      const summary = summarizeJevStats({ statsFile });
      assert.equal(summary.exists, true);
      assert.equal(summary.total, 2);
      assert.equal(summary.interventions, 1);
      assert.equal(summary.fallbacks, 1);
      assert.equal(summary.byHook.same_failure_cause.interventions, 1);
      assert.equal(summary.byHook.busy_action.fallbacks, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Hook 4 런타임 연동: waitForTmuxIdle이 --if-busy auto에서 steer를 interrupt로, agy의 wait를 queue로 전환한다", async () => {
    const tmuxCalls = [];
    let pollCount = 0;
    await waitForTmuxIdle(
      { cli: "claude", isBusy: (text) => text.includes("Working") },
      {
        session: "claude-test:0.0",
        pollIntervalMs: 5,
        busyTimeoutMs: 1000,
        ifBusy: "auto",
        prompt: "지금 작업 취소하고 롤백부터 해",
      },
      {
        captureVisible: async () => {
          pollCount += 1;
          return pollCount === 1 ? "Working..." : "Idle>";
        },
        runTmux: async (_remote, args) => {
          tmuxCalls.push(args);
        },
        sleep: async () => {},
        judgeBusyAction: async () => ({ action: "steer", confidence: 0.94 }),
      },
    );
    assert.equal(tmuxCalls.length, 1);
    assert.deepEqual(tmuxCalls[0], [
      "send-keys",
      "-t",
      "=claude-test:0.0",
      "Escape",
    ]);

    const agyElapsed = await waitForTmuxIdle(
      { cli: "agy", isBusy: () => true },
      {
        session: "agy-test:0.0",
        pollIntervalMs: 5,
        busyTimeoutMs: 1000,
        ifBusy: "auto",
        prompt: "다 끝나면 요약도 해줘",
      },
      {
        captureVisible: async () => "Thinking...",
        runTmux: async () => {},
        sleep: async () => {},
        judgeBusyAction: async () => ({ action: "wait", confidence: 0.91 }),
      },
    );
    assert.equal(typeof agyElapsed, "number");
  });

  it("Hook 5 런타임 연동: createHeadlessIntervention이 healthy_thinking이면 단계별 개입 없이 유예하고 waiting_input이면 맞춤 프롬프트를 주입한다", async () => {
    let ladderCalled = 0;
    const healthyHandler = createHeadlessIntervention(
      { paneId: "tfx:0.1", cli: "codex", resultFile: "/tmp/nonexistent.txt" },
      null,
      {
        capturePsmuxPane: () => "Running cargo test --workspace...",
        judgeWorkerHealth: async () => ({
          status: "healthy_thinking",
          confidence: 0.95,
        }),
        createInterventionLadder: () => {
          ladderCalled += 1;
          return { intervene: async () => ({ outcome: "terminated" }) };
        },
      },
    );
    const healthyResult = await healthyHandler({ inactiveMs: 180_000 });
    assert.equal(healthyResult, true);
    assert.equal(ladderCalled, 0);

    let capturedPrompt = "";
    const waitingHandler = createHeadlessIntervention(
      { paneId: "tfx:0.1", cli: "claude", resultFile: "/tmp/nonexistent.txt" },
      null,
      {
        capturePsmuxPane: () => "? Proceed with migration? (y/N)",
        judgeWorkerHealth: async () => ({
          status: "waiting_input",
          confidence: 0.93,
        }),
        createInterventionLadder: (opts) => {
          capturedPrompt = opts.reinstructPrompt || "";
          return { intervene: async () => ({ outcome: "reactivated" }) };
        },
      },
    );
    const waitingResult = await waitingHandler({ inactiveMs: 180_000 });
    assert.equal(waitingResult, true);
    assert.equal(capturedPrompt.includes("대화형 입력 대기"), true);
  });

  it("bridge.mjs: jev-stats, jev-batch, handoff-check 서브커맨드가 정상 동작한다", async () => {
    const statsOk = await runBridgeMain(["jev-stats"]);
    assert.equal(statsOk, true);

    const batchOk = await runBridgeMain([
      "jev-batch",
      "--payload",
      JSON.stringify({
        state: "worker output",
        questions: { q1: { kind: "noul", query: "is it ok?" } },
      }),
    ]);
    assert.equal(batchOk, true);

    const handoffOk = await runBridgeMain([
      "handoff-check",
      "--payload",
      JSON.stringify({
        rawText:
          "--- HANDOFF ---\nstatus: ok\nlead_action: accept\nfiles_changed: a.mjs\nverdict: done\n---",
        exitCode: 0,
        gitDiffFiles: ["a.mjs"],
      }),
    ]);
    assert.equal(handoffOk, true);
  });

  it("Pre-route: executionFlagsForCli가 CLI별 실행 권한 플래그(read_only / workspace_auto / bypass)를 반환한다", () => {
    assert.equal(
      executionFlagsForCli("codex", "read_only").flagsString,
      "--sandbox read-only --skip-git-repo-check",
    );
    assert.equal(
      executionFlagsForCli("codex", "workspace_auto").flagsString,
      "--full-auto --skip-git-repo-check",
    );
    assert.equal(
      executionFlagsForCli("codex", "bypass").flagsString,
      "--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check",
    );
    assert.equal(
      executionFlagsForCli("antigravity", "read_only").flagsString,
      "--print --sandbox",
    );
    assert.equal(
      executionFlagsForCli("antigravity", "bypass").flagsString,
      "--print --dangerously-skip-permissions",
    );
    assert.equal(
      executionFlagsForCli("claude", "read_only").flagsString,
      "--permission-mode plan",
    );
    assert.equal(
      executionFlagsForCli("claude", "workspace_auto").flagsString,
      "--permission-mode acceptEdits",
    );
    assert.equal(
      executionFlagsForCli("claude", "bypass").flagsString,
      "--permission-mode bypassPermissions --allow-dangerously-skip-permissions",
    );
  });

  it("Pre-route: judgeTaskRouting이 복잡도, 프로파일, 실행 권한(read_only/workspace_auto/bypass), 필요한 MCP 서버를 단일 배치로 판정한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-route-"));
    const statsFile = join(dir, "jev-stats.jsonl");
    try {
      const res = await judgeTaskRouting(
        {
          prompt:
            "React 공식 문서를 찾아보고 AuthContext 아키텍처를 재설계한 뒤 외부 staging 서버에 배포해라",
          agentType: "architect",
          cliType: "codex",
          availableServers: ["context7", "brave-search", "playwright", "exa"],
        },
        {
          statsFile,
          batchClient: async () => ({
            complexity: { choice: "high_risk", confidence: 0.92 },
            execution_mode: { choice: "bypass", confidence: 0.91 },
            mcp_profile: { choice: "reviewer", confidence: 0.88 },
            mcp_context7: { value: true, confidence: 0.94 },
            mcp_brave_search: { value: true, confidence: 0.86 },
            mcp_playwright: { value: false, confidence: 0.95 },
            mcp_exa: { value: false, confidence: 0.9 },
          }),
        },
      );
      assert.equal(res.complexity, "high_risk");
      assert.equal(res.codexProfile, "astra_xhigh");
      assert.equal(res.agyProfile, "argon_high");
      assert.equal(res.claudeModel, "opus");
      assert.equal(res.claudeEffort, "high");
      assert.equal(res.executionMode, "bypass");
      assert.equal(
        res.executionFlags,
        "--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check",
      );
      assert.equal(res.mcpProfile, "reviewer");
      assert.deepEqual(res.neededMcpServers, ["context7", "brave-search"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("MCP 동적 선택: judgeMcpSelection 및 buildMcpPolicyWithJev가 태스크에 필요한 MCP 서버만 남긴다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-mcp-"));
    const statsFile = join(dir, "jev-stats.jsonl");
    try {
      const sel = await judgeMcpSelection(
        {
          taskText: "Next.js 15 App Router 공식 문서 확인",
          agentType: "executor",
          availableServers: ["context7", "playwright"],
        },
        {
          statsFile,
          batchClient: async () => ({
            mcp_profile: { choice: "implementer", confidence: 0.9 },
            mcp_context7: { value: true, confidence: 0.93 },
            mcp_playwright: { value: false, confidence: 0.92 },
          }),
        },
      );
      assert.equal(sel.mcpProfile, "implementer");
      assert.deepEqual(sel.neededServers, ["context7"]);

      const policy = await buildMcpPolicyWithJev(
        {
          agentType: "executor",
          requestedProfile: "auto",
          taskText: "Next.js 15 App Router 공식 문서 확인",
          availableServers: ["context7", "playwright", "brave-search"],
        },
        {
          statsFile,
          batchClient: async () => ({
            mcp_profile: { choice: "implementer", confidence: 0.91 },
            mcp_context7: { value: true, confidence: 0.95 },
            mcp_playwright: { value: false, confidence: 0.94 },
            mcp_brave_search: { value: false, confidence: 0.91 },
          }),
        },
      );
      assert.deepEqual(policy.enabledServers, ["context7"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("추가 병목 훅: judgeTargetSession, assignTasksWithJev, submitPromptWithJevVerification, verifyInstructionAckWithJev, judgeInboxPriority, evaluateReviewGateWithJev 동작 검증", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-extra-"));
    const statsFile = join(dir, "jev-stats.jsonl");
    try {
      const targetPick = await judgeTargetSession(
        {
          prompt: "DB 스키마 마이그레이션 에러 확인해줘",
          candidates: [
            { id: "sess-ui", name: "frontend-ui", role: "designer" },
            { id: "sess-db", name: "backend-db", role: "executor" },
          ],
        },
        {
          statsFile,
          client: async () => ({ choice: "candidate_1", confidence: 0.92 }),
        },
      );
      assert.equal(targetPick.selectedIndex, 1);
      assert.equal(targetPick.selected.id, "sess-db");

      const assigned = await assignTasksWithJev(
        "UI 레이아웃 개편 + 백엔드 쿼리 최적화",
        [
          { target: "s:0.1", cli: "codex" },
          { target: "s:0.2", cli: "antigravity" },
        ],
        {
          statsFile,
          batchClient: async () => ({
            subtask_0_worker: { choice: "worker_1", confidence: 0.91 },
            subtask_0_cli: { choice: "antigravity", confidence: 0.9 },
            subtask_1_worker: { choice: "worker_0", confidence: 0.93 },
            subtask_1_cli: { choice: "codex", confidence: 0.92 },
          }),
        },
      );
      assert.equal(assigned.length, 2);
      assert.equal(assigned[0].subtask, "백엔드 쿼리 최적화");
      assert.equal(assigned[1].subtask, "UI 레이아웃 개편");

      let enterCalls = 0;
      const submitRes = await submitPromptWithJevVerification({
        cli: "claude",
        prompt: "리팩터링 시작해",
        capture: () => "> 리팩터링 시작해",
        sendEnter: () => {
          enterCalls += 1;
        },
        sleep: () => {},
        settleMs: 0,
        retryLimit: 1,
        jevOptions: {
          statsFile,
          client: async () => ({
            choice: "stuck_in_composer",
            confidence: 0.93,
          }),
        },
      });
      assert.equal(submitRes.submitted, true);
      assert.equal(submitRes.jevState, "stuck_in_composer");
      assert.equal(enterCalls, 2);

      const indexPath = join(dir, "results.json");
      const resultsIdx = createResultsIndex(
        indexPath,
        "sess-test",
        [{ paneName: "w1", cli: "codex", resultFile: "w1.out" }],
        () => true,
      );
      const ackVerdict = await resultsIdx.verifyInstructionAckWithJev(
        "w1",
        {
          instruction: "auth.mjs의 토큰 만료 시간을 1시간으로 수정해",
          recentOutput: "Editing auth.mjs to set token expiry to 3600s...",
        },
        {
          statsFile,
          batchClient: async () => ({
            ack: { value: true, confidence: 0.94 },
            status: { choice: "acknowledged_executing", confidence: 0.91 },
          }),
        },
      );
      assert.equal(ackVerdict.acknowledged, true);
      assert.equal(ackVerdict.ackStatus, "acknowledged_executing");

      const prio = await judgeInboxPriority(
        {
          text: "권한 에러로 배포가 멈췄습니다. 승인 여부 결정이 필요합니다.",
          summary: "배포 중단",
          from: "worker-1",
        },
        {
          statsFile,
          client: async () => ({ choice: "urgent_blocker", confidence: 0.95 }),
        },
      );
      assert.equal(prio.priority, "urgent_blocker");
      assert.equal(prio.urgencyScore, 100);

      const gate = await evaluateReviewGateWithJev(
        {
          diffStat: "1 file changed, 2 insertions(+)",
          handoffSummary: "오타 수정",
          previousReviews: "LGTM",
          currentReview: "LGTM, no issues found",
        },
        {
          statsFile,
          batchClient: async () => ({
            gate: { choice: "skip_review", confidence: 0.92 },
            converged: { value: true, confidence: 0.95 },
          }),
        },
      );
      assert.equal(gate.gate, "skip_review");
      assert.equal(gate.converged, true);
      assert.equal(gate.fallback, false);

      const routeCliOk = await runBridgeMain([
        "judge-route",
        "--delimited",
        "--payload",
        JSON.stringify({
          prompt: "단순 버전 확인",
          agentType: "explore",
          cliType: "codex",
        }),
      ]);
      assert.equal(routeCliOk, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
