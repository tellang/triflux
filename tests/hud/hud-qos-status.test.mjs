import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  for (const name of ["claude", "codex", "antigravity"]) {
    writeFileSync(
      join(cacheDir, `.${name}-refresh-lock`),
      JSON.stringify({ t: Date.now() }),
    );
  }
});

after(() => {
  if (mockHomeDir) rmSync(mockHomeDir, { recursive: true, force: true });
});

function runHud(extraEnv = {}, { preserveAnsi = false } = {}) {
  const result = spawnSync(process.execPath, [hudScriptPath], {
    cwd: mockHomeDir,
    input: JSON.stringify({
      session_id: "hud-test-session",
      context_window: { used_percentage: 25, context_window_size: 200000 },
    }),
    env: {
      ...process.env,
      HOME: mockHomeDir,
      USERPROFILE: mockHomeDir,
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
    assert.match(runHud(), /^a:.*Fh:.*25%.*n\/a.*hud-prj/m);
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
  });
});
