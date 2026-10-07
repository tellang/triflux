import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "tfx-s5-state-"));
const previousPidDir = process.env.TFX_HUB_PID_DIR;
process.env.TFX_HUB_PID_DIR = dir;
const { startHeadlessTeam } = await import(
  "../../hub/team/cli/commands/start/start-headless.mjs"
);
const { loadTeamState, saveTeamState, clearTeamState } = await import(
  "../../hub/team/cli/services/state-store.mjs"
);
const { isTeamAlive } = await import(
  "../../hub/team/cli/services/runtime-mode.mjs"
);

after(() => {
  if (previousPidDir === undefined) delete process.env.TFX_HUB_PID_DIR;
  else process.env.TFX_HUB_PID_DIR = previousPidDir;
  rmSync(dir, { recursive: true, force: true });
});

const options = (sessionId) => ({
  sessionId,
  task: "test",
  lead: "claude",
  agents: ["codex"],
  subtasks: ["test"],
  layout: "2x2",
  dashboard: false,
});

test("headless state remains readable while running and is cleared after completion", async () => {
  let finish;
  let killed = false;
  const result = startHeadlessTeam({
    ...options("state-running"),
    _deps: {
      runHeadlessInteractive: async (sessionName, _assignments, opts) => {
        opts.onProgress({
          type: "session_created",
          sessionName: "actual-session",
        });
        await new Promise((resolve) => {
          finish = resolve;
        });
        return {
          sessionName,
          results: [],
          kill() {
            killed = true;
          },
        };
      },
    },
  });
  const running = loadTeamState("state-running");
  assert.equal(running.sessionName, "actual-session");
  assert.equal(isTeamAlive(running), true);
  assert.equal(killed, false);
  finish();
  await result;
  assert.equal(killed, true);
  assert.equal(loadTeamState("state-running"), null);
});

test("failed headless startup clears its state and preserves the error", async () => {
  await assert.rejects(
    startHeadlessTeam({
      ...options("state-failed"),
      _deps: {
        runHeadlessInteractive() {
          throw new Error("dispatch failed");
        },
      },
    }),
    /dispatch failed/,
  );
  assert.equal(loadTeamState("state-failed"), null);
});

test("stop targets the requested session and an unknown id leaves other states intact", async () => {
  const { teamStop } = await import("../../hub/team/cli/commands/stop.mjs");
  for (const sessionId of ["state-one", "state-two"])
    saveTeamState(
      { sessionId, sessionName: `${sessionId}-${Date.now()}-unused` },
      sessionId,
    );
  try {
    await teamStop(["unknown-id"]);
    assert.ok(loadTeamState("state-one"));
    assert.ok(loadTeamState("state-two"));
    await teamStop(["state-one"]);
    assert.equal(loadTeamState("state-one"), null);
    assert.ok(loadTeamState("state-two"));
  } finally {
    clearTeamState("state-one");
    clearTeamState("state-two");
  }
});

test("stop signals the headless owner and clears only its state", async (t) => {
  const { teamStop } = await import("../../hub/team/cli/commands/stop.mjs");
  const sessionId = "state-headless-stop";
  const ownerPid = 999999;
  const signals = [];
  t.mock.method(process, "kill", (pid, signal) => {
    signals.push([pid, signal]);
    assert.ok(loadTeamState(sessionId));
  });
  saveTeamState({ sessionId, teammateMode: "headless", ownerPid }, sessionId);
  saveTeamState({ sessionId: "state-other" }, "state-other");
  try {
    await teamStop([sessionId]);
    assert.deepEqual(signals, [[ownerPid, "SIGTERM"]]);
    assert.equal(loadTeamState(sessionId), null);
    assert.ok(loadTeamState("state-other"));
  } finally {
    clearTeamState(sessionId);
    clearTeamState("state-other");
  }
});

test("headless pane commands reject before accessing the owner or multiplexer", async (t) => {
  t.mock.method(process, "kill", () => {
    assert.fail("headless pane commands must not probe the owner");
  });
  const sessionId = "state-headless-commands";
  saveTeamState(
    { sessionId, teammateMode: "headless", ownerPid: 999999 },
    sessionId,
  );
  try {
    for (const [command, handler] of [
      ["send", "teamSend"],
      ["interrupt", "teamInterrupt"],
      ["control", "teamControl"],
      ["focus", "teamFocus"],
    ]) {
      const module = await import(`../../hub/team/cli/commands/${command}.mjs`);
      await assert.rejects(
        module[handler](["worker-1", "test"]),
        /headless 실행에는 지원하지 않는다/,
      );
    }
    assert.ok(loadTeamState(sessionId));
  } finally {
    clearTeamState(sessionId);
  }
});
