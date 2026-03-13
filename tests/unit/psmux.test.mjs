import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGINAL_ENV = {
  PSMUX_CAPTURE_ROOT: process.env.PSMUX_CAPTURE_ROOT,
  PSMUX_POLL_INTERVAL_MS: process.env.PSMUX_POLL_INTERVAL_MS,
  PSMUX_POLL_INTERVAL_SEC: process.env.PSMUX_POLL_INTERVAL_SEC,
};

const restorers = [];
const tempDirs = [];

function registerRestore(restore) {
  restorers.push(restore);
}

function createTempCaptureRoot(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  process.env.PSMUX_CAPTURE_ROOT = dir;
  process.env.PSMUX_POLL_INTERVAL_MS = "1";
  delete process.env.PSMUX_POLL_INTERVAL_SEC;
  return dir;
}

function mockExecFileSync({ captureOutputs = [] } = {}) {
  const calls = [];
  let captureIndex = 0;

  const tracker = mock.method(childProcess, "execFileSync", (file, args) => {
    const argv = Array.isArray(args) ? [...args] : [];
    calls.push({ file, args: argv });

    switch (argv[0]) {
      case "-V":
        return "psmux 1.0.0";
      case "list-panes":
        return [
          "lead\ttfx-test:0.0\t0\t",
          "worker-1\ttfx-test:0.1\t0\t",
        ].join("\n");
      case "pipe-pane":
        return "";
      case "capture-pane": {
        const value = captureOutputs[Math.min(captureIndex, captureOutputs.length - 1)] || "";
        captureIndex += 1;
        return value;
      }
      case "send-keys":
        return "";
      default:
        throw new Error(`예상하지 못한 execFileSync 호출: ${argv.join(" ")}`);
    }
  });

  registerRestore(() => tracker.mock.restore());
  return { calls };
}

async function importFreshPsmux() {
  const stamp = `${Date.now()}-${Math.random()}`;
  return import(new URL(`../../hub/team/psmux.mjs?test=${stamp}`, import.meta.url));
}

afterEach(() => {
  while (restorers.length > 0) {
    restorers.pop()();
  }

  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }

  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("psmux.mjs steering", () => {
  it("startCapture는 pipe-pane을 설정하고 snapshot 로그를 만든다", async () => {
    createTempCaptureRoot("psmux-start-");
    const execMock = mockExecFileSync({
      captureOutputs: ["first line\nsecond line"],
    });
    const { startCapture } = await importFreshPsmux();

    const result = startCapture("tfx-test", "worker-1");

    assert.equal(result.paneId, "tfx-test:0.1");
    assert.equal(result.paneName, "worker-1");
    assert.equal(readFileSync(result.logPath, "utf8"), "first line\nsecond line");
    assert.ok(
      execMock.calls.some(
        (call) =>
          call.args[0] === "pipe-pane" &&
          call.args[1] === "-t" &&
          call.args[2] === "tfx-test:0.1" &&
          typeof call.args[3] === "string" &&
          call.args[3].includes("pipe-pane-capture.ps1"),
      ),
    );
  });

  it("dispatchCommand는 완료 토큰을 붙인 PowerShell 명령을 literal send-keys로 전송한다", async () => {
    createTempCaptureRoot("psmux-dispatch-");
    const execMock = mockExecFileSync({
      captureOutputs: ["capture ready"],
    });
    const { dispatchCommand } = await importFreshPsmux();

    const result = dispatchCommand("tfx-test", "worker-1", 'Write-Host "hello"');

    const literalSend = execMock.calls.find(
      (call) => call.args[0] === "send-keys" && call.args.includes("-l"),
    );
    assert.ok(literalSend);
    const commandText = literalSend.args[literalSend.args.length - 1];

    assert.equal(result.paneId, "tfx-test:0.1");
    assert.equal(result.paneName, "worker-1");
    assert.ok(commandText.includes('Write-Host "hello"'));
    assert.ok(commandText.includes(result.token));
    assert.ok(commandText.includes("__TRIFLUX_DONE__"));
    assert.ok(
      execMock.calls.some(
        (call) =>
          call.args[0] === "send-keys" &&
          call.args[1] === "-t" &&
          call.args[2] === "tfx-test:0.1" &&
          call.args[3] === "Enter",
      ),
    );
  });

  it("waitForCompletion은 completion token을 polling하고 exit code를 파싱한다", async () => {
    createTempCaptureRoot("psmux-wait-");
    mockExecFileSync({
      captureOutputs: [
        "initial snapshot",
        "still running",
        "log line\n__TRIFLUX_DONE__:token-123:7\n",
      ],
    });
    const { startCapture, waitForCompletion } = await importFreshPsmux();

    const capture = startCapture("tfx-test", "worker-1");
    const result = waitForCompletion("tfx-test", "worker-1", "token-123", 1);

    assert.equal(capture.paneId, "tfx-test:0.1");
    assert.equal(result.matched, true);
    assert.equal(result.exitCode, 7);
    assert.equal(result.match, "__TRIFLUX_DONE__:token-123:7");
  });
});
