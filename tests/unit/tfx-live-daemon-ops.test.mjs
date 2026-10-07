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
import { readClaudeTranscript } from "../../hub/team/claude-transcript.mjs";
import {
  contextGuard,
  modelContext,
  readCodexContext,
} from "../../hub/team/session-context.mjs";

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
  await withFakeDaemon(async ({ configDir, tmpRoot, transcriptPath }) => {
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
  });
});

test("daemon-attach blocks an over-limit transcript before sending input", async () => {
  for (const [cli, model, tokens, pct] of [
    ["claude", "claude-fable-5-1", 900_000, 90],
    ["codex", "gpt-6.1-sol", 231_000, 22],
    ["agy", "gemini-3.8-flash", 1_048_576 * 0.18, 18],
  ]) {
    const context = modelContext(cli, model, tokens);
    assert.equal(context.contextPct, pct);
    assert.equal(contextGuard(cli, context).errorCode, "context-limit");
    assert.deepEqual(
      contextGuard(cli, context, { maxContextPct: 0, warnContextPct: 0 }),
      {},
    );
  }
  const unknown = modelContext("claude", "unknown-model", 999_999);
  assert.equal(unknown.contextLimitTokens, null);
  assert.equal(
    contextGuard("claude", unknown).contextWarning.reason,
    "unknown-model",
  );
  await withFakeDaemon(
    async ({ configDir, tmpRoot, transcriptPath, requests }) => {
      await fs.writeFile(
        transcriptPath,
        [
          { type: "turn_context", payload: { model: "gpt-6-astra" } },
          {
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                last_token_usage: { total_tokens: 231_000 },
                total_token_usage: { total_tokens: 9_000_000 },
                model_context_window: 258_400,
              },
            },
          },
        ]
          .map(JSON.stringify)
          .join("\n"),
      );
      const codex = await readCodexContext(transcriptPath);
      assert.equal(codex.contextPct, 22);
      assert.equal(codex.contextLimitTokens, 1_050_000);
      assert.equal(codex.executionContextLimitTokens, 258_400);
      await fs.writeFile(
        transcriptPath,
        JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-fable-5-1",
            usage: { input_tokens: 899_999, cache_read_input_tokens: 1 },
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
      assert.equal(result.estimatedContextTokens, 900_000);
      assert.equal(result.contextLimitTokens, 1_000_000);
      assert.equal(result.contextPct, 90);
      assert.equal(result.inputSent, false);
      assert.deepEqual(
        requests.map((request) => request.op),
        ["list"],
      );
    },
  );
});

test("transcript detects a new compact boundary and its token metadata", async () => {
  await withFakeDaemon(async ({ transcriptPath }) => {
    const boundary = {
      type: "system",
      subtype: "compact_boundary",
      compactMetadata: { preTokens: 750_000, postTokens: 25_000 },
    };
    await fs.writeFile(transcriptPath, `${JSON.stringify(boundary)}\n`);
    const before = await readClaudeTranscript(transcriptPath);
    await fs.appendFile(transcriptPath, `${JSON.stringify(boundary)}\n`);
    const after = await readClaudeTranscript(transcriptPath);
    assert.equal(after.compactCount, before.compactCount + 1);
    assert.deepEqual(after.compact, { preTokens: 750_000, postTokens: 25_000 });
    assert.equal(after.context.estimatedContextTokens, 25_000);
  });
});
