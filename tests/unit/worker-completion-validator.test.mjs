// tests/unit/worker-completion-validator.test.mjs — Issue #115 Lane 1.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateWorkerCompletion } from "../../hub/team/worker-completion-validator.mjs";

describe("validateWorkerCompletion", () => {
  it("rejects status=ok payload that is missing commits_made", () => {
    const result = validateWorkerCompletion({ status: "ok" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing_commits_made");
  });

  it("rejects status=ok payload with empty commits_made array", () => {
    const result = validateWorkerCompletion({
      status: "ok",
      commits_made: [],
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "empty_commits_made");
  });

  it("accepts status=ok payload with at least one commit entry", () => {
    const result = validateWorkerCompletion({
      status: "ok",
      shard: "worker-a",
      commits_made: [
        { sha: "abc1234", message: "feat: add feature" },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, undefined);
  });

  it("allows status=skipped payload with empty or omitted commits_made", () => {
    const omitted = validateWorkerCompletion({
      status: "skipped",
      reason: "no-op for this shard",
    });
    assert.equal(omitted.ok, true);

    const empty = validateWorkerCompletion({
      status: "skipped",
      commits_made: [],
    });
    assert.equal(empty.ok, true);
  });

  it("rejects non-object payloads", () => {
    assert.equal(validateWorkerCompletion(null).ok, false);
    assert.equal(validateWorkerCompletion("ok").ok, false);
    assert.equal(validateWorkerCompletion(undefined).ok, false);
  });

  it("rejects status=failed payload with a reason (BUG-G #130)", () => {
    const result = validateWorkerCompletion({
      status: "failed",
      reason: "codex stall",
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "worker_self_reported_failure:codex stall");
  });

  it("rejects status=failed payload with empty commits_made (BUG-G #130)", () => {
    const result = validateWorkerCompletion({
      status: "failed",
      commits_made: [],
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "worker_self_reported_failure:unspecified");
  });

  it("rejects status=failed payload even when commits_made has entries", () => {
    const result = validateWorkerCompletion({
      status: "failed",
      reason: "partial work then abort",
      commits_made: [{ sha: "abc1234", message: "wip" }],
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /^worker_self_reported_failure:/);
  });
});
