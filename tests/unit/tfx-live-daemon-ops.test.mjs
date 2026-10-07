import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  attachClaudeDaemonSession,
  deriveClaudeDaemonPaths,
} from "../../hub/team/claude-daemon-control.mjs";
import {
  findClaudeTranscript,
  readClaudeTranscript,
} from "../../hub/team/claude-transcript.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const execFileAsync = promisify(execFile);

async function withFakeDaemon(fn) {
  const configDir = await fs.mkdtemp(path.join(repoRoot, ".tfx-daemon-"));
  const tmpRoot = await fs.mkdtemp(path.join(repoRoot, ".tfx-sock-"));
  const paths = deriveClaudeDaemonPaths({ configDir, tmpRoot });
  const sessionId = "daemon-session";
  const cwd = "/work/project.test";
  const session = { short: "abc12345", sessionId, cwd, state: "idle" };
  const transcriptPath = path.join(
    configDir,
    "projects",
    "-work-project-test",
    `${sessionId}.jsonl`,
  );
  await fs.mkdir(path.dirname(paths.controlSock), { recursive: true });
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  const requests = [];
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", (data) => {
      const request = JSON.parse(String(data).split("\n")[0]);
      requests.push(request);
      if (request.op === "list") {
        socket.end(`${JSON.stringify({ ok: true, jobs: [session] })}\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(paths.controlSock, resolve));
  try {
    await fn({ configDir, tmpRoot, transcriptPath, requests, session });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(configDir, { recursive: true, force: true });
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

async function runBridge(verb, payload) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      process.execPath,
      [
        path.join(repoRoot, "hub", "bridge.mjs"),
        verb,
        "--payload",
        JSON.stringify(payload),
      ],
      { cwd: repoRoot },
    ));
  } catch (error) {
    stdout = error.stdout;
  }
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

test("Claude transcript matches human request and turn end while ignoring tool results", async () => {
  const configDir = await fs.mkdtemp(path.join(repoRoot, ".tfx-transcript-"));
  const cwd = "/work/project.test";
  const sessionId = "session-1";
  const transcriptPath = path.join(
    configDir,
    "projects",
    "-work-project-test",
    `${sessionId}.jsonl`,
  );
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  await fs.writeFile(
    transcriptPath,
    [
      { type: "user", message: { content: "[tfx-live req=abc123] do work" } },
      {
        type: "assistant",
        timestamp: "2026-10-08T00:00:00Z",
        message: {
          model: "claude-test",
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 3,
          },
          content: [{ type: "text", text: "first" }],
        },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", content: "tool output" }] },
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "finished" }],
          stop_reason: "end_turn",
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  try {
    assert.equal(
      await findClaudeTranscript({ configDir, sessionId, cwd }),
      transcriptPath,
    );
    assert.equal(
      await findClaudeTranscript({
        configDir: path.join(configDir, "omc-runtime"),
        sourceConfigDir: configDir,
        sessionId,
        cwd,
      }),
      transcriptPath,
    );
    const result = await readClaudeTranscript(transcriptPath, {
      requestId: "abc123",
    });
    assert.equal(result.response, "finished");
    assert.equal(result.turnEnded, true);
    assert.deepEqual(result.context, {
      estimatedContextTokens: 33,
      model: "claude-test",
      measuredAt: "2026-10-08T00:00:00Z",
    });
  } finally {
    await fs.rm(configDir, { recursive: true, force: true });
  }
});

test("Claude attach noWait returns after submitting input", async () => {
  const sockPath = path.join(repoRoot, `.tfx-${process.pid}.sock`);
  const server = net.createServer((socket) => {
    let sentHandshake = false;
    socket.on("data", (data) => {
      if (!sentHandshake) {
        sentHandshake = true;
        socket.write(`${JSON.stringify({ ok: true, op: "attach" })}\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(sockPath, resolve));
  try {
    const result = await attachClaudeDaemonSession({
      controlSock: sockPath,
      short: "abc12345",
      input: "hello",
      initialDrainMs: 0,
      timeoutMs: 1000,
      noWait: true,
    });
    assert.equal(result.inputSent, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.matchedCompletion, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(sockPath, { force: true });
  }
});

test("daemon-wait requires transcript turn end even when daemon is idle", async () => {
  await withFakeDaemon(
    async ({ configDir, tmpRoot, transcriptPath, session }) => {
      const entries = [
        { type: "user", message: { content: "[tfx-live req=req1] task" } },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "result" }] },
        },
      ];
      await fs.writeFile(
        transcriptPath,
        entries.map(JSON.stringify).join("\n") + "\n",
      );
      const payload = {
        configDir,
        tmpRoot,
        short: "abc12345",
        requestId: "req1",
        timeoutMs: 1000,
        pollIntervalMs: 100,
      };
      const pending = await runBridge("daemon-wait", payload);
      assert.equal(pending.status, "working");
      assert.equal(pending.timedOut, true);
      assert.equal(pending.requestId, "req1");
      assert.equal(pending.estimatedContextTokens, null);
      entries.push({ type: "system", subtype: "turn_duration" });
      await fs.writeFile(
        transcriptPath,
        entries.map(JSON.stringify).join("\n") + "\n",
      );
      const complete = await runBridge("daemon-wait", payload);
      assert.equal(complete.status, "completed");
      assert.equal(complete.response, "result");
      assert.equal(complete.done, true);
      await fs.writeFile(
        transcriptPath,
        [entries[0], entries.at(-1)].map(JSON.stringify).join("\n") + "\n",
      );
      const empty = await runBridge("daemon-wait", payload);
      assert.equal(empty.status, "failed");
      assert.equal(empty.done, false);
      assert.equal(complete.requestId, "req1");
      entries.push({
        type: "user",
        message: { content: "[tfx-live req=req2] next" },
      });
      await fs.writeFile(
        transcriptPath,
        entries.map(JSON.stringify).join("\n") + "\n",
      );
      session.state = "working";
      const prior = await runBridge("daemon-wait", payload);
      assert.equal(prior.status, "completed");
      assert.equal(prior.response, "result");
    },
  );
});

test("daemon-attach blocks an over-limit transcript before sending input", async () => {
  await withFakeDaemon(
    async ({ configDir, tmpRoot, transcriptPath, requests }) => {
      await fs.writeFile(
        transcriptPath,
        JSON.stringify({
          type: "assistant",
          message: {
            usage: { input_tokens: 850_000, cache_read_input_tokens: 1 },
            content: [{ type: "text", text: "ready" }],
          },
        }) + "\n",
      );
      const result = await runBridge("daemon-attach", {
        configDir,
        tmpRoot,
        short: "abc12345",
        prompt: "do not send",
        noWait: true,
      });
      assert.equal(result.errorCode, "context-limit");
      assert.equal(result.contextTokens, 850_001);
      assert.equal(result.inputSent, false);
      assert.deepEqual(
        requests.map((request) => request.op),
        ["list"],
      );
    },
  );
});
