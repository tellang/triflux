// tests/unit/check-mcp-hub.test.mjs
// #168 P3: hub /health ping checker factory 동작 검증.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createHubHealthChecker } from "../../hub/team/check-mcp-hub.mjs";

describe("#168 createHubHealthChecker", () => {
  const ORIGINAL_ENV = process.env.TFX_HUB_URL;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.TFX_HUB_URL;
    else process.env.TFX_HUB_URL = ORIGINAL_ENV;
  });

  it("returns true when hub /health responds 200", async () => {
    const calls = [];
    const check = createHubHealthChecker({
      hubUrl: "http://example:9999",
      fetchFn: async (url) => {
        calls.push(url);
        return { ok: true };
      },
    });
    const ok = await check();
    assert.equal(ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], "http://example:9999/health");
  });

  it("returns false when hub /health responds non-ok", async () => {
    const check = createHubHealthChecker({
      hubUrl: "http://example:9999",
      fetchFn: async () => ({ ok: false }),
    });
    assert.equal(await check(), false);
  });

  it("returns false on fetch reject (network/timeout)", async () => {
    const check = createHubHealthChecker({
      hubUrl: "http://example:9999",
      fetchFn: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    assert.equal(await check(), false);
  });

  it("aborts after timeoutMs", async () => {
    let aborted = false;
    const check = createHubHealthChecker({
      hubUrl: "http://example:9999",
      timeoutMs: 10,
      fetchFn: (_url, opts) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    });
    assert.equal(await check(), false);
    assert.equal(aborted, true);
  });

  it("honors TFX_HUB_URL env when hubUrl not passed", async () => {
    process.env.TFX_HUB_URL = "http://env-host:1234";
    const calls = [];
    const check = createHubHealthChecker({
      fetchFn: async (url) => {
        calls.push(url);
        return { ok: true };
      },
    });
    await check();
    assert.equal(calls[0], "http://env-host:1234/health");
  });

  it("strips trailing slash from hubUrl", async () => {
    const calls = [];
    const check = createHubHealthChecker({
      hubUrl: "http://example:9999/",
      fetchFn: async (url) => {
        calls.push(url);
        return { ok: true };
      },
    });
    await check();
    assert.equal(calls[0], "http://example:9999/health");
  });

  it("returns false when global fetch missing and no fetchFn given", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = undefined;
      const check = createHubHealthChecker({ hubUrl: "http://example:9999" });
      assert.equal(await check(), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
