import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildWindowsHubAutostartCommand,
  classifySchtasksStderr,
  ensureWindowsHubAutostart,
  getWindowsHubAutostartStatus,
  SCHTASKS_TR_MAX_LENGTH,
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

describe("#161 P3 — /TR 262자 제한 사전 검증", () => {
  it("non-Windows 에서는 early return (reason: non-windows)", () => {
    if (process.platform === "win32") return;
    const result = ensureWindowsHubAutostart({
      nodePath: "C:\\node\\node.exe",
      pluginRoot: "C:\\triflux",
    });
    assert.equal(result.supported, false);
    assert.equal(result.reason, "non-windows");
  });

  it("길이 초과 command 는 win32 에서 throw (schtasks 호출 전)", () => {
    if (process.platform !== "win32") return;
    // SCHTASKS_TR_MAX_LENGTH(261) 초과를 만드는 긴 pluginRoot (ASCII)
    const longRoot = `C:\\${"x".repeat(SCHTASKS_TR_MAX_LENGTH)}`;
    assert.throws(
      () =>
        ensureWindowsHubAutostart({
          nodePath: "C:\\node\\node.exe",
          pluginRoot: longRoot,
        }),
      /schtasks \/TR 인자가.*초과합니다/,
    );
  });

  it("한글 경로는 char count 기준이라 /TR cap 미만 (byte 오차단 방지)", () => {
    // 실제 schtasks 호출 없이 build 함수 결과의 char/byte count 만 비교 — hermetic.
    // Codex Round 2 P1: ensureWindowsHubAutostart 직접 호출은 host 의 실제 task 를
    // 건드리므로 buildWindowsHubAutostartCommand 단독으로 검증한다.
    const koreanRoot = `C:\\${"한".repeat(60)}`;
    const command = buildWindowsHubAutostartCommand({
      nodePath: "C:\\node\\node.exe",
      pluginRoot: koreanRoot,
    });
    const chars = command.length;
    const utf8Bytes = Buffer.byteLength(command, "utf8");
    assert.ok(
      utf8Bytes > chars,
      `multi-byte 경로라 UTF-8 bytes(${utf8Bytes}) > chars(${chars})`,
    );
    assert.ok(
      chars <= SCHTASKS_TR_MAX_LENGTH,
      `한글 경로 char count(${chars}) 가 limit(${SCHTASKS_TR_MAX_LENGTH}) 이하 — byte 기반이면 false positive`,
    );
  });

  it("SCHTASKS_TR_MAX_LENGTH 상수는 의도된 값 (261)", () => {
    assert.equal(SCHTASKS_TR_MAX_LENGTH, 261);
  });
});
