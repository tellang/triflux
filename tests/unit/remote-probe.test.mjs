// tests/unit/remote-probe.test.mjs — remote-probe.mjs 유닛 테스트
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  createRemoteProbe,
  sshCapturePane,
  sshSessionExists,
} from "../../hub/team/remote-probe.mjs";

// ── 헬퍼 ────────────────────────────────────────────────────────────────────

/** execFileSync mock 팩토리 — 성공 시 반환값, 실패 시 throw */
function mockExecFileSync(returnValue) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (returnValue instanceof Error) throw returnValue;
    return returnValue;
  };
  fn.calls = calls;
  return fn;
}

/** probe 옵션 — 자동 발화 억제, 빠른 threshold */
function probeOpts(overrides = {}) {
  return {
    intervalMs: 999_999,
    l1ThresholdMs: 100,
    l3ThresholdMs: 200,
    ...overrides,
  };
}

/** 기본 세션 정보 */
function makeSession(overrides = {}) {
  return {
    host: "test-host",
    paneTarget: "tfx-test:0.0",
    sessionName: "tfx-test",
    ...overrides,
  };
}

// ── 1. sshCapturePane ───────────────────────────────────────────────────────

describe("remote-probe: sshCapturePane", () => {
  it("성공 시 마지막 N줄을 반환해야 한다", () => {
    const mock = mockExecFileSync("line1\nline2\nline3\n\nline4\nline5\n");
    const result = sshCapturePane("host", "sess:0.0", 3, { execFileSync: mock });
    assert.equal(result, "line3\nline4\nline5");
  });

  it("SSH 명령에 올바른 인자를 전달해야 한다", () => {
    const mock = mockExecFileSync("output");
    sshCapturePane("ultra4", "my-sess:0.0", 5, { execFileSync: mock });
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].cmd, "ssh");
    assert.ok(mock.calls[0].args.includes("ultra4"));
    assert.ok(mock.calls[0].args.some((a) => a.includes("capture-pane")));
  });

  it("SSH 실패 시 null을 반환해야 한다", () => {
    const mock = mockExecFileSync(new Error("ssh failed"));
    const result = sshCapturePane("host", "sess:0.0", 5, { execFileSync: mock });
    assert.equal(result, null);
  });

  it("빈 출력 시 빈 문자열을 반환해야 한다", () => {
    const mock = mockExecFileSync("\n\n\n");
    const result = sshCapturePane("host", "sess:0.0", 5, { execFileSync: mock });
    assert.equal(result, "");
  });
});

// ── 2. sshSessionExists ────────────────────────────────────────────────────

describe("remote-probe: sshSessionExists", () => {
  it("has-session 성공 시 true를 반환해야 한다", () => {
    const mock = mockExecFileSync("");
    const result = sshSessionExists("host", "sess", { execFileSync: mock });
    assert.equal(result, true);
  });

  it("has-session에 올바른 인자를 전달해야 한다", () => {
    const mock = mockExecFileSync("");
    sshSessionExists("ultra4", "tfx-spawn-1", { execFileSync: mock });
    assert.equal(mock.calls[0].cmd, "ssh");
    assert.ok(mock.calls[0].args.includes("ultra4"));
    assert.ok(mock.calls[0].args.some((a) => a.includes("has-session")));
  });

  it("has-session 실패 시 false를 반환해야 한다", () => {
    const mock = mockExecFileSync(new Error("no session"));
    const result = sshSessionExists("host", "sess", { execFileSync: mock });
    assert.equal(result, false);
  });
});

// ── 3. createRemoteProbe 인터페이스 ─────────────────────────────────────────

describe("remote-probe: createRemoteProbe interface", () => {
  it("start, stop, probe, getStatus를 노출해야 한다", () => {
    const probe = createRemoteProbe(makeSession(), probeOpts());
    assert.equal(typeof probe.start, "function");
    assert.equal(typeof probe.stop, "function");
    assert.equal(typeof probe.probe, "function");
    assert.equal(typeof probe.getStatus, "function");
  });

  it("frozen 객체를 반환해야 한다", () => {
    const probe = createRemoteProbe(makeSession(), probeOpts());
    assert.ok(Object.isFrozen(probe));
  });

  it("started는 초기에 false여야 한다", () => {
    const probe = createRemoteProbe(makeSession(), probeOpts());
    assert.equal(probe.started, false);
  });

  it("getStatus 초기값은 l0=null, l2=skip이어야 한다", () => {
    const probe = createRemoteProbe(makeSession(), probeOpts());
    const status = probe.getStatus();
    assert.equal(status.l0, null);
    assert.equal(status.l2, "skip");
    assert.equal(status.l1, null);
    assert.equal(status.l3, null);
  });

  it("resetTracking이 존재해야 한다", () => {
    const probe = createRemoteProbe(makeSession(), probeOpts());
    assert.equal(typeof probe.resetTracking, "function");
  });
});

