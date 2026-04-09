import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createHealthProbe,
  detectInputWait,
  PROBE_DEFAULTS,
} from "../../hub/team/health-probe.mjs";

describe("health-probe: detectInputWait", () => {
  it("물음표로 끝나는 출력을 INPUT_WAIT로 감지해야 한다", () => {
    const result = detectInputWait("Do you want to continue?");
    assert.equal(result.detected, true);
    assert.ok(result.pattern);
  });

  it("y/n 프롬프트를 감지해야 한다", () => {
    const result = detectInputWait("Apply changes? (y/n)");
    assert.equal(result.detected, true);
  });

  it("choose/select 프롬프트를 감지해야 한다", () => {
    const result = detectInputWait("Choose an option:");
    assert.equal(result.detected, true);
  });

  it("confirm 패턴을 감지해야 한다", () => {
    const result = detectInputWait("Please confirm before proceeding");
    assert.equal(result.detected, true);
  });

  it("> 프롬프트를 감지해야 한다", () => {
    const result = detectInputWait("Enter your choice\n> ");
    assert.equal(result.detected, true);
  });

  it("일반 출력은 INPUT_WAIT가 아니어야 한다", () => {
    const result = detectInputWait("Processing files... done.");
    assert.equal(result.detected, false);
    assert.equal(result.pattern, null);
  });

  it("빈 입력은 false를 반환해야 한다", () => {
    assert.equal(detectInputWait("").detected, false);
    assert.equal(detectInputWait(null).detected, false);
  });

  it("마지막 5줄만 검사해야 한다 (오래된 질문 무시)", () => {
    const output = [
      "Do you want to continue?", // 오래된 질문 (6번째 줄 이전)
      "line 1",
      "line 2",
      "line 3",
      "line 4",
      "Processing complete.", // 최근 줄은 정상
    ].join("\n");
    const result = detectInputWait(output);
    assert.equal(result.detected, false);
  });
});

describe("health-probe: createHealthProbe", () => {
  it("probe()는 L0/L1/L2/L3 결과를 반환해야 한다", async () => {
    const outputBytes = 100;
    const session = {
      pid: 9999,
      alive: true,
      getOutputBytes: () => outputBytes,
      getRecentOutput: () => "hello world",
    };

    const probe = createHealthProbe(session, { enableL2: false });
    const result = await probe.probe();

    assert.equal(result.l0, "ok");
    assert.equal(result.l1, "ok");
    assert.equal(result.l2, "skip");
    assert.ok(result.ts);
  });

  it("alive=false이면 L0이 fail이어야 한다", async () => {
    const session = {
      pid: null,
      alive: false,
      getOutputBytes: () => 0,
      getRecentOutput: () => "",
    };

    const probe = createHealthProbe(session);
    const result = await probe.probe();

    assert.equal(result.l0, "fail");
  });

  it("output이 threshold 동안 변하지 않으면 L1이 stall이어야 한다", async () => {
    const bytes = 50;
    const session = {
      pid: 1,
      alive: true,
      getOutputBytes: () => bytes,
      getRecentOutput: () => "normal output",
    };

    const probe = createHealthProbe(session, { l1ThresholdMs: 0 });

    // 첫 probe: output 기록
    await probe.probe();
    // 두 번째 probe: bytes 동일 + threshold=0 → stall
    const result = await probe.probe();

    assert.equal(result.l1, "stall");
  });

  it("output이 없지만 질문 패턴이면 L1이 input_wait이어야 한다", async () => {
    const bytes = 50;
    const session = {
      pid: 1,
      alive: true,
      getOutputBytes: () => bytes,
      getRecentOutput: () => "Would you like to proceed? (y/n)",
    };

    const probe = createHealthProbe(session, { l1ThresholdMs: 0 });
    await probe.probe();
    const result = await probe.probe();

    assert.equal(result.l1, "input_wait");
    assert.ok(result.inputWaitPattern);
  });

  it("resetTracking()은 내부 상태를 초기화해야 한다", async () => {
    const session = {
      pid: 1,
      alive: true,
      getOutputBytes: () => 100,
      getRecentOutput: () => "",
    };

    const probe = createHealthProbe(session);
    await probe.probe();
    probe.resetTracking();

    const status = probe.getStatus();
    assert.equal(status.l0, null);
    assert.equal(status.l1, null);
  });

  it("start()/stop()은 정상 동작해야 한다", () => {
    const session = {
      pid: 1,
      alive: true,
      getOutputBytes: () => 0,
      getRecentOutput: () => "",
    };

    const probe = createHealthProbe(session, { intervalMs: 100_000 });
    assert.equal(probe.started, false);
    probe.start();
    assert.equal(probe.started, true);
    probe.stop();
    assert.equal(probe.started, false);
  });
});

describe("health-probe: PROBE_DEFAULTS", () => {
  it("기존 stallThresholdMs(30s) 값을 l1ThresholdMs로 계승해야 한다", () => {
    assert.equal(PROBE_DEFAULTS.l1ThresholdMs, 30_000);
  });

  it("기존 stallTimeout(120s) 값을 l3ThresholdMs로 계승해야 한다", () => {
    assert.equal(PROBE_DEFAULTS.l3ThresholdMs, 120_000);
  });

  it("probe 주기는 5초여야 한다", () => {
    assert.equal(PROBE_DEFAULTS.intervalMs, 5_000);
  });
});
