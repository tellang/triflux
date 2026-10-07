import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { refreshPreflightCacheIfStale } from "../../scripts/preflight-cache.mjs";

test("유효한 캐시는 다시 갱신하지 않는다", async () => {
  let calls = 0;
  const changed = await refreshPreflightCacheIfStale({
    readCache: () => ({ timestamp: Date.now() }),
    refresh: () => {
      calls += 1;
    },
  });
  assert.equal(changed, false);
  assert.equal(calls, 0);
});

test("디스크 캐시가 없거나 손상되거나 만료됐을 때만 갱신한다", (t) => {
  const home = mkdtempSync(join(tmpdir(), "tfx-preflight-refresh-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cacheDir = join(home, ".claude", "cache");
  mkdirSync(cacheDir, { recursive: true });
  const cache = join(cacheDir, "tfx-preflight.json");
  const moduleUrl = new URL(
    "../../scripts/preflight-cache.mjs",
    import.meta.url,
  ).href;
  for (const [content, expectedCalls] of [
    [null, 1],
    ["{broken", 1],
    [JSON.stringify({ timestamp: Date.now() - 3_600_001 }), 1],
    [JSON.stringify({ timestamp: Date.now() }), 0],
  ]) {
    if (content !== null) writeFileSync(cache, content);
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { refreshPreflightCacheIfStale } from ${JSON.stringify(moduleUrl)};
      let calls = 0;
      await refreshPreflightCacheIfStale({ refresh: () => { calls++; } });
      process.stdout.write(String(calls));
    `,
      ],
      {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Number(result.stdout), expectedCalls, String(content));
  }
});

test("없거나 만료된 캐시는 route에서 다시 갱신한다", async () => {
  let calls = 0;
  const changed = await refreshPreflightCacheIfStale({
    readCache: () => null,
    refresh: () => {
      calls += 1;
    },
  });
  assert.equal(changed, true);
  assert.equal(calls, 1);

  const route = readFileSync(
    join(process.cwd(), "scripts/tfx-route.sh"),
    "utf8",
  );
  assert.match(route, /TFX_PKG_ROOT\/scripts\/preflight-cache\.mjs/);
  const refreshIndex = route.indexOf('"$_preflight_script" --if-stale');
  const cacheReadIndex = route.indexOf("tfx-preflight.json", refreshIndex);
  assert.ok(refreshIndex >= 0 && cacheReadIndex > refreshIndex);
});
