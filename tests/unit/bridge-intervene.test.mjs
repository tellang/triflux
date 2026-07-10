import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const BRIDGE = resolve(TEST_DIR, "..", "..", "hub", "bridge.mjs");
const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length)
    rmSync(tempDirs.pop(), { recursive: true, force: true });
});

async function runBridge(args, allowFailure = false) {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [BRIDGE, ...args],
      { cwd: tmpdir() },
    );
    return JSON.parse(stdout.trim().split("\n").filter(Boolean).at(-1));
  } catch (error) {
    if (!allowFailure) throw error;
    return JSON.parse(
      String(error.stdout).trim().split("\n").filter(Boolean).at(-1),
    );
  }
}

function waitForExit(child) {
  return new Promise((resolveExit) => child.once("exit", resolveExit));
}

it("intervene-run은 hermetic child process를 종료하고 JSON 한 줄을 출력한다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "triflux-bridge-intervene-"));
  tempDirs.push(dir);
  const log = join(dir, "stdout.log");
  writeFileSync(log, "quiet");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  const payload = JSON.stringify({
    channel: "process",
    pid: child.pid,
    cli: "other",
    stdoutLog: log,
    reinstructWaitSec: 1,
    resumeWaitSec: 1,
    sigtermGraceSec: 1,
  });
  const result = await runBridge(["intervene-run", "--payload", payload]);
  if (child.exitCode === null && child.signalCode === null)
    await waitForExit(child);

  assert.equal(result.ok, true);
  assert.ok(["terminated", "killed"].includes(result.outcome));
  assert.ok(Array.isArray(result.attempts));
});

it("intervene-run은 잘못된 payload도 JSON 실패 계약으로 반환한다", async () => {
  const result = await runBridge(["intervene-run", "--payload", "{"], true);
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "failed");
});
