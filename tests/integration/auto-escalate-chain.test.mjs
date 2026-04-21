// tests/integration/auto-escalate-chain.test.mjs
// Phase 3 Step F — auto-escalate CLI 체인 승격 통합 테스트.
//
// 시나리오: 기본 체인 [A, B, C] 에서 A 가 max_iterations 소진 시 B 로
// 전이하고, B 가 소진되면 C, C 까지 소진되면 BUDGET_EXCEEDED 로
// "escalation-chain-exhausted" 이유와 함께 종료한다. 매 bridge 호출은
// 독립 프로세스이므로 snapshot 을 통한 state 복원 확인.
//
// Open question 임시 합의 #1: DEFAULT_ESCALATION_CHAIN 은 Codex:gpt-5-mini
// 로 시작. 이 테스트는 custom chain 으로 빠른 검증.

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
  const dir = mkdtempSync(join(tmpdir(), "triflux-autoescalate-"));
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

function seedChainSnapshot(snapshot, chain, maxIterations = 2) {
  // bridge retry-run 은 cliChain 파라미터를 CLI 플래그로 직접 받지 않는다.
  // 기본값은 DEFAULT_ESCALATION_CHAIN. 테스트를 위해 초기 snapshot 을
  // 직접 seed 한다 — retry-state-machine 의 applySnapshot 이 cliChain
  // 필드를 복원하므로 첫 retry-run 부터 이 chain 을 사용한다.
  const seed = {
    version: 1,
    current: "PLANNING",
    iterations: 0,
    maxIterations,
    stuckCounter: 0,
    lastFailureReason: null,
    cliIndex: 0,
    cliChain: chain,
    mode: "auto-escalate",
    sessionId: null,
    history: [],
  };
  writeFileSync(snapshot, JSON.stringify(seed));
}

function failIteration(snapshot, reason) {
  bridgeRun(["retry-run", "--snapshot", snapshot, "--event", "start"]);
  return bridgeRun([
    "retry-run",
    "--snapshot",
    snapshot,
    "--event",
    "verify-fail",
    "--reason",
    reason,
  ]);
}

describe("auto-escalate CLI 체인 승격 — Phase 3 Step F", () => {
  it("체인 [A,B,C], maxIter=2 — A 소진 후 B 로 전이", () => {
    const dir = makeTempDir();
    const snapshot = join(dir, "escalate.json");
    seedChainSnapshot(
      snapshot,
      [
        { cli: "codex", model: "A" },
        { cli: "codex", model: "B" },
        { cli: "claude", model: "C" },
      ],
      2,
    );

    // A 단계 첫 fail
    const r1 = failIteration(snapshot, "A-fail-1");
    assert.equal(r1.cliIndex, 0);
    assert.equal(r1.iterations, 1);
    assert.equal(r1.cli.model, "A");
    assert.equal(r1.shouldStop, false);

    // A 단계 두 번째 fail → maxIterations 소진 → escalate to B
    const r2 = failIteration(snapshot, "A-fail-2");
    assert.equal(r2.cliIndex, 1);
    assert.equal(r2.iterations, 0); // escalate 후 reset
    assert.equal(r2.cli.model, "B");
    assert.equal(r2.current, "EXECUTING");
    assert.equal(r2.shouldStop, false);
  });

  it("체인 끝까지 소진 시 BUDGET_EXCEEDED + chain-exhausted reason", () => {
    const dir = makeTempDir();
    const snapshot = join(dir, "escalate.json");
    seedChainSnapshot(
      snapshot,
      [
        { cli: "a", model: "1" },
        { cli: "b", model: "2" },
      ],
      2,
    );

    failIteration(snapshot, "s1-a");
    failIteration(snapshot, "s1-b"); // escalate to b
    failIteration(snapshot, "s2-a");
    const final = failIteration(snapshot, "s2-b"); // exhausted

    assert.equal(final.current, "BUDGET_EXCEEDED");
    assert.equal(final.shouldStop, true);
    assert.equal(final.transition.reason, "escalation-chain-exhausted");
  });

  it("승격 중 verify-success 는 즉시 DONE (체인 중단)", () => {
    const dir = makeTempDir();
    const snapshot = join(dir, "escalate.json");
    seedChainSnapshot(
      snapshot,
      [
        { cli: "codex", model: "mini" },
        { cli: "claude", model: "opus" },
      ],
      3,
    );

    failIteration(snapshot, "first-fail");
    bridgeRun(["retry-run", "--snapshot", snapshot, "--event", "start"]);
    const done = bridgeRun([
      "retry-run",
      "--snapshot",
      snapshot,
      "--event",
      "verify-success",
    ]);
    assert.equal(done.current, "DONE");
    assert.equal(done.shouldStop, true);
    // 체인 첫 번째 단계에서 성공 — cliIndex 0 유지
    assert.equal(done.cliIndex, 0);
  });

  it("stuck detector 는 체인 승격과 독립 — 동일 reason 3회는 STUCK 으로 즉시 중단", () => {
    const dir = makeTempDir();
    const snapshot = join(dir, "escalate.json");
    seedChainSnapshot(
      snapshot,
      [
        { cli: "codex", model: "A" },
        { cli: "claude", model: "B" },
      ],
      5,
    );

    failIteration(snapshot, "same");
    failIteration(snapshot, "same");
    const stuck = failIteration(snapshot, "same");

    assert.equal(stuck.current, "STUCK");
    assert.equal(stuck.shouldStop, true);
    assert.equal(stuck.stuckCounter, 3);
    // stuck 은 첫 CLI 단계에서 발생 — escalate 하지 않음
    assert.equal(stuck.cliIndex, 0);
  });
});