// ── 4. L0: SSH 연결 + 세션 존재 확인 ──────────────────────────────────────

describe("remote-probe: L0 probe", () => {
  it("세션이 존재하면 l0=ok를 반환해야 한다", async () => {
    const mock = mockExecFileSync("");
    const probe = createRemoteProbe(makeSession(), {
      ...probeOpts(),
      deps: { execFileSync: mock },
    });
    const result = await probe.probe();
    assert.equal(result.l0, "ok");
  });

  it("세션이 없으면 l0=fail을 반환해야 한다", async () => {
    let callCount = 0;
    const mock = (cmd, args, opts) => {
      callCount += 1;
      // has-session 호출은 첫 번째 — 실패시킴
      if (callCount === 1) throw new Error("no session");
      return "";
    };
    const probe = createRemoteProbe(makeSession(), {
      ...probeOpts(),
      deps: { execFileSync: mock },
    });
    const result = await probe.probe();
    assert.equal(result.l0, "fail");
  });
});

// ── 5. L1: 출력 변화 감지 ──────────────────────────────────────────────────

describe("remote-probe: L1 probe", () => {
  it("출력이 변경되면 l1=ok를 반환해야 한다", async () => {
    let captureCount = 0;
    const mock = (cmd, args, opts) => {
      // has-session은 성공
      if (args.some((a) => a.includes("has-session"))) return "";
      // capture-pane은 매번 다른 출력
      captureCount += 1;
      return `output-${captureCount}\n`;
    };
    const probe = createRemoteProbe(makeSession(), {
      ...probeOpts(),
      deps: { execFileSync: mock },
    });
    const r1 = await probe.probe();
    assert.equal(r1.l1, "ok");
    const r2 = await probe.probe();
    assert.equal(r2.l1, "ok");
  });

  it("출력이 동일하고 threshold 초과 시 l1=stall을 반환해야 한다", async () => {
    const mock = (cmd, args) => {
      if (args.some((a) => a.includes("has-session"))) return "";
      return "same output\n";
    };
    const probe = createRemoteProbe(makeSession(), {
      ...probeOpts({ l1ThresholdMs: 0 }),  // 즉시 stall 판정
      deps: { execFileSync: mock },
    });
    // 첫 probe — hash 초기화
    await probe.probe();
    // 두 번째 probe — 동일 출력 + threshold 0ms → stall
    const result = await probe.probe();
    assert.equal(result.l1, "stall");
  });
});

// ── 6. L1.5: INPUT_WAIT 감지 ───────────────────────────────────────────────

describe("remote-probe: L1.5 INPUT_WAIT", () => {
  it("질문 패턴이 있으면 l1=input_wait를 반환해야 한다", async () => {
    const mock = (cmd, args) => {
      if (args.some((a) => a.includes("has-session"))) return "";
      return "Do you want to continue? (y/n)\n";
    };
    const probe = createRemoteProbe(makeSession(), {
      ...probeOpts({ l1ThresholdMs: 0 }),
      deps: { execFileSync: mock },
    });
    await probe.probe();
    const result = await probe.probe();
    assert.equal(result.l1, "input_wait");
    assert.ok(result.inputWaitPattern);
  });
});

// ── 7. L3: 완료 토큰 감지 ──────────────────────────────────────────────────

