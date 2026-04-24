import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  WINDOWS_HUB_AUTOSTART_TASK,
  buildWindowsHubAutostartCommand,
  getWindowsHubAutostartStatus,
} from "../../scripts/setup.mjs";

describe("setup hub autostart", () => {
  it("Windows Task Scheduler command points at hub-ensure", () => {
    const command = buildWindowsHubAutostartCommand({
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      pluginRoot: "C:\\triflux",
    });

    assert.match(command, /node\.exe"/);
    assert.match(
      command,
      new RegExp(
        join("C:\\triflux", "scripts", "hub-ensure.mjs").replace(
          /[\\^$.*+?()[\]{}|]/g,
          "\\$&",
        ),
      ),
    );
  });

  it("status helper is safe on every platform", () => {
    const status = getWindowsHubAutostartStatus();
    assert.equal(status.taskName, WINDOWS_HUB_AUTOSTART_TASK);
    assert.equal(typeof status.registered, "boolean");
  });
});
