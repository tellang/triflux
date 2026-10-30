import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
  judgeBusyAction,
  judgeComposerState,
  judgeHandoffQuality,
  judgeInboxPriority,
  judgeInstructionAck,
  judgePeerConvergence,
  judgeReviewGate,
  judgeSameFailureCause,
  judgeTargetSession,
  judgeTaskRouting,
  judgeWorkerHealth,
  queryJev,
  queryJevBatch,
} from "../../hub/lib/jev-addon.mjs";
import {
  buildMcpPolicy,
  buildMcpPolicyWithJev,
} from "../../scripts/lib/mcp-filter.mjs";

it("teamSend는 Jev drop 판단에도 명시적 메시지를 실제 주입한다", async (t) => {
  const injected = [];
  const sendUrl = new URL(
    "../../hub/team/cli/commands/send.mjs",
    import.meta.url,
  );
  globalThis.__jevSendRegression = {
    loadTeamState: () => ({ members: [{ name: "worker", pane: "fake:0.1" }] }),
    isTeamAlive: () => true,
    resolveMember: (state) => state.members[0],
    injectPrompt: (...args) => injected.push(args),
    capturePaneOutput: () => "Working...",
    isJevEnabled: () => true,
    judgeBusyAction: async () => ({ action: "drop", confidence: 1 }),
    ok: () => {},
    DIM: "",
    RESET: "",
    WHITE: "",
  };
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === sendUrl.href) {
        const names = Object.keys(globalThis.__jevSendRegression).join(",");
        return {
          url: `data:text/javascript,${encodeURIComponent(`export const {${names}} = globalThis.__jevSendRegression;`)}`,
          shortCircuit: true,
        };
      }
      return next(specifier, context);
    },
  });
  t.after(() => {
    hook.deregister();
    delete globalThis.__jevSendRegression;
  });
  const { teamSend } = await import(sendUrl.href);
  await teamSend(["worker", "반드시", "전달"]);
  assert.deepEqual(injected, [["fake:0.1", "반드시 전달"]]);
});

const secretInput = [
  "Authorization: Bearer FAKE_AUTH_SECRET",
  'API_KEY="FAKE_API_SECRET"',
  "access_token=FAKE_TOKEN_SECRET",
  "password: FAKE_PASSWORD_SECRET",
  "-----BEGIN PRIVATE KEY-----\nFAKE_PRIVATE_SECRET\n-----END PRIVATE KEY-----",
].join("\n");
const rawOutput = `RAW_LOG_MARKER\n${secretInput}\nRunning tests...\nProceed? [y/N]\nError: retry`;

function assertProtected(payload) {
  assert.doesNotMatch(
    payload,
    /FAKE_(?:AUTH|API|TOKEN|PASSWORD|PRIVATE)_SECRET/,
  );
  assert.doesNotMatch(payload, /RAW_LOG_MARKER/);
}

it("HTTP와 CLI 단건/배치 경계는 query와 criteria의 민감값을 제거한다", async () => {
  const request = {
    kind: "noul",
    query: `판단 ${secretInput}`,
    context: secretInput,
    criteria: { yes: secretInput, API_KEY: "FAKE_API_SECRET" },
  };
  const payloads = [];
  await queryJev(request, {
    env: { JEV_API_KEY: "mock-key", TFX_JEV_STATS: "0" },
    fetchImpl: async (_url, options) => {
      payloads.push(options.body);
      return { ok: true, json: async () => ({ value: true, confidence: 1 }) };
    },
  });
  await queryJevBatch(
    { state: secretInput, questions: { q: request } },
    {
      env: { JEV_API_KEY: "mock-key", TFX_JEV_STATS: "0" },
      fetchImpl: async (_url, options) => {
        payloads.push(options.body);
        return { ok: true, json: async () => ({ answers: {} }) };
      },
    },
  );
  await queryJev(request, {
    env: { TFX_JEV: "1", TFX_JEV_CLI: "/mock/jev", TFX_JEV_STATS: "0" },
    execFileImpl: async (_bin, args) => {
      payloads.push(JSON.stringify(args));
      return { stdout: '{"value":true,"confidence":1}' };
    },
  });
  assert.equal(payloads.length, 3);
  payloads.forEach(assertProtected);
});

