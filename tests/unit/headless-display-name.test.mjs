import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripAnsi } from "../../hub/team/ansi.mjs";
import { buildHeadlessAssignments } from "../../hub/team/cli/commands/start/start-headless.mjs";
import {
  normalizeHeadlessRole,
  resolveHeadlessDisplayName,
} from "../../hub/team/headless.mjs";
import { createLogDashboard } from "../../hub/team/tui.mjs";

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

  it("uses displayName as the UI label when role is empty", () => {
    assert.equal(
      resolveHeadlessDisplayName({ role: "", displayName: "worker-3" }, ""),
      "worker-3",
    );
  });

  it("renders displayName without injecting it into role", () => {
    let output = "";
    const fakeStream = {
      write: (s) => {
        output += s;
      },
      columns: 160,
      isTTY: false,
    };
    const tui = createLogDashboard({
      stream: fakeStream,
      refreshMs: 0,
      columns: 160,
    });

    tui.updateWorker("worker-1", {
      cli: "codex",
      displayName: "worker-1",
      role: "",
      status: "running",
    });
    tui.render();

    const clean = stripAnsi(output);
    assert.ok(clean.includes("worker-1"), "displayName should be visible");
    assert.equal(clean.includes("(worker-1)"), false, "role must stay empty");
    tui.close();
  });
});
