import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { waitForTmuxIdle } from "../../bin/tfx-live.mjs";
import { readTailSafe, main as runBridgeMain } from "../../hub/bridge.mjs";
import {
  classifyWorkerMode,
  executionFlagsForCli,
  isJevEnabled,
  judgeBusyAction,
  judgeHandoffQuality,
  judgeInboxPriority,
  judgeMcpSelection,
  judgePeerConvergence,
  judgeRoutingBranch,
  judgeSameFailureCause,
  judgeTargetSession,
  judgeTaskRouting,
  judgeWorkerHealth,
  judgeWorkerMode,
  parseRoutingBranches,
  queryJev,
  queryJevBatch,
  recordMcpSelectionShadow,
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
import { shiftCodexAgentProfile } from "../../scripts/lib/agent-route-policy.mjs";
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
  it("의미 발췌는 600자 응답과 500자 과제의 경계를 자르거나 정규화하지 않는다", async () => {
    const requests = [];
    const options = {
      env: { TFX_JEV_STATS: "0" },
      client: async (request) => {
        requests.push(request);
        return { value: false, confidence: 0.95 };
      },
    };
    const previous = ` ${"가".repeat(597)}! `;
    const current = "B".repeat(600);
    const seed = "T".repeat(500);
    assert.deepEqual(await judgeSameFailureCause(previous, current, options), {
      sameCause: false,
      confidence: 0.95,
    });
    assert.deepEqual(
      await judgePeerConvergence(
        {
          seed,
          previousResponse: previous,
          currentResponse: current,
          hopIndex: 2,
        },
        options,
      ),
      { converged: false, confidence: 0.95 },
    );
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.ok(request.context.includes(previous));
      assert.ok(request.context.includes(current));
    }
    assert.ok(requests[1].context.includes(seed));
    assert.equal(
      (await judgeSameFailureCause(
        "ENOENT /tmp/a",
        "ENOENT /tmp/a",
        options,
      )) !== null,
      true,
    );
    assert.equal(requests.length, 2);
  });

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

    const dropRes = await judgeBusyAction(
      {
        incomingMessage: "이미 처리한 중복 요청",
        currentOutput: "같은 파일 수정 중",
        allowDrop: true,
      },
      {
        client: async (q) => {
          assert.deepEqual(q.options, ["steer", "wait", "drop"]);
          return { output: "drop", confidence: 0.93 };
        },
      },
    );
    assert.equal(dropRes?.action, "drop");
  });

  it("Hook 5: judgeWorkerHealth가 대화형 프롬프트 대기를 waiting_input으로 판정하고 readTailSafe가 파일 끝 바이트만 읽는다", async () => {
    const res = await judgeWorkerHealth(
      {
        recentOutput: "? Overwrite existing configuration file? (y/N)",
        stderrTail: "",
        elapsedSec: 120,
      },
      {
        client: async () => ({ choice: "waiting_input", confidence: 0.96 }),
      },
    );
    assert.equal(res?.status, "waiting_input");
    assert.equal(res?.healthState, "waiting_input");

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

  it("Hook 5 런타임 연동: 실제 progressing 판정은 개입을 유예하고 waiting_input이면 맞춤 프롬프트를 주입한다", async () => {
    let ladderCalled = 0;
    const healthyHandler = createHeadlessIntervention(
      { paneId: "tfx:0.1", cli: "codex", resultFile: "/tmp/nonexistent.txt" },
      null,
      {
        capturePsmuxPane: () => "Running cargo test --workspace...",
        judgeWorkerHealth: (input) =>
          judgeWorkerHealth(input, {
            client: async () => ({ choice: "progressing", confidence: 0.95 }),
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

    for (const status of ["waiting_input", "looping_error"]) {
      let capturedPrompt = "";
      const waitingHandler = createHeadlessIntervention(
        {
          paneId: "tfx:0.1",
          cli: "claude",
          resultFile: "/tmp/nonexistent.txt",
        },
        null,
        {
          capturePsmuxPane: () => "? Proceed with migration? (y/N)",
          judgeWorkerHealth: (input) =>
            judgeWorkerHealth(input, {
              client: async () => ({ choice: status, confidence: 0.93 }),
            }),
          createInterventionLadder: (opts) => {
            capturedPrompt = opts.reinstructPrompt || "";
            return { intervene: async () => ({ outcome: "reactivated" }) };
          },
        },
      );
      const waitingResult = await waitingHandler({ inactiveMs: 180_000 });
      assert.equal(waitingResult, true);
      assert.equal(
        capturedPrompt.includes(
          status === "waiting_input"
            ? "대화형 입력 대기"
            : "동일 오류 반복 루프",
        ),
        true,
      );
    }
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
      "--sandbox workspace-write --skip-git-repo-check",
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
          agentType: "executor",
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

      const partialRes = await judgeTaskRouting(
        {
          prompt: "문서만 참조해서 구조 확인",
          agentType: "architect",
          cliType: "codex",
          availableServers: ["context7"],
        },
        {
          statsFile,
          batchClient: async () => ({
            complexity: { choice: "standard", confidence: 0.4 },
            execution_mode: { choice: "bypass", confidence: 0.3 },
            mcp_profile: { choice: "reviewer", confidence: 0.92 },
            mcp_context7: { value: true, confidence: 0.91 },
          }),
        },
      );
      assert.equal(partialRes.complexity, null);
      assert.equal(partialRes.codexProfile, null);
      assert.equal(partialRes.executionMode, null);
      assert.equal(partialRes.executionFlags, null);
      assert.equal(partialRes.mcpProfile, "reviewer");
      assert.deepEqual(partialRes.neededMcpServers, ["context7"]);
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
      assert.equal(policy.codexConfig.mcp_servers.context7.enabled, true);
      assert.deepEqual(policy.codexConfig.mcp_servers.playwright, {
        enabled: false,
      });
      assert.deepEqual(policy.codexConfig.mcp_servers["brave-search"], {
        enabled: false,
      });
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

      const conflictAssigned = await assignTasksWithJev(
        "태스크A + 태스크B + 태스크C",
        [
          { target: "s:0.1", cli: "codex" },
          { target: "s:0.2", cli: "claude" },
          { target: "s:0.3", cli: "antigravity" },
        ],
        {
          statsFile,
          batchClient: async () => ({
            subtask_0_worker: { choice: "worker_2", confidence: 0.91 },
            subtask_1_worker: { choice: "worker_0", confidence: 0.92 },
            subtask_2_worker: { choice: "worker_0", confidence: 0.9 },
          }),
        },
      );
      assert.deepEqual(
        conflictAssigned.map((w) => w.subtask),
        ["태스크B", "태스크C", "태스크A"],
      );

      let enterCalls = 0;
      const submitRes = await submitPromptWithJevVerification({
        cli: "claude",
        prompt: "리팩터링 시작해",
        capture: () =>
          enterCalls < 2 ? "> 리팩터링 시작해" : "Working on refactoring...",
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
      assert.equal(submitRes.jevState, "submitted_running");
      assert.equal(enterCalls, 2);

      await assert.rejects(
        () =>
          submitPromptWithJevVerification({
            cli: "antigravity",
            prompt: "실패 유지 확인",
            capture: () => "> 실패 유지 확인",
            sendEnter: () => {},
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
          }),
        /Antigravity prompt submission failed/,
      );

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

describe("judgeRoutingBranch", () => {
  const routingText = [
    "- D0: 명시 스킬은 유지한다.",
    "- D3: 제품 수요는 `office-hours`; D4 해법 발산은 `brainstorming`.",
    "- D7: 로컬 파일은 Explore; 외부 문서는 `tfx-research`.",
  ].join("\n");

  it("한 줄에 묶인 분기까지 나누고 기준을 정본에서 그대로 보낸다", async () => {
    let sent;
    const verdict = await judgeRoutingBranch(
      { task: "공식 문서를 찾아줘", routingText },
      {
        client: (request) => {
          sent = request;
          return { choice: "D7", confidence: 0.9 };
        },
      },
    );
    assert.deepEqual(
      parseRoutingBranches(routingText).D4,
      "해법 발산은 `brainstorming`.",
    );
    assert.deepEqual(sent.options, ["D3", "D4", "D7", "none"]);
    assert.equal(
      verdict.rule,
      "로컬 파일은 Explore; 외부 문서는 `tfx-research`.",
    );
  });

  it("실제 라우팅 정본의 D1~D11 을 모두 읽는다", () => {
    const branches = parseRoutingBranches(
      readFileSync(".claude/rules/tfx-routing.md", "utf8"),
    );
    assert.deepEqual(
      Object.keys(branches),
      Array.from({ length: 12 }, (_, n) => `D${n}`),
    );
  });

  it("tfx judge route 는 스킬이 읽는 JSON 을 내고 비활성에서도 성공한다", () => {
    const dir = mkdtempSync(join(tmpdir(), "tfx-judge-"));
    const fakeCli = join(dir, "jev");
    writeFileSync(
      fakeCli,
      `#!${process.execPath}\nconst seen = process.argv.join(" ").includes("tfx-research");\nconsole.log(JSON.stringify({ choice: seen ? "D7" : "none", confidence: 0.9 }));\n`,
      { mode: 0o755 },
    );
    const run = (env) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          ["bin/triflux.mjs", "judge", "route", "--task", "공식 문서 찾아줘"],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              JEV_API_KEY: "",
              TYPESAFE_API_KEY: "",
              TFX_JEV_STATS: "0",
              ...env,
            },
          },
        ),
      );
    try {
      assert.equal(run({ TFX_JEV_CLI: fakeCli, TFX_JEV: "" }).choice, "D7");
      assert.deepEqual(run({ TFX_JEV: "0" }), {
        enabled: false,
        choice: null,
        rule: null,
        confidence: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("D0, D4, none, 낮은 신뢰도는 판정하지 않아 전문 읽기로 돌아간다", async () => {
    for (const reply of [
      { choice: "D0", confidence: 0.99 },
      { choice: "none", confidence: 0.99 },
      { choice: "D4", confidence: 0.99 },
      { choice: "D7", confidence: 0.4 },
    ]) {
      assert.equal(
        await judgeRoutingBranch(
          { task: "요청", routingText },
          { client: () => reply },
        ),
        null,
      );
    }
  });
});

describe("judgeWorkerMode", () => {
  const options = { env: { TFX_JEV: "", TFX_JEV_STATS: "0" } };

  for (const [task, choice, ruleMode] of [
    ["git push 실행", "bypass", "bypass"],
    ["로컬 파일 수정과 테스트", "auto", "auto"],
    ["코드 리뷰", "bypass", "auto"],
    ["릴리스 실행", "auto", "bypass"],
  ]) {
    it(`Jev ${choice}를 채택하고 규칙 ${ruleMode}와 출처를 보존한다: ${task}`, async () => {
      const verdict = await judgeWorkerMode(
        { task },
        { ...options, client: () => ({ choice, confidence: 0.91 }) },
      );
      assert.equal(verdict.mode, choice);
      assert.equal(verdict.source, "jev");
      assert.equal(verdict.ruleMode, ruleMode);
      assert.equal(verdict.confidence, 0.91);
      assert.equal(verdict.fallbackReason, null);
      assert.ok(verdict.reason);
      assert.ok(!verdict.reason.includes(task));
    });
  }

  for (const [fallbackReason, overrides] of [
    ["jev_disabled", { env: { TFX_JEV: "0" } }],
    ["low_confidence", { client: () => ({ choice: "auto", confidence: 0.6 }) }],
    [
      "low_confidence",
      {
        minConfidence: 0.95,
        client: () => ({ choice: "auto", confidence: 0.9 }),
      },
    ],
    [
      "jev_failed",
      {
        client: () => {
          throw new Error("주입 client 실패");
        },
      },
    ],
    ["jev_failed", { client: () => null }],
    ["jev_failed", { client: () => ({ choice: "other", confidence: 0.99 }) }],
    [
      "jev_unclear",
      { client: () => ({ choice: "unclear", confidence: 0.99 }) },
    ],
  ]) {
    it(`${fallbackReason}이면 규칙 판정을 반환한다`, async () => {
      const verdict = await judgeWorkerMode(
        { task: "배포 실행" },
        { ...options, ...overrides },
      );
      assert.equal(verdict.mode, "bypass");
      assert.equal(verdict.ruleMode, "bypass");
      assert.equal(verdict.source, "rule");
      assert.equal(verdict.fallbackReason, fallbackReason);
      assert.equal(verdict.confidence, null);
    });
  }

  it("비활성 상태에서는 client를 호출하지 않고 빈 입력에도 판정한다", async () => {
    const verdict = await judgeWorkerMode(undefined, {
      env: { TFX_JEV: "0" },
      client: () => assert.fail("비활성 client 호출"),
    });
    assert.equal(verdict.mode, "auto");
    assert.equal(verdict.fallbackReason, "jev_disabled");
  });

  for (const [mode, tasks] of [
    [
      "auto",
      [
        "commit, push, PR, 릴리스, 설치본 교체는 하지 않는다",
        "git push origin main 금지",
        "gh pr merge 하지 않는다",
        "push/머지 금지",
        "릴리스는 절대 하지 않는다",
        "머지 는 금지",
        "배포 안 함",
        "푸시, 머지, 릴리스는 리드가 한다",
        "Do not run git push",
        "should not deploy",
        "avoid deploying",
        "without any push",
        "don’t push",
        "remote-spawn.mjs 의 원격 psmux 감싸기 로직 수정과 테스트",
        "노션 기획서를 보고 함수 작성",
        "Jira 티켓 보고 버그 수정",
        "원격 접속해서 로컬 파일 수정",
        "delete unused code",
        "로컬 브랜치 삭제",
        "배포하고 push는 금지",
        "release는 리드 몫",
        "publish docs 말고 조사",
        "메일 보내지 마라",
        "push 말아 주세요",
        "삭제 말 것",
        "배포 안 한다",
        "배포 안 해",
        "배포 안 됨",
        "배포 안 됩니다",
        "배포 안 돼",
        "배포 불가",
        "릴리스 제외",
        "삭제 없이",
        "메일 전송 못 한다",
        "no deployment",
        "never publish",
        "don't send email",
        "push 금지, 배포한다",
        "push 금지!배포한다",
        "push 금지?배포한다",
        "push 금지;배포한다",
        "push 금지.배포한다",
        "git push 하지 않는다. 로컬 파일 수정",
        "리뷰",
        "조회",
        "read-only",
        "inspect",
        "investigate",
        "audit",
        "미사용 import drop 하고 로컬 patch 작성",
        "post-processing 함수 구현",
        "put the helper into utils",
        "동작 개선",
        "머지 충돌 해결",
        "README 배포 절 수정",
        "Slack 어댑터 수정",
      ],
    ],
    [
      "bypass",
      [
        "push 금지. 스테이징에 배포한다",
        "push 금지; 스테이징에 배포한다",
        "push 금지! 스테이징에 배포한다",
        "push 금지? 스테이징에 배포한다",
        "push 금지\n스테이징에 배포한다",
        "스테이징에 배포한다",
        "프로덕션 DB 레코드를 삭제한다",
        "버킷 삭제",
        "PR 을 만든다",
        "open a PR",
        "Notion 페이지 업데이트",
        "슬랙에 결과 게시",
        "git push origin main",
        "PR 열기",
        "create a pull request",
        "PR 를 생성한다",
        "메일 보내기",
        "send mail",
        "send email",
        "PATCH API",
        "PUT API",
        "POST API",
        "DELETE API",
        "DROP TABLE records",
        "DROP DATABASE staging",
        "terraform apply",
        "kubectl apply",
        "npm publish",
        "gh release create",
        "git commit 하고 원격 저장소에 올린다",
        "원격 설정 갱신",
        "원격 설정 반영",
        "원격 리소스 생성",
        "Jira 티켓 작성",
        "Slack 메시지 업데이트",
        "Notion 페이지를 열고, 결과 업데이트",
        "CES 에이전트 instruction 을 원격에 PATCH",
        "git push --no-verify origin main",
        "git push -no-color origin main",
        "잘못된 레코드를 프로덕션 DB 에서 삭제한다",
        "불가피하게 프로덕션 배포",
        "사용자가 승인한 PR 머지",
        "배포는 사용자 몫이라 사용자가 한다",
        "PR 올리기",
        "Slack 에 공지",
        "노션에 페이지 만들기",
        "npm 게시",
      ],
    ],
  ]) {
    for (const task of tasks) {
      it(`규칙 판정은 ${mode}다: ${task}`, () => {
        assert.equal(classifyWorkerMode(task).mode, mode);
      });
    }
  }

  for (const [task, write, artifact] of [
    ["Google Docs 문서 수정", "외부 문서 쓰기", "문서"],
    ["구글 독스 문서 생성", "외부 문서 쓰기", "문서"],
    ["Confluence 문서 갱신", "외부 문서 쓰기", "문서"],
    ["merge conflict 해결", "merge", "conflict"],
    ["CHANGELOG 릴리스 항목 작성", "릴리스", "CHANGELOG"],
    ["POST 클라이언트 수정", "POST", "클라이언트"],
    ["DELETE 파서 수정", "DELETE", "파서"],
    ["배포 스크립트 버그 수정", "배포", "스크립트"],
    ["릴리스 노트 초안 작성", "릴리스", "초안"],
    ["merge sort 구현", "merge", "구현"],
    ["POST 핸들러 구현", "POST", "핸들러"],
    ["배포 버튼 UI 수정", "배포", "버튼"],
    ["DELETE handler refactor", "DELETE", "handler"],
    ["release notes draft", "release", "notes"],
    ["deploy.mjs 수정", "deploy", "파일 확장자"],
    ["원격 파일 삭제", "삭제", "파일"],
    ["리뷰하고 배포한다", "배포", "리뷰"],
    ["PR 생성 금지. 함수 작성 후 배포", "배포", "함수"],
  ]) {
    it(`읽기나 코드 산출물과 섞인 외부 변경은 모호한 auto다: ${task}`, () => {
      const verdict = classifyWorkerMode(task);
      assert.equal(verdict.mode, "auto");
      assert.match(verdict.reason, /모호/);
      assert.ok(verdict.reason.includes(write));
      assert.ok(verdict.reason.includes(artifact));
    });
  }

  it("외부 변경이 없으면 읽기나 코드 산출물 신호를 근거에 적는다", () => {
    assert.match(classifyWorkerMode("로컬 파일 수정").reason, /로컬/);
    assert.match(classifyWorkerMode("로컬 파일 수정").reason, /파일/);
    assert.match(classifyWorkerMode("코드 리뷰").reason, /리뷰/);
    assert.match(classifyWorkerMode().reason, /외부 변경 신호가 없/);
  });

  for (const [task, signal] of [
    ["푸시하지 마세요", "푸시"],
    ["shouldn't deploy", "deploy"],
    ["머지는 리드에게 맡긴다", "머지"],
    ["배포는 이번 범위가 아니다", "배포"],
    ["다운타임 없이 프로덕션에 배포한다", "배포"],
    ["cannot publish", "publish"],
    ["릴리스 범위 밖", "릴리스"],
    ["배포는 CI가 한다", "배포"],
    ["푸시는 리드가 맡는다", "푸시"],
    ["배포는 사용자가 진행한다", "배포"],
    ["머지는 리드가 합니다", "머지"],
    ["머지와 릴리스는 리드가 진행", "릴리스"],
    ["릴리스는 사용자가 직접 한다", "릴리스"],
    ["푸시 안 합니다", "푸시"],
    ["푸시 안합니다", "푸시"],
    ["배포 없음", "배포"],
    ["배포는 없다", "배포"],
    ["push 금지. 로컬 파일 수정", "git push"],
  ]) {
    it(`제외한 외부 변경 신호와 모호함을 근거에 남긴다: ${task}`, () => {
      const verdict = classifyWorkerMode(task);
      assert.equal(verdict.mode, "auto");
      assert.match(verdict.reason, /제외/);
      assert.match(verdict.reason, /모호/);
      assert.ok(verdict.reason.includes(signal));
      assert.doesNotMatch(verdict.reason, /외부 변경 신호가 없/);
    });
  }

  it("다른 문장에 외부 변경이 남아도 제외한 신호를 근거에 남긴다", () => {
    const verdict = classifyWorkerMode("push 금지. 스테이징에 배포한다");
    assert.equal(verdict.mode, "bypass");
    assert.match(verdict.reason, /배포/);
    assert.match(verdict.reason, /제외.*git push/);
    assert.doesNotMatch(verdict.reason, /모호/);
  });

  it("로컬 규칙 입력은 앞 2,000자만 사용한다", () => {
    assert.equal(classifyWorkerMode(`${"가".repeat(2000)} 배포`).mode, "auto");
    assert.equal(
      classifyWorkerMode(`배포 ${"가".repeat(2000)} 금지`).mode,
      "bypass",
    );
  });

  for (const input of [null, { task: Object.create(null) }, { task: 123 }]) {
    it("문자열이 아닌 입력에도 throw 없이 빈 입력으로 판정한다", async () => {
      const verdict = await judgeWorkerMode(input, {
        ...options,
        client: () => assert.fail("빈 입력 전송"),
      });
      assert.equal(verdict.mode, "auto");
      assert.equal(verdict.fallbackReason, "unsafe_input");
    });
  }

  for (const [kind, task] of [
    ["비밀 값", "배포 API_KEY=unit-test-secret-value"],
    ["이메일", "메일 전송 unit.user@example.test"],
    ["내부 이메일", "메일 전송 unit-user@localhost"],
    ["한국어 이메일", "메일 전송 테스트@예시.한국"],
    ["한국 전화", "전송 010-1234-5678"],
    ["구분자 없는 전화", "전송 01012345678"],
    ["국제 전화", "전송 +1 (202) 555-0123"],
    ["주민번호", "삭제 900101-1234567"],
    ["카드", "삭제 1234-5678-9012-3456"],
    ["공백 구분 카드", "삭제 1234 5678 9012 3456"],
    ["macOS 홈", "수정 /Users/example/project"],
    ["Linux 홈", "수정 /home/example/project"],
    ["Windows 홈", String.raw`수정 C:\Users\example\project`],
    ["URL 인증", "POST https://unit-user:unit-pass@example.test/api"],
    ["AWS 키", `AWS 키 ${["AKIA", "IOSFODNN7EXAMPLE"].join("")} 로 배포`],
    [
      "Slack 토큰",
      `배포 토큰 ${["xoxb", "1234567890", "abcdefghijEXAMPLE"].join("-")}`,
    ],
    [
      "JWT",
      [
        "eyJhbGciOiJIUzI1NiJ9",
        "eyJzdWIiOiJleGFtcGxlMTIzIn0",
        "exampleSignature1234567890",
      ].join("."),
    ],
    [
      "Slack webhook",
      `https://hooks.slack.com/services/${["T123EXAMPLE", "B456EXAMPLE", "exampleWebhookToken1234567890"].join("/")}`,
    ],
    ["한국어 비밀 라벨", "비밀번호: hunter2example 로 로그인"],
    ["영어 비밀 라벨", "password hunter2example 로 배포"],
    ["비밀 라벨 값", "시크릿=examplevalue 로 배포"],
    ["점 구분 전화", "전화 010.1234.5678 고객에게 전송"],
    ["점 구분 카드", "카드 1234.5678.9012.3456"],
    ["공백 주민번호", "주민번호 900101 - 1234567"],
    ["전각 전화", "전화 ０１０.１２３４.５６７８ 고객에게 전송"],
    ["file URL 홈", "file:///Users/example/x 수정"],
    ["cwd 홈", "--cwd=/Users/example/x 수정"],
    ["백틱 홈", "`/home/example/x` 수정"],
    ["WSL 홈", "/mnt/c/Users/example/x 수정"],
    ["Windows 슬래시 홈", "c:/users/example/x 수정"],
    ["Windows 소문자 홈", String.raw`c:\users\example\x 수정`],
    ["한국어 라벨 조사", "비밀번호는 hunter2example 로 로그인"],
    ["토큰 라벨 조사", "토큰은 abc123defexample 사용"],
    ["API 키 라벨", "API 키 abcd1234efghexample"],
    ["키 라벨", "키: abcd1234example"],
    ["apikey 라벨", "apikey abcd1234example"],
    ["접두사 토큰 라벨", "access_token abc123xyzexample"],
    ["괄호 구분 전화", "전화 010)1234)5678"],
    [
      "대시 구분 전화",
      `전화 010${String.fromCodePoint(0x2013)}1234${String.fromCodePoint(0x2013)}5678`,
    ],
    ["괄호 구분 주민번호", "주민번호 900101 ) 1234567"],
    [
      "대시 구분 주민번호",
      `주민번호 900101 ${String.fromCodePoint(0x2013)} 1234567`,
    ],
    [
      "국제 전화 대시",
      `전화 +44 20${String.fromCodePoint(0x2013)}1234${String.fromCodePoint(0x2013)}5678`,
    ],
    ["혼합 토큰", `배포 ${"example".repeat(3)}123`],
    ["pw 라벨", "pw: hunter2"],
    ["pwd 라벨", "pwd=hunter2"],
    ["비번 라벨", "비번은 hunter2"],
    ["밑줄 API 키", "API_KEY abcd1234"],
    ["하이픈 API 키", "api-key abcd1234"],
    ["영문 key 라벨", "key: abcd1234"],
    ["복합 key 라벨", "secret key abc123def"],
    ["비밀번호 수단 조사", "비밀번호로 hunter2 사용"],
    ["비밀번호 값 조사", "비밀번호 값은 hunter2"],
    ["토큰값 조사", "토큰값은 abc123def"],
    ["토큰 수단 조사", "토큰으로 abc123def 호출"],
    ["영문 라벨 연결어", "password is hunter2"],
    ["MSYS 홈", ["", "c", "Users", "kim", "x"].join("/")],
    ["Cygwin 홈", ["", "cygdrive", "c", "Users", "kim"].join("/")],
    ["WSL 소문자 홈", ["", "mnt", "c", "users", "kim", "x"].join("/")],
    [
      "Windows 이중 구분자 홈",
      ["C:", "Users", "kim", "x"].join(String.raw`\\`),
    ],
    ["괄호 공백 전화", "(010) 1234-5678"],
    ["빈 요약", "  "],
    ["길이 초과", "a".repeat(1001)],
    ["제어 문자", `리뷰${String.fromCodePoint(0x200b)}한다`],
    ["구조화 입력", '{"operation":"deploy"}'],
  ]) {
    it(`${kind}는 외부로 보내지 않고 원문 없는 unsafe_input을 반환한다`, async () => {
      let calls = 0;
      const verdict = await judgeWorkerMode(
        { task },
        {
          ...options,
          client: () => {
            calls++;
            return { choice: "auto", confidence: 0.9 };
          },
        },
      );
      assert.equal(calls, 0);
      assert.equal(verdict.source, "rule");
      assert.equal(verdict.fallbackReason, "unsafe_input");
      assert.equal(verdict.confidence, null);
      assert.ok(!JSON.stringify(verdict).includes(task));
    });
  }

  it("정상 요약은 공백만 정리해 query에 보내고 선택지는 강제하지 않는다", async () => {
    let sent;
    await judgeWorkerMode(
      { task: "  로컬  파일\n수정과 테스트  " },
      {
        ...options,
        client: (request) => {
          sent = request;
          return { choice: "auto", confidence: 0.9 };
        },
      },
    );
    assert.equal(sent.hook, "worker_mode");
    assert.equal(sent.kind, "choice");
    assert.deepEqual(sent.options, ["bypass", "auto", "unclear"]);
    assert.deepEqual(JSON.parse(sent.context), {
      task: "로컬 파일 수정과 테스트",
    });
    assert.match(sent.query, /prohibited|forbidden/);
  });

  for (const [task, normalized] of [
    ["토큰 갱신 로직 수정", "토큰 갱신 로직 수정"],
    ["API 키 교체", "API 키 교체"],
    ["비밀번호 변경 화면 구현", "비밀번호 변경 화면 구현"],
    ["패키지 2개 업데이트", "패키지 2개 업데이트"],
    ["src/" + "home/index.tsx 수정", "src/" + "home/index.tsx 수정"],
    ["ＰＯＳＴ 핸들러 구현", "POST 핸들러 구현"],
  ]) {
    it(`정상 요약을 NFKC 정규화해 전송한다: ${task}`, async () => {
      let sent;
      const verdict = await judgeWorkerMode(
        { task },
        {
          ...options,
          client: (request) => {
            sent = JSON.parse(request.context).task;
            return { choice: "auto", confidence: 0.9 };
          },
        },
      );
      assert.equal(sent, normalized);
      assert.equal(verdict.source, "jev");
    });
  }

  it("1,000자 요약까지 자르지 않고 전송한다", async () => {
    const task = "a".repeat(1000);
    const verdict = await judgeWorkerMode(
      { task },
      {
        ...options,
        client: (request) => {
          assert.equal(JSON.parse(request.context).task, task);
          return { choice: "auto", confidence: 0.9 };
        },
      },
    );
    assert.equal(verdict.source, "jev");
  });

  it("CLI는 비활성 상태에서도 한 줄 JSON을 내고 --task 누락은 실패한다", () => {
    const dir = mkdtempSync(join(tmpdir(), "tfx-worker-mode-"));
    const cliOptions = {
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, HOME: dir, TFX_JEV: "0" },
    };
    try {
      const stdout = execFileSync(
        process.execPath,
        ["bin/triflux.mjs", "judge", "worker-mode", "--task", "git push"],
        cliOptions,
      );
      assert.equal(stdout.trim().split("\n").length, 1);
      assert.deepEqual(JSON.parse(stdout), {
        enabled: false,
        mode: "bypass",
        reason: "외부 변경 신호(git push)가 있어 bypass를 권고합니다.",
        source: "rule",
        fallbackReason: "jev_disabled",
        ruleMode: "bypass",
        confidence: null,
      });
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            ["bin/triflux.mjs", "judge", "worker-mode"],
            cliOptions,
          ),
        (error) => Number.isInteger(error.status) && error.status !== 0,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("judgeTaskRouting 역할 등급", () => {
  const route = (agentType, choice, confidence) =>
    judgeTaskRouting(
      { prompt: "여러 파일에 걸친 변경을 처리한다", agentType },
      {
        batchClient: () => ({
          answers: {
            complexity: { choice, confidence },
            execution_mode: { choice: "read_only", confidence: 0.9 },
            mcp_profile: { choice: "none", confidence: 0.9 },
          },
        }),
      },
    );

  it("역할 정책이 있는 역할은 높은 신뢰도의 방향 판정만 낸다", async () => {
    const shift = (choice, confidence) =>
      judgeTaskRouting(
        { prompt: "인증 우회 가능성을 검토한다", agentType: "code-reviewer" },
        {
          batchClient: () => ({
            answers: {
              complexity: { choice: "deep", confidence: 0.99 },
              tier_shift: { choice, confidence },
            },
          }),
        },
      );
    assert.equal((await shift("raise", 0.9)).tierShift, "raise");
    assert.equal((await shift("raise", 0.8)).tierShift, null);
    assert.equal((await shift("keep", 0.99)).tierShift, null);
  });

  it("사다리는 한 단계만 옮기고 끝과 보안 리뷰어의 하한을 지킨다", () => {
    assert.equal(
      shiftCodexAgentProfile("code-reviewer", "raise"),
      "astra_xhigh",
    );
    assert.equal(shiftCodexAgentProfile("code-reviewer", "lower"), "sol_med");
    assert.equal(shiftCodexAgentProfile("architect", "raise"), "astra_xhigh");
    assert.equal(shiftCodexAgentProfile("architect", "lower"), "sol_high");
    assert.equal(shiftCodexAgentProfile("writer", "raise"), "terra_high");
    assert.equal(
      shiftCodexAgentProfile("security-reviewer", "lower"),
      "astra_xhigh",
    );
  });

  it("MCP shadow 는 판정을 기록만 하고 Jev 가 꺼져 있으면 호출하지 않는다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-shadow-"));
    const statsFile = join(dir, "stats.jsonl");
    const input = {
      taskText: "로그인 흐름을 브라우저에서 확인한다",
      agentType: "qa-tester",
      availableServers: ["playwright", "exa"],
    };
    try {
      await recordMcpSelectionShadow(input, {
        statsFile,
        batchClient: () => ({
          answers: {
            mcp_profile: { choice: "executor", confidence: 0.9 },
            mcp_playwright: { noul: 0.9 },
            mcp_exa: { noul: 0.1 },
          },
        }),
      });
      const shadow = readFileSync(statsFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .find((row) => row.hook === "mcp_selection_shadow");
      assert.deepEqual(shadow.selected, ["playwright"]);
      assert.equal(shadow.intervened, false);
      assert.equal(
        await recordMcpSelectionShadow(input, { env: { TFX_JEV: "0" } }),
        null,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("역할 정책이 있는 역할은 복잡도로 프로필을 바꾸지 않는다", async () => {
    for (const [role, choice] of [
      ["code-reviewer", "deep"],
      ["architect", "trivial"],
    ]) {
      const routing = await route(role, choice, 0.99);
      assert.equal(routing.complexity, choice);
      assert.equal(routing.codexProfile, null);
      assert.equal(routing.claudeModel, null);
    }
  });

  it("범용 역할도 불확실하면 기본 등급을 유지한다", async () => {
    assert.equal((await route("executor", "deep", 0.8)).codexProfile, null);
    assert.equal(
      (await route("executor", "deep", 0.9)).codexProfile,
      "astra_xhigh",
    );
    assert.equal((await route("executor", "trivial", 0.75)).codexProfile, null);
    assert.equal(
      (await route("executor", "trivial", 0.9)).codexProfile,
      "luna_low",
    );
  });
});
