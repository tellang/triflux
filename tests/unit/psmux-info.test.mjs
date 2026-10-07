import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatPsmuxInstallGuidance,
  formatPsmuxUpdateGuidance,
  probePsmuxSupport,
} from "../../scripts/lib/psmux-info.mjs";

describe("psmux-info", () => {
  it("guidance formatters include official install/update commands (win32)", () => {
    const installText = formatPsmuxInstallGuidance("", "win32");
    const updateText = formatPsmuxUpdateGuidance("", "win32");
    assert.match(installText, /winget install psmux/);
    assert.match(installText, /scoop install psmux/);
    assert.match(updateText, /winget upgrade psmux/);
    assert.match(updateText, /cargo install psmux --force/);
  });

  for (const [platform, install, update] of [
    ["darwin", "brew install tmux", "brew upgrade tmux"],
    ["linux", "apt install tmux", "apt install --only-upgrade tmux"],
  ]) {
    it(`${platform} 설치 안내를 반환한다`, () => {
      assert.equal(formatPsmuxInstallGuidance("", platform), install);
      assert.equal(formatPsmuxUpdateGuidance("", platform), update);
    });
  }

  it("probePsmuxSupport detects required commands from help output", () => {
    const calls = [];
    const result = probePsmuxSupport({
      execFileSyncFn(command, args) {
        calls.push([command, ...args]);
        if (args[0] === "-V") return "psmux 3.3.1";
        if (args[0] === "--help")
          return "new-session\nattach-session\nkill-session\ncapture-pane\ndetach-client\n";
        throw new Error("unexpected");
      },
    });

    assert.equal(result.installed, true);
    assert.equal(result.ok, true);
    assert.equal(result.recommended, true);
    assert.deepEqual(result.missingCommands, []);
    assert.deepEqual(calls, [
      ["psmux", "-V"],
      ["psmux", "--help"],
    ]);
  });

  it("probePsmuxSupport marks missing commands as incompatible", () => {
    const result = probePsmuxSupport({
      execFileSyncFn(_command, args) {
        if (args[0] === "-V") return "psmux 3.2.0";
        if (args[0] === "--help")
          return "new-session\nattach-session\nkill-session\n";
        throw new Error("unexpected");
      },
    });

    assert.equal(result.installed, true);
    assert.equal(result.ok, false);
    assert.equal(result.recommended, false);
    assert.deepEqual(result.missingCommands, ["capture-pane"]);
    assert.deepEqual(result.missingOptionalCommands, ["detach-client"]);
  });

  it("probePsmuxSupport handles --help failure gracefully", () => {
    const result = probePsmuxSupport({
      execFileSyncFn(_command, args) {
        if (args[0] === "-V") return "psmux 3.3.1";
        if (args[0] === "--help") throw new Error("help unavailable");
        throw new Error("unexpected");
      },
    });

    assert.equal(result.installed, true);
    assert.equal(result.version, "3.3.1");
    assert.equal(
      result.ok,
      false,
      "help 실패 시 required commands 검증 불가 → ok=false",
    );
    assert.ok(
      result.missingCommands.length > 0,
      "모든 required commands가 missing으로 판정",
    );
  });
});
