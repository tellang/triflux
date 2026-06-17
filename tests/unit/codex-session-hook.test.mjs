import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runCodexSessionHook } from "../../hooks/codex-session-hook.mjs";
import { registerInteractiveSession } from "../../hooks/session-start-fast.mjs";

function payload(overrides = {}) {
  return JSON.stringify({
    session_id: "codex-session-1",
    cwd: "/work/triflux",
    hook_event_name: "session_start",
    ...overrides,
  });
}

describe("codex-session-hook", () => {
  it("register mode ensures the hub, registers the flat codex payload, drains, and returns {}", async () => {
    const calls = [];
    const result = await runCodexSessionHook(payload(), {
      argvMode: "register",
      writeStdout: false,
      hubEnsureRun: async (stdinData) => calls.push(["ensure", stdinData]),
      registerInteractiveSession: (stdinData) =>
        calls.push(["register", stdinData]),
      heartbeatInteractiveSession: () => calls.push(["heartbeat"]),
      drainPendingSynapse: async (timeoutMs) =>
        calls.push(["drain", timeoutMs]),
    });

    assert.equal(result, "{}\n");
    assert.deepEqual(calls, [
      ["ensure", payload()],
      ["register", payload()],
      ["drain", 1000],
    ]);
  });

  it("heartbeat mode heartbeats the flat codex payload and drains without hub ensure", async () => {
    const calls = [];
    const result = await runCodexSessionHook(
      payload({ hook_event_name: "user_prompt_submit" }),
      {
        argvMode: "heartbeat",
        writeStdout: false,
        hubEnsureRun: async () => calls.push(["ensure"]),
        registerInteractiveSession: () => calls.push(["register"]),
        heartbeatInteractiveSession: (stdinData) =>
          calls.push(["heartbeat", stdinData]),
        drainPendingSynapse: async (timeoutMs) =>
          calls.push(["drain", timeoutMs]),
      },
    );

    assert.equal(result, "{}\n");
    assert.deepEqual(calls, [
      ["heartbeat", payload({ hook_event_name: "user_prompt_submit" })],
      ["drain", 500],
    ]);
  });

  it("falls back to hook_event_name case-insensitively when argv mode is absent", async () => {
    const calls = [];
    await runCodexSessionHook(
      payload({ hook_event_name: "UserPromptSubmit" }),
      {
        argvMode: "",
        writeStdout: false,
        heartbeatInteractiveSession: () => calls.push("heartbeat"),
        drainPendingSynapse: async () => {},
      },
    );

    assert.deepEqual(calls, ["heartbeat"]);
  });

  it("register path emits a codex participant CTO session_started event", async () => {
    const events = [];
    await runCodexSessionHook(payload(), {
      argvMode: "register",
      writeStdout: false,
      hubEnsureRun: async () => {},
      registerInteractiveSession: (stdinData) =>
        registerInteractiveSession(stdinData, {
          register: () => {},
          heartbeat: () => {},
          gitRunner: () => {},
          resolveLakeRoot: () => ({
            projectRoot: "/work/triflux",
            lakeRoot: "/work/triflux/.triflux/lake",
          }),
          ctoAppend: (lakeRoot, event) => events.push({ lakeRoot, event }),
        }),
      drainPendingSynapse: async () => {},
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events.length, 1);
    assert.equal(events[0].lakeRoot, "/work/triflux/.triflux/lake");
    assert.equal(events[0].event.event, "session_started");
    assert.equal(events[0].event.actor.cli, "codex");
    assert.equal(events[0].event.session_id, "codex-session-1");
  });

  it("keeps hook stdout JSON-only even when side effects log to stdout", async () => {
    const writes = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = function writeForTest(
      chunk,
      encodingOrCallback,
      callback,
    ) {
      writes.push(String(chunk));
      const done =
        typeof encodingOrCallback === "function"
          ? encodingOrCallback
          : callback;
      if (typeof done === "function") done();
      return true;
    };

    try {
      const result = await runCodexSessionHook(payload(), {
        argvMode: "register",
        hubEnsureRun: async () => {
          process.stdout.write("[mcp-sync] skipped\n");
          console.log("[mcp-sync] console noise");
        },
        registerInteractiveSession: () => {
          process.stdout.write("[session-start] register noise\n");
        },
        drainPendingSynapse: async () => {
          process.stdout.write("[synapse] drain noise\n");
        },
      });

      assert.equal(result, "{}\n");
      assert.deepEqual(writes, ["{}\n"]);
      assert.doesNotThrow(() => JSON.parse(writes.join("")));
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  it("absorbs parse failures, unknown modes, and seam errors while still returning {}", async () => {
    const calls = [];
    const result = await runCodexSessionHook("{not-json", {
      argvMode: "register",
      writeStdout: false,
      hubEnsureRun: async () => {
        calls.push("ensure");
        throw new Error("hub failed");
      },
      registerInteractiveSession: () => {
        calls.push("register");
        throw new Error("register failed");
      },
      drainPendingSynapse: async () => {
        calls.push("drain");
        throw new Error("drain failed");
      },
    });

    assert.equal(result, "{}\n");
    assert.deepEqual(calls, []);
  });
});
