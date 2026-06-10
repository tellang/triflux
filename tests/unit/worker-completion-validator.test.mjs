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
      commits_made: [{ sha: "abc1234", message: "feat: add feature" }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, undefined);
  });

  it("rejects non-object payloads", () => {
    assert.equal(validateWorkerCompletion(null).ok, false);
    assert.equal(validateWorkerCompletion("ok").ok, false);
    assert.equal(validateWorkerCompletion(undefined).ok, false);
  });

  it("accepts status=failed payload with reason and no commits_made", () => {
    const result = validateWorkerCompletion({
      status: "failed",
      reason: "codex stall",
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, undefined);
  });

  it("accepts status=failed payload with empty commits_made", () => {
    const result = validateWorkerCompletion({
      status: "failed",
      commits_made: [],
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, undefined);
  });

  it("accepts status=blocked payload with optional reason and no commits_made", () => {
    const result = validateWorkerCompletion({
      status: "blocked",
      reason: "waiting on user input",
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, undefined);
  });

  it("rejects obsolete status=skipped payloads", () => {
    const result = validateWorkerCompletion({
      status: "skipped",
      reason: "old no-op contract",
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid_status:skipped");
  });
});
