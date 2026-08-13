import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  createCtoAutoCollector,
  isCtoAutoCollectDisabled,
} from "../../hub/team/cto-auto-collect.mjs";

const tmpRoots = [];

function makeProjectRoot() {
  const root = mkdtempSync(join(tmpdir(), "tfx-cto-auto-test-"));
  tmpRoots.push(root);
  // resolveLakeRootDir 가 toplevel 로 안 올라가도록 임시 root 를 git toplevel 로
  // 만든다(.git 마커). 이게 없으면 mkdtemp 상위에서 우연히 .git 을 만날 때
  // rootDir 가 흔들려 테스트가 비결정적이 된다.
  mkdirSync(join(root, ".git"), { recursive: true });
  return root;
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeCollector({
  registry,
  runCollect,
  now = () => 1_000_000,
  env = {},
}) {
  return createCtoAutoCollector({
    registry,
    runCollect,
    now,
    env,
    debounceMs: 120_000,
  });
}

describe("cto-auto-collect", () => {
  it("recognizes opt-out env values", () => {
    for (const value of ["0", "false", "off", "no", " FALSE "]) {
      assert.equal(
        isCtoAutoCollectDisabled({ TFX_CTO_AUTO_COLLECT: value }),
        true,
      );
    }
    assert.equal(
      isCtoAutoCollectDisabled({ TFX_CTO_AUTO_COLLECT: "1" }),
      false,
    );
    assert.equal(isCtoAutoCollectDisabled({}), false);
  });

  it("triggers runCollect with reason 'triggered' when a same-project peer exists", async () => {
    const root = makeProjectRoot();
    const calls = [];
    const collector = makeCollector({
      registry: {
        querySessions(filter) {
          assert.deepEqual(filter, {
            cwd: root,
            worktree: root,
            excludeSessionId: "new-session",
          });
          return [{ sessionId: "peer-session" }];
        },
      },
      runCollect: async (args, opts) => calls.push({ args, opts }),
    });

    const result = collector.handleSessionStarted({
      sessionId: "new-session",
      session: { cwd: root, worktreePath: root },
    });
    await collector.drain();

    assert.equal(result.triggered, true);
    assert.equal(result.reason, "triggered");
    assert.equal(result.peerCount, 1);
    assert.deepEqual(calls, [{ args: [], opts: { rootDir: root } }]);
  });

  it("triggers solo collect when there are no peers (single-session)", async () => {
    const root = makeProjectRoot();
    const soloCalls = [];
    const solo = makeCollector({
      registry: { querySessions: () => [] },
      runCollect: async (args, opts) => soloCalls.push({ args, opts }),
    });
    const result = solo.handleSessionStarted({
      sessionId: "solo",
      session: { cwd: root, worktreePath: root },
    });
    await solo.drain();
    assert.equal(result.triggered, true);
    assert.equal(result.reason, "triggered-solo");
    assert.equal(result.peerCount, 0);
    assert.deepEqual(soloCalls, [{ args: [], opts: { rootDir: root } }]);
  });

  it("falls through to solo collect when querySessions throws", async () => {
    const root = makeProjectRoot();
    const calls = [];
    const collector = makeCollector({
      registry: {
        querySessions() {
          throw new Error("registry down");
        },
      },
      runCollect: async (args, opts) => calls.push({ args, opts }),
    });
    const result = collector.handleSessionStarted({
      sessionId: "x",
      session: { cwd: root, worktreePath: root },
    });
    await collector.drain();
    assert.equal(result.triggered, true);
    assert.equal(result.reason, "triggered-solo");
    assert.deepEqual(calls, [{ args: [], opts: { rootDir: root } }]);
  });

  it("skips when env disables it, and while debounced", async () => {
    const root = makeProjectRoot();
    const calls = [];
    const disabled = makeCollector({
      env: { TFX_CTO_AUTO_COLLECT: "off" },
      registry: { querySessions: () => [{ sessionId: "peer" }] },
      runCollect: async () => calls.push("disabled"),
    });
    assert.equal(
      disabled.handleSessionStarted({
        sessionId: "solo",
        session: { cwd: root, worktreePath: root },
      }).reason,
      "disabled",
    );

    let now = 2_000_000;
    const debounced = makeCollector({
      now: () => now,
      registry: { querySessions: () => [{ sessionId: "peer" }] },
      runCollect: async () => calls.push("debounced"),
    });
    assert.equal(
      debounced.handleSessionStarted({
        sessionId: "a",
        session: { cwd: root, worktreePath: root },
      }).triggered,
      true,
    );
    now += 1_000;
    assert.equal(
      debounced.handleSessionStarted({
        sessionId: "b",
        session: { cwd: root, worktreePath: root },
      }).reason,
      "debounced",
    );
    await debounced.drain();

    assert.deepEqual(calls, ["debounced"]);
  });

  it("does not call runCollect when TFX_CTO disables an opted-in auto-collector", async () => {
    const root = makeProjectRoot();
    const calls = [];
    const collector = makeCollector({
      env: {
        TFX_CTO: "0",
        TFX_CTO_AUTO_COLLECT: "1",
        TFX_CTO_NORTH_STAR: "1",
      },
      registry: { querySessions: () => [{ sessionId: "peer" }] },
      runCollect: async () => calls.push("collect"),
    });

    const result = collector.handleSessionStarted({
      sessionId: "master-off",
      session: { cwd: root, worktreePath: root },
    });
    await collector.drain();

    assert.deepEqual(result, { triggered: false, reason: "disabled" });
    assert.deepEqual(calls, []);
  });

  it("skips when current.md is fresh", () => {
    const root = makeProjectRoot();
    const lakeRoot = join(root, ".triflux", "lake");
    mkdirSync(lakeRoot, { recursive: true });
    const currentMd = join(lakeRoot, "current.md");
    writeFileSync(currentMd, "fresh\n", "utf8");
    const now = 3_000_000;
    utimesSync(currentMd, new Date(now - 1_000), new Date(now - 1_000));

    const collector = makeCollector({
      now: () => now,
      registry: { querySessions: () => [{ sessionId: "peer" }] },
      runCollect: async () => {
        throw new Error("must not collect");
      },
    });

    assert.equal(
      collector.handleSessionStarted({
        sessionId: "a",
        session: { cwd: root, worktreePath: root },
      }).reason,
      "fresh-lake",
    );
  });
});
