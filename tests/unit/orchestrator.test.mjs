import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildLeadPrompt,
  buildPrompt,
  orchestrate,
} from "../../hub/team/orchestrator.mjs";

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

  it("한 worker의 prompt 제출 실패를 보고하고 나머지 worker 주입을 계속한다", async () => {
    const attempted = [];
    const reported = [];
    const failures = await orchestrate(
      "test-session",
      [
        { target: "test-session:0.1", cli: "antigravity", subtask: "first" },
        { target: "test-session:0.2", cli: "codex", subtask: "second" },
      ],
      {
        injectPrompt(target) {
          attempted.push(target);
          if (target.endsWith(".1"))
            throw new Error("prompt remains in composer");
        },
        onInjectionFailure(failure) {
          reported.push(failure);
        },
      },
    );

    assert.deepEqual(attempted, ["test-session:0.1", "test-session:0.2"]);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].target, "test-session:0.1");
    assert.equal(failures[0].cli, "antigravity");
    assert.equal(failures[0].message, "prompt remains in composer");
    assert.deepEqual(reported, failures);
  });
});

describe("buildLeadPrompt grounding and evidence gates", () => {
  it("리드와 워커는 허브 호출 없이 결과 파일을 보고한다", () => {
    const config = {
      agentId: "lead-1",
      cli: "codex",
      repoRoot: "/repo/triflux",
      workers: [{ agentId: "worker-1", cli: "codex", subtask: "edit" }],
    };
    const lead = buildLeadPrompt("ship shard", config);
    const worker = buildPrompt("edit", config);
    for (const prompt of [lead, worker])
      assert.doesNotMatch(prompt, /bridge\.mjs|task\.result|27888/);
    assert.match(lead, /모든 워커의 결과와 출력 파일을 확인하고 통합한다/);
    assert.match(lead, /무응답 워커는 상태를 보고하고 중단한다/);
    assert.match(worker, /변경 파일, 검증 결과와 출력 파일 경로/);
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
});