for (const transport of ["http", "cli"]) {
  it(`worker output의 모든 판단 경로는 원문 대신 상태 메타데이터를 ${transport}로 보낸다`, async () => {
    const payloads = [];
    const options =
      transport === "http"
        ? {
            env: { JEV_API_KEY: "mock-key", TFX_JEV_STATS: "0" },
            fetchImpl: async (_url, init) => {
              payloads.push(init.body);
              return {
                ok: true,
                json: async () => ({ choice: "progressing", confidence: 1 }),
              };
            },
          }
        : {
            env: { TFX_JEV: "1", TFX_JEV_CLI: "/mock/jev", TFX_JEV_STATS: "0" },
            execFileImpl: async (_bin, args) => {
              payloads.push(JSON.stringify(args));
              return { stdout: '{"choice":"progressing","confidence":1}' };
            },
          };
    await judgeWorkerHealth(
      { stdoutTail: rawOutput, stderrTail: rawOutput, rolloutTail: rawOutput },
      options,
    );
    await judgeHandoffQuality(
      {
        rawText: rawOutput,
        handoff: {
          task: rawOutput,
          status: rawOutput,
          verdict: rawOutput,
          lead_action: rawOutput,
        },
      },
      options,
    );
    await judgeSameFailureCause(rawOutput, `${rawOutput}\nagain`, options);
    await judgePeerConvergence(
      { previousResponse: rawOutput, currentResponse: rawOutput, hopIndex: 2 },
      options,
    );
    await judgeBusyAction(
      { prompt: secretInput, threadSummary: rawOutput },
      options,
    );
    await judgeComposerState(
      { capturedText: rawOutput, promptPrefix: secretInput },
      options,
    );
    await judgeInstructionAck(
      { instruction: secretInput, recentOutput: rawOutput },
      options,
    );
    await judgeInboxPriority({ text: rawOutput, summary: rawOutput }, options);
    await judgeReviewGate(
      {
        handoffSummary: rawOutput,
        previousReviews: rawOutput,
        currentReview: rawOutput,
      },
      options,
    );
    await judgeTargetSession(
      {
        prompt: secretInput,
        candidates: [
          { id: "one", preview: rawOutput },
          { id: "two", preview: rawOutput },
        ],
      },
      options,
    );
    const outputJudgmentCount = payloads.length;
    await judgeTaskRouting(
      {
        prompt: `${secretInput}\n${"x".repeat(1400)}\nAuthorization: Bearer ${"FAKE_AUTH_SECRET".repeat(100)}`,
      },
      options,
    );
    assert.equal(payloads.length, transport === "http" ? 11 : 14);
    for (const payload of payloads) assertProtected(payload);
    for (const payload of payloads.slice(0, outputJudgmentCount))
      assert.match(payload, /(?:chars|lines)/);
  });
}

it("CLI-only 배치는 기존 단건 CLI로 key별 답과 보호된 context를 전달한다", async () => {
  const calls = [];
  const result = await queryJevBatch(
    {
      state: secretInput,
      questions: {
        health: {
          kind: "choice",
          query: secretInput,
          options: ["progressing", "waiting_input"],
          context: "local context",
        },
        ready: { kind: "noul", query: "ready?" },
      },
    },
    {
      env: { TFX_JEV: "1", TFX_JEV_CLI: "/mock/jev", TFX_JEV_STATS: "0" },
      execFileImpl: async (bin, args) => {
        calls.push({ bin, args });
        return {
          stdout:
            args[0] === "choice"
              ? '{"choice":"progressing","confidence":0.95}'
              : '{"value":true,"confidence":0.9}',
        };
      },
    },
  );
  assert.deepEqual(result, {
    health: { choice: "progressing", confidence: 0.95 },
    ready: { value: true, confidence: 0.9 },
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0].args.join(" "), /local context/);
  for (const call of calls) assertProtected(JSON.stringify(call));
});

