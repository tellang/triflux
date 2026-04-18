// tests/integration/ralph-state-compaction.test.mjs
// Phase 3 Step F — ralph state machine compaction survive 통합 테스트.
//
// 시나리오: Claude 세션이 compaction 을 겪어도 ralph state 는
// snapshot 파일로 persist 되므로, bridge retry-run 매 호출이 독립
// 프로세스여도 상태가 유지된다.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(TEST_DIR, "..", "..");
const BRIDGE = resolve(PROJECT_ROOT, "hub", "bridge.mjs");

const tempDirs = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "triflux-ralph-compact-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function bridgeRun(args) {
  const out = execFileSync("node", [BRIDGE, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    cwd: tmpdir(),
  });
  const lines = out.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

describe("ralph state machine compaction survive — Phase 3 Step F", () => {
  it("5 iteration 진행 중 매 호출이 독립 프로세스여도 counter 유지", () => {
    const dir = makeTempDir();
    const snapshot = join(dir, "ralph.json");

    for (let i = 1; i <= 5; i += 1) {
      const start = bridgeRun([
        "retry-run",
        "--snapshot",
        snapshot,
        "--mode",
        "ralph",
        "--max-iterations",
        "10",
        "--event",
        "start",
      ]);
      assert.equal(start.iterations, i, `iteration ${i} should increment`);

      const fail = bridgeRun([
        "retry-run",
        "--snapshot",
        snapshot,
        "--event",
        "verify-fail",
        "--reason",
        `reason-${i}`,
      ]);
      assert.equal(fail.current, "DIAGNOSING");
      assert.equal(fail.iterations, i);
    }

    // status 로 최종 확인 (transition 없음)
    const status = bridgeRun(["retry-status", "--snapshot", snapshot]);
    assert.equal(status.exists, true);
    assert.equal(status.iterations, 5);
    assert.equal(status.current, "DIAGNOSING");
    assert.equal(status.mode, "ralph");
  });

  it("snapshot 파일이 임의로 edit 되면 applySnapshot 이 반영", () => {
    const dir = makeTempDir();
    const snapshot = join(dir, "ralph.json");

    bridgeRun([
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
    bridgeRun([
      "retry-run",
      "--snapshot",
      snapshot,
      "--event",
      "verify-fail",
      "--reason",
      "initial",
    ]);

    // 외부에서 snapshot 을 편집 (compaction 중 백업 복원 시뮬레이션)
    const snap = JSON.parse(readFileSync(snapshot, "utf8"));
    snap.iterations = 42;
    snap.lastFailureReason = "manual-override";
    writeFileSync(snapshot, JSON.stringify(snap));

    const next = bridgeRun([
      "retry-run",
      "--snapshot",
      snapshot,
      "--event",
      "verify-fail",
      "--reason",
      "manual-override", // 같은 reason 이면 stuckCounter 증가
    ]);
    // 이전 snapshot 의 lastFailureReason 과 일치 → stuckCounter 2
    assert.equal(next.stuckCounter, 2);
    assert.equal(next.iterations, 42);
  });

  it("DONE 도달 후 재호출 해도 DONE 유지 (idempotent resume)", () => {
    const dir = makeTempDir();
    const snapshot = join(dir, "ralph.json");

    bridgeRun([
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
    const done = bridgeRun([
      "retry-run",
      "--snapshot",
      snapshot,
      "--event",
      "verify-success",
    ]);
    assert.equal(done.current, "DONE");
    assert.equal(done.shouldStop, true);

    const status = bridgeRun(["retry-status", "--snapshot", snapshot]);
    assert.equal(status.current, "DONE");
    assert.equal(status.shouldStop, true);
  });
});
