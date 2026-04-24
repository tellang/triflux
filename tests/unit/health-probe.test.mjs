import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("probe state 파일을 pid 기준으로 쓸 수 있어야 한다", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tfx-probe-test-"));
    const session = {
      pid: 4242,
      alive: true,
      getOutputBytes: () => 0,
      getRecentOutput: () => "Initializing MCP...",
    };

    const probe = createHealthProbe(session, {
      enableL2: true,
      checkMcp: async () => false,
      writeStateFile: true,
      stateDir,
    });
    await probe.probe();

    const state = JSON.parse(readFileSync(join(stateDir, "4242.json"), "utf8"));
    assert.equal(state.pid, 4242);
    assert.equal(state.state, "mcp_initializing");
    assert.equal(state.result.l2, "fail");
  });
});

describe("health-probe: stop() race (#162)", () => {
  it("stop() 후 probe() 호출은 null 을 반환해야 한다", async () => {
    const session = {
      pid: 4243,
      alive: true,
      getOutputBytes: () => 0,
      getRecentOutput: () => "",
    };
    const probe = createHealthProbe(session);
    probe.stop(); // start() 안 했어도 stopped 는 set 안 됨 — start() 후 stop() 필요
    probe.start();
    probe.stop();
    const result = await probe.probe();
    assert.equal(result, null);
  });

  it("start() 는 stopped flag 를 리셋해야 한다", async () => {
    const session = {
      pid: 4244,
      alive: true,
      getOutputBytes: () => 100,
      getRecentOutput: () => "",
    };
    const probe = createHealthProbe(session, { intervalMs: 100_000 });
    probe.start();
    probe.stop();
    assert.equal(await probe.probe(), null);
    probe.start();
    const result = await probe.probe();
    assert.ok(result, "start() 후 probe() 는 null 이 아니어야 한다");
    assert.equal(result.l0, "ok");
    probe.stop();
  });

  it("in-flight probe() 가 stop() 후 state file 을 재생성하지 않아야 한다", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tfx-probe-race-"));
    let releaseMcp;
    const mcpPromise = new Promise((resolve) => {
      releaseMcp = resolve;
    });
    const session = {
      pid: 4245,
      alive: true,
      getOutputBytes: () => 0,
      getRecentOutput: () => "",
    };
    const probe = createHealthProbe(session, {
      enableL2: true,
      checkMcp: () => mcpPromise, // 영원히 await — manually release
      writeStateFile: true,
      stateDir,
      intervalMs: 100_000,
    });
    probe.start();

    // start() 가 즉시 첫 probe() 를 발사. probeL2 의 await mcpPromise 에서 yield 됨.
    // 이 시점에 stop() 호출 → stopped=true + unlinkSync (state file 없음)
    probe.stop();

    // in-flight probe() 를 release. writeState 직전 stopped 체크로 skip 되어야 함.
    releaseMcp(true);

    // stopAndDrain 대신 stop 이미 호출. in-flight 가 끝날 때까지 micro-task 로 yield.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const stateFile = join(stateDir, "4245.json");
    assert.equal(
      existsSync(stateFile),
      false,
      "stop() 후 in-flight probe() 가 state file 을 재생성하면 안 됨",
    );
    // tmp 파일도 leak 되면 안 됨 (writeState 가 stopped 를 보고 일찍 return).
    const leftovers = readdirSync(stateDir).filter((n) => n.startsWith("4245.json.tmp"));
    assert.deepEqual(leftovers, [], `tmp 파일이 남으면 안 됨: ${leftovers.join(",")}`);
  });

  it("stopAndDrain() 은 in-flight probe() 완료까지 await 한다", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tfx-probe-drain-"));
    let releaseMcp;
    const mcpPromise = new Promise((resolve) => {
      releaseMcp = resolve;
    });
    const session = {
      pid: 4246,
      alive: true,
      getOutputBytes: () => 0,
      getRecentOutput: () => "",
    };
    const probe = createHealthProbe(session, {
      enableL2: true,
      checkMcp: () => mcpPromise,
      writeStateFile: true,
      stateDir,
      intervalMs: 100_000,
    });
    probe.start();
    // stop+drain 을 먼저 호출하되, drain 은 in-flight release 까지 대기.
    queueMicrotask(() => releaseMcp(true));
    await probe.stopAndDrain();
    const stateFile = join(stateDir, "4246.json");
    assert.equal(existsSync(stateFile), false);
  });

  it("atomic write 결과는 항상 valid JSON 이어야 한다", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tfx-probe-atomic-"));
    const session = {
      pid: 4247,
      alive: true,
      getOutputBytes: () => 256,
      getRecentOutput: () => "",
    };
    const probe = createHealthProbe(session, {
      writeStateFile: true,
      stateDir,
    });
    // 여러 번 연속 write → 매번 JSON.parse 성공해야 함.
    for (let i = 0; i < 10; i += 1) {
      await probe.probe();
      const raw = readFileSync(join(stateDir, "4247.json"), "utf8");
      assert.doesNotThrow(() => JSON.parse(raw), `iteration ${i} JSON parse fail`);
    }
    probe.stop();
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
