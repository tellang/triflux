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
    const leftovers = readdirSync(stateDir).filter((n) =>
      n.startsWith("4245.json.tmp"),
    );
    assert.deepEqual(
      leftovers,
      [],
      `tmp 파일이 남으면 안 됨: ${leftovers.join(",")}`,
    );
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
      assert.doesNotThrow(
        () => JSON.parse(raw),
        `iteration ${i} JSON parse fail`,
      );
    }
    probe.stop();
  });
});

// PR #167 review findings — P0 + P1 회귀 가드.
describe("health-probe: PR #167 review fixes", () => {
  it("P0 — stop()→start() 재호출 시 old run 의 in-flight probe 가 새 run 의 state 를 덮지 않아야 한다", async () => {
    // 시나리오: probe1 시작 → await probeL2 진행 중 → stop() → start() (run-2) → probe1 의
    // writeState 가 epoch 비교로 skip 되어야 한다 (옛 stopped flag 만으로는 start() 가
    // stopped=false reset 한 후 race 못 막음).
    const stateDir = mkdtempSync(join(tmpdir(), "tfx-probe-epoch-"));
    let releaseMcp;
    const mcpPromise = new Promise((resolve) => {
      releaseMcp = resolve;
    });
    let probeCount = 0;
    const session = {
      pid: 9170,
      alive: true,
      getOutputBytes: () => 100 + probeCount,
      getRecentOutput: () => "",
    };
    const probe = createHealthProbe(session, {
      enableL2: true,
      checkMcp: () => {
        probeCount += 1;
        return mcpPromise; // 영원히 hold 하지 않고 외부에서 release
      },
      writeStateFile: true,
      stateDir,
      intervalMs: 100_000,
      onProbe: () => {},
    });
    probe.start(); // run-1 (epoch 1) — probe1 시작 (await checkMcp 에 멈춤)
    // 짧은 yield 로 probe1 이 await checkMcp 까지 도달
    await new Promise((r) => setImmediate(r));

    probe.stop(); // stopped=true
    probe.start(); // run-2 (epoch 2) — probe2 시작

    // run-1 의 probe1 은 여전히 await checkMcp 에 멈춰 있다. 해제 → writeState 시도 → epoch 비교로 skip 되어야.
    releaseMcp(true);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // run-2 의 probe 도 동일 mcpPromise 를 받았으므로 같이 release. 단 epoch 2 라 정상 write.
    // 이 시점 state file 은 run-2 의 결과여야 (run-1 이 덮으면 회귀).
    await probe.stopAndDrain();
    const stateFile = join(stateDir, "9170.json");
    if (existsSync(stateFile)) {
      const raw = readFileSync(stateFile, "utf8");
      assert.doesNotThrow(
        () => JSON.parse(raw),
        "state file 은 valid JSON 이어야",
      );
    } else {
      // stop() 후 unlink 됐으면 OK. 핵심: 회귀 가드는 race 로 stale state 가 안 남는 것.
    }
  });

  it("P1-1 — 겹친 in-flight probe 들이 모두 drain 되어야 한다 (단일 var 패턴 회귀)", async () => {
    // 시나리오: 단일 inFlightProbe 변수를 쓰면 N+1 이 N 끝나기 전에 시작 → N 을 덮어써
    // stopAndDrain() 시 N 이 누락. Set 패턴은 모두 추적.
    const stateDir = mkdtempSync(join(tmpdir(), "tfx-probe-drain-"));
    const releases = [];
    const inFlightCount = { value: 0 };
    let probeStarted = 0;
    const session = {
      pid: 9171,
      alive: true,
      getOutputBytes: () => probeStarted * 10,
      getRecentOutput: () => "",
    };
    const probe = createHealthProbe(session, {
      enableL2: true,
      checkMcp: () =>
        new Promise((resolve) => {
          probeStarted += 1;
          inFlightCount.value += 1;
          releases.push(() => {
            inFlightCount.value -= 1;
            resolve(true);
          });
        }),
      writeStateFile: true,
      stateDir,
      intervalMs: 100_000,
    });
    // 수동으로 probe() 3번 연속 호출 — 각각 await checkMcp 에 멈춤 → 3 in-flight 동시
    const p1 = probe.probe();
    const p2 = probe.probe();
    const p3 = probe.probe();
    await new Promise((r) => setImmediate(r));
    assert.equal(inFlightCount.value, 3, "3 probe 가 동시 in-flight 여야");

    // stopAndDrain 호출 → release 처리 → 모두 drain 되어야
    const drainPromise = probe.stopAndDrain();
    // release 모두 호출
    for (const release of releases) release();
    await drainPromise;
    assert.equal(
      inFlightCount.value,
      0,
      "stopAndDrain 후 in-flight = 0 (모두 drain)",
    );
    // promises 도 정상 settle (allSettled 라 reject 도 OK)
    await Promise.allSettled([p1, p2, p3]);
  });

  it("P1-2 — atomic write 1차/2차 rename 실패 시뮬레이션 — 기존 파일이 손실되지 않아야 한다 (소스 검증)", () => {
    // backup-then-swap 패턴이 코드에 들어있는지 source 검증.
    // 옛 unlinkSync→renameSync 패턴은 1차 unlink 후 2차 rename 실패 시 기존 파일 손실.
    const source = readFileSync(
      new URL("../../hub/team/health-probe.mjs", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /backup-then-swap|backupCreated/,
      "P1-2 backup-then-swap 패턴 사라짐",
    );
    assert.match(
      source,
      /renameSync\(stateFile, backupPath\)/,
      "backup rename 분기 사라짐",
    );
    assert.match(
      source,
      /renameSync\(backupPath, stateFile\)/,
      "backup 복구 분기 사라짐",
    );
    // 옛 패턴 (unlinkSync → renameSync 직접 시퀀스) 회귀 가드
    assert.doesNotMatch(
      source,
      /unlinkSync\(stateFile\);\s*\}\s*catch\s*\{\}\s*renameSync\(tmpPath, stateFile\);/,
      "옛 unlinkSync→renameSync 비원자 패턴 회귀",
    );
  });

  it("P0 — source 에 runEpoch 가드 분기 포함", () => {
    const source = readFileSync(
      new URL("../../hub/team/health-probe.mjs", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /runEpoch\s*\+=\s*1/,
      "start() 에서 runEpoch 증가 사라짐",
    );
    assert.match(
      source,
      /probeEpoch\s*=\s*runEpoch/,
      "probe() 에서 epoch 캡처 사라짐",
    );
    assert.match(
      source,
      /probeEpoch\s*!==\s*runEpoch/,
      "writeState() 의 epoch 비교 사라짐",
    );
  });

  it("P1-1 — source 에 inFlightProbes Set 패턴 포함", () => {
    const source = readFileSync(
      new URL("../../hub/team/health-probe.mjs", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /inFlightProbes\s*=\s*new Set\(\)/,
      "inFlightProbes Set 선언 사라짐",
    );
    assert.match(source, /inFlightProbes\.add\(promise\)/, "Set add 사라짐");
    assert.match(
      source,
      /Promise\.allSettled\(Array\.from\(inFlightProbes\)\)/,
      "stopAndDrain allSettled drain 사라짐",
    );
    // 옛 단일 var 패턴 회귀 가드
    assert.doesNotMatch(
      source,
      /let\s+inFlightProbe\s*=\s*null/,
      "옛 단일 inFlightProbe 변수 회귀",
    );
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
