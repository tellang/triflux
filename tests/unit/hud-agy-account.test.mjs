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
      import { ANTIGRAVITY_QUOTA_CACHE_PATH, ANTIGRAVITY_SETTINGS_PATH } from ${JSON.stringify(new URL("../../hud/constants.mjs", import.meta.url).href)};
      const future = new Date(Date.now() + 3600000).toISOString();
      const bucket = {
        id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)",
        remaining_fraction: 0.75, reset_time: future,
      };
      const success = (item) => JSON.stringify({
        status: "SUCCESS", num_turns: 0,
        command: { name: "usage", data: { groups: [{ name: "All Models", buckets: [item] }] } },
      });
      await refreshAntigravityQuotaCache((command, args, opts) => {
        assert.equal(command, "agy");
        assert.deepEqual(args, ["-p", "/usage", "--output-format", "json"]);
        assert.equal(opts.stdio[0], "ignore");
        assert.equal(opts.timeout, 15000);
        return success(bucket);
      });
      assert.deepEqual(readAntigravityQuotaSnapshot(), {
        data: { usedPercent: 25, resetTime: future, stale: false },
        shouldRefresh: false,
      });
      const cached = JSON.parse(readFileSync(ANTIGRAVITY_QUOTA_CACHE_PATH));
      writeFileSync(ANTIGRAVITY_QUOTA_CACHE_PATH, JSON.stringify({ ...cached, timestamp: 1 }));
      assert.equal(readAntigravityQuotaSnapshot().data.stale, true);
      assert.equal(readAntigravityQuotaSnapshot().shouldRefresh, true);
      for (const value of [null, "0.75", -1, 2]) {
        await refreshAntigravityQuotaCache(() => success({ ...bucket, remaining_fraction: value }));
        assert.equal(readAntigravityQuotaSnapshot().data, null);
      }
      for (const reset_time of [null, "invalid", "1970-01-01T00:00:00Z", new Date(Date.now() - 1).toISOString()]) {
        await refreshAntigravityQuotaCache(() => success({ ...bucket, remaining_fraction: 1, reset_time }));
        assert.equal(readAntigravityQuotaSnapshot().data, null);
      }
      await refreshAntigravityQuotaCache(() => success({ ...bucket, remaining_fraction: 1 }));
      assert.equal(readAntigravityQuotaSnapshot().data.usedPercent, 0);
      await refreshAntigravityQuotaCache(() => JSON.stringify({ status: "ERROR", usage: { total_tokens: 0 } }));
      assert.deepEqual(readAntigravityQuotaSnapshot(), { data: null, shouldRefresh: false });
      await refreshAntigravityQuotaCache(() => { throw new Error("timeout"); });
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

it("로그인 판정: 프로젝트, 계정 파일, 최근 조회 성공만 로그인으로 본다", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "triflux-agy-auth-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      import { mkdirSync, writeFileSync } from "node:fs";
      import { dirname } from "node:path";
      import { getAntigravityAuthKind, refreshAntigravityQuotaCache } from ${JSON.stringify(providerUrl.href)};
      import { ANTIGRAVITY_OAUTH_PATHS, ANTIGRAVITY_QUOTA_CACHE_PATH, ANTIGRAVITY_SETTINGS_PATH } from ${JSON.stringify(new URL("../../hud/constants.mjs", import.meta.url).href)};
      const write = (path, value) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(value));
      };
      const ok = () => JSON.stringify({ status: "SUCCESS", command: { name: "usage", data: { groups: [] } } });
      const fail = () => { throw new Error("timeout"); };
      assert.equal(getAntigravityAuthKind(), null);
      write(ANTIGRAVITY_QUOTA_CACHE_PATH, { accountLabel: "old@example.test", buckets: [], signedInAt: Date.now() });
      assert.equal(getAntigravityAuthKind(), null, "다른 계정의 캐시는 근거가 아니다");
      await refreshAntigravityQuotaCache(ok);
      assert.equal(getAntigravityAuthKind(), "account", "Keychain 로그인은 조회 성공으로 판정한다");
      await refreshAntigravityQuotaCache(fail);
      assert.equal(getAntigravityAuthKind(), "account", "일시 실패로 회색이 되지 않는다");
      write(ANTIGRAVITY_QUOTA_CACHE_PATH, { accountLabel: null, buckets: null, signedInAt: 1 });
      assert.equal(getAntigravityAuthKind(), null, "오래전 성공은 근거가 아니다");
      write(ANTIGRAVITY_OAUTH_PATHS[0], { email: "user@example.test" });
      assert.equal(getAntigravityAuthKind(), "account");
      write(ANTIGRAVITY_SETTINGS_PATH, { gcp: { project: "p" } });
      assert.equal(getAntigravityAuthKind(), "project");
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

