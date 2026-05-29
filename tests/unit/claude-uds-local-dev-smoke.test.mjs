import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseArgs,
  subscribeUntilMarker,
  summarizeJobs,
  usage,
} from "../../experiments/native-bridge-feasibility/claude-uds-local-dev-smoke.mjs";

async function withUnixJsonLineServer(messages, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "uds-smoke-test-"));
  const sockPath = path.join(dir, "control.sock");
  const server = net.createServer((socket) => {
    socket.on("data", () => {
      for (const message of messages) {
        socket.write(`${JSON.stringify(message)}\n`);
      }
    });
  });

  try {
    server.listen(sockPath);
    await once(server, "listening");
    await fn(sockPath);
  } finally {
    server.close();
    await once(server, "close").catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("parseArgs defaults to a dev-only marker/report and parses overrides", () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.timeoutMs, 90_000);
  assert.match(defaults.marker, /^TFX_UDS_LOCAL_DEV_/);
  assert.match(defaults.reportPath, /uds-local-dev-latest-report\.json$/);

  const parsed = parseArgs([
    "--marker",
    "MARKER",
    "--timeout",
    "1.5",
    "--report",
    "/tmp/uds-report.json",
  ]);
  assert.equal(parsed.marker, "MARKER");
  assert.equal(parsed.timeoutMs, 1500);
  assert.equal(parsed.reportPath, "/tmp/uds-report.json");
});

test("parseArgs rejects unknown flags and invalid timeouts", () => {
  assert.throws(() => parseArgs(["--unknown", "x"]), /Unknown flag/);
  assert.throws(() => parseArgs(["--timeout", "0"]), /positive number/);
  assert.throws(() => parseArgs(["unexpected"]), /Unexpected argument/);
  assert.throws(() => parseArgs(["--marker"]), /Missing value/);
});

test("usage documents UDS control socket dispatch semantics", () => {
  const text = usage();
  assert.match(text, /Unix domain socket/);
  assert.match(text, /control\.sock/);
  assert.match(text, /dispatches one short-lived prompt job/);
});

test("summarizeJobs redacts daemon list records to stable fields", () => {
  const summary = summarizeJobs({
    ok: true,
    jobs: [
      {
        short: "abcd1234",
        pid: 123,
        sessionId: "abcd",
        state: "running",
        tempo: "active",
        cwd: "/tmp/project",
        name: "smoke",
        agent: "claude",
        source: "shell",
        outcome: "done",
        detail: "should be dropped",
        intent: "should be dropped",
      },
    ],
  });

  assert.deepEqual(summary, [
    {
      short: "abcd1234",
      pid: 123,
      sessionId: "abcd",
      state: "running",
      tempo: "active",
      cwd: "/tmp/project",
      name: "smoke",
      agent: "claude",
      source: "shell",
      outcome: "done",
    },
  ]);
});

test("subscribeUntilMarker resolves when marker appears in stream output", async () => {
  await withUnixJsonLineServer(
    [
      { type: "snapshot", streamTail: ["booting\n"] },
      { type: "state", patch: { tempo: "active" } },
      { type: "stream", line: "TFX_UDS_LOCAL_DEV_TEST\n" },
    ],
    async (sockPath) => {
      const result = await subscribeUntilMarker(
        sockPath,
        "shorty",
        "TFX_UDS_LOCAL_DEV_TEST",
        {
          timeoutMs: 1000,
        },
      );

      assert.equal(result.markerSeen, true);
      assert.equal(result.short, "shorty");
      assert.equal(result.messageCount, 3);
      assert.equal(result.stateCount, 1);
      assert.equal(result.streamBytes > 0, true);
    },
  );
});

test("subscribeUntilMarker resolves on settled even without marker", async () => {
  await withUnixJsonLineServer(
    [
      { type: "snapshot", streamTail: ["booting\n"] },
      { type: "settled", outcome: "done" },
    ],
    async (sockPath) => {
      const result = await subscribeUntilMarker(
        sockPath,
        "shorty",
        "MISSING_MARKER",
        {
          timeoutMs: 1000,
        },
      );

      assert.equal(result.markerSeen, false);
      assert.equal(result.settled, "done");
      assert.equal(result.messageCount, 2);
    },
  );
});
