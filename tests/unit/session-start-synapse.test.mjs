// tests/unit/session-start-synapse.test.mjs — SessionStart self-register seam
//
// Exercises registerInteractiveSession() via its injectable seams (register /
// heartbeat / gitRunner) so the test is hermetic: no real hub, no real git.
// Asserts the minimal-register payload shape, the no-session no-op, that pid is
// never sent (hook PID ≠ session PID), and that the blocking path stays git-free
// (worktree/branch arrive asynchronously via heartbeat, never inline).

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  emitParticipantSessionStarted,
  heartbeatInteractiveSession,
  registerInteractiveSession,
} from "../../hooks/session-start-fast.mjs";

function payloadJson(obj) {
  return JSON.stringify(obj);
}

describe("registerInteractiveSession (SessionStart self-register)", () => {
  it("registers a minimal interactive payload from cwd alone (no git, no pid)", () => {
    const registered = [];
    const ctoEvents = [];
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
        ctoAppend: (lakeRoot, event) => ctoEvents.push({ lakeRoot, event }),
        resolveLakeRoot: (cwd) => ({
          projectRoot: cwd,
          lakeRoot: `${cwd}/.triflux/lake`,
        }),
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
    assert.equal(ctoEvents.length, 0, "CTO append is fire-and-forget");
  });

  it("emits a compact non-policy CTO session_started event", async () => {
    const appended = [];

    const result = await emitParticipantSessionStarted(
      payloadJson({
        session_id: "sess-cto",
        cwd: "/home/dev/proj",
        hook_event_name: "SessionStart",
      }),
      {
        resolveLakeRoot: (cwd) => ({
          projectRoot: "/home/dev/proj",
          lakeRoot: `${cwd}/.triflux/lake`,
        }),
        ctoAppend: async (lakeRoot, event) => {
          appended.push({ lakeRoot, event });
          return { appended: true, event };
        },
        now: "2026-06-17T00:00:00.000Z",
      },
    );

    assert.equal(result.appended, true);
    assert.deepEqual(appended, [
      {
        lakeRoot: "/home/dev/proj/.triflux/lake",
        event: {
          event: "session_started",
          source: "tfx_participant_hook",
          session_id: "sess-cto",
          project_root: "/home/dev/proj",
          worktree_path: "/home/dev/proj",
          branch: "",
          status: "active",
          actor: {
            cli: "claude",
            session_id: "sess-cto",
            host: "local",
          },
          summary: "claude session_started sess-cto",
          now: "2026-06-17T00:00:00.000Z",
        },
      },
    ]);
  });

  it("swallows CTO append failures without blocking SessionStart", async () => {
    const result = await emitParticipantSessionStarted(
      payloadJson({ session_id: "sess-fail", cwd: "/home/dev/proj" }),
      {
        resolveLakeRoot: () => ({
          projectRoot: "/home/dev/proj",
          lakeRoot: "/home/dev/proj/.triflux/lake",
        }),
        ctoAppend: async () => {
          throw new Error("ledger unavailable");
        },
      },
    );

    assert.equal(result, null);
  });

  it("appends session_started to the canonical project CTO ledger", async () => {
    const root = mkdtempSync(join(tmpdir(), "tfx-participant-cto-"));
    try {
      await emitParticipantSessionStarted(
        payloadJson({
          session_id: "sess-ledger",
          cwd: root,
          hook_event_name: "SessionStart",
        }),
        { now: "2026-06-17T00:00:00.000Z" },
      );

      const lines = readFileSync(
        join(root, ".triflux", "lake", "ledger.jsonl"),
        "utf8",
      )
        .trim()
        .split("\n");
      assert.equal(lines.length, 1);
      const event = JSON.parse(lines[0]);
      assert.equal(event.event, "session_started");
      assert.equal(event.source, "tfx_participant_hook");
      assert.equal(event.ref.session_id, "sess-ledger");
      assert.equal(event.ref.actor.cli, "claude");
      assert.equal(event.ref.status, "active");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
        ctoAppend: () => {},
        resolveLakeRoot: (cwd) => ({
          projectRoot: cwd,
          lakeRoot: `${cwd}/lake`,
        }),
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
        ctoAppend: () => {},
        resolveLakeRoot: (cwd) => ({
          projectRoot: cwd,
          lakeRoot: `${cwd}/lake`,
        }),
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

describe("heartbeatInteractiveSession (UserPromptSubmit liveness)", () => {
  it("fires a heartbeat with cwd-derived worktree, host, and prompt task summary", () => {
    const heartbeats = [];

    heartbeatInteractiveSession(
      payloadJson({
        session_id: "sess-hb",
        cwd: "/home/dev/proj",
        prompt: "implement the live-session heartbeat",
      }),
      {
        heartbeat: (sessionId, partial) =>
          heartbeats.push({ sessionId, partial }),
      },
    );

    assert.equal(heartbeats.length, 1);
    assert.equal(heartbeats[0].sessionId, "sess-hb");
    assert.equal(heartbeats[0].partial.worktreePath, "/home/dev/proj");
    assert.equal(heartbeats[0].partial.host, "local");
    assert.equal(
      heartbeats[0].partial.taskSummary,
      "implement the live-session heartbeat",
    );
    // pid must NOT be sent — liveness is the TTL + heartbeat's job (cf. register).
    assert.equal("pid" in heartbeats[0].partial, false);
  });

  it("caps the task summary at 100 chars (buildSynapseTaskSummary contract)", () => {
    const heartbeats = [];

    heartbeatInteractiveSession(
      payloadJson({
        session_id: "sess-long",
        cwd: "/p",
        prompt: "x".repeat(250),
      }),
      {
        heartbeat: (sessionId, partial) =>
          heartbeats.push({ sessionId, partial }),
      },
    );

    assert.equal(heartbeats[0].partial.taskSummary.length, 100);
  });

  it("omits taskSummary when the payload carries no prompt", () => {
    const heartbeats = [];

    heartbeatInteractiveSession(
      payloadJson({ session_id: "sess-noprompt", cwd: "/p" }),
      {
        heartbeat: (sessionId, partial) =>
          heartbeats.push({ sessionId, partial }),
      },
    );

    assert.equal(heartbeats.length, 1);
    assert.equal("taskSummary" in heartbeats[0].partial, false);
  });

  it("is a no-op when the payload has no session_id", () => {
    const heartbeats = [];

    heartbeatInteractiveSession(payloadJson({ cwd: "/p", prompt: "hi" }), {
      heartbeat: (sessionId, partial) =>
        heartbeats.push({ sessionId, partial }),
    });

    assert.equal(heartbeats.length, 0);
  });

  it("is a no-op (no throw) on unparseable payload", () => {
    const heartbeats = [];

    assert.doesNotThrow(() =>
      heartbeatInteractiveSession("{not json", {
        heartbeat: (sessionId, partial) =>
          heartbeats.push({ sessionId, partial }),
      }),
    );

    assert.equal(heartbeats.length, 0);
  });
});
