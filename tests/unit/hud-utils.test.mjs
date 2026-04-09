import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { dim } from "../../hud/colors.mjs";
import {
  clampPercent,
  decodeJwtEmail,
  formatResetRemaining,
  formatResetRemainingDayHour,
  getContextPercent,
  isResetPast,
  padAnsiLeft,
  padAnsiRight,
  readJsonMigrate,
  stripAnsi,
} from "../../hud/utils.mjs";

const TEMP_DIRS = [];

function makeTempDir() {
  const dir = join(
    tmpdir(),
    `triflux-hud-utils-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  TEMP_DIRS.push(dir);
  return dir;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function withMockedNow(nowMs, fn) {
  const originalNow = Date.now;
  Date.now = () => nowMs;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("hud/utils.mjs", () => {
  it("ANSI padding helpers use visible width instead of escape length", () => {
    const colored = dim("ok");

    const left = padAnsiLeft(colored, 5);
    const right = padAnsiRight(colored, 5);

    assert.equal(stripAnsi(left).length, 5);
    assert.equal(stripAnsi(right).length, 5);
    assert.equal(stripAnsi(left), "   ok");
    assert.equal(stripAnsi(right), "ok   ");
  });

  it("readJsonMigrate prefers the new file and falls back to migrating the legacy file", () => {
    const dir = makeTempDir();
    const newPath = join(dir, "state", "new.json");
    const legacyPath = join(dir, "state", "legacy.json");

    writeJson(legacyPath, { source: "legacy" });
    const migrated = readJsonMigrate(newPath, legacyPath, {
      source: "fallback",
    });

    assert.deepEqual(migrated, { source: "legacy" });
    assert.equal(
      existsSync(newPath),
      true,
      "legacy data should be copied to the new path",
    );

    writeJson(newPath, { source: "new" });
    assert.deepEqual(
      readJsonMigrate(newPath, legacyPath, { source: "fallback" }),
      { source: "new" },
    );
  });

  it("clampPercent clamps numeric input and treats invalid input as zero", () => {
    assert.equal(clampPercent(49.6), 50);
    assert.equal(clampPercent(120), 100);
    assert.equal(clampPercent(-3), 0);
    assert.equal(clampPercent("oops"), 0);
  });

  it("getContextPercent prefers native usage percentage and otherwise calculates from token usage", () => {
    assert.equal(
      getContextPercent({ context_window: { used_percentage: 87.4 } }),
      87,
    );

    assert.equal(
      getContextPercent({
        context_window: {
          current_usage: {
            input_tokens: 250,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 150,
          },
          context_window_size: 1000,
        },
      }),
      50,
    );

    assert.equal(
      getContextPercent({ context_window: { context_window_size: 0 } }),
      0,
    );
  });

  it("reset helpers share the same future-target behavior for past timestamps", () => {
    const nowMs = Date.parse("2026-01-01T00:00:00.000Z");

    withMockedNow(nowMs, () => {
      assert.equal(
        formatResetRemaining("2025-12-31T23:00:00.000Z", 2 * 60 * 60 * 1000),
        "1h00m",
      );
      assert.equal(
        formatResetRemainingDayHour("2026-01-03T05:00:00.000Z", 0),
        "02d05h",
      );
      assert.equal(isResetPast("2025-12-31T23:59:00.000Z"), true);
      assert.equal(isResetPast("2026-01-01T00:01:00.000Z"), false);
    });
  });

  it("decodeJwtEmail extracts email from the JWT payload and rejects malformed tokens", () => {
    const payload = Buffer.from(
      JSON.stringify({ email: "dev@example.com" }),
      "utf8",
    ).toString("base64url");
    const token = `header.${payload}.sig`;

    assert.equal(decodeJwtEmail(token), "dev@example.com");
    assert.equal(decodeJwtEmail("not-a-jwt"), null);
  });
});
