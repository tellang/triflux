// tests/unit/session-start-synapse.test.mjs — SessionStart self-register seam
//
// Exercises registerInteractiveSession() via its injectable seams (register /
// heartbeat / gitRunner) so the test is hermetic: no real hub, no real git.
// Asserts the minimal-register payload shape, the no-session no-op, that pid is
// never sent (hook PID ≠ session PID), and that the blocking path stays git-free
// (worktree/branch arrive asynchronously via heartbeat, never inline).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { registerInteractiveSession } from "../../hooks/session-start-fast.mjs";

function payloadJson(obj) {
  return JSON.stringify(obj);
}

describe("registerInteractiveSession (SessionStart self-register)", () => {
  it("registers a minimal interactive payload from cwd alone (no git, no pid)", () => {
    const registered = [];
    let gitCalled = false;

    registerInteractiveSession(
      payloadJson({ session_id: "sess-abc", cwd: "/home/dev/proj" }),
      {
        register: (meta) => registered.push(meta),
        heartbeat: () => {},
        // gitRunner is async-by-contract; if it were awaited inline the register
        // would not have happened yet. Mark it called but never resolve here.
        gitRunner: () => {
          gitCalled = true;
        },
      },
    );

    // Register happens synchronously, before any git resolution.
    assert.equal(registered.length, 1);
    const meta = registered[0];
    assert.equal(meta.sessionId, "sess-abc");
    assert.equal(meta.cwd, "/home/dev/proj");
    assert.equal(meta.worktreePath, "/home/dev/proj");
    assert.equal(meta.branch, "");
    assert.equal(meta.sessionKind, "interactive");
    assert.equal(meta.host, "local");
    assert.equal(meta.isRemote, false);
    // pid must NOT be present — the hook PID is not the session PID.
    assert.equal("pid" in meta, false);
    // git enrichment is scheduled (async), not run on the blocking path.
    assert.equal(gitCalled, true);
  });

  it("is a no-op when the payload has no session_id", () => {
    const registered = [];
    let gitCalled = false;

    registerInteractiveSession(payloadJson({ cwd: "/home/dev/proj" }), {
      register: (meta) => registered.push(meta),
      heartbeat: () => {},
      gitRunner: () => {
        gitCalled = true;
      },
    });

    assert.equal(registered.length, 0);
    assert.equal(gitCalled, false);
  });

  it("is a no-op (no throw) on unparseable payload", () => {
    const registered = [];
    assert.doesNotThrow(() =>
      registerInteractiveSession("{not json", {
        register: (meta) => registered.push(meta),
        heartbeat: () => {},
        gitRunner: () => {},
      }),
    );
    assert.equal(registered.length, 0);
  });

  it("enriches worktree/branch asynchronously via heartbeat (off the blocking path)", async () => {
    const registered = [];
    const heartbeats = [];

    registerInteractiveSession(
      payloadJson({ session_id: "sess-enrich", cwd: "/home/dev/proj" }),
      {
        register: (meta) => registered.push(meta),
        heartbeat: (sessionId, partial) =>
          heartbeats.push({ sessionId, partial }),
        // Resolve git context out-of-band, simulating async execFile callbacks.
        gitRunner: (_cwd, args, cb) => {
          if (args[1] === "--show-toplevel") {
            setImmediate(() => cb("/home/dev/proj/.wt/shard-1"));
          } else {
            setImmediate(() => cb("feature/x"));
          }
        },
      },
    );

    // Synchronous register already done; heartbeat not yet (still async).
    assert.equal(registered.length, 1);
    assert.equal(heartbeats.length, 0);

    // Let the async git callbacks + heartbeat flush.
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(heartbeats.length, 1);
    assert.equal(heartbeats[0].sessionId, "sess-enrich");
    assert.equal(
      heartbeats[0].partial.worktreePath,
      "/home/dev/proj/.wt/shard-1",
    );
    assert.equal(heartbeats[0].partial.branch, "feature/x");
  });

  it("skips the enrich heartbeat when git adds nothing (non-repo cwd)", async () => {
    const registered = [];
    const heartbeats = [];

    registerInteractiveSession(
      payloadJson({ session_id: "sess-norepo", cwd: "/tmp/plain" }),
      {
        register: (meta) => registered.push(meta),
        heartbeat: (sessionId, partial) =>
          heartbeats.push({ sessionId, partial }),
        // Non-repo: both git calls fail → empty strings.
        gitRunner: (_cwd, _args, cb) => setImmediate(() => cb("")),
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(registered.length, 1);
    // worktreePath defaults back to cwd and branch is empty → no new info → no heartbeat.
    assert.equal(heartbeats.length, 0);
  });
});
