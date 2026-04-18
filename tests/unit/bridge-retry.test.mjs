// tests/unit/bridge-retry.test.mjs
// Phase 3 Step C2 — bridge retry-run / retry-status 서브커맨드 스모크 테스트.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(TEST_DIR, "..", "..");
const BRIDGE = resolve(PROJECT_ROOT, "hub", "bridge.mjs");

const tempDirs = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "triflux-bridge-retry-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function runBridge(args) {
  const out = execFileSync("node", [BRIDGE, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    cwd: tmpdir(),
  });
  const lines = out.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

describe("bridge retry-run / retry-status — Phase 3 Step C2", () => {
  it("retry-status 는 snapshot 없으면 exists:false", () => {
    const dir = makeTempDir();
    const snapshot = join(dir, "snap.json");
    const out = runBridge(["retry-status", "--snapshot", snapshot]);
    assert.equal(out.ok, true);
    assert.equal(out.exists, false);
  });

  it("retry-run start → verify-fail → verify-success 순환", () => {
    const dir = makeTempDir();
    const snapshot = join(dir, "snap.json");

    const r1 = runBridge([
      "retry-run",
      "--snapshot",
      snapshot,
      "--mode",
      "ralph",
      "--max-iterations",
      "5",
      "--event",
      "start",
    ]);
    assert.equal(r1.current, "EXECUTING");
    assert.equal(r1.iterations, 1);
    assert.equal(r1.shouldStop, false);

    const r2 = runBridge([
      "retry-run",
      "--snapshot",
      snapshot,
      "--event",
      "verify-fail",
      "--reason",
      "tests-fail",
    ]);
    assert.equal(r2.current, "DIAGNOSING");
    assert.equal(r2.shouldStop, false);
    assert.equal(r2.lastFailureReason, "tests-fail");

    const r3 = runBridge([
      "retry-run",
      "--snapshot",
      snapshot,
      "--event",
      "start",
    ]);
    assert.equal(r3.current, "EXECUTING");
    assert.equal(r3.iterations, 2);

    const r4 = runBridge([
      "retry-run",
      "--snapshot",
      snapshot,
      "--event",
      "verify-success",
    ]);
    assert.equal(r4.current, "DONE");
    assert.equal(r4.done, true);
    assert.equal(r4.shouldStop, true);
  });

  it("retry-run 동일 reason 3회 → STUCK + shouldStop", () => {
    const dir = makeTempDir();
    const snapshot = join(dir, "snap.json");
    for (let i = 0; i < 3; i += 1) {
      runBridge([
        "retry-run",
        "--snapshot",
        snapshot,
        "--mode",
        "ralph",
        "--max-iterations",
        "100",
        "--event",
        "start",
      ]);
      const last = runBridge([
        "retry-run",
        "--snapshot",
        snapshot,
        "--event",
        "verify-fail",
        "--reason",
        "same",
      ]);
      if (i === 2) {
        assert.equal(last.current, "STUCK");
        assert.equal(last.shouldStop, true);
        assert.equal(last.stuckCounter, 3);
      }
    }
  });
});
