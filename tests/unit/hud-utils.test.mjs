import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { dim } from "../../hud/colors.mjs";
import {
  acquireSpawnLock,
  clampPercent,
  decodeJwtEmail,
  formatPercentCell,
  formatPlaceholderPercentCell,
  formatResetRemaining,
  formatResetRemainingDayHour,
  formatTimeCell,
  formatTimeCellDH,
  padAnsiRight,
  parseRetryAfterMs,
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
  it("값이 없는 칸도 정상 값과 같은 폭이다", () => {
    assert.equal(
      formatPlaceholderPercentCell().length,
      formatPercentCell(7).length,
    );
    for (const empty of ["", null, undefined]) {
      assert.equal(
        formatTimeCell(empty).length,
        formatTimeCell("0h24m").length,
      );
      assert.equal(
        formatTimeCellDH(empty).length,
        formatTimeCellDH("04d00h").length,
      );
      assert.doesNotMatch(
        formatTimeCell(empty) + formatTimeCellDH(empty),
        /\d|n\/a/,
      );
    }
  });

  it("ANSI padding helpers use visible width instead of escape length", () => {
    const colored = dim("ok");

    const right = padAnsiRight(colored, 5);

    assert.equal(stripAnsi(right).length, 5);
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
    });
  });

  it("advanceToNextCycle returns next reset (not now) at exact cycle boundary", () => {
    const FIVE_H = 5 * 60 * 60 * 1000;
    const SEVEN_D = 7 * 24 * 60 * 60 * 1000;
    const nowMs = Date.parse("2026-04-22T00:00:00.000Z");

    withMockedNow(nowMs, () => {
      const epoch5h = new Date(nowMs - FIVE_H).toISOString();
      const epoch7d = new Date(nowMs - SEVEN_D).toISOString();

      // exact boundary: elapsed == cycleMs → 다음 reset = now + cycle
      assert.equal(
        formatResetRemaining(epoch5h, FIVE_H),
        "5h00m",
        "exact 5h boundary should display 5h00m, not n/a",
      );
      assert.equal(
        formatResetRemainingDayHour(epoch7d, SEVEN_D),
        "07d00h",
        "exact 7d boundary should display 07d00h, not n/a",
      );

      // double boundary: elapsed == 2 * cycleMs → +1 cycle from now
      const epoch10h = new Date(nowMs - 2 * FIVE_H).toISOString();
      assert.equal(formatResetRemaining(epoch10h, FIVE_H), "5h00m");

      // 1ms past boundary still works
      const epoch5hPlus = new Date(nowMs - FIVE_H - 1).toISOString();
      assert.equal(formatResetRemaining(epoch5hPlus, FIVE_H), "4h59m");
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

describe("갱신 락과 Retry-After", () => {
  it("락은 ttl 안에서만 막고, 시계가 뒤로 간 락은 깨진 것으로 본다", () => {
    const lock = join(tmpdir(), `tfx-hud-lock-${process.pid}`);
    const now = 1_000_000;
    try {
      assert.equal(acquireSpawnLock(lock, 30_000, now), true);
      assert.equal(acquireSpawnLock(lock, 30_000, now + 10_000), false);
      assert.equal(acquireSpawnLock(lock, 30_000, now + 31_000), true);
      writeFileSync(lock, JSON.stringify({ t: now + 3_600_000 }));
      assert.equal(acquireSpawnLock(lock, 30_000, now), true);
    } finally {
      rmSync(lock, { force: true });
    }
  });

  it("Retry-After 는 초와 HTTP 날짜를 받는다", () => {
    const now = Date.parse("2026-10-10T00:00:00Z");
    assert.equal(parseRetryAfterMs("120", now), 120_000);
    assert.equal(
      parseRetryAfterMs("Sat, 10 Oct 2026 00:05:00 GMT", now),
      300_000,
    );
    assert.equal(parseRetryAfterMs("0", now), null);
    assert.equal(parseRetryAfterMs(undefined, now), null);
  });
});
