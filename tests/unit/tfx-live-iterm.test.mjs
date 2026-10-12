import assert from "node:assert/strict";
import test from "node:test";
import * as tfxLive from "../../bin/tfx-live.mjs";

test("iTerm AppleScript literals preserve quotes and backslashes without injection", () => {
  assert.equal(
    tfxLive.appleScriptString('리뷰 "팀" \\ path'),
    '"리뷰 \\"팀\\" \\\\ path"',
  );
  for (const control of [
    "\n",
    "\r",
    "\t",
    "\0",
    "\u007f",
    "\u0085",
    "\u2028",
  ]) {
    assert.throws(
      () => tfxLive.appleScriptString(`team${control}close`),
      /control characters/,
    );
  }
});

test("iTerm integration is limited to local macOS sessions inside iTerm2", () => {
  for (const env of [
    { LC_TERMINAL: "iTerm2" },
    { TERM_PROGRAM: "iTerm.app" },
  ]) {
    assert.equal(tfxLive.shouldUseIterm(undefined, "darwin", env), true);
    assert.equal(tfxLive.shouldUseIterm("host", "darwin", env), false);
    assert.equal(tfxLive.shouldUseIterm(undefined, "linux", env), false);
    assert.equal(tfxLive.shouldUseIterm(undefined, "win32", env), false);
  }
  assert.equal(tfxLive.shouldUseIterm(undefined, "darwin", {}), false);
  assert.equal(
    tfxLive.shouldUseIterm(undefined, "darwin", {
      TERM_PROGRAM: "Apple_Terminal",
    }),
    false,
  );
});