it("프로젝트 과금은 gcloud 토큰으로 공용 주간 쿼터를 읽고, 실패하면 GCP 표시로 돌아간다", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "triflux-agy-project-"));
  try {
    const agyDir = join(homeDir, ".gemini", "antigravity-cli");
    mkdirSync(agyDir, { recursive: true });
    writeFileSync(
      join(agyDir, "settings.json"),
      JSON.stringify({ gcp: { project: "quota-project", location: "global" } }),
    );
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      import { refreshAntigravityQuotaCache, readAntigravityQuotaSnapshot } from ${JSON.stringify(providerUrl.href)};
      const prefix = "discoveryengine.googleapis.com/quota/ratev2/agentic_wtu_tier_enterprise_plus_pp_weekly_regional";
      const start = Math.floor(Date.now() / 1000) - 86400;
      const series = (kind, value, windowStart) => ({
        metric: { type: prefix + "/" + kind, labels: windowStart ? { window_start_time: String(windowStart) } : {} },
        points: [{ value: { int64Value: String(value) } }],
      });
      const timeSeries = [
        series("net_usage", 68000000, start),
        series("net_usage", 1000000, start + 3600),
        series("limit", 93750000),
      ];
      assert.deepEqual(readAntigravityQuotaSnapshot(), { data: null, shouldRefresh: true });
      const urls = [];
      await refreshAntigravityQuotaCache(
        (command, args) => {
          assert.equal(command, "gcloud");
          assert.deepEqual(args, ["auth", "print-access-token"]);
          return "token\\n";
        },
        async (target, init) => {
          const url = new URL(target);
          urls.push(url);
          assert.equal(init.headers.Authorization, "Bearer token");
          if (url.pathname.endsWith("/metricDescriptors")) {
            const types = ["net_usage", "limit", "usage"].map((kind) => ({ type: prefix + "/" + kind }));
            return { ok: true, json: async () => ({ metricDescriptors: types }) };
          }
          const type = url.searchParams.get("filter").match(/metric.type = "([^"]+)"/)[1];
          return { ok: true, json: async () => ({ timeSeries: timeSeries.filter((s) => s.metric.type === type) }) };
        },
      );
      assert.equal(urls.length, 3, "usage 지표는 읽지 않는다");
      assert.equal(urls[1].pathname, "/v3/projects/quota-project/timeSeries");
      assert.match(urls[1].searchParams.get("filter"), /regional_location = "global"/);
      assert.deepEqual(readAntigravityQuotaSnapshot(), {
        data: {
          usedPercent: 74,
          resetTime: new Date((start + 7 * 86400) * 1000).toISOString(),
          stale: false,
        },
        shouldRefresh: false,
      });
      await refreshAntigravityQuotaCache(() => { throw new Error("reauth"); });
      assert.deepEqual(readAntigravityQuotaSnapshot(), { data: null, shouldRefresh: false });
      await refreshAntigravityQuotaCache(() => "token", async () => ({ ok: false }));
      assert.equal(readAntigravityQuotaSnapshot().data, null);
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
