import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ensureTmuxOrExit,
  normalizeTeammateMode,
} from "../../hub/team/cli/services/runtime-mode.mjs";

const deps = (platform, mux, isTTY = true, env = {}) => ({
  platform,
  isTTY,
  env,
  detectMultiplexer: () => mux,
});

test("auto selects an available platform multiplexer", () => {
  for (const [platform, mux, expected] of [
    ["win32", "psmux", "psmux"],
    ["darwin", "tmux", "tmux"],
    ["linux", "tmux", "tmux"],
    ["win32", "git-bash-tmux", "tmux"],
  ])
    assert.equal(normalizeTeammateMode("auto", deps(platform, mux)), expected);
  assert.equal(
    normalizeTeammateMode(
      "auto",
      deps("win32", "psmux", true, { TMUX: "/tmp/tmux" }),
    ),
    "tmux",
  );
});

test("TTY without a usable multiplexer fails with installation guidance", () => {
  for (const [platform, mux, hint] of [
    ["darwin", null, "brew install tmux"],
    ["linux", null, "apt install tmux"],
    ["win32", null, "winget install psmux"],
    ["darwin", "psmux", "brew install tmux"],
  ]) {
    assert.throws(
      () => normalizeTeammateMode("auto", deps(platform, mux)),
      (error) => error.code === "TMUX_REQUIRED" && error.message.includes(hint),
    );
    assert.throws(() => ensureTmuxOrExit(deps(platform, mux)), {
      code: "TMUX_REQUIRED",
    });
  }
});

test("non-TTY without a multiplexer remains headless", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    assert.equal(
      normalizeTeammateMode("auto", deps(platform, null, false)),
      "headless",
    );
  }
});

test("explicit supported modes do not require detection during parsing", () => {
  for (const [mode, platform, expected] of [
    ["headless", "linux", "headless"],
    ["hl", "darwin", "headless"],
    ["TMUX", "linux", "tmux"],
    ["psmux", "win32", "psmux"],
  ]) {
    assert.equal(
      normalizeTeammateMode(mode, {
        platform,
        detectMultiplexer() {
          throw new Error("unexpected detection");
        },
      }),
      expected,
    );
  }
});

test("removed, unknown and non-Windows psmux modes fail explicitly", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    for (const mode of [
      "wt",
      "windows-terminal",
      "windows_terminal",
      "in-process",
      "inline",
      "native",
      "unknown",
    ]) {
      assert.throws(
        () => normalizeTeammateMode(mode, deps(platform, null)),
        /지원하지 않는 teammate mode/,
      );
    }
  }
  for (const platform of ["darwin", "linux"])
    assert.throws(
      () => normalizeTeammateMode("psmux", deps(platform, "tmux")),
      /지원하지 않는 teammate mode/,
    );
});
