import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const TRACKER = fileURLToPath(
  new URL("../../hooks/subagent-tracker.mjs", import.meta.url),
);
const VERIFIER = fileURLToPath(
  new URL("../../hooks/subagent-verifier.mjs", import.meta.url),
);

function runHook(script, payload, stateDir) {
  return spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, TRIFLUX_SUBAGENT_STATE_DIR: stateDir },
  });
}

function readState(stateDir) {
  return JSON.parse(readFileSync(join(stateDir, "subagents.json"), "utf8"));
}

function runHookAsync(script, payload, stateDir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, TRIFLUX_SUBAGENT_STATE_DIR: stateDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

describe("subagent lifecycle tracking", { concurrency: false }, () => {
  let stateDir;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "tfx-subagent-tracker-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("records SubagentStart and matches SubagentStop by id", () => {
    const start = runHook(
      TRACKER,
      {
        hook_event_name: "SubagentStart",
        session_id: "s1",
        agent_id: "a1",
        agent_type: "executor",
        expectedDeliverables: ["changed files", "tests"],
      },
      stateDir,
    );
    assert.equal(start.status, 0);
    assert.equal(start.stdout, "");

    let state = readState(stateDir);
    assert.equal(Object.keys(state.agents).length, 1);
    assert.equal(state.agents.a1.sessionId, "s1");
    assert.equal(state.agents.a1.agentType, "executor");
    assert.deepEqual(state.agents.a1.expectedDeliverables, [
      "changed files",
      "tests",
    ]);

    const stop = runHook(
      TRACKER,
      {
        hook_event_name: "SubagentStop",
        session_id: "s1",
        agent_id: "a1",
        agent_type: "executor",
      },
      stateDir,
    );
    assert.equal(stop.status, 0);
    const out = JSON.parse(stop.stdout);
    assert.match(out.systemMessage, /executor/);
    assert.match(out.systemMessage, /duration=\d+ms/);
    assert.match(out.systemMessage, /running=0/);
    assert.match(out.systemMessage, /completed=1/);

    state = readState(stateDir);
    assert.equal(Object.keys(state.agents).length, 0);
    assert.equal(state.completed.length, 1);
    assert.equal(state.completed[0].key, "a1");
  });

  it("deduplicates repeated SubagentStart events for the same key", () => {
    const payload = {
      hook_event_name: "SubagentStart",
      session_id: "s1",
      agent_id: "a1",
      agent_type: "planner",
    };
    runHook(TRACKER, payload, stateDir);
    runHook(TRACKER, payload, stateDir);
    const state = readState(stateDir);
    assert.equal(Object.keys(state.agents).length, 1);
    assert.equal(state.completed.length, 0);
  });

  it("falls back to subagent id and session/type key matching", () => {
    assert.equal(
      runHook(
        TRACKER,
        {
          hook_event_name: "SubagentStart",
          session_id: "s2",
          subagent_id: "sub-1",
          subagent_type: "researcher",
        },
        stateDir,
      ).status,
      0,
    );
    let state = readState(stateDir);
    assert.ok(state.agents["sub-1"]);

    assert.equal(
      runHook(
        TRACKER,
        {
          hook_event_name: "SubagentStart",
          session_id: "s3",
          subagent_type: "critic",
        },
        stateDir,
      ).status,
      0,
    );
    state = readState(stateDir);
    assert.ok(state.agents["s3:critic"]);

    const stop = runHook(
      TRACKER,
      {
        hook_event_name: "SubagentStop",
        session_id: "s3",
        subagent_type: "critic",
      },
      stateDir,
    );
    assert.equal(stop.status, 0);
    assert.match(JSON.parse(stop.stdout).systemMessage, /critic/);
    state = readState(stateDir);
    assert.ok(state.agents["sub-1"]);
    assert.equal(state.agents["s3:critic"], undefined);
    assert.equal(state.completed[0].key, "s3:critic");
  });

  it("ignores malformed and unrelated events silently", () => {
    const malformed = spawnSync(process.execPath, [TRACKER], {
      input: "not json",
      encoding: "utf8",
      env: { ...process.env, TRIFLUX_SUBAGENT_STATE_DIR: stateDir },
    });
    assert.equal(malformed.status, 0);
    assert.equal(malformed.stdout, "");

    const unrelated = runHook(
      TRACKER,
      { hook_event_name: "PreToolUse", tool_name: "Bash" },
      stateDir,
    );
    assert.equal(unrelated.status, 0);
    assert.equal(unrelated.stdout, "");
    assert.equal(existsSync(join(stateDir, "subagents.json")), false);
  });

  it("drops stale running agents and caps completed summaries", () => {
    mkdirSync(stateDir, { recursive: true });
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      join(stateDir, "subagents.json"),
      JSON.stringify({
        version: 1,
        updatedAt: old,
        agents: {
          stale: { key: "stale", startedAt: old, agentType: "executor" },
        },
        completed: Array.from({ length: 20 }, (_, index) => ({
          key: `done-${index}`,
          agentType: "executor",
          stoppedAt: old,
          durationMs: index,
        })),
      }),
      "utf8",
    );

    const stop = runHook(
      TRACKER,
      {
        hook_event_name: "SubagentStop",
        session_id: "s3",
        agent_id: "fresh",
        agent_type: "executor",
      },
      stateDir,
    );

    assert.equal(stop.status, 0);
    const state = readState(stateDir);
    assert.equal(state.agents.stale, undefined);
    assert.equal(state.completed.length, 20);
    assert.equal(state.completed.at(-1).key, "fresh");
  });

  it("preserves concurrent SubagentStart updates under lock", async () => {
    const starts = Array.from({ length: 30 }, (_, index) =>
      runHookAsync(
        TRACKER,
        {
          hook_event_name: "SubagentStart",
          session_id: "s-concurrent",
          agent_id: `agent-${index}`,
          agent_type: "executor",
        },
        stateDir,
      ),
    );
    const results = await Promise.all(starts);
    assert.deepEqual(
      results.map((result) => result.status),
      Array.from({ length: 30 }, () => 0),
    );
    const state = readState(stateDir);
    assert.equal(Object.keys(state.agents).length, 30);
  });

  it("does not make verifier warn for a start payload without output", () => {
    const result = runHook(
      VERIFIER,
      {
        hook_event_name: "SubagentStart",
        session_id: "s1",
        agent_id: "a1",
        agent_type: "executor",
      },
      stateDir,
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });

  it("verifier keeps existing empty-output warning on SubagentStop", () => {
    const result = runHook(
      VERIFIER,
      {
        hook_event_name: "SubagentStop",
        session_id: "s1",
        agent_id: "a1",
        agent_type: "executor",
        result: "",
      },
      stateDir,
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout, /subagent-verifier/);
  });
});
