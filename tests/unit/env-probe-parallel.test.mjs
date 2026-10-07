import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { describe, it } from "node:test";

import { probeClis } from "../../scripts/lib/env-probe.mjs";

function makeAsyncResolver(delayMs, paths = {}) {
  const calls = [];
  const resolver = (name) =>
    new Promise((resolve) => {
      calls.push(name);
      setTimeout(() => {
        resolve(Object.hasOwn(paths, name) ? paths[name] : `/usr/bin/${name}`);
      }, delayMs);
    });
  return { calls, resolver };
}

describe("env-probe parallel CLI probing", () => {
  it("probeClis는 Promise.all로 병렬 probe 결과를 모은다", async () => {
    const { calls, resolver } = makeAsyncResolver(40, {
      gemini: "/opt/gemini",
    });
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
    assert.ok(
      elapsedMs < 100,
      `expected parallel probe under 100ms, got ${elapsedMs}ms`,
    );
  });
});
