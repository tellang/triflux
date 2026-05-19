import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
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

const HOOK = fileURLToPath(
  new URL("../../hooks/session-end-cleanup.mjs", import.meta.url),
);

function run(payload, root, extraEnv = {}) {
  return spawnSync(process.execPath, [HOOK], {
    cwd: root,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CWD: root, ...extraEnv },
  });
}

function writeState(root, state) {
  mkdirSync(join(root, ".triflux", "subagents"), { recursive: true });
  writeFileSync(
    join(root, ".triflux", "subagents", "subagents.json"),
    JSON.stringify(state),
    "utf8",
  );
}

function writeExecutable(path, content) {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

describe("session-end-cleanup hook", () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tfx-session-end-"));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reports stale lifecycle files by default without deleting them", () => {
    writeState(root, {
      agents: {
        running: { startedAt: new Date().toISOString() },
        completed: {
          startedAt: new Date(Date.now() - 10_000).toISOString(),
          stoppedAt: new Date().toISOString(),
        },
        stale: { startedAt: new Date(Date.now() - 3_600_000).toISOString() },
      },
    });

    const result = run(
      { hook_event_name: "SessionEnd", session_id: "s1" },
      root,
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /\[session-end-cleanup\]/);
    const out = JSON.parse(result.stdout);
    const context = out.systemMessage;
    assert.match(context, /running=1/);
    assert.match(context, /completed=1/);
    assert.match(context, /stale=1/);
    assert.ok(result.stdout.length < 2048);
    assert.equal(
      existsSync(join(root, ".triflux", "subagents", "subagents.json")),
      true,
    );
  });

  it("emits SessionEnd-compatible structured JSON without event-specific output", () => {
    writeState(root, {
      agents: {
        running: { startedAt: new Date().toISOString() },
      },
    });

    const result = run(
      { hook_event_name: "SessionEnd", session_id: "s1", reason: "other" },
      root,
    );

    assert.equal(result.status, 0);
    const out = JSON.parse(result.stdout);
    assert.equal(typeof out.systemMessage, "string");
    assert.equal(out.hookSpecificOutput, undefined);
    assert.equal(out.decision, undefined);
    assert.equal(out.reason, undefined);
  });

  it("reports detached tmux session age, cwd, command, and memory estimate", () => {
    writeState(root, {
      agents: {
        running: { startedAt: new Date().toISOString() },
      },
    });
    const fakeBin = join(root, "fake-bin");
    mkdirSync(fakeBin, { recursive: true });
    writeExecutable(
      join(fakeBin, "tmux"),
      `#!/bin/sh
if [ "$1" = "list-sessions" ]; then
  printf 'tfx-old\\t0\\t%d\\n' $(($(date +%s) - 7200))
  exit 0
fi
if [ "$1" = "list-panes" ]; then
  printf '%s\\tnode\\t4242\\n' '${root}'
  exit 0
fi
exit 1
`,
    );
    writeExecutable(
      join(fakeBin, "ps"),
      `#!/bin/sh
if [ "$1" = "-o" ] && [ "$2" = "rss=" ]; then
  printf '65536\\n'
  exit 0
fi
exit 1
`,
    );

    const result = run(
      { hook_event_name: "SessionEnd", session_id: "s1", reason: "other" },
      root,
      { PATH: `${fakeBin}:${process.env.PATH}` },
    );

    assert.equal(result.status, 0);
    const out = JSON.parse(result.stdout);
    const match = out.systemMessage.match(/detached_tmux_sessions=(\[.*\])$/);
    assert.ok(match, out.systemMessage);
    const sessions = JSON.parse(match[1]);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].name, "tfx-old");
    assert.ok(sessions[0].age);
    assert.equal(sessions[0].cwd, root);
    assert.equal(sessions[0].command, "node");
    assert.equal(sessions[0].memory_estimate_mb, 64);
  });

  it("deletes stale lifecycle files only when opt-in cleanup is enabled", () => {
    writeState(root, {
      agents: {
        stale: { startedAt: new Date(Date.now() - 3_600_000).toISOString() },
      },
    });

    const result = run(
      { hook_event_name: "SessionEnd", session_id: "s1" },
      root,
      { TFX_SESSION_END_CLEANUP: "1" },
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /cleanup=removed/);
    assert.equal(
      existsSync(join(root, ".triflux", "subagents", "subagents.json")),
      false,
    );
  });

  it("opt-in cleanup prunes stale running agents and preserves fresh state", () => {
    writeState(root, {
      agents: {
        fresh: { startedAt: new Date().toISOString(), agentType: "executor" },
        stale: {
          startedAt: new Date(Date.now() - 3_600_000).toISOString(),
          agentType: "planner",
        },
      },
      completed: [{ key: "done", stoppedAt: new Date().toISOString() }],
    });

    const result = run(
      { hook_event_name: "SessionEnd", session_id: "s1" },
      root,
      { TFX_SESSION_END_CLEANUP: "1" },
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /cleanup=pruned-1/);
    const state = JSON.parse(
      readFileSync(
        join(root, ".triflux", "subagents", "subagents.json"),
        "utf8",
      ),
    );
    assert.ok(state.agents.fresh);
    assert.equal(state.agents.stale, undefined);
    assert.equal(state.completed.length, 1);
  });

  it("exits silently for non-SessionEnd events", () => {
    writeState(root, {
      agents: {
        stale: { startedAt: new Date(Date.now() - 3_600_000).toISOString() },
      },
    });

    const result = run({ hook_event_name: "SessionStart" }, root, {
      TFX_SESSION_END_CLEANUP: "1",
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(
      existsSync(join(root, ".triflux", "subagents", "subagents.json")),
      true,
    );
  });

  it("no-ops silently when no state file exists", () => {
    const result = run(
      { hook_event_name: "SessionEnd", session_id: "s1" },
      root,
    );

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });

  it("no-ops safely for malformed lifecycle JSON", () => {
    mkdirSync(join(root, ".triflux", "subagents"), { recursive: true });
    writeFileSync(
      join(root, ".triflux", "subagents", "subagents.json"),
      "{not json",
      "utf8",
    );

    const result = run(
      { hook_event_name: "SessionEnd", session_id: "s1" },
      root,
      { TFX_SESSION_END_CLEANUP: "1" },
    );

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(
      existsSync(join(root, ".triflux", "subagents", "subagents.json")),
      true,
    );
  });
});
