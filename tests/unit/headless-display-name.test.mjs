import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildHeadlessAssignments } from "../../hub/team/cli/commands/start/start-headless.mjs";
import { normalizeHeadlessRole } from "../../hub/team/headless.mjs";

describe("headless displayName / role separation", () => {
  it("keeps generated worker labels out of assignment role", () => {
    const assignments = buildHeadlessAssignments({
      agents: ["codex"],
      subtasks: ["implement the fix"],
      assigns: [],
      mcpProfile: "auto",
      model: "test-model",
      cwd: "/tmp",
    });

    assert.equal(assignments[0].role, "");
    assert.equal(assignments[0].displayName, "worker-1");
  });

  it("drops worker-like role pollution while preserving validated agent roles", () => {
    assert.equal(normalizeHeadlessRole("worker-2"), "");
    assert.equal(normalizeHeadlessRole("executor"), "executor");
  });
});
