import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

const originalPsmuxBin = process.env.PSMUX_BIN;
process.env.PSMUX_BIN = "/usr/bin/false";

const { runHeadless, runHeadlessInteractive, runHeadlessWithCleanup } =
  await import("../../hub/team/headless.mjs?session-ownership-test");

after(() => {
  if (originalPsmuxBin === undefined) delete process.env.PSMUX_BIN;
  else process.env.PSMUX_BIN = originalPsmuxBin;
});

const assignments = [{ cli: "codex", prompt: "ownership regression" }];

describe("runHeadless session ownership", () => {
  for (const progressive of [true, false]) {
    const mode = progressive ? "progressive" : "batch";

    it(`${mode}는 create 반환 직후 ownership을 획득해 theme 오류를 한 번 cleanup한다`, async () => {
      const events = [];

      await assert.rejects(
        runHeadless(`owned-${mode}`, assignments, {
          progressive,
          _deps: {
            createPsmuxSession(sessionName) {
              events.push(["create", sessionName]);
              return { sessionName, panes: [`${sessionName}:0.0`] };
            },
            applyTrifluxTheme(sessionName) {
              events.push(["theme", sessionName]);
              throw new Error(`${mode} theme failed`);
            },
            killPsmuxSession(sessionName) {
              events.push(["kill", sessionName]);
            },
          },
        }),
        new RegExp(`${mode} theme failed`, "u"),
      );

      assert.deepEqual(events, [
        ["create", `owned-${mode}`],
        ["theme", `owned-${mode}`],
        ["kill", `owned-${mode}`],
      ]);
    });

    it(`${mode} create duplicate throw는 ownership을 획득하지 않아 cleanup하지 않는다`, async () => {
      const events = [];

      await assert.rejects(
        runHeadless(`foreign-${mode}`, assignments, {
          progressive,
          _deps: {
            createPsmuxSession(sessionName) {
              events.push(["create-duplicate", sessionName]);
              throw new Error(`${mode} duplicate session`);
            },
            applyTrifluxTheme(sessionName) {
              events.push(["theme", sessionName]);
            },
            killPsmuxSession(sessionName) {
              events.push(["kill", sessionName]);
            },
          },
        }),
        new RegExp(`${mode} duplicate session`, "u"),
      );

      assert.deepEqual(events, [["create-duplicate", `foreign-${mode}`]]);
    });
  }

  it("성공 반환은 acquired ownership을 보존하고 release는 idempotent하다", async () => {
    const kills = [];
    const result = await runHeadless("owned-success", assignments, {
      _deps: {
        dispatchProgressive(sessionName, _assignments, dispatchOpts) {
          dispatchOpts.sessionOwnership.acquire(sessionName);
          return [];
        },
        killPsmuxSession: (sessionName) => kills.push(sessionName),
      },
    });

    assert.equal(result.sessionOwnership.owned, true);
    assert.equal(result.sessionOwnership.release(), true);
    assert.equal(result.sessionOwnership.owned, false);
    assert.equal(result.sessionOwnership.release(), false);
    assert.deepEqual(kills, ["owned-success"]);
  });
});

describe("runHeadless callers preserve ownership", () => {
  it("runHeadlessWithCleanup은 foreign session을 cleanup하지 않는다", async () => {
    let runCalls = 0;
    const kills = [];

    const result = await runHeadlessWithCleanup([], {
      sessionPrefix: "foreign-cleanup",
      _deps: {
        async runHeadless(sessionName, _assignments, runOpts) {
          runCalls += 1;
          return {
            sessionName,
            results: [],
            sessionOwnership: runOpts._sessionOwnership,
          };
        },
        killPsmuxSession: (sessionName) => kills.push(sessionName),
      },
    });

    assert.equal(runCalls, 1);
    assert.equal(result.sessionOwnership.owned, false);
    assert.deepEqual(kills, []);
  });

  it("runHeadlessWithCleanup은 success/error에서 acquired session을 정확히 한 번 cleanup한다", async () => {
    for (const throwsAfterAcquire of [false, true]) {
      const kills = [];
      let capturedOwnership;
      const invocation = runHeadlessWithCleanup([], {
        sessionPrefix: throwsAfterAcquire ? "owned-error" : "owned-success",
        _deps: {
          async runHeadless(sessionName, _assignments, runOpts) {
            capturedOwnership = runOpts._sessionOwnership;
            capturedOwnership.acquire(sessionName);
            if (throwsAfterAcquire) throw new Error("dispatch failed");
            return {
              sessionName,
              results: [],
              sessionOwnership: capturedOwnership,
            };
          },
          killPsmuxSession: (sessionName) => kills.push(sessionName),
        },
      });

      if (throwsAfterAcquire) {
        await assert.rejects(invocation, /dispatch failed/u);
      } else {
        await invocation;
      }

      assert.equal(capturedOwnership.owned, false);
      assert.equal(capturedOwnership.release(), false);
      assert.equal(kills.length, 1);
    }
  });

  for (const owned of [false, true]) {
    it(`runHeadlessInteractive handle.kill은 owned=${owned}에서만 한 번 cleanup한다`, async () => {
      let runCalls = 0;
      const kills = [];
      const handle = await runHeadlessInteractive("interactive-owner", [], {
        _deps: {
          async runHeadless(sessionName, _assignments, runOpts) {
            runCalls += 1;
            if (owned) runOpts._sessionOwnership.acquire(sessionName);
            return {
              sessionName,
              results: [],
              sessionOwnership: runOpts._sessionOwnership,
            };
          },
          killPsmuxSession: (sessionName) => kills.push(sessionName),
        },
      });

      assert.equal(runCalls, 1);
      handle.kill();
      handle.kill();

      assert.equal(handle._killed, true);
      assert.deepEqual(kills, owned ? ["interactive-owner"] : []);
    });
  }
});