describe("remote-probe: L3 probe", () => {
  it("출력이 있으면 l3=ok를 반환해야 한다", async () => {
    const mock = (cmd, args) => {
      if (args.some((a) => a.includes("has-session"))) return "";
      return "Working on it...\n";
    };
    const probe = createRemoteProbe(makeSession(), {
      ...probeOpts(),
      deps: { execFileSync: mock },
    });
    const result = await probe.probe();
    assert.equal(result.l3, "ok");
  });

  it("__TRIFLUX_DONE__ 토큰이 있으면 l3=completed를 반환해야 한다", async () => {
    const mock = (cmd, args) => {
      if (args.some((a) => a.includes("has-session"))) return "";
      return "result output\n__TRIFLUX_DONE__:token-abc:0\n";
    };
    const probe = createRemoteProbe(makeSession(), {
      ...probeOpts(),
      deps: { execFileSync: mock },
    });
    const result = await probe.probe();
    assert.equal(result.l3, "completed");
  });

  it("출력이 없고 timeout 초과 시 l3=timeout을 반환해야 한다", async () => {
    const mock = (cmd, args) => {
      if (args.some((a) => a.includes("has-session"))) return "";
      return "\n\n";  // 빈 줄만
    };
    const probe = createRemoteProbe(makeSession(), {
      ...probeOpts({ l3ThresholdMs: 0 }),
      deps: { execFileSync: mock },
    });
    const result = await probe.probe();
    assert.equal(result.l3, "timeout");
  });
});

// ── 8. onProbe 콜백 ────────────────────────────────────────────────────────

describe("remote-probe: onProbe callback", () => {
  it("probe 실행 시 onProbe 콜백이 호출되어야 한다", async () => {
    const results = [];
    const mock = (cmd, args) => {
      if (args.some((a) => a.includes("has-session"))) return "";
      return "output\n";
    };
    const probe = createRemoteProbe(makeSession(), {
      ...probeOpts(),
      onProbe: (r) => results.push(r),
      deps: { execFileSync: mock },
    });
    await probe.probe();
    assert.equal(results.length, 1);
    assert.ok("l0" in results[0]);
    assert.ok("l1" in results[0]);
    assert.ok("l3" in results[0]);
    assert.ok("ts" in results[0]);
  });
});

// ── 9. start/stop ──────────────────────────────────────────────────────────

describe("remote-probe: start/stop", () => {
  it("start 후 started=true, stop 후 started=false여야 한다", () => {
    const mock = mockExecFileSync("");
    const probe = createRemoteProbe(makeSession(), {
      ...probeOpts(),
      deps: { execFileSync: mock },
    });
    probe.start();
    assert.equal(probe.started, true);
    probe.stop();
    assert.equal(probe.started, false);
  });

  it("start를 두 번 호출해도 에러가 발생하지 않아야 한다", () => {
    const mock = mockExecFileSync("");
    const probe = createRemoteProbe(makeSession(), {
      ...probeOpts(),
      deps: { execFileSync: mock },
    });
    probe.start();
    probe.start();  // 중복 호출
    assert.equal(probe.started, true);
    probe.stop();
  });

  it("stop을 start 없이 호출해도 에러가 발생하지 않아야 한다", () => {
    const mock = mockExecFileSync("");
    const probe = createRemoteProbe(makeSession(), {
      ...probeOpts(),
      deps: { execFileSync: mock },
    });
    assert.doesNotThrow(() => probe.stop());
  });
});

// ── 10. resetTracking ──────────────────────────────────────────────────────

describe("remote-probe: resetTracking", () => {
  it("resetTracking 후 상태가 초기화되어야 한다", async () => {
    const mock = (cmd, args) => {
      if (args.some((a) => a.includes("has-session"))) return "";
      return "output\n";
    };
    const probe = createRemoteProbe(makeSession(), {
      ...probeOpts(),
      deps: { execFileSync: mock },
    });
    await probe.probe();
    const beforeReset = probe.getStatus();
    assert.equal(beforeReset.l0, "ok");

    probe.resetTracking();
    const afterReset = probe.getStatus();
    assert.equal(afterReset.l0, null);
    assert.equal(afterReset.l1, null);
    assert.equal(afterReset.l2, "skip");
    assert.equal(afterReset.l3, null);
  });
});

// ── 11. L0 fail 시 L1/L3 스킵 ──────────────────────────────────────────────

describe("remote-probe: L0 fail skips L1/L3", () => {
  it("L0 실패 시 capture-pane을 호출하지 않아야 한다", async () => {
    const calls = [];
    const mock = (cmd, args) => {
      const joined = args.join(" ");
      calls.push(joined);
      if (joined.includes("has-session")) throw new Error("no session");
      return "should not reach\n";
    };
    const probe = createRemoteProbe(makeSession(), {
      ...probeOpts(),
      deps: { execFileSync: mock },
    });
    const result = await probe.probe();
    assert.equal(result.l0, "fail");
    // capture-pane 호출이 없어야 함
    assert.ok(!calls.some((c) => c.includes("capture-pane")));
  });
});