it("배치 CLI/HTTP 실패는 원문 없는 reason code 통계를 남기고 폴백한다", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "jev-batch-failure-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const transport of ["cli", "http"]) {
    const statsFile = join(dir, `${transport}.jsonl`);
    const options =
      transport === "cli"
        ? {
            env: { TFX_JEV: "1", TFX_JEV_CLI: "/mock/jev" },
            execFileImpl: async () => {
              throw new Error(secretInput);
            },
          }
        : {
            env: { JEV_API_KEY: "mock-key" },
            fetchImpl: async () => ({ ok: false }),
          };
    assert.equal(
      await queryJevBatch(
        {
          state: secretInput,
          questions: { q: { kind: "noul", query: "ok?" } },
        },
        { ...options, statsFile },
      ),
      null,
    );
    const rows = readFileSync(statsFile, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].hook, "jev_batch");
    assert.equal(
      rows[0].reason,
      transport === "cli" ? "batch_call_failed" : "batch_http_failed",
    );
    assert.equal(rows[0].intervened, false);
    assertProtected(JSON.stringify(rows));
  }
});

it("MCP 전체 false는 none이며 partial/저신뢰 판단은 기존 정책으로 폴백한다", async () => {
  const options = {
    agentType: "explore",
    requestedProfile: "auto",
    taskText: "문서 조사와 최신 웹 검색",
    availableServers: ["context7", "brave-search", "playwright"],
    registeredServers: ["context7", "brave-search", "playwright"],
    inventory: {},
  };
  const base = buildMcpPolicy(options);
  assert.deepEqual(base.allowedServers, ["context7", "brave-search"]);
  const answers = Object.fromEntries(
    base.allowedServers.map((server) => [
      `mcp_${server.replace(/[^a-zA-Z0-9_]/g, "_")}`,
      { value: false, confidence: 0.95 },
    ]),
  );
  const none = await buildMcpPolicyWithJev(options, {
    batchClient: async () => ({
      ...answers,
      mcp_profile: { choice: "explore", confidence: 0.95 },
    }),
  });
  assert.deepEqual(none.allowedServers, []);
  assert.equal(none.resolvedProfile, "none");
  assert.ok(
    Object.values(none.codexConfig.mcp_servers).every(
      (s) => s.enabled === false,
    ),
  );
  for (const invalid of [
    {},
    { mcp_context7: { value: false, confidence: 0.95 } },
    { ...answers, mcp_context7: { value: false, confidence: 0.2 } },
  ]) {
    const policy = await buildMcpPolicyWithJev(options, {
      batchClient: async () => ({
        ...invalid,
        mcp_profile: { choice: "explore", confidence: 0.95 },
      }),
    });
    assert.deepEqual(policy, base);
  }
  const wider = await buildMcpPolicyWithJev(options, {
    batchClient: async () => ({
      ...answers,
      mcp_profile: { choice: "designer", confidence: 0.95 },
      mcp_context7: { value: true, confidence: 0.95 },
      mcp_playwright: { value: true, confidence: 0.95 },
    }),
  });
  assert.deepEqual(wider.allowedServers, ["context7"]);
  assert.equal(wider.codexConfig.mcp_servers.playwright.enabled, false);
  const noBaseServers = { ...options, agentType: "qa-tester" };
  assert.deepEqual(
    await buildMcpPolicyWithJev(noBaseServers, {
      batchClient: async () => {
        assert.fail("기존 정책이 none이면 확장을 판단하지 않는다");
      },
    }),
    buildMcpPolicy(noBaseServers),
  );
});
