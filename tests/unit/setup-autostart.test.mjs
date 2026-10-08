import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildWindowsHubAutostartCommand,
  classifySchtasksStderr,
  getWindowsHubAutostartStatus,
  WINDOWS_HUB_AUTOSTART_TASK,
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

describe("#161 P2 — classifySchtasksStderr", () => {
  it('"The system cannot find the file specified" → not_registered', () => {
    assert.equal(
      classifySchtasksStderr(
        "ERROR: The system cannot find the file specified.",
      ),
      "not_registered",
    );
  });
  it('"Access is denied" → access_denied', () => {
    assert.equal(
      classifySchtasksStderr("ERROR: Access is denied."),
      "access_denied",
    );
  });
  it("한글: 찾을 수 없습니다 → not_registered", () => {
    assert.equal(
      classifySchtasksStderr("오류: 지정된 파일을 찾을 수 없습니다."),
      "not_registered",
    );
  });
  it("한글: 액세스가 거부되었습니다 → access_denied", () => {
    assert.equal(
      classifySchtasksStderr("오류: 액세스가 거부되었습니다."),
      "access_denied",
    );
  });
  it("알 수 없는 에러 → unknown", () => {
    assert.equal(
      classifySchtasksStderr("ERROR: Something weird went wrong."),
      "unknown",
    );
  });
  it("빈 stderr → unknown", () => {
    assert.equal(classifySchtasksStderr(""), "unknown");
    assert.equal(classifySchtasksStderr(null), "unknown");
  });
});
