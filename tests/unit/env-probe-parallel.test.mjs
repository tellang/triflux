import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import {
  checkCli,
  checkCliSync,
  probeClis,
  resetCliProbeCache,
} from "../../scripts/lib/env-probe.mjs";

function makeAsyncResolver(delayMs, paths = {}) {
  const calls = [];
  const resolver = (name) => new Promise((resolve) => {
    calls.push(name);
    setTimeout(() => {
      resolve(Object.hasOwn(paths, name) ? paths[name] : `/usr/bin/${name}`);
    }, delayMs);
  });
  return { calls, resolver };
}

describe("env-probe parallel CLI probing", () => {
  beforeEach(() => {
    resetCliProbeCache();
  });

  it("probeClis는 Promise.all로 병렬 probe 결과를 모은다", async () => {
    const { calls, resolver } = makeAsyncResolver(40, { gemini: "/opt/gemini" });
    const startedAt = performance.now();
    const result = await probeClis(["codex", "gemini", "claude"], {
      whichCommandAsyncFn: resolver,
    });
    const elapsedMs = performance.now() - startedAt;

    assert.deepEqual(result, {
      codex: { ok: true, path: "/usr/bin/codex" },
      gemini: { ok: true, path: "/opt/gemini" },
      claude: { ok: true, path: "/usr/bin/claude" },
    });
    assert.deepEqual(calls.sort(), ["claude", "codex", "gemini"]);
    assert.ok(elapsedMs < 100, `expected parallel probe under 100ms, got ${elapsedMs}ms`);
  });

  it("checkCli는 동일 CLI의 동시 요청을 하나의 in-flight probe로 합친다", async () => {
    let callCount = 0;
    const resolver = (name) => new Promise((resolve) => {
      callCount += 1;
      setTimeout(() => resolve(`/bin/${name}`), 25);
    });

    const [first, second] = await Promise.all([
      checkCli("codex", { whichCommandAsyncFn: resolver }),
      checkCli("codex", { whichCommandAsyncFn: resolver }),
    ]);

    assert.deepEqual(first, { ok: true, path: "/bin/codex" });
    assert.deepEqual(second, { ok: true, path: "/bin/codex" });
    assert.equal(callCount, 1);
  });

  it("checkCli는 첫 결과를 캐시하고 이후 동일 CLI는 캐시를 반환한다", async () => {
    let callCount = 0;
    const first = await checkCli("gemini", {
      whichCommandAsyncFn: async (name) => {
        callCount += 1;
        return `/cache/${name}`;
      },
    });
    const second = await checkCli("gemini", {
      whichCommandAsyncFn: async () => {
        callCount += 1;
        return null;
      },
    });

    assert.deepEqual(first, { ok: true, path: "/cache/gemini" });
    assert.deepEqual(second, { ok: true, path: "/cache/gemini" });
    assert.equal(callCount, 1);
  });

  it("checkCliSync는 whichCommand 기반 호환 래퍼로 캐시를 채운다", async () => {
    let syncCalls = 0;
    const syncResult = checkCliSync("claude", {
      whichCommandFn: (name) => {
        syncCalls += 1;
        return `/sync/${name}`;
      },
    });
    const asyncResult = await checkCli("claude", {
      whichCommandAsyncFn: async () => {
        throw new Error("should not run after sync cache warmup");
      },
    });

    assert.deepEqual(syncResult, { ok: true, path: "/sync/claude" });
    assert.deepEqual(asyncResult, { ok: true, path: "/sync/claude" });
    assert.equal(syncCalls, 1);
  });
});
