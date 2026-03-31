import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildBackgroundCompletionSummary,
  buildWtAttachArgs,
  createIsolatedSession,
  createIsolatedSessionName,
  emitBackgroundCompletionSummary,
  evaluateContextDrift,
} from "../../scripts/session-spawn-helper.mjs";

describe("session-spawn-helper createIsolatedSessionName()", () => {
  it("uses required tfx-isolated-{timestamp} format", () => {
    const sessionName = createIsolatedSessionName(1735689600123);
    assert.equal(sessionName, "tfx-isolated-1735689600123");
  });
});

describe("session-spawn-helper createIsolatedSession()", () => {
  it("creates isolated psmux session and optional initial command", () => {
    const calls = [];
    const result = createIsolatedSession(
      {
        timestamp: 1735689600123,
        initialCommand: "echo hello",
      },
      {
        createSessionFn: (...args) => calls.push({ type: "create", args }),
        sendKeysFn: (...args) => calls.push({ type: "send", args }),
      },
    );

    assert.equal(result.sessionName, "tfx-isolated-1735689600123");
    assert.equal(result.paneId, "tfx-isolated-1735689600123:0.0");
    assert.deepEqual(calls[0], {
      type: "create",
      args: ["tfx-isolated-1735689600123", { layout: "1xN", paneCount: 1 }],
    });
    assert.deepEqual(calls[1], {
      type: "send",
      args: ["tfx-isolated-1735689600123:0.0", "echo hello", true],
    });
  });
});

describe("session-spawn-helper buildWtAttachArgs()", () => {
  it("attaches via wt triflux profile", () => {
    const args = buildWtAttachArgs("tfx-isolated-1735689600123");
    assert.deepEqual(args, [
      "new-tab",
      "-p",
      "triflux",
      "--title",
      "tfx-isolated-1735689600123",
      "--",
      "psmux",
      "attach",
      "-t",
      "tfx-isolated-1735689600123",
    ]);
  });
});

describe("session-spawn-helper evaluateContextDrift()", () => {
  it("marks drift=true when overlap with task context is too low", () => {
    const result = evaluateContextDrift({
      taskPrompt: "Implement context isolation for psmux attach flow",
      latestOutput: "Updated README badges and npm keywords only",
      minOverlapRatio: 0.5,
    });
    assert.equal(result.drift, true);
    assert.equal(result.reason, "token-overlap-low");
  });

  it("keeps drift=false when output stays on task", () => {
    const result = evaluateContextDrift({
      taskPrompt: "Implement context isolation for psmux attach flow",
      latestOutput: "Implemented psmux isolation and attach flow update",
      minOverlapRatio: 0.3,
    });
    assert.equal(result.drift, false);
    assert.equal(result.reason, "token-overlap-ok");
  });
});

describe("session-spawn-helper background completion summary", () => {
  it("builds stdout-friendly summary payload", () => {
    const summary = buildBackgroundCompletionSummary({
      sessionName: "tfx-isolated-1735689600123",
      exitCode: 0,
      taskPrompt: "Implement context isolation",
      stdoutText: "Implemented context isolation and added tests.",
    });
    assert.equal(summary.status, "success");
    assert.match(summary.summaryLine, /\[session=tfx-isolated-1735689600123\]/u);
    assert.match(summary.summaryLine, /context_drift=no/u);
  });

  it("emits summary to stdout writer", () => {
    const writes = [];
    const writer = {
      write(chunk) {
        writes.push(String(chunk));
      },
    };
    emitBackgroundCompletionSummary(
      {
        sessionName: "tfx-isolated-1735689600123",
        exitCode: 1,
        taskPrompt: "Implement context isolation",
        stderrText: "Unhandled exception while attaching session",
      },
      writer,
    );
    assert.equal(writes.length, 1);
    assert.match(writes[0], /status=failed/u);
  });
});
