import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeMode,
  runAgySessionHook,
  toSessionPayload,
} from "../../hooks/agy-session-hook.mjs";
import { registerInteractiveSession } from "../../hooks/session-start-fast.mjs";

function agyPayload(overrides = {}) {
  return JSON.stringify({
    conversationId: "ec33ebf9-0cba-4100-8142-c61503f6c587",
    workspacePaths: ["/work/triflux"],
    transcriptPath: "/work/triflux/.gemini/antigravity/transcript.jsonl",
    artifactDirectoryPath: "/work/triflux/.gemini/antigravity/artifacts",
    invocationNum: 1,
    ...overrides,
  });
}

// What the adapter forwards to the session seams: the Codex-shaped payload.
function sessionPayload(overrides = {}) {
  return toSessionPayload(JSON.parse(agyPayload(overrides)));
}

describe("agy-session-hook adapter", () => {
  it("toSessionPayload maps conversationId -> session_id and workspacePaths[0] -> cwd", () => {
    const out = JSON.parse(
      toSessionPayload({
        conversationId: "conv-1",
        workspacePaths: ["/a", "/b"],
      }),
    );
    assert.deepEqual(out, {
      session_id: "conv-1",
      cwd: "/a",
      actor_cli: "agy",
    });
  });

  it("toSessionPayload falls back to process.cwd() when no workspace path is present", () => {
    const out = JSON.parse(toSessionPayload({ conversationId: "conv-2" }));
    assert.equal(out.session_id, "conv-2");
    assert.equal(out.cwd, process.cwd());
    assert.equal(out.actor_cli, "agy");
  });

  it("normalizeMode gates on invocationNum: first call registers, later calls heartbeat", () => {
    assert.equal(normalizeMode("", { invocationNum: 1 }), "register");
    assert.equal(normalizeMode("", { invocationNum: 3 }), "heartbeat");
    // explicit argv mode always wins
    assert.equal(normalizeMode("heartbeat", { invocationNum: 1 }), "heartbeat");
    assert.equal(normalizeMode("register", { invocationNum: 9 }), "register");
    // unknown invocation index defaults to register (idempotent + ensures hub)
    assert.equal(normalizeMode("", {}), "register");
  });

  it("register mode ensures the hub, registers the mapped payload, drains, returns {}", async () => {
    const calls = [];
    const result = await runAgySessionHook(agyPayload({ invocationNum: 1 }), {
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
      ["ensure", sessionPayload({ invocationNum: 1 })],
      ["register", sessionPayload({ invocationNum: 1 })],
      ["drain", 1000],
    ]);
  });

  it("suppresses side-effect stdout while preserving the final JSON hook result", async () => {
    let captured = "";
    const originalWrite = process.stdout.write;
    process.stdout.write = (chunk, encodingOrCallback, callback) => {
      captured += String(chunk);
      const done =
        typeof encodingOrCallback === "function"
          ? encodingOrCallback
          : callback;
      if (typeof done === "function") done();
      return true;
    };
    try {
      const result = await runAgySessionHook(agyPayload({ invocationNum: 1 }), {
        hubEnsureRun: async () => {
          process.stdout.write("[mcp-sync] skipped: noisy side effect\n");
          console.log("noisy console log");
        },
        registerInteractiveSession: () => {
          process.stdout.write("[register] noisy side effect\n");
        },
        drainPendingSynapse: async () => {},
      });

      assert.equal(result, "{}\n");
      assert.equal(captured, "{}\n");
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  it("heartbeat mode heartbeats the mapped payload and drains without hub ensure", async () => {
    const calls = [];
    const result = await runAgySessionHook(agyPayload({ invocationNum: 4 }), {
      writeStdout: false,
      hubEnsureRun: async () => calls.push(["ensure"]),
      registerInteractiveSession: () => calls.push(["register"]),
      heartbeatInteractiveSession: (stdinData) =>
        calls.push(["heartbeat", stdinData]),
      drainPendingSynapse: async (timeoutMs) =>
        calls.push(["drain", timeoutMs]),
    });

    assert.equal(result, "{}\n");
    assert.deepEqual(calls, [
      ["heartbeat", sessionPayload({ invocationNum: 4 })],
      ["drain", 500],
    ]);
  });

  it("explicit argv register mode overrides a later invocationNum", async () => {
    const calls = [];
    await runAgySessionHook(agyPayload({ invocationNum: 7 }), {
      argvMode: "register",
      writeStdout: false,
      hubEnsureRun: async () => calls.push("ensure"),
      registerInteractiveSession: () => calls.push("register"),
      drainPendingSynapse: async () => calls.push("drain"),
    });
    assert.deepEqual(calls, ["ensure", "register", "drain"]);
  });

  it("register path emits an agy participant CTO session_started event", async () => {
    const events = [];
    await runAgySessionHook(agyPayload({ invocationNum: 1 }), {
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
    assert.equal(events[0].event.actor.cli, "agy");
    assert.equal(
      events[0].event.session_id,
      "ec33ebf9-0cba-4100-8142-c61503f6c587",
    );
  });

  it("stays a silent no-op when conversationId is missing", async () => {
    const calls = [];
    const result = await runAgySessionHook(
      JSON.stringify({ workspacePaths: ["/work"] }),
      {
        writeStdout: false,
        hubEnsureRun: async () => calls.push("ensure"),
        registerInteractiveSession: () => calls.push("register"),
        heartbeatInteractiveSession: () => calls.push("heartbeat"),
        drainPendingSynapse: async () => calls.push("drain"),
      },
    );
    assert.equal(result, "{}\n");
    assert.deepEqual(calls, []);
  });

  it("absorbs parse failures and seam errors while still returning {}", async () => {
    const calls = [];
    const result = await runAgySessionHook("{not-json", {
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
