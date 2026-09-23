// tests/unit/bridge-retry.test.mjs
// Phase 3 Step C2 — bridge retry-run / retry-status 서브커맨드 스모크 테스트.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("retry-status 는 profile 지정 chain step 을 codex --profile argv 로 방출한다", () => {
    const dir = makeTempDir();
    const snapshot = join(dir, "snap.json");
    writeFileSync(
      snapshot,
      JSON.stringify({
        version: 1,
        current: "EXECUTING",
        iterations: 1,
        maxIterations: 3,
        stuckCounter: 0,
        lastFailureReason: null,
        cliIndex: 0,
        cliChain: [
          {
            cli: "codex",
            model: "gpt-6-sol",
            profile: "gpt6_sol_high",
          },
          { cli: "claude", model: "opus" },
        ],
        mode: "auto-escalate",
        sessionId: null,
        history: [],
      }),
      "utf8",
    );

    const status = runBridge(["retry-status", "--snapshot", snapshot]);
    assert.deepEqual(status.cli, {
      cli: "codex",
      model: "gpt-6-sol",
      profile: "gpt6_sol_high",
    });
    assert.deepEqual(status.cliInvocation, {
      cli: "codex",
      model: "gpt-6-sol",
      profile: "gpt6_sol_high",
      argv: ["--profile", "gpt6_sol_high"],
    });
  });

  it("retry-status 는 옛 xhigh/max/ultra snapshot profile을 정규화한 argv로 방출한다", () => {
    for (const [legacy, canonical] of [
      ["gpt56_sol_xhigh", "gpt6_astra_xhigh"],
      ["gpt56_sol_max", "gpt6_astra_max"],
      ["gpt56_sol_ultra", "gpt6_astra_max"],
    ]) {
      const dir = makeTempDir();
      const snapshot = join(dir, `${legacy}.json`);
      writeFileSync(
        snapshot,
        JSON.stringify({
          version: 1,
          current: "EXECUTING",
          iterations: 1,
          maxIterations: 3,
          stuckCounter: 0,
          lastFailureReason: null,
          cliIndex: 0,
          cliChain: [{ cli: "codex", model: "gpt-6-astra", profile: legacy }],
          mode: "auto-escalate",
          sessionId: null,
          history: [],
        }),
        "utf8",
      );

      assert.deepEqual(
        runBridge(["retry-status", "--snapshot", snapshot]).cliInvocation,
        {
          cli: "codex",
          model: "gpt-6-astra",
          profile: canonical,
          argv: ["--profile", canonical],
        },
      );
    }
  });

  it("retry-status 는 옛 GPT-5.6 snapshot의 model도 새 profile에 맞춘다", () => {
    for (const [legacyModel, legacy, model, canonical] of [
      ["gpt-5.6-terra", "gpt56_terra_high", "gpt-6-sol", "gpt6_sol_high"],
      ["gpt-5.6-luna", "gpt56_luna_low", "gpt-6-luna", "gpt6_luna_low"],
    ]) {
      const dir = makeTempDir();
      const snapshot = join(dir, `${legacy}.json`);
      writeFileSync(
        snapshot,
        JSON.stringify({
          version: 1,
          current: "EXECUTING",
          iterations: 1,
          maxIterations: 3,
          stuckCounter: 0,
          lastFailureReason: null,
          cliIndex: 0,
          cliChain: [{ cli: "codex", model: legacyModel, profile: legacy }],
          mode: "auto-escalate",
          sessionId: null,
          history: [],
        }),
        "utf8",
      );

      assert.deepEqual(
        runBridge(["retry-status", "--snapshot", snapshot]).cliInvocation,
        {
          cli: "codex",
          model,
          profile: canonical,
          argv: ["--profile", canonical],
        },
      );
    }
  });
});
