import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const hudScriptPath = join(__dirname, "../../hud/hud-qos-status.mjs");
const snapshotDir = join(__dirname, "__snapshots__");
const mockHomeDir = join(__dirname, "__mock_home__");
const mockOmcConfigDir = join(mockHomeDir, ".omc", "config");
const mockClaudeCacheDir = join(mockHomeDir, ".claude", "cache");
const mockOmcStateDir = join(mockHomeDir, ".omc", "state");
const mockGeminiDir = join(mockHomeDir, ".gemini");
const mockAntigravityCliDir = join(mockGeminiDir, "antigravity-cli");

// Ensure directories exist
if (!existsSync(snapshotDir)) {
  mkdirSync(snapshotDir, { recursive: true });
}

before(() => {
  mkdirSync(mockOmcConfigDir, { recursive: true });
  mkdirSync(mockClaudeCacheDir, { recursive: true });
  mkdirSync(mockOmcStateDir, { recursive: true });

  // Setup mock data for richer HUD output (colors, percentages, alignment)
  const fakeFutureDate = "2026-12-31T23:59:59Z";
  const fakeTimestampMs = Date.now() + 86400000;

  // Claude Usage
  writeFileSync(
    join(mockClaudeCacheDir, "claude-usage-cache.json"),
    JSON.stringify({
      timestamp: Date.now(),
      data: {
        fiveHourPercent: 65,
        weeklyPercent: 30,
        fiveHourResetsAt: fakeFutureDate,
        weeklyResetsAt: fakeFutureDate,
      },
    }),
  );

  // Codex Rate Limits
  writeFileSync(
    join(mockClaudeCacheDir, "codex-rate-limits-cache.json"),
    JSON.stringify({
      timestamp: Date.now(),
      buckets: {
        codex: {
          timestamp: new Date().toISOString(),
          primary: {
            used_percent: 88,
            resets_at: Math.floor(fakeTimestampMs / 1000),
          },
          secondary: {
            used_percent: 45,
            resets_at: Math.floor(fakeTimestampMs / 1000),
          },
          tokens: { total_tokens: 50000 },
        },
      },
    }),
  );

  // Gemini Quota
  writeFileSync(
    join(mockClaudeCacheDir, "gemini-quota-cache.json"),
    JSON.stringify({
      cacheKey: "gemini-main::none",
      timestamp: Date.now(),
      buckets: [{ modelId: "gemini-3-flash-preview", remainingFraction: 0.1 }],
    }),
  );

  // Gemini Session
  writeFileSync(
    join(mockClaudeCacheDir, "gemini-session-cache.json"),
    JSON.stringify({
      timestamp: Date.now(),
      session: { total: 120000, model: "gemini-3-flash-preview" },
    }),
  );

  // Savings / Context mapping
  writeFileSync(
    join(mockOmcStateDir, "sv-accumulator.json"),
    JSON.stringify({
      codex: { tokens: 100000 },
      gemini: { tokens: 200000 },
      totalCostSaved: 12.5,
    }),
  );
});

after(() => {
  if (existsSync(mockHomeDir)) {
    rmSync(mockHomeDir, { recursive: true, force: true });
  }
});

