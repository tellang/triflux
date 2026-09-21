import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as sessionModule from "../../hub/team/session.mjs";
import {
  detectMultiplexer,
  hasWindowsTerminal,
  listSessions,
  resolveAttachCommand,
  sessionExists,
} from "../../hub/team/session.mjs";

describe("session.mjs", () => {
  it("non-TTY attach split argv는 requesting lead pane을 exact target으로 사용한다", () => {
    assert.deepEqual(
      sessionModule.buildSplitAttachArgs(
        "worker-session",
        "%42",
        "/tmp/tmux socket;literal,123,0",
      ),
      [
        "split-window",
        "-t",
        "%42",
        "-v",
        "-l",
        "50%",
        "env -u TMUX tmux -S '/tmp/tmux socket;literal' attach -t 'worker-session'",
      ],
    );
  });

  it("non-TTY attach split argv는 공백, 작은따옴표, 세미콜론이 든 세션 이름을 한 덩어리로 인용한다", () => {
    assert.equal(
      sessionModule
        .buildSplitAttachArgs(
          "worker session's;unsafe",
          "%42",
          "/tmp/tmux-501/default,123,0",
        )
        .at(-1),
      "env -u TMUX tmux -S '/tmp/tmux-501/default' attach -t 'worker session'\\''s;unsafe'",
    );
  });

  it("non-TTY attach split argv는 빈 세션 이름을 거부한다", () => {
    assert.throws(
      () =>
        sessionModule.buildSplitAttachArgs(
          "",
          "%42",
          "/tmp/tmux-501/default,123,0",
        ),
      /session name is required/u,
    );
  });

  it("splitAttachToClient는 explicit pane으로만 split하고 focused client를 조회하지 않는다", () => {
    const calls = [];
    assert.equal(
      sessionModule.splitAttachToClient("worker-session", {
        targetPane: "%42",
        tmuxEnv: "/tmp/tmux-501/default,123,0",
        _deps: {
          detectMultiplexer: () => "tmux",
          spawnSync: (command, args) => {
            calls.push([command, args]);
            return { status: 0 };
          },
        },
      }),
      true,
    );
    assert.deepEqual(calls, [
      [
        "tmux",
        sessionModule.buildSplitAttachArgs(
          "worker-session",
          "%42",
          "/tmp/tmux-501/default,123,0",
        ),
      ],
    ]);
  });

  it("splitAttachToClient는 requesting lead pane이 없으면 tmux를 실행하지 않는다", () => {
    let called = false;
    assert.equal(
      sessionModule.splitAttachToClient("worker-session", {
        _deps: {
          detectMultiplexer: () => "tmux",
          spawnSync: () => {
            called = true;
            return { status: 0 };
          },
        },
      }),
      false,
    );
    assert.equal(called, false);
  });

  it("splitAttachToClient는 requesting lead TMUX socket이 없으면 tmux를 실행하지 않는다", () => {
    let called = false;
    assert.equal(
      sessionModule.splitAttachToClient("worker-session", {
        targetPane: "%42",
        _deps: {
          detectMultiplexer: () => "tmux",
          spawnSync: () => {
            called = true;
            return { status: 0 };
          },
        },
      }),
      false,
    );
    assert.equal(called, false);
  });

  it("resolveAttachCommand는 git-bash-tmux에서 Git Bash attach spec를 반환해야 한다", () => {
    const spec = resolveAttachCommand("demo-session", {
      mux: "git-bash-tmux",
      bashCommand: "C:/Program Files/Git/bin/bash.exe",
    });

    assert.deepEqual(spec, {
      command: "C:/Program Files/Git/bin/bash.exe",
      args: ["-lc", "tmux attach-session -t demo-session"],
    });
  });

  it("detectMultiplexer()는 string 또는 null을 반환해야 한다", () => {
    const mux = detectMultiplexer();
    assert.ok(mux === null || ["tmux", "git-bash-tmux", "psmux"].includes(mux));
  });

  it("sessionExists(nonexistent)는 false를 반환해야 한다", () => {
    const missingSession = `nonexistent-session-${Date.now()}-${Math.random()}`;
    assert.equal(sessionExists(missingSession), false);
  });

  it("listSessions()는 배열을 반환해야 한다", () => {
    const sessions = listSessions();
    assert.ok(Array.isArray(sessions));
  });

  it("hasWindowsTerminal()은 boolean을 반환해야 한다", () => {
    const hasWt = hasWindowsTerminal();
    assert.equal(typeof hasWt, "boolean");
  });
});

const sessionSrc = readFileSync(
  join(import.meta.dirname, "../../hub/team/session.mjs"),
  "utf8",
);

describe("session.mjs wt-manager migration", () => {
  it("Git Bash 후보 배열 대신 bash-path helper를 사용한다", () => {
    assert.ok(sessionSrc.includes("resolveGitBashExecutable"));
    assert.ok(!sessionSrc.includes("GIT_BASH_CANDIDATES"));
  });

  it("hasWindowsTerminal이 env-detect의 getEnvironment를 사용한다", () => {
    assert.ok(sessionSrc.includes("getEnvironment"));
    assert.ok(sessionSrc.includes(".terminal.hasWt"));
  });

  it("createWtManager를 import한다", () => {
    assert.ok(sessionSrc.includes('from "./wt-manager.mjs"'));
  });

  it("wt.exe 직접 호출이 없다", () => {
    assert.ok(
      !sessionSrc.match(/(?:spawn|execFile(?:Sync)?)\s*\(\s*["']wt\.exe/),
    );
  });
});
