import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { launchLead } from "../../hub/team/lead-launch.mjs";
import {
  mcpCatalogPath,
  readMcpCatalog,
  refreshMcpCatalog,
} from "../../scripts/lib/mcp-recommendation-catalog.mjs";

function fixture(t) {
  const home = fs.mkdtempSync(join(tmpdir(), "tfx-mcp-reviewfix-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return {
    home,
    env: {
      HOME: home,
      CODEX_HOME: join(home, "codex"),
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_CACHE_HOME: join(home, "cache"),
      TFX_JEV: "1",
      TFX_JEV_STATS: "0",
    },
  };
}

function server(name = "io.example/docs", extra = {}) {
  return {
    server: { name, description: "Documentation", version: "1", ...extra },
  };
}

function response(servers, nextCursor) {
  return {
    ok: true,
    json: async () => ({ servers, metadata: { nextCursor } }),
  };
}

function official(catalog) {
  return catalog.entries.filter((entry) => entry.sourceId === "official");
}

test("Malformed records are skipped with fixed persisted count and reason", async (t) => {
  const f = fixture(t);
  const result = await refreshMcpCatalog({
    ...f,
    fetchImpl: async () =>
      response([
        server(),
        null,
        server("io.example/bad-description", { description: null }),
        server("io.example/bad-version", { version: null }),
        server("io.example/bad-package", { packages: [null] }),
        server("io.example/bad-remote", { remotes: [null] }),
        server("io.example/bad-env", {
          packages: [{ environmentVariables: "PRIVATE_INVALID" }],
        }),
        server("io.example/last"),
      ]),
  });
  assert.equal(result.status, "fresh");
  assert.deepEqual(
    official(result).map((e) => e.serverId),
    ["io.example/docs", "io.example/last"],
  );
  assert.ok(result.diagnostics.includes("catalog_records_skipped:6"));
  assert.ok(result.diagnostics.includes("malformed_registry_server"));
  assert.deepEqual(readMcpCatalog(f).diagnostics, result.diagnostics);
  assert.equal(fs.existsSync(`${result.cacheFile}.failure`), false);
  assert.equal(fs.existsSync(`${result.cacheFile}.progress`), false);
  assert.doesNotMatch(
    fs.readFileSync(result.cacheFile, "utf8"),
    /PRIVATE_INVALID/,
  );
});

test("Skipped counts resume without publishing partial records or double counting", async (t) => {
  const f = fixture(t);
  const first = await refreshMcpCatalog({
    ...f,
    fetchImpl: async (url) => {
      if (new URL(url).searchParams.has("cursor")) return { ok: false };
      return response([server(), {}], "next");
    },
  });
  assert.equal(first.status, "missing");
  assert.deepEqual(official(first), []);
  const pending = JSON.parse(
    fs.readFileSync(`${first.cacheFile}.progress`, "utf8"),
  );
  assert.equal(pending.cursor, "next");
  assert.equal(pending.skippedRecords, 1);
  const completed = await refreshMcpCatalog({
    ...f,
    fetchImpl: async (url) => {
      assert.equal(new URL(url).searchParams.get("cursor"), "next");
      return response([{}, server("io.example/last")]);
    },
  });
  assert.equal(completed.status, "fresh");
  assert.equal(completed.watermark, pending.startedAt);
  assert.equal(official(completed).length, 2);
  assert.ok(completed.diagnostics.includes("catalog_records_skipped:2"));
  assert.equal(fs.existsSync(`${first.cacheFile}.failure`), false);
});

test("An all-malformed initial listing stays missing and can be retried", async (t) => {
  const f = fixture(t);
  const result = await refreshMcpCatalog({
    ...f,
    fetchImpl: async () => response([{}, null]),
  });
  assert.equal(result.status, "missing");
  assert.equal(result.watermark, null);
  assert.equal(fs.existsSync(result.cacheFile), false);
  assert.ok(result.diagnostics.includes("catalog_refresh_failed"));
  assert.ok(result.diagnostics.includes("catalog_records_skipped:2"));
  assert.ok(
    readMcpCatalog(f).diagnostics.includes("catalog_records_skipped:2"),
  );
  const recovered = await refreshMcpCatalog({
    ...f,
    fetchImpl: async () => response([server()]),
  });
  assert.equal(recovered.status, "fresh");
  assert.equal(official(recovered).length, 1);
  assert.ok(
    !recovered.diagnostics.some((d) =>
      d.startsWith("catalog_records_skipped:"),
    ),
  );
});

test("Incremental malformed records preserve existing entries while valid tombstones apply", async (t) => {
  const f = fixture(t);
  const initial = await refreshMcpCatalog({
    ...f,
    fetchImpl: async () => response([server(), server("io.example/deleted")]),
  });
  const result = await refreshMcpCatalog({
    ...f,
    fetchImpl: async (url) => {
      assert.equal(
        new URL(url).searchParams.get("updated_since"),
        initial.watermark,
      );
      return response([
        server("io.example/docs", { description: null }),
        {
          server: { name: "io.example/deleted" },
          _meta: {
            "io.modelcontextprotocol.registry/official": { status: "deleted" },
          },
        },
      ]);
    },
  });
  assert.equal(result.status, "fresh");
  assert.deepEqual(
    official(result).map((e) => e.serverId),
    ["io.example/docs"],
  );
  assert.equal(official(result)[0].description, "Documentation");
  assert.ok(result.diagnostics.includes("catalog_records_skipped:1"));
});

for (const disappearingRead of [1, 2]) {
  test(`Lock disappearance at read ${disappearingRead} preserves the other owner's completed cache`, async (t) => {
    const f = fixture(t);
    const initial = await refreshMcpCatalog({
      ...f,
      fetchImpl: async () => response([server()]),
    });
    const lock = `${initial.cacheFile}.lock`;
    fs.writeFileSync(lock, "2147483647:other-owner");
    const published = JSON.parse(fs.readFileSync(initial.cacheFile, "utf8"));
    published.collectedAt = new Date(
      Date.parse(initial.collectedAt) + 100,
    ).toISOString();
    const originalRead = fs.readFileSync;
    let lockReads = 0;
    const mocked = t.mock.method(fs, "readFileSync", (file, ...args) => {
      if (file === lock && ++lockReads === disappearingRead) {
        fs.writeFileSync(initial.cacheFile, JSON.stringify(published));
        fs.unlinkSync(lock);
      }
      return originalRead(file, ...args);
    });
    syncBuiltinESMExports();
    let result;
    try {
      result = await refreshMcpCatalog({
        ...f,
        fetchImpl: () => assert.fail("unowned refresh must not fetch"),
      });
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(lockReads, disappearingRead);
    assert.equal(result.status, "fresh");
    assert.equal(result.collectedAt, published.collectedAt);
    assert.equal(fs.existsSync(`${initial.cacheFile}.failure`), false);
    assert.equal(fs.existsSync(`${initial.cacheFile}.progress`), false);
    assert.equal(
      fs.readFileSync(initial.cacheFile, "utf8"),
      JSON.stringify(published),
    );
    assert.ok(!result.diagnostics.includes("catalog_refresh_in_progress"));
  });
}

test("A lock not acquired never changes another owner's failure or progress", async (t) => {
  const f = fixture(t);
  const file = mcpCatalogPath(f);
  fs.mkdirSync(join(f.env.XDG_CACHE_HOME, "triflux"), { recursive: true });
  for (const [suffix, value] of [
    ["lock", `${process.pid}:other-owner`],
    ["failure", "other-owner-failure"],
    ["progress", "other-owner-progress"],
  ])
    fs.writeFileSync(`${file}.${suffix}`, value);
  const originalRead = fs.readFileSync;
  const mocked = t.mock.method(fs, "readFileSync", (path, ...args) => {
    if (path === `${file}.lock`)
      throw Object.assign(new Error("PRIVATE"), { code: "EACCES" });
    return originalRead(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    await refreshMcpCatalog({ ...f, fetchImpl: () => assert.fail("fetch") });
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(
    fs.readFileSync(`${file}.lock`, "utf8"),
    `${process.pid}:other-owner`,
  );
  assert.equal(
    fs.readFileSync(`${file}.failure`, "utf8"),
    "other-owner-failure",
  );
  assert.equal(
    fs.readFileSync(`${file}.progress`, "utf8"),
    "other-owner-progress",
  );
});

test("Repeated lead auto-refresh aborts promptly and explicit refresh resumes the listing", async (t) => {
  const f = fixture(t);
  let aborted = 0;
  let starts = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await launchLead(
      {
        cli: "codex",
        role: "11.3 MCP 카탈로그 테스트",
        cwd: f.home,
        task: "문서 확인",
      },
      {
        jevOptions: { env: { TFX_JEV: "0" } },
        recommendationOptions: {
          ...f,
          jevOptions: {
            env: f.env,
            batchClient: async () => ({
              selection: { choice: "none", confidence: 1 },
            }),
          },
          fetchImpl: async (url, { signal }) => {
            if (!new URL(url).searchParams.has("cursor")) {
              assert.equal(attempt, 0, "resume must use the saved cursor");
              return response([server()], "resume");
            }
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                signal.removeEventListener("abort", onAbort);
                reject(new Error("auto-refresh exceeded test budget"));
              }, 2000);
              function onAbort() {
                clearTimeout(timer);
                aborted++;
                reject(signal.reason);
              }
              signal.addEventListener("abort", onAbort, { once: true });
            });
          },
        },
        run: async (_node, [, action]) => {
          if (action === "start") starts++;
          return {
            stdout: JSON.stringify(
              action === "start" ? { ready: true } : { ok: true },
            ),
          };
        },
      },
    );
    assert.equal(result.ok, true);
    assert.ok(
      result.mcpRecommendation.diagnostics.includes("catalog_refresh_failed"),
    );
    assert.equal(
      aborted,
      attempt + 1,
      "lead refresh must abort before the 2s watchdog",
    );
  }
  assert.equal(starts, 2);
  const completed = await refreshMcpCatalog({
    ...f,
    fetchImpl: async (url, { signal }) => {
      assert.equal(new URL(url).searchParams.get("cursor"), "resume");
      await new Promise((resolve) => setTimeout(resolve, 600));
      signal.throwIfAborted();
      return response([server("io.example/last")]);
    },
  });
  assert.equal(completed.status, "fresh");
  assert.equal(official(completed).length, 2);
  assert.equal(fs.existsSync(`${completed.cacheFile}.failure`), false);
});
