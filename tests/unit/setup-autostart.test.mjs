import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildWindowsHubAutostartCommand,
  classifySchtasksStderr,
  ensureWindowsHubAutostart,
  getWindowsHubAutostartStatus,
  SCHTASKS_TR_MAX_LENGTH,
  validateSchtasksTrLength,
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

  it("한글 경로는 validateSchtasksTrLength 에서 throw 하지 않아야 한다 (byte 오차단 방지)", () => {
    // 실제 schtasks 호출 없이, ensureWindowsHubAutostart 가 내부적으로 쓰는 공용
    // 검증 함수를 직접 exercise — hermetic 하면서도 회귀 시 (byte 기반으로 돌아가면) 포착.
    // Codex Round 3 P2 반영: buildWindowsHubAutostartCommand 만 호출하면 ensureWindowsHubAutostart
    // 내부 검증 로직과 분리돼 회귀 감지 커버리지 손실.
    const koreanRoot = `C:\\${"한".repeat(60)}`;
    const command = buildWindowsHubAutostartCommand({
      nodePath: "C:\\node\\node.exe",
      pluginRoot: koreanRoot,
    });
    const chars = command.length;
    const utf8Bytes = Buffer.byteLength(command, "utf8");
    assert.ok(
      utf8Bytes > chars,
      `multi-byte 경로 — UTF-8 bytes(${utf8Bytes}) > chars(${chars})`,
    );
    // ensureWindowsHubAutostart 와 동일한 검증 함수를 호출 → throw 하면 즉시 실패
    assert.doesNotThrow(
      () => validateSchtasksTrLength(command),
      `한글 경로 command (${chars} chars / ${utf8Bytes} bytes) 가 /TR 검증에서 throw 되면 안 됨`,
    );
  });

  it("SCHTASKS_TR_MAX_LENGTH 상수는 의도된 값 (261)", () => {
    assert.equal(SCHTASKS_TR_MAX_LENGTH, 261);
  });
});
