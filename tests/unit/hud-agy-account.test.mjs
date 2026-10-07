import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

const providerUrl = new URL("../../hud/providers/gemini.mjs", import.meta.url);

function accountLabel(homeDir) {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { getAntigravityAccountLabel } from ${JSON.stringify(providerUrl.href)}; process.stdout.write(getAntigravityAccountLabel() || "");`,
    ],
    { encoding: "utf8", env: { ...process.env, HOME: homeDir } },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

it("shows the GCP project when Antigravity authenticates with a project", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "triflux-agy-hud-"));
  try {
    const agyDir = join(homeDir, ".gemini", "antigravity-cli");
    mkdirSync(agyDir, { recursive: true });
    writeFileSync(
      join(agyDir, "settings.json"),
      JSON.stringify({ gcp: { project: "test-project" } }),
    );
    writeFileSync(
      join(agyDir, "oauth_creds.json"),
      JSON.stringify({ email: "user@example.test" }),
    );
    assert.equal(accountLabel(homeDir), "test-project");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

it("shows the Antigravity OAuth email when no GCP project is configured", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "triflux-agy-hud-"));
  try {
    const agyDir = join(homeDir, ".gemini", "antigravity-cli");
    mkdirSync(agyDir, { recursive: true });
    writeFileSync(
      join(agyDir, "oauth_creds.json"),
      JSON.stringify({ email: "user@example.test" }),
    );
    assert.equal(accountLabel(homeDir), "user@example.test");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

it("공식 usage 응답을 현재 모델의 사용률로 바꾸고 실패를 0%로 표시하지 않는다", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "triflux-agy-quota-"));
  try {
    const agyDir = join(homeDir, ".gemini", "antigravity-cli");
    mkdirSync(agyDir, { recursive: true });
    writeFileSync(
      join(agyDir, "settings.json"),
      JSON.stringify({
        model: "Gemini 3.8 Flash (High)",
        gcp: { project: "quota-project" },
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      import { readFileSync, writeFileSync } from "node:fs";
      import { refreshAntigravityQuotaCache, readAntigravityQuotaSnapshot } from ${JSON.stringify(providerUrl.href)};
      import { ANTIGRAVITY_QUOTA_CACHE_PATH } from ${JSON.stringify(new URL("../../hud/constants.mjs", import.meta.url).href)};
      const bucket = {
        id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)",
        remaining_fraction: 0.75, reset_time: "1970-01-01T00:00:00Z",
      };
      const success = (item) => JSON.stringify({
        status: "SUCCESS", num_turns: 0,
        command: { name: "usage", data: { groups: [{ name: "All Models", buckets: [item] }] } },
      });
      refreshAntigravityQuotaCache((command, args, opts) => {
        assert.equal(command, "agy");
        assert.deepEqual(args, ["-p", "/usage", "--output-format", "json"]);
        assert.equal(opts.stdio[0], "ignore");
        assert.equal(opts.timeout, 15000);
        return success(bucket);
      });
      assert.deepEqual(readAntigravityQuotaSnapshot(), {
        data: { usedPercent: 25, resetTime: "1970-01-01T00:00:00Z", stale: false },
        shouldRefresh: false,
      });
      const cached = JSON.parse(readFileSync(ANTIGRAVITY_QUOTA_CACHE_PATH));
      writeFileSync(ANTIGRAVITY_QUOTA_CACHE_PATH, JSON.stringify({ ...cached, timestamp: 1 }));
      assert.equal(readAntigravityQuotaSnapshot().data.stale, true);
      assert.equal(readAntigravityQuotaSnapshot().shouldRefresh, true);
      for (const value of [null, "0.75", -1, 2]) {
        refreshAntigravityQuotaCache(() => success({ ...bucket, remaining_fraction: value }));
        assert.equal(readAntigravityQuotaSnapshot().data, null);
      }
      refreshAntigravityQuotaCache(() => JSON.stringify({ status: "ERROR", usage: { total_tokens: 0 } }));
      assert.deepEqual(readAntigravityQuotaSnapshot(), { data: null, shouldRefresh: false });
      refreshAntigravityQuotaCache(() => { throw new Error("timeout"); });
      assert.deepEqual(readAntigravityQuotaSnapshot(), { data: null, shouldRefresh: false });
    `,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
      },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
