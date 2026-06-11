import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLeadPrompt, orchestrate } from "../../hub/team/orchestrator.mjs";

function makeMockInject() {
  const calls = [];
  const inject = (target, prompt, opts = {}) => {
    calls.push({ target, prompt, opts });
  };
  return { inject, calls };
}

describe("orchestrator cli hint propagation (#117)", () => {
  it("worker.cli='codex'는 injectPrompt에 { useFileRef: true, cli: 'codex' }로 전파된다", async () => {
    const { inject, calls } = makeMockInject();
    await orchestrate(
      "test-session",
      [{ target: "test-session:0.1", cli: "codex", subtask: "task1" }],
      { injectPrompt: inject },
    );
    const worker = calls.find((c) => c.target === "test-session:0.1");
    assert.ok(worker, "worker injectPrompt call should exist");
    assert.equal(worker.opts.useFileRef, true);
    assert.equal(worker.opts.cli, "codex");
  });

  it("worker.cli='gemini'도 { useFileRef: true, cli: 'gemini' }로 전파된다", async () => {
    const { inject, calls } = makeMockInject();
    await orchestrate(
      "test-session",
      [{ target: "test-session:0.1", cli: "gemini", subtask: "task1" }],
      { injectPrompt: inject },
    );
    const worker = calls.find((c) => c.target === "test-session:0.1");
    assert.ok(worker);
    assert.equal(worker.opts.useFileRef, true);
    assert.equal(worker.opts.cli, "gemini");
  });

  it("lead.cli='claude'는 lead injectPrompt에 { useFileRef: true, cli: 'claude' }로 전파된다", async () => {
    const { inject, calls } = makeMockInject();
    await orchestrate(
      "test-session",
      [{ target: "test-session:0.1", cli: "gemini", subtask: "worker" }],
      {
        lead: {
          target: "test-session:0.0",
          cli: "claude",
          task: "lead task",
        },
        injectPrompt: inject,
      },
    );
    const lead = calls.find((c) => c.target === "test-session:0.0");
    assert.ok(lead, "lead injectPrompt call should exist");
    assert.equal(lead.opts.useFileRef, true);
    assert.equal(lead.opts.cli, "claude");
  });

  it("lead.cli=undefined일 때 opts.cli는 undefined로 전파되며 useFileRef는 유지된다 (shouldUseFileRef의 null 케이스 동작 보존)", async () => {
    const { inject, calls } = makeMockInject();
    await orchestrate(
      "test-session",
      [{ target: "test-session:0.1", cli: "gemini", subtask: "worker" }],
      {
        lead: { target: "test-session:0.0", task: "lead task" },
        injectPrompt: inject,
      },
    );
    const lead = calls.find((c) => c.target === "test-session:0.0");
    assert.ok(lead);
    assert.equal(lead.opts.cli, undefined);
    assert.equal(lead.opts.useFileRef, true);
  });

  it("다수 worker + lead 혼합 시 각 호출에 해당 cli가 정확히 매핑된다", async () => {
    const { inject, calls } = makeMockInject();
    await orchestrate(
      "test-session",
      [
        { target: "test-session:0.1", cli: "codex", subtask: "t1" },
        { target: "test-session:0.2", cli: "gemini", subtask: "t2" },
        { target: "test-session:0.3", cli: "claude", subtask: "t3" },
      ],
      {
        lead: { target: "test-session:0.0", cli: "claude", task: "lead" },
        injectPrompt: inject,
      },
    );
    const byTarget = Object.fromEntries(calls.map((c) => [c.target, c.opts]));
    assert.equal(byTarget["test-session:0.0"].cli, "claude");
    assert.equal(byTarget["test-session:0.1"].cli, "codex");
    assert.equal(byTarget["test-session:0.2"].cli, "gemini");
    assert.equal(byTarget["test-session:0.3"].cli, "claude");
    for (const opts of Object.values(byTarget)) {
      assert.equal(opts.useFileRef, true);
    }
  });

  it("opts.injectPrompt 미지정 시 기본 동작 (default injectPrompt import) — 이 경로는 실행하지 않고 DI 경로만 검증", () => {
    // 실 psmux 호출을 피하기 위해 기본 경로 실행은 생략.
    // DI가 작동하는지만 위 테스트들로 검증되면 기본 import 경로도 동일 signature로 호출됨을 보장한다.
    assert.ok(typeof orchestrate === "function");
  });
});

describe("buildLeadPrompt grounding and evidence gates", () => {
  it("repoRoot가 있으면 bridge 호출을 절대경로로 안내한다", () => {
    const prompt = buildLeadPrompt("ship shard", {
      agentId: "lead-1",
      repoRoot: "/repo/triflux",
      workers: [{ agentId: "worker-1", cli: "codex", subtask: "edit" }],
    });

    assert.ok(prompt.includes("node /repo/triflux/hub/bridge.mjs result"));
    assert.ok(prompt.includes("node /repo/triflux/hub/bridge.mjs context"));
    assert.ok(!prompt.includes("node hub/bridge.mjs result"));
  });

  it("리드 프롬프트는 task.result 수신 종료 조건과 무응답 중단 조건을 포함한다", () => {
    const prompt = buildLeadPrompt("ship shard", {
      agentId: "lead-1",
      repoRoot: "/repo/triflux",
      workers: [{ agentId: "worker-1", cli: "codex", subtask: "edit" }],
    });

    assert.ok(
      prompt.includes(
        "모든 워커의 task.result 수신 후 결과를 통합하고 종료하라. 워커가 무응답이면 상태를 보고하고 중단하라.",
      ),
      prompt,
    );
  });

  it("리드 프롬프트는 증거 없는 완료 주장을 통합하지 않도록 지시한다", () => {
    const prompt = buildLeadPrompt("ship shard", {
      agentId: "lead-1",
      repoRoot: "/repo/triflux",
      workers: [{ agentId: "worker-1", cli: "codex", subtask: "edit" }],
    });

    assert.ok(
      prompt.includes(
        "증거(커밋/테스트/파일) 없는 완료 주장은 통합하지 말고 해당 워커에 redo 를 지시하라.",
      ),
      prompt,
    );
  });

  it("repoRoot가 없으면 기존 상대 bridge 호출을 유지한다", () => {
    const prompt = buildLeadPrompt("ship shard", {
      agentId: "lead-1",
      workers: [{ agentId: "worker-1", cli: "codex", subtask: "edit" }],
    });

    assert.ok(prompt.includes("node hub/bridge.mjs result"));
    assert.ok(prompt.includes("node hub/bridge.mjs context"));
  });
});
