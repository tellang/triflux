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
  for (const name of ["claude", "codex"]) {
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

  it("agy 준비 상태에서만 a 행을 보이고 GCP 프로젝트 ID를 계정 칸에 표시한다", () => {
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
    assert.doesNotMatch(runHud(), /^a:/m);
    assert.match(
      runHud({}, { preserveAnsi: true }),
      /^\x1b\[0m\x1b\[2m(?:\x1b\[[0-9;]*m)*g/m,
    );
    writeFileSync(
      preflightPath,
      JSON.stringify({ timestamp: Date.now(), antigravity: { ok: true } }),
    );
    const output = runHud();
    assert.match(output, /^a:.*hud-prj/m);
    assert.doesNotMatch(output, /^g:/m);
    assert.doesNotMatch(output, /^a:.*\d+%/m);
    assert.doesNotMatch(
      runHud({}, { preserveAnsi: true }),
      /^\x1b\[0m\x1b\[2m(?:\x1b\[[0-9;]*m)*a/m,
    );
    assert.doesNotMatch(runHud({ TFX_DISABLE_ANTIGRAVITY: "1" }), /^a:/m);
    writeFileSync(
      preflightPath,
      JSON.stringify({
        timestamp: Date.now() - 24 * 60 * 60 * 1000,
        antigravity: { ok: true },
      }),
    );
    assert.doesNotMatch(runHud(), /^a:/m);
  });
});
