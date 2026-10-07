import assert from "node:assert/strict";
import { test } from "node:test";
import { processHandoff } from "../../hub/team/handoff.mjs";

const block = `--- HANDOFF ---
status: ok
lead_action: accept
task: implementation
files_changed: hub/a.mjs, tests/a.test.mjs
verdict: 검증 완료
confidence: high
risk: low
detail: result.txt`;

test("the last HANDOFF overrides an echoed prompt and preserves changed files", () => {
  const result = processHandoff(
    `${block}\n${block.replace("검증 완료", "최종 결과")}`,
  );
  assert.equal(result.valid, true);
  assert.equal(result.handoff.verdict, "최종 결과");
  assert.deepEqual(result.handoff.files_changed, [
    "hub/a.mjs",
    "tests/a.test.mjs",
  ]);
  assert.match(result.formatted, /action=accept/);
});

test("empty changed files cannot authorize acceptance", () => {
  const result = processHandoff(
    block.replace("hub/a.mjs, tests/a.test.mjs", "none"),
  );
  assert.equal(result.handoff.lead_action, "needs_read");
  assert.deepEqual(result.handoff.files_changed, []);
});

test("missing routing fields invalidate the handoff and context fills result details", () => {
  const result = processHandoff(
    "--- HANDOFF ---\nlead_action: retry\nverdict: incomplete",
    { exitCode: 1, resultFile: "error.txt", gitDiffFiles: ["a.mjs"] },
  );
  assert.equal(result.valid, false);
  assert.equal(result.handoff.status, "failed");
  assert.equal(result.handoff.detail, "error.txt");
  assert.deepEqual(result.handoff.files_changed, ["a.mjs"]);
});

test("oversized handoffs require reading the result and trim the summary", () => {
  const result = processHandoff(
    block
      .replace("검증 완료", "x".repeat(1000))
      .replace("hub/a.mjs, tests/a.test.mjs", "a.mjs,b.mjs,c.mjs,d.mjs"),
  );
  assert.equal(result.handoff.lead_action, "needs_read");
  assert.ok(result.handoff.verdict.length <= 80);
  assert.deepEqual(result.handoff.files_changed, [
    "a.mjs",
    "b.mjs",
    "c.mjs",
    "+1 more",
  ]);
});

test("missing blocks preserve failure, timeout and no-change outcomes", () => {
  for (const [exitCode, files, action, stage, retryable] of [
    [0, [], "needs_read"],
    [0, ["a.mjs"], "accept"],
    [1, [], "retry", "execution", "yes"],
    [124, [], "retry", "timeout", "no"],
  ]) {
    const result = processHandoff("unstructured output", {
      exitCode,
      gitDiffFiles: files,
    });
    assert.equal(result.fallback, true);
    assert.equal(result.valid, false);
    assert.equal(result.handoff.lead_action, action);
    assert.equal(result.handoff.error_stage, stage);
    assert.equal(result.handoff.retryable, retryable);
  }
});

test("invalid enum values normalize and failure metadata survives formatting", () => {
  const result = processHandoff(
    block
      .replace("status: ok", "status: failed")
      .replace("lead_action: accept", "lead_action: invalid") +
      "\nerror_stage: timeout\nretryable: no\npartial_output: yes",
  );
  assert.equal(result.handoff.lead_action, "needs_read");
  assert.match(result.formatted, /stage=timeout retryable=no/);
  assert.equal(result.handoff.partial_output, "yes");
});
