import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const hudScriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../hud/hud-qos-status.mjs",
);
let mockHomeDir;
let cacheDir;

before(() => {
  mockHomeDir = mkdtempSync(join(tmpdir(), "tfx-hud-status-"));
  cacheDir = join(mockHomeDir, ".claude", "cache");
  mkdirSync(cacheDir, { recursive: true });
});

after(() => {
  if (mockHomeDir) rmSync(mockHomeDir, { recursive: true, force: true });
});

function runHud(
  extraEnv = {},
  { preserveAnsi = false, args = [], input = {} } = {},
) {
  for (const name of ["claude", "codex", "antigravity"]) {
    writeFileSync(
      join(cacheDir, `.${name}-refresh-lock`),
      JSON.stringify({ t: Date.now() }),
    );
  }
  const result = spawnSync(process.execPath, [hudScriptPath, ...args], {
    cwd: mockHomeDir,
    input: JSON.stringify({
      session_id: "hud-test-session",
      context_window: { used_percentage: 25, context_window_size: 200000 },
      ...input,
    }),
    env: {
      ...process.env,
      HOME: mockHomeDir,
      USERPROFILE: mockHomeDir,
      // 로그인 판정이 바깥 CODEX_HOME 의 auth.json 을 읽지 않게 목 HOME 에 고정한다.
      CODEX_HOME: join(mockHomeDir, ".codex"),
      COLUMNS: "120",
      LINES: "40",
      OMC_HUD_COMPACT: "",
      OMC_HUD_MINIMAL: "",
      TFX_HUB_PID_DIR: join(cacheDir, "tfx-hub"),
      TFX_MACHINE_PROFILE_PATH: join(mockHomeDir, "missing-profile.env"),
      TFX_DISABLE_ANTIGRAVITY: "0",
      ...extraEnv,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return preserveAnsi
    ? result.stdout
    : result.stdout.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("HUD provider visibility", () => {
  it("정책이 Codex 를 차단하면 x 행을 숨긴다", () => {
    const output = runHud({ TFX_DISABLE_CODEX: "0" });
    assert.match(output, /^x:/m);
    assert.match(output, /CTX:25%/);
    assert.doesNotMatch(output, /50K\/200K/);
    assert.doesNotMatch(runHud({ TFX_DISABLE_CODEX: "1" }), /^x:/m);
    const bandDir = join(cacheDir, "triflux", "claude-band");
    mkdirSync(bandDir, { recursive: true });
    const marker = join(bandDir, "hud-test-session");
    writeFileSync(marker, "");
    try {
      const bandOutput = runHud({ TFX_DISABLE_CODEX: "0" });
      assert.doesNotMatch(bandOutput, /^c:/m);
      assert.match(bandOutput, /^x:/m);
      writeFileSync(marker, "off");
      assert.match(runHud({ TFX_DISABLE_CODEX: "0" }), /^c:/m);
      writeFileSync(marker, "all:1");
      assert.equal(runHud({ TFX_DISABLE_CODEX: "0" }).trim(), "");
      // band 가 돌리는 HUD 는 표식과 상관없이 c 행을 mods 가 넘긴 사용량으로 그린다.
      const bandRows = runHud(
        { TFX_DISABLE_CODEX: "0" },
        {
          args: ["--band"],
          input: {
            rate_limits: { seven_day: { used_percentage: 42.4 } },
          },
        },
      );
      assert.match(bandRows, /^tfx-band 1\nc:.*1w:.*42%/);
      assert.match(bandRows, /^x:/m);
      const spendRows = runHud(
        {},
        {
          args: ["--band"],
          input: {
            claude_rate_limits: [{ kind: "spend_limit", percentUsed: 83 }],
          },
        },
      );
      assert.match(spendRows, /^c: \$:.*83%/m);
      // band 가 3분 넘게 갱신하지 않으면 statusLine 이 다시 다 그린다.
      const stale = new Date(Date.now() - 4 * 60 * 1000);
      utimesSync(marker, stale, stale);
      assert.match(runHud({ TFX_DISABLE_CODEX: "0" }), /^c:/m);
    } finally {
      rmSync(marker);
    }
  });

  it("preflight 없이 agy 프로젝트를 표시하고 Gemini 폴백과 팀 행을 그리지 않는다", () => {
    const preflightPath = join(cacheDir, "tfx-preflight.json");
    const settingsDir = join(mockHomeDir, ".gemini", "antigravity-cli");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, "settings.json"),
      JSON.stringify({
        model: "Gemini 3.5 Flash (High)",
        gcp: { project: "hud-prj" },
      }),
    );
    const teamDir = join(cacheDir, "tfx-hub");
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(
      join(teamDir, "team-state-hud.json"),
      JSON.stringify({
        sessionName: "hud",
        startedAt: Date.now(),
        members: [{ name: "codex-1", role: "worker", cli: "codex" }],
        tasks: [{ owner: "codex-1", status: "in_progress" }],
      }),
    );
    writeFileSync(
      join(mockHomeDir, ".gemini", "oauth_creds.json"),
      JSON.stringify({ email: "gemini-only@example.test" }),
    );
    assert.match(runHud(), /^a:.*hud-prj/m);
    writeFileSync(
      preflightPath,
      JSON.stringify({ timestamp: Date.now(), antigravity: { ok: true } }),
    );
    const output = runHud();
    assert.match(output, /^a:.*hud-prj/m);
    assert.doesNotMatch(output, /^(g:|▲)/m);
    assert.doesNotMatch(output, /gemini-only/);
    assert.doesNotMatch(output, /^a:.*\d+%/m);
    const quotaPath = join(cacheDir, "antigravity-quota-cache.json");
    const quota = {
      timestamp: Date.now(),
      accountLabel: "hud-prj",
      buckets: [
        {
          id: "gemini-3.5-flash-high",
          name: "Gemini 3.5 Flash (High)",
          remaining_fraction: 0.75,
          reset_time: "1970-01-01T00:00:00Z",
        },
      ],
    };
    writeFileSync(quotaPath, JSON.stringify(quota));
    const disabledOutput = runHud();
    // GCP 프로젝트 과금은 로그인된 정상 상태라 회색이 아니고, 쿼터 대신 과금 방식을 보인다.
    assert.match(disabledOutput, /^a:.*GCP.*hud-prj/m);
    assert.doesNotMatch(disabledOutput, /^a:.*(?:\d+%|n\/a|[█▓▒░])/m);
    assert.doesNotMatch(
      runHud({}, { preserveAnsi: true }),
      /^\x1b\[0m\x1b\[2ma:/m,
    );
    writeFileSync(
      quotaPath,
      JSON.stringify({ ...quota, accountLabel: "other-project" }),
    );
    assert.doesNotMatch(runHud(), /^a:.*25%/m);
    writeFileSync(quotaPath, JSON.stringify(quota));
    assert.doesNotMatch(runHud({ TFX_DISABLE_ANTIGRAVITY: "1" }), /^(a:|g:)/m);
    writeFileSync(
      preflightPath,
      JSON.stringify({
        timestamp: Date.now() - 24 * 60 * 60 * 1000,
        antigravity: { ok: true },
      }),
    );
    assert.match(runHud(), /^a:.*hud-prj/m);
    assert.match(runHud({ COLUMNS: "30" }), /a:/);
    assert.doesNotMatch(
      runHud({ COLUMNS: "30", TFX_DISABLE_ANTIGRAVITY: "1" }),
      /[ag]:/,
    );

    const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      join(settingsDir, "settings.json"),
      JSON.stringify({ model: "Gemini 3.5 Flash (High)" }),
    );
    writeFileSync(
      join(settingsDir, "oauth_creds.json"),
      JSON.stringify({ email: "quota-user@example.test" }),
    );
    const personalQuota = { ...quota, accountLabel: "quota-user@example.test" };
    writeFileSync(quotaPath, JSON.stringify(personalQuota));
    assert.doesNotMatch(runHud(), /^a:.*\d+%/m);
    personalQuota.buckets[0].reset_time = future;
    writeFileSync(quotaPath, JSON.stringify(personalQuota));
    writeFileSync(
      join(cacheDir, "claude-usage-cache.json"),
      JSON.stringify({
        timestamp: Date.now(),
        data: {
          fiveHourPercent: 17,
          weeklyPercent: 100,
          fiveHourResetsAt: future,
        },
      }),
    );
    writeFileSync(
      join(cacheDir, "codex-rate-limits-cache.json"),
      JSON.stringify({
        timestamp: Date.now(),
        buckets: {
          codex: {
            primary: {
              used_percent: 100,
              resets_at: Date.parse(future) / 1000,
            },
            secondary: { used_percent: 83 },
          },
        },
      }),
    );
    const configDir = join(mockHomeDir, ".omc", "config");
    mkdirSync(configDir, { recursive: true });
    for (const tier of ["full", "compact", "minimal"]) {
      writeFileSync(join(configDir, "hud.json"), JSON.stringify({ tier }));
      for (const active of [true, false]) {
        writeFileSync(
          quotaPath,
          JSON.stringify({
            ...personalQuota,
            buckets: active ? personalQuota.buckets : [],
          }),
        );
        const lines = runHud({ TFX_DISABLE_CODEX: "0" }).trim().split("\n");
        const [claude, codex, agy] = lines;
        assert.equal(lines.length, 3);
        assert.equal(
          agy.indexOf("|"),
          codex.indexOf("|"),
          `${tier}: ${lines.join("\n")}`,
        );
        assert.equal(agy.indexOf("|"), claude.indexOf("|"));
        assert.equal(
          agy.indexOf(active ? "25%" : "--%") + 3,
          claude.indexOf("17%") + 3,
        );
        assert.match(
          agy,
          active ? /^a: --:.*25%.*quota-user$/ : /^a: --:.*--%.*quota-user$/,
        );
        if (tier !== "minimal") {
          assert.equal(agy.indexOf("("), claude.indexOf("("));
          assert.equal(agy.indexOf("("), codex.indexOf("("));
        }
        if (tier === "full") {
          assert.equal(agy.slice(6, 11), active ? "█░░░░" : "░░░░░");
        }
      }
    }
  });

  it("회색은 로그인 안 된 행에만 쓴다", () => {
    const dimRow = (output, marker) =>
      new RegExp(
        `^\\x1b\\[0m\\x1b\\[2m(?:\\x1b\\[[0-9;]*m)*${marker}`,
        "m",
      ).test(output);
    rmSync(join(mockHomeDir, ".gemini"), { recursive: true, force: true });
    rmSync(join(cacheDir, "antigravity-quota-cache.json"), { force: true });
    rmSync(join(cacheDir, "codex-rate-limits-cache.json"), { force: true });
    rmSync(join(mockHomeDir, ".omc"), { recursive: true, force: true });
    const loggedOut = runHud(
      { TFX_DISABLE_CODEX: "0" },
      { preserveAnsi: true },
    );
    assert.ok(dimRow(loggedOut, "a"), loggedOut);
    assert.ok(dimRow(loggedOut, "x"), loggedOut);

    mkdirSync(join(mockHomeDir, ".codex"), { recursive: true });
    writeFileSync(join(mockHomeDir, ".codex", "auth.json"), "{}");
    const codexLoggedIn = runHud(
      { TFX_DISABLE_CODEX: "0" },
      { preserveAnsi: true },
    );
    assert.ok(!dimRow(codexLoggedIn, "x"), codexLoggedIn);
    assert.match(codexLoggedIn.replace(/\x1b\[[0-9;]*m/g, ""), /^x:.*--%/m);
  });
});

describe("HUD statusLine sh 래퍼", {
  skip: process.platform === "win32",
}, () => {
  it("band 가 그리는 세션에서만 HUD 를 건너뛴다", () => {
    const wrapper = join(dirname(hudScriptPath), "hud-statusline.sh");
    const marker = join(cacheDir, "triflux", "claude-band", "wrap-session");
    mkdirSync(dirname(marker), { recursive: true });
    const run = () =>
      spawnSync("sh", [wrapper, process.execPath], {
        input: JSON.stringify({ session_id: "wrap-session" }),
        env: { ...process.env, HOME: mockHomeDir, COLUMNS: "120" },
        encoding: "utf8",
      }).stdout.replace(/\x1b\[[0-9;]*m/g, "");
    writeFileSync(marker, "all:1");
    assert.equal(run().trim(), "");
    writeFileSync(marker, "off");
    assert.match(run(), /^c:/m);
  });
});
