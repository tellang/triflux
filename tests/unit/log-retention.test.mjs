import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { gunzipSync } from "node:zlib";

import { readJsonLines, runLogRetention } from "../../hub/log-retention.mjs";

const TEST_ROOT = join(tmpdir(), `tfx-log-retention-${process.pid}`);
const NOW = new Date("2026-07-01T00:00:00.000Z");

function resetTestRoot() {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
  return TEST_ROOT;
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function readGzip(path) {
  return gunzipSync(readFileSync(path)).toString("utf8");
}

function ledgerOptions(rootDir, extra = {}) {
  return {
    enabled: true,
    rootDir,
    lakeRoot: join(rootDir, ".triflux", "lake"),
    swarmLogsRoot: join(rootDir, ".triflux", "swarm-logs"),
    batchEventsPath: join(rootDir, ".cache", "batch-events.jsonl"),
    now: NOW,
    policies: {
      ledger: {
        maxBytes: 128,
        maxAgeMs: 365 * 24 * 60 * 60 * 1000,
        tailBytes: 64,
        tailAgeMs: 0,
      },
      swarm: {
        maxBytes: Number.MAX_SAFE_INTEGER,
        maxAgeMs: Number.MAX_SAFE_INTEGER,
        activeMtimeGraceMs: 0,
      },
      batch: {
        rotateAfterLines: Number.MAX_SAFE_INTEGER,
        keepLines: 100,
      },
      ...extra.policies,
    },
    ...extra,
  };
}

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("log-retention", () => {
  it("does not rotate a log path owned by a live getActive() session", async () => {
    const rootDir = resetTestRoot();
    const lakeRoot = join(rootDir, ".triflux", "lake");
    const ledgerPath = join(lakeRoot, "ledger.jsonl");
    mkdirSync(lakeRoot, { recursive: true });
    const original = Array.from({ length: 20 }, (_, index) =>
      jsonLine({
        ts: "2026-06-30T00:00:00.000Z",
        event: "session_heartbeat",
        ref: { actor: { session_id: "live-session" } },
        index,
      }),
    ).join("");
    writeFileSync(ledgerPath, original, "utf8");

    const result = await runLogRetention(
      ledgerOptions(rootDir, {
        getActive: () => [{ sessionId: "live-session", logPath: ledgerPath }],
      }),
    );

    const ledger = result.results.find((entry) => entry.log === "ledger");
    assert.equal(ledger.skipped, true);
    assert.equal(ledger.reason, "active");
    assert.equal(readFileSync(ledgerPath, "utf8"), original);
    assert.equal(existsSync(join(lakeRoot, "archive")), false);
  });

  it("rotates an over-threshold ledger and preserves the retained tail losslessly", async () => {
    const rootDir = resetTestRoot();
    const lakeRoot = join(rootDir, ".triflux", "lake");
    const ledgerPath = join(lakeRoot, "ledger.jsonl");
    mkdirSync(lakeRoot, { recursive: true });

    const lines = Array.from({ length: 6 }, (_, index) =>
      jsonLine({
        ts: "2026-06-01T00:00:00.000Z",
        event: "checkpoint_saved",
        index,
        payload: "x".repeat(12),
      }),
    );
    const retainedTailBytes = Buffer.byteLength(lines.slice(-2).join(""));
    const original = lines.join("");
    writeFileSync(ledgerPath, original, "utf8");

    const result = await runLogRetention(
      ledgerOptions(rootDir, {
        policies: {
          ledger: {
            maxBytes: 128,
            maxAgeMs: Number.MAX_SAFE_INTEGER,
            tailBytes: retainedTailBytes,
            tailAgeMs: 0,
          },
        },
      }),
    );

    const ledger = result.results.find((entry) => entry.log === "ledger");
    assert.equal(ledger.rotated, true);
    assert.equal(ledger.archivedLines, 4);
    assert.equal(ledger.retainedLines, 2);

    const archived = readGzip(ledger.archivePath);
    const retained = readFileSync(ledgerPath, "utf8");
    assert.equal(archived, lines.slice(0, 4).join(""));
    assert.equal(retained, lines.slice(-2).join(""));
    assert.equal(archived + retained, original);
  });

  it("reads a bounded JSONL tail from a sparse file larger than 1GB", () => {
    const rootDir = resetTestRoot();
    const path = join(rootDir, "huge-ledger.jsonl");
    const fd = openSync(path, "w");
    try {
      writeSync(fd, jsonLine({ ts: "2020-01-01T00:00:00.000Z", index: 0 }));
      const offset = 1024 ** 3 + 8192;
      writeSync(fd, "\n", offset - 1, "utf8");
      writeSync(
        fd,
        jsonLine({ ts: "2026-07-01T00:00:00.000Z", index: 1 }),
        offset,
        "utf8",
      );
    } finally {
      closeSync(fd);
      // openSync/writeSync keeps this tiny on filesystems with sparse support.
      // The assertion below proves the logical file size crosses the guard.
    }

    assert.ok(statSync(path).size > 1024 ** 3);
    const entries = readJsonLines(path, { limit: 5, maxBytes: 4096 });
    assert.deepEqual(entries, [{ ts: "2026-07-01T00:00:00.000Z", index: 1 }]);
  });
});