function runHudWithDimensions(cols, rows, extraEnv = {}, options = {}) {
  try {
    const input = JSON.stringify({
      context_window: { used_percentage: 25, context_window_size: 200000 },
    });
    const output = execSync(`node "${hudScriptPath}"`, {
      input,
      // Default to the mock home (no .triflux/lake) so the cto north-star row
      // does not leak in from the real repo cwd when a dev has run
      // `tfx cto collect`. Tests that exercise the cto row pass an explicit cwd.
      cwd: options.cwd || mockHomeDir,
      env: {
        ...process.env,
        COLUMNS: cols.toString(),
        LINES: rows.toString(),
        OMC_HUD_COMPACT: "", // Unset explicit flags
        OMC_HUD_MINIMAL: "",
        TFX_ANTIGRAVITY_OK: "",
        HOME: mockHomeDir,
        USERPROFILE: mockHomeDir,
        ...extraEnv,
      },
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output;
  } catch (err) {
    return err.stdout ? err.stdout.toString() : err.message;
  }
}

function matchSnapshot(name, actualContent) {
  const snapshotFile = join(snapshotDir, `${name}.snap`);

  if (process.env.UPDATE_SNAPSHOTS === "1" || !existsSync(snapshotFile)) {
    writeFileSync(snapshotFile, actualContent, "utf-8");
  } else {
    const expectedContent = readFileSync(snapshotFile, "utf-8");
    assert.equal(
      actualContent,
      expectedContent,
      `Snapshot mismatch for ${name}`,
    );
  }
}

function normalizeOutput(output) {
  // We keep ANSI color codes to ensure UI aesthetics (gauges, red/yellow warnings) match expectations.
  // We sanitize time variables dynamically based on future dates so they don't break on runs.
  let normalized = output;
  normalized = normalized.replace(/\b\d+h\d{2}m\b/g, "XXhXXm");
  normalized = normalized.replace(/\b\d+d\d+h\b/g, "XXdXXh");
  return normalized;
}

function stripAnsiText(output) {
  return output.replace(/\x1b\[[0-9;]*m/g, "");
}

function fakeJwtWithEmail(email) {
  const payload = Buffer.from(JSON.stringify({ email })).toString("base64url");
  return `header.${payload}.signature`;
}

describe("HUD Breakpoints", () => {
  it("renders 'full' tier correctly (cols >= 120)", () => {
    const output = runHudWithDimensions(120, 40);
    matchSnapshot("full_tier", normalizeOutput(output));
  });

  it("renders 'compact' tier correctly (80 <= cols < 120)", () => {
    const output = runHudWithDimensions(100, 40);
    matchSnapshot("compact_tier", normalizeOutput(output));
  });

  it("renders 'minimal' tier correctly (60 <= cols < 80)", () => {
    const output = runHudWithDimensions(70, 40);
    matchSnapshot("minimal_tier", normalizeOutput(output));
  });

  it("renders 'micro' tier correctly (40 <= cols < 60)", () => {
    const output = runHudWithDimensions(50, 40);
    matchSnapshot("micro_tier", normalizeOutput(output));
  });

  it("renders 'nano' tier correctly (cols < 40)", () => {
    const output = runHudWithDimensions(35, 40);
    matchSnapshot("nano_tier_cols", normalizeOutput(output));
  });

  it("renders 'nano' tier correctly (lines == 1)", () => {
    writeFileSync(
      join(mockOmcConfigDir, "hud.json"),
      JSON.stringify({ lines: 1 }),
    );
    const output = runHudWithDimensions(120, 1);
    matchSnapshot("nano_tier_lines", normalizeOutput(output));
    rmSync(join(mockOmcConfigDir, "hud.json"));
  });

  it("respects explicit tier flags in hud.json (forced compact)", () => {
    const hudConfigPath = join(mockOmcConfigDir, "hud.json");
    writeFileSync(hudConfigPath, JSON.stringify({ tier: "compact" }));
    try {
      const output = runHudWithDimensions(150, 40); // Even with large cols, it should be compact
      matchSnapshot("forced_compact_tier", normalizeOutput(output));
    } finally {
      rmSync(hudConfigPath, { force: true });
    }
  });

  it("does not combine sv from Codex bucket and Gemini session fallbacks when accumulator is missing", () => {
    const accumulatorPaths = [
      join(mockClaudeCacheDir, "sv-accumulator.json"),
      join(mockOmcStateDir, "sv-accumulator.json"),
    ];
    const originals = accumulatorPaths.map((path) => ({
      path,
      content: existsSync(path) ? readFileSync(path, "utf8") : null,
    }));
    for (const path of accumulatorPaths) rmSync(path, { force: true });
    try {
      const output = stripAnsiText(runHudWithDimensions(120, 40));
      assert.match(output, /^c: .*sv:\s*--%/m);
      assert.doesNotMatch(output, /^c: .*sv:\s*150%/m);
      assert.match(output, /^x: .*sv:\s*25%/m);
      assert.match(output, /^g: .*sv:\s*60%/m);
    } finally {
      for (const original of originals) {
        if (original.content == null) {
          rmSync(original.path, { force: true });
        } else {
          writeFileSync(original.path, original.content);
        }
      }
    }
  });

  it("renders Antigravity as a and hides the Gemini g marker when ready", () => {
    const preflightPath = join(mockClaudeCacheDir, "tfx-preflight.json");
    const oauthPath = join(mockAntigravityCliDir, "oauth_creds.json");
    const settingsPath = join(mockAntigravityCliDir, "settings.json");
    mkdirSync(mockAntigravityCliDir, { recursive: true });
    writeFileSync(
      preflightPath,
      JSON.stringify({
        timestamp: Date.now(),
        antigravity: { ok: true, path: "/fake/bin/agy", reason: "ready" },
        available_agents: ["codex", "gemini", "antigravity", "claude"],
      }),
    );
    writeFileSync(
      oauthPath,
      JSON.stringify({ id_token: fakeJwtWithEmail("hudacct@example.com") }),
    );
    // Antigravity HUD now renders current-model + Gn slots, so the fixture must
    // provide settings.json instead of asserting the removed generic q slot.
    writeFileSync(
      settingsPath,
      JSON.stringify({ model: "Gemini 3.5 Flash (High)" }),
    );
    try {
      const fullOutput = stripAnsiText(runHudWithDimensions(120, 40));
      assert.match(fullOutput, /^a:/m);
      assert.match(fullOutput, /^a: .*Fh:.*Gn:/m);
      assert.doesNotMatch(fullOutput, /^a: .*q:/m);
      assert.doesNotMatch(fullOutput, /^a: .*Pr:/m);
      assert.doesNotMatch(fullOutput, /^a: .*Fl:/m);
      assert.doesNotMatch(fullOutput, /^a: .*5h:/m);
      assert.doesNotMatch(fullOutput, /^a: .*1w:/m);
      assert.match(fullOutput, /\bhudacct\b/);
      assert.doesNotMatch(fullOutput, /\banti\b/);
      assert.doesNotMatch(fullOutput, /^g:/m);
      assert.doesNotMatch(fullOutput, /gemini/);

      const nanoOutput = stripAnsiText(runHudWithDimensions(35, 40));
      assert.match(nanoOutput, /\ba:/);
      assert.match(nanoOutput, /\ba:--/);
      assert.doesNotMatch(nanoOutput, /\ba:90\b/);
      assert.doesNotMatch(nanoOutput, /\bg:/);
    } finally {
      rmSync(preflightPath, { force: true });
      rmSync(oauthPath, { force: true });
      rmSync(settingsPath, { force: true });
    }
  });

  it("does not derive Antigravity readiness from redundant or stale signals", () => {
    const preflightPath = join(mockClaudeCacheDir, "tfx-preflight.json");
    const staleTimestamp = Date.now() - 2 * 60 * 60 * 1000;
    try {
      writeFileSync(
        preflightPath,
        JSON.stringify({
          timestamp: Date.now(),
          antigravity: { ok: false, reason: "auth_missing" },
          available_agents: ["codex", "gemini", "antigravity", "claude"],
        }),
      );
      const redundantSignalOutput = stripAnsiText(
        runHudWithDimensions(120, 40, { TFX_ANTIGRAVITY_OK: "1" }),
      );
      assert.match(redundantSignalOutput, /^g:/m);
      assert.doesNotMatch(redundantSignalOutput, /^a:/m);

      writeFileSync(
        preflightPath,
        JSON.stringify({
          timestamp: staleTimestamp,
          antigravity: { ok: true, path: "/fake/bin/agy", reason: "ready" },
          available_agents: ["codex", "gemini", "antigravity", "claude"],
        }),
      );
      const staleOutput = stripAnsiText(runHudWithDimensions(120, 40));
      assert.match(staleOutput, /^g:/m);
      assert.doesNotMatch(staleOutput, /^a:/m);
    } finally {
      rmSync(preflightPath, { force: true });
    }
  });

  it("renders the CTO north-star row and keeps nano/micro tiers compact", () => {
    const projectDir = join(mockHomeDir, "cto-project");
    const lakeDir = join(projectDir, ".triflux", "lake");
    mkdirSync(lakeDir, { recursive: true });
    writeFileSync(
      join(lakeDir, "current.md"),
      [
        "brief_version: cto-lake.v1",
        "repo_state",
        "summary: focus on the north-star row",
        "",
      ].join("\n"),
      "utf8",
    );

    const fullOutput = stripAnsiText(
      runHudWithDimensions(120, 40, {}, { cwd: projectDir }),
    );
    assert.match(fullOutput, /^\^: cto:focus on the north-star row/m);
    assert.match(fullOutput, /^\^: .* \| cto-lake\.v1/m);

    const microOutput = stripAnsiText(
      runHudWithDimensions(50, 40, {}, { cwd: projectDir }),
    );
    assert.match(microOutput, /^\^: cto:focus on the north-star row/m);
    assert.doesNotMatch(microOutput, /cto-lake\.v1/);

    const nanoOutput = stripAnsiText(
      runHudWithDimensions(35, 40, {}, { cwd: projectDir }),
    );
    assert.doesNotMatch(nanoOutput, /cto-lake\.v1/);
    assert.doesNotMatch(nanoOutput, /^\^:/m);
  });
});
