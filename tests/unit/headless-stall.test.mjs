// tests/unit/headless-stall.test.mjs — waitForCompletionWithStallDetect 단위 테스트
// _deps DI로 psmux 함수를 mock하여 실제 함수를 호출한다.

import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { waitForCompletionWithStallDetect } from "../../hub/team/headless.mjs";

const RESULT_DIR = join(tmpdir(), "tfx-stall-test");

/**
 * Mock deps 빌더 — 기본값은 "frozen output" (stall 유발)
 * @param {object} overrides
 */
function createDeps(overrides = {}) {
  return {
    capturePsmuxPane: () => "frozen",
    existsSync: () => false,
    statSync: () => ({ mtimeMs: 0 }),
    readFileSync: () => "",
    psmuxExec: (args) => {
      if (args[0] === "split-window") return "tfx:0.2";
      return "";
    },
    dispatchCommand: () => {},
    startCapture: () => {},
    ...overrides,
  };
}

describe("waitForCompletionWithStallDetect", () => {
  beforeEach(() => mkdirSync(RESULT_DIR, { recursive: true }));
  afterEach(() => {
    try {
      rmSync(RESULT_DIR, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("completion 토큰 감지 시 즉시 반환한다", async () => {
    let call = 0;
    const deps = createDeps({
      capturePsmuxPane: () => {
        call++;
        if (call >= 2) return "some output\nTFX_DONE_tok1:0\ntrailing";
        return "some output";
      },
    });

    const result = await waitForCompletionWithStallDetect(
      "sess",
      "0.1",
      "/tmp/r.txt",
      {
        token: "tok1",
        pollInterval: 20,
        stallTimeout: 500,
        completionTimeout: 3000,
        _deps: deps,
      },
    );

    assert.equal(result.matched, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.restarts, 0);
    assert.equal(result.stallDetected, false);
  });

  it("output 변화 시 stall 타이머가 리셋된다", async () => {
    let call = 0;
    const deps = createDeps({
      capturePsmuxPane: () => {
        call++;
        // 매번 다른 출력 → stall 방지, 5번째에 완료
        if (call >= 5) return `out-${call}\nTFX_DONE_t2:0`;
        return `out-${call}`;
      },
    });

    const result = await waitForCompletionWithStallDetect(
      "sess",
      "0.1",
      "/tmp/r.txt",
      {
        token: "t2",
        pollInterval: 20,
        stallTimeout: 80, // 80ms — 폴링 4회 분량
        completionTimeout: 3000,
        _deps: deps,
      },
    );

    assert.equal(result.matched, true);
    assert.equal(result.stallDetected, false);
  });

  it("resultFile mtime 변화 + 내용 존재 시 완료로 간주한다", async () => {
    const resultFile = join(RESULT_DIR, "result-mtime.txt");
    let call = 0;
    let mtime = 1000;

    const deps = createDeps({
      capturePsmuxPane: () => "same", // 출력 불변
      existsSync: () => {
        call++;
        return call >= 3; // 3번째 폴링부터 파일 존재
      },
      statSync: () => ({ mtimeMs: (mtime += 100) }), // mtime 계속 증가
      readFileSync: () => "task completed",
    });

    const result = await waitForCompletionWithStallDetect(
      "sess",
      "0.1",
      resultFile,
      {
        token: "t3",
        pollInterval: 20,
        stallTimeout: 500,
        completionTimeout: 3000,
        _deps: deps,
      },
    );

    assert.equal(result.matched, true);
    assert.equal(result.exitCode, 0);
  });

  it("무출력 시 stall 감지 → kill + re-dispatch → 재시작 후 완료", async () => {
    let iteration = 0;
    let killCalls = 0;
    let dispatchCalls = 0;

    const deps = createDeps({
      capturePsmuxPane: () => {
        iteration++;
        // 재시작 후(iteration > 10) 완료 토큰 출력
        if (iteration > 10) return "TFX_DONE_t4:0";
        return "frozen";
      },
      psmuxExec: (args) => {
        if (args[0] === "kill-pane") {
          killCalls++;
          return "";
        }
        if (args[0] === "split-window") return "tfx:0.3";
        return "";
      },
      dispatchCommand: () => {
        dispatchCalls++;
      },
    });

    const result = await waitForCompletionWithStallDetect(
      "sess",
      "0.1",
      "/tmp/r.txt",
      {
        token: "t4",
        command: "codex --prompt test",
        pollInterval: 10,
        stallTimeout: 50, // 50ms 무변화 → stall
        completionTimeout: 5000,
        maxRestarts: 3, // 3 cycles needed: cycle 1(1-5), cycle 2(6-10), cycle 3(11+ → done)
        _deps: deps,
      },
    );

    assert.equal(result.matched, true);
    assert.equal(result.stallDetected, true);
    assert.ok(result.restarts >= 1, "최소 1회 재시작");
    assert.ok(killCalls >= 1, "kill-pane 호출됨");
    assert.ok(dispatchCalls >= 1, "re-dispatch 호출됨");
  });

  it("maxRestarts 초과 시 STALL_EXHAUSTED 에러를 throw한다", async () => {
    const deps = createDeps(); // frozen output → stall 유발

    await assert.rejects(
      () =>
        waitForCompletionWithStallDetect("sess", "0.1", "/tmp/r.txt", {
          token: "t5",
          command: "codex --prompt test",
          pollInterval: 10,
          stallTimeout: 40,
          completionTimeout: 5000,
          maxRestarts: 1,
          _deps: deps,
        }),
      (err) => {
        assert.equal(err.code, "STALL_EXHAUSTED");
        assert.equal(err.category, "transient");
        assert.ok(err.recovery.includes("수동 확인"));
        assert.equal(typeof err.restarts, "number");
        return true;
      },
    );
  });

  it("completionTimeout 초과 시 timedOut=true 결과를 반환한다", async () => {
    let call = 0;
    const deps = createDeps({
      capturePsmuxPane: () => `changing-${call++}`, // 출력 변화 → stall 방지
    });

    const result = await waitForCompletionWithStallDetect(
      "sess",
      "0.1",
      "/tmp/r.txt",
      {
        token: "t6",
        pollInterval: 15,
        stallTimeout: 500,
        completionTimeout: 60, // 60ms 전체 타임아웃
        _deps: deps,
      },
    );

    assert.equal(result.matched, false);
    assert.equal(result.timedOut, true);
  });

  it("onPoll 콜백이 매 폴링마다 호출된다", async () => {
    let pollCount = 0;
    let call = 0;
    const deps = createDeps({
      capturePsmuxPane: () => {
        call++;
        if (call >= 3) return "TFX_DONE_t7:0";
        return `out-${call}`;
      },
    });

    await waitForCompletionWithStallDetect("sess", "0.1", "/tmp/r.txt", {
      token: "t7",
      pollInterval: 15,
      stallTimeout: 500,
      completionTimeout: 3000,
      onPoll: () => {
        pollCount++;
      },
      _deps: deps,
    });

    assert.ok(pollCount >= 2, `onPoll 최소 2회 호출 (실제: ${pollCount})`);
  });

  it("command 없이 stall 시 pane만 kill하고 재시작 (re-dispatch 없음)", async () => {
    let killCalls = 0;
    let dispatchCalls = 0;

    const deps = createDeps({
      psmuxExec: (args) => {
        if (args[0] === "kill-pane") {
          killCalls++;
          return "";
        }
        if (args[0] === "split-window") return "tfx:0.4";
        return "";
      },
      dispatchCommand: () => {
        dispatchCalls++;
      },
    });

    await assert.rejects(
      () =>
        waitForCompletionWithStallDetect("sess", "0.1", "/tmp/r.txt", {
          // command 없음
          token: "t8",
          pollInterval: 10,
          stallTimeout: 40,
          completionTimeout: 5000,
          maxRestarts: 1,
          _deps: deps,
        }),
      (err) => {
        assert.equal(err.code, "STALL_EXHAUSTED");
        return true;
      },
    );

    assert.ok(killCalls >= 1, "pane kill은 발생");
    assert.equal(dispatchCalls, 0, "command 없으면 re-dispatch 없음");
  });

  it("특수 문자 token이 정상 이스케이프된다", async () => {
    let call = 0;
    const specialToken = "tok.special+chars";
    const deps = createDeps({
      capturePsmuxPane: () => {
        call++;
        if (call >= 2) return `output\nTFX_DONE_${specialToken}:42\nmore`;
        return "output";
      },
    });

    const result = await waitForCompletionWithStallDetect(
      "sess",
      "0.1",
      "/tmp/r.txt",
      {
        token: specialToken,
        pollInterval: 15,
        stallTimeout: 500,
        completionTimeout: 3000,
        _deps: deps,
      },
    );

    assert.equal(result.matched, true);
    assert.equal(result.exitCode, 42);
  });

  it("STALL_EXHAUSTED 에러 구조가 핸드오프 스펙과 일치한다", async () => {
    const deps = createDeps();

    try {
      await waitForCompletionWithStallDetect("sess", "0.1", "/tmp/r.txt", {
        token: "t9",
        command: "test-cmd",
        pollInterval: 10,
        stallTimeout: 30,
        completionTimeout: 5000,
        maxRestarts: 0, // 즉시 exhausted
        _deps: deps,
      });
      assert.fail("에러가 throw되어야 한다");
    } catch (err) {
      // 스펙: {code: 'STALL_EXHAUSTED', category: 'transient', recovery: '...'}
      assert.equal(err.code, "STALL_EXHAUSTED");
      assert.equal(err.category, "transient");
      assert.equal(typeof err.recovery, "string");
      assert.equal(typeof err.restarts, "number");
      assert.ok(err instanceof Error);
    }
  });
});
