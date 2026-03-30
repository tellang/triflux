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
  PSMUX_SESSION: process.env.PSMUX_SESSION,
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

describe("resolvePane fallback (psmux title 미설정 우회)", () => {
  function mockWithPsmuxDefaultTitles({ captureOutputs = [] } = {}) {
    const calls = [];
    let captureIndex = 0;

    const tracker = mock.method(childProcess, "execFileSync", (file, args) => {
      const argv = Array.isArray(args) ? [...args] : [];
      calls.push({ file, args: argv });

      switch (argv[0]) {
        case "-V":
          return "psmux 3.3.0";
        case "list-panes":
          // psmux는 select-pane -T가 동작하지 않아 기본 "pane %N" 타이틀 반환
          return [
            "pane %1\ttfx-test:0.0\t0\t",
            "pane %2\ttfx-test:0.1\t0\t",
            "pane %3\ttfx-test:0.2\t0\t",
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

  it("'lead'는 pane index 0으로 fallback 매핑된다", async () => {
    createTempCaptureRoot("psmux-fallback-lead-");
    mockWithPsmuxDefaultTitles({ captureOutputs: ["snapshot"] });
    const { startCapture } = await importFreshPsmux();

    const result = startCapture("tfx-test", "lead");
    assert.equal(result.paneId, "tfx-test:0.0");
  });

  it("'worker-1'은 pane index 1로 fallback 매핑된다", async () => {
    createTempCaptureRoot("psmux-fallback-w1-");
    mockWithPsmuxDefaultTitles({ captureOutputs: ["snapshot"] });
    const { startCapture } = await importFreshPsmux();

    const result = startCapture("tfx-test", "worker-1");
    assert.equal(result.paneId, "tfx-test:0.1");
  });

  it("'worker-2'는 pane index 2로 fallback 매핑된다", async () => {
    createTempCaptureRoot("psmux-fallback-w2-");
    mockWithPsmuxDefaultTitles({ captureOutputs: ["snapshot"] });
    const { startCapture } = await importFreshPsmux();

    const result = startCapture("tfx-test", "worker-2");
    assert.equal(result.paneId, "tfx-test:0.2");
  });

  it("pane target 직접 접근은 여전히 동작한다", async () => {
    createTempCaptureRoot("psmux-fallback-target-");
    mockWithPsmuxDefaultTitles({ captureOutputs: ["snapshot"] });
    const { startCapture } = await importFreshPsmux();

    const result = startCapture("tfx-test", "tfx-test:0.1");
    assert.equal(result.paneId, "tfx-test:0.1");
  });

  it("범위 초과 이름은 에러를 던진다", async () => {
    createTempCaptureRoot("psmux-fallback-oob-");
    mockWithPsmuxDefaultTitles({ captureOutputs: ["snapshot"] });
    const { startCapture } = await importFreshPsmux();

    assert.throws(
      () => startCapture("tfx-test", "worker-999"),
      /Pane을 찾을 수 없습니다/,
    );
  });

  it("알 수 없는 이름은 에러를 던진다", async () => {
    createTempCaptureRoot("psmux-fallback-unknown-");
    mockWithPsmuxDefaultTitles({ captureOutputs: ["snapshot"] });
    const { startCapture } = await importFreshPsmux();

    assert.throws(
      () => startCapture("tfx-test", "unknown-pane"),
      /Pane을 찾을 수 없습니다/,
    );
  });

  it("dispatchCommand도 fallback으로 동작한다", async () => {
    createTempCaptureRoot("psmux-fallback-dispatch-");
    mockWithPsmuxDefaultTitles({ captureOutputs: ["snapshot"] });
    const { dispatchCommand } = await importFreshPsmux();

    const result = dispatchCommand("tfx-test", "worker-1", "Write-Host test");
    assert.equal(result.paneId, "tfx-test:0.1");
    assert.ok(result.token.length > 0);
  });

  // B-edge: worker-0은 거부 (lead 충돌 방지)
  it("worker-0은 거부된다 (lead와 충돌 방지)", async () => {
    createTempCaptureRoot("psmux-fallback-w0-");
    mockWithPsmuxDefaultTitles({ captureOutputs: ["snapshot"] });
    const { startCapture } = await importFreshPsmux();

    assert.throws(
      () => startCapture("tfx-test", "worker-0"),
      /Pane을 찾을 수 없습니다/,
    );
  });

  // B-edge: 빈 문자열 거부
  it("빈 문자열은 거부된다", async () => {
    createTempCaptureRoot("psmux-fallback-empty-");
    mockWithPsmuxDefaultTitles({ captureOutputs: ["snapshot"] });
    const { startCapture } = await importFreshPsmux();

    assert.throws(
      () => startCapture("tfx-test", ""),
      /Pane을 찾을 수 없습니다/,
    );
  });

  // B-edge: 특수문자/인젝션 안전
  it("특수문자 입력은 안전하게 거부된다", async () => {
    createTempCaptureRoot("psmux-fallback-special-");
    mockWithPsmuxDefaultTitles({ captureOutputs: ["snapshot"] });
    const { startCapture } = await importFreshPsmux();

    assert.throws(() => startCapture("tfx-test", "worker-1; rm -rf /"), /Pane을 찾을 수 없습니다/);
    assert.throws(() => startCapture("tfx-test", "$(whoami)"), /Pane을 찾을 수 없습니다/);
    assert.throws(() => startCapture("tfx-test", "worker-1\ttfx:0.0"), /Pane을 찾을 수 없습니다/);
  });

  // B-edge: 대소문자 — WORKER-1, Lead, LEAD 모두 동작
  it("대소문자 무관하게 동작한다 (WORKER-1, Lead, LEAD)", async () => {
    createTempCaptureRoot("psmux-fallback-case-");
    mockWithPsmuxDefaultTitles({ captureOutputs: ["snapshot"] });
    const { startCapture } = await importFreshPsmux();

    assert.equal(startCapture("tfx-test", "WORKER-1").paneId, "tfx-test:0.1");
    assert.equal(startCapture("tfx-test", "Worker-2").paneId, "tfx-test:0.2");
    assert.equal(startCapture("tfx-test", "LEAD").paneId, "tfx-test:0.0");
    assert.equal(startCapture("tfx-test", "Lead").paneId, "tfx-test:0.0");
  });

  // C-regression: title 직접 매칭이 index fallback보다 우선
  it("title 직접 매칭이 index fallback보다 우선한다", async () => {
    createTempCaptureRoot("psmux-fallback-priority-");
    // title이 실제로 설정된 경우 (tmux 정상 동작)
    const calls = [];
    let captureIndex = 0;
    const tracker = mock.method(childProcess, "execFileSync", (file, args) => {
      const argv = Array.isArray(args) ? [...args] : [];
      calls.push({ file, args: argv });
      switch (argv[0]) {
        case "-V": return "psmux 3.3.0";
        case "list-panes":
          // worker-1 title이 실제 설정된 경우 — index 2에 위치
          return [
            "lead\ttfx-test:0.0\t0\t",
            "other\ttfx-test:0.1\t0\t",
            "worker-1\ttfx-test:0.2\t0\t",
          ].join("\n");
        case "pipe-pane": return "";
        case "capture-pane": return captureIndex++ < 1 ? "snapshot" : "";
        case "send-keys": return "";
        default: throw new Error(`unexpected: ${argv.join(" ")}`);
      }
    });
    registerRestore(() => tracker.mock.restore());
    const { startCapture } = await importFreshPsmux();

    // title "worker-1"이 index 2에 있으므로, title 매칭 우선 → tfx-test:0.2
    const result = startCapture("tfx-test", "worker-1");
    assert.equal(result.paneId, "tfx-test:0.2");
  });
});

describe("psmux nested-session protection", () => {
  it("psmuxExec는 subprocess env에서 PSMUX_SESSION을 제거한다", async () => {
    createTempCaptureRoot("psmux-nested-session-");
    process.env.PSMUX_SESSION = "inside-psmux-session";
    const calls = [];

    const tracker = mock.method(childProcess, "execFileSync", (file, args, opts = {}) => {
      const argv = Array.isArray(args) ? [...args] : [];
      calls.push({ file, args: argv, opts });
      if (argv[0] === "-V") return "psmux 3.3.0";
      return "";
    });
    registerRestore(() => tracker.mock.restore());

    const { psmuxExec } = await importFreshPsmux();
    psmuxExec(["-V"]);

    const versionCall = calls.find((call) => call.args[0] === "-V");
    assert.ok(versionCall, "psmux -V 호출이 있어야 함");
    assert.equal(versionCall.opts?.env?.PSMUX_SESSION, undefined);
    assert.equal(process.env.PSMUX_SESSION, "inside-psmux-session");
  });
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
    const result = await waitForCompletion("tfx-test", "worker-1", "token-123", 1);

    assert.equal(capture.paneId, "tfx-test:0.1");
    assert.equal(result.matched, true);
    assert.equal(result.exitCode, 7);
    assert.equal(result.match, "__TRIFLUX_DONE__:token-123:7");
  });
});

describe("killPsmuxSession cleanup", () => {
  function mockForKillSession() {
    const calls = [];

    const tracker = mock.method(childProcess, "execFileSync", (file, args) => {
      const argv = Array.isArray(args) ? [...args] : [];
      calls.push({ file, args: argv });

      switch (argv[0]) {
        case "-V":
          return "psmux 3.3.0";
        case "list-panes": {
          const fmt = argv.find((a) => a.includes("pane_index"));
          if (fmt) {
            return "0\ttfx-kill:0.0\n1\ttfx-kill:0.1";
          }
          // #{pane_pid} format
          return "1234\n5678";
        }
        case "pipe-pane":
          return "";
        case "kill-session":
          return "";
        default:
          return "";
      }
    });

    // mock execSync for taskkill and powershell orphan cleanup
    const execSyncTracker = mock.method(childProcess, "execSync", (cmd) => {
      calls.push({ file: "execSync", args: [cmd] });
      return "";
    });

    registerRestore(() => tracker.mock.restore());
    registerRestore(() => execSyncTracker.mock.restore());
    return { calls };
  }

  it("killPsmuxSession은 pipe-pane 해제 → 트리 종료 → 세션 종료 → 고아 정리 순서로 실행한다", async () => {
    createTempCaptureRoot("psmux-kill-");
    const { calls } = mockForKillSession();
    const { killPsmuxSession } = await importFreshPsmux();

    killPsmuxSession("tfx-kill");

    // pipe-pane 해제 호출 확인 (각 pane에 대해)
    const pipePaneCalls = calls.filter(
      (c) => Array.isArray(c.args) && c.args[0] === "pipe-pane",
    );
    assert.ok(pipePaneCalls.length >= 2, `pipe-pane 해제가 2회 이상 호출되어야 함 (실제: ${pipePaneCalls.length})`);

    // taskkill 호출 확인
    const taskkillCalls = calls.filter(
      (c) => c.file === "execSync" && typeof c.args[0] === "string" && c.args[0].includes("taskkill"),
    );
    assert.ok(taskkillCalls.length >= 2, `taskkill이 2회 이상 호출되어야 함 (실제: ${taskkillCalls.length})`);

    // kill-session 호출 확인
    const killSessionCalls = calls.filter(
      (c) => Array.isArray(c.args) && c.args[0] === "kill-session",
    );
    assert.equal(killSessionCalls.length, 1, "kill-session은 1회 호출");

    // 고아 프로세스 정리 호출 확인 (pipe-pane-capture + node.exe)
    const orphanCalls = calls.filter(
      (c) => c.file === "execSync" && typeof c.args[0] === "string" && c.args[0].includes("pipe-pane-capture"),
    );
    assert.ok(orphanCalls.length >= 1, "고아 pipe-pane 헬퍼 정리가 호출되어야 함");

    // 순서 검증: pipe-pane 해제가 taskkill보다 먼저
    const firstPipePaneIdx = calls.findIndex(
      (c) => Array.isArray(c.args) && c.args[0] === "pipe-pane",
    );
    const firstTaskkillIdx = calls.findIndex(
      (c) => c.file === "execSync" && typeof c.args[0] === "string" && c.args[0].includes("taskkill"),
    );
    assert.ok(firstPipePaneIdx < firstTaskkillIdx, "pipe-pane 해제가 taskkill보다 먼저 실행되어야 함");
  });
});
