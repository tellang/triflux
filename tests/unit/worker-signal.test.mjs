import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  appendSignalLineAtomic,
  WorkerSignalChannel,
} from "../../hub/team/worker-signal.mjs";

const tempDirs = [];

function makeSignalDir() {
  const dir = mkdtempSync(join(tmpdir(), "tfx-worker-signal-"));
  tempDirs.push(dir);
  return join(dir, ".omc", "state", "worker-signals", "session-1");
}

async function readJsonl(filePath) {
  const raw = await readFile(filePath, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function waitForSignals(signalDir, options = {}) {
  const signals = [];
  const controller = new AbortController();
  const promise = WorkerSignalChannel.listen({
    signalDir,
    abortSignal: controller.signal,
    pollMs: options.pollMs ?? 10,
    timeoutMs: options.timeoutMs,
    now: options.now,
    onSignal(signal) {
      signals.push(signal);
      options.onSignal?.(signal, controller);
    },
  });

  return { signals, controller, promise };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("WorkerSignalChannel", () => {
  it("writes start, heartbeat, done, and error lifecycle signals to shard JSONL", async () => {
    const signalDir = makeSignalDir();
    const channel = new WorkerSignalChannel({ shardId: "shard-a", signalDir });

    await channel.start();
    await channel.heartbeat({ step: "plan" });
    await channel.done({ commit: "abc123" });
    await channel.error("late failure", { code: "E_LATE" });

    const filePath = join(signalDir, "shard-a.jsonl");
    const records = await readJsonl(filePath);

    assert.deepEqual(
      records.map((record) => record.type),
      ["start", "heartbeat", "done", "error"],
    );
    assert.ok(records.every((record) => record.shardId === "shard-a"));
    assert.equal(records[1].meta.step, "plan");
    assert.equal(records[2].payload.commit, "abc123");
    assert.equal(records[3].reason, "late failure");
  });

  it("listens for appended signals from shard files", async () => {
    const signalDir = makeSignalDir();
    const channel = new WorkerSignalChannel({ shardId: "shard-b", signalDir });
    const listener = waitForSignals(signalDir, {
      onSignal(signal, controller) {
        if (signal.type === "done") {
          controller.abort();
        }
      },
    });

    await channel.start();
    await channel.done({ ok: true });
    await listener.promise;

    assert.deepEqual(
      listener.signals.map((signal) => signal.type),
      ["start", "done"],
    );
    assert.equal(listener.signals[1].payload.ok, true);
  });

  it("serializes overlapping writes for the same shard file", async () => {
    const signalDir = makeSignalDir();
    const channel = new WorkerSignalChannel({
      shardId: "shard-concurrent",
      signalDir,
    });

    await Promise.all([
      channel.start(),
      channel.heartbeat({ step: 1 }),
      channel.done({ ok: true }),
    ]);

    const records = await readJsonl(join(signalDir, "shard-concurrent.jsonl"));
    assert.deepEqual(
      records.map((record) => record.type),
      ["start", "heartbeat", "done"],
    );
  });

  it("emits one stale event when heartbeat is older than timeout", async () => {
    const signalDir = makeSignalDir();
    let now = Date.parse("2026-04-26T00:00:00.000Z");
    const channel = new WorkerSignalChannel({
      shardId: "shard-stale",
      signalDir,
      now: () => now,
    });
    await channel.heartbeat({ phase: "exec" });

    now += 1_001;
    const listener = waitForSignals(signalDir, {
      timeoutMs: 1_000,
      now: () => now,
      onSignal(signal, controller) {
        if (signal.type === "stale") {
          controller.abort();
        }
      },
    });
    await listener.promise;

    const staleEvents = listener.signals.filter(
      (signal) => signal.type === "stale",
    );
    assert.equal(staleEvents.length, 1);
    assert.equal(staleEvents[0].shardId, "shard-stale");
    assert.equal(staleEvents[0].timeoutMs, 1_000);
  });

  it("keeps the previous JSONL content when fallback replacement fails", async () => {
    const signalDir = makeSignalDir();
    const filePath = join(signalDir, "shard-rollback.jsonl");
    const initial = `${JSON.stringify({
      type: "start",
      shardId: "shard-rollback",
      ts: "2026-04-26T00:00:00.000Z",
    })}\n`;

    await appendSignalLineAtomic(filePath, initial);

    const realFs = await import("node:fs/promises");
    const renameCalls = [];
    const failingFs = {
      ...realFs,
      async rename(from, to) {
        renameCalls.push({ from: basename(from), to: basename(to) });
        if (from.endsWith(".tmp") && to === filePath) {
          const error = new Error("simulated replace failure");
          error.code = renameCalls.length === 1 ? "EPERM" : "EIO";
          throw error;
        }
        return realFs.rename(from, to);
      },
    };

    await assert.rejects(
      () =>
        appendSignalLineAtomic(
          filePath,
          `${JSON.stringify({
            type: "done",
            shardId: "shard-rollback",
            ts: "2026-04-26T00:00:01.000Z",
            payload: {},
          })}\n`,
          { fs: failingFs },
        ),
      /simulated replace failure/,
    );

    assert.equal(await readFile(filePath, "utf8"), initial);
    const leftovers = (await readdir(signalDir)).filter(
      (name) => name.endsWith(".tmp") || name.endsWith(".bak"),
    );
    assert.deepEqual(leftovers, []);
  });
});
