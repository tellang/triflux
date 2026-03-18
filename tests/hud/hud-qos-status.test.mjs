import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const hudScriptPath = join(__dirname, "../../hud/hud-qos-status.mjs");
const snapshotDir = join(__dirname, "__snapshots__");
const mockHomeDir = join(__dirname, "__mock_home__");
const mockOmcConfigDir = join(mockHomeDir, ".omc", "config");
const mockClaudeCacheDir = join(mockHomeDir, ".claude", "cache");
const mockOmcStateDir = join(mockHomeDir, ".omc", "state");

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
  writeFileSync(join(mockClaudeCacheDir, "claude-usage-cache.json"), JSON.stringify({
    timestamp: Date.now(),
    data: {
      fiveHourPercent: 65,
      weeklyPercent: 30,
      fiveHourResetsAt: fakeFutureDate,
      weeklyResetsAt: fakeFutureDate
    }
  }));

  // Codex Rate Limits
  writeFileSync(join(mockClaudeCacheDir, "codex-rate-limits-cache.json"), JSON.stringify({
    timestamp: Date.now(),
    buckets: {
      codex: {
        primary: { used_percent: 88, resets_at: Math.floor(fakeTimestampMs / 1000) },
        secondary: { used_percent: 45, resets_at: Math.floor(fakeTimestampMs / 1000) },
        tokens: { total_tokens: 50000 }
      }
    }
  }));

  // Gemini Quota
  writeFileSync(join(mockClaudeCacheDir, "gemini-quota-cache.json"), JSON.stringify({
    timestamp: Date.now(),
    buckets: [
      { modelId: "gemini-3-flash-preview", remainingFraction: 0.1 }
    ]
  }));

  // Gemini Session
  writeFileSync(join(mockClaudeCacheDir, "gemini-session-cache.json"), JSON.stringify({
    timestamp: Date.now(),
    session: { total: 120000, model: "gemini-3-flash-preview" }
  }));

  // Savings / Context mapping
  writeFileSync(join(mockOmcStateDir, "sv-accumulator.json"), JSON.stringify({
    codex: { tokens: 100000 },
    gemini: { tokens: 200000 },
    totalCostSaved: 12.50
  }));
});

after(() => {
  if (existsSync(mockHomeDir)) {
    rmSync(mockHomeDir, { recursive: true, force: true });
  }
});

function runHudWithDimensions(cols, rows, extraEnv = {}) {
  try {
    const input = JSON.stringify({
      context_window: { used_percentage: 25, context_window_size: 200000 }
    });
    const output = execSync(`node "${hudScriptPath}"`, {
      input,
      env: {
        ...process.env,
        COLUMNS: cols.toString(),
        LINES: rows.toString(),
        OMC_HUD_COMPACT: "", // Unset explicit flags
        OMC_HUD_MINIMAL: "",
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
    assert.equal(actualContent, expectedContent, `Snapshot mismatch for ${name}`);
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
    writeFileSync(join(mockOmcConfigDir, "hud.json"), JSON.stringify({ lines: 1 }));
    const output = runHudWithDimensions(120, 1);
    matchSnapshot("nano_tier_lines", normalizeOutput(output));
    rmSync(join(mockOmcConfigDir, "hud.json"));
  });

  it("respects explicit tier flags in hud.json (forced compact)", () => {
    writeFileSync(join(mockOmcConfigDir, "hud.json"), JSON.stringify({ tier: "compact" }));
    const output = runHudWithDimensions(150, 40); // Even with large cols, it should be compact
    matchSnapshot("forced_compact_tier", normalizeOutput(output));
    rmSync(join(mockOmcConfigDir, "hud.json"));
  });
});
