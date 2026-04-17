import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  detectMultiplexer,
  hasWindowsTerminal,
  listSessions,
  resolveAttachCommand,
  sessionExists,
} from "../../hub/team/session.mjs";

describe("session.mjs", () => {
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
    assert.ok(
      mux === null ||
        ["tmux", "git-bash-tmux", "wsl-tmux", "psmux"].includes(mux),
    );
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
