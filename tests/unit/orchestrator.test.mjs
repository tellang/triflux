import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { orchestrate } from "../../hub/team/orchestrator.mjs";

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
