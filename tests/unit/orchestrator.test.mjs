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
});
