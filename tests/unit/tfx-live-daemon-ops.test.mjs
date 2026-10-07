import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { deriveClaudeDaemonPaths } from "../../hub/team/claude-daemon-control.mjs";
import {
  findClaudeTranscript,
  readClaudeTranscript,
} from "../../hub/team/claude-transcript.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const execFileAsync = promisify(execFile);

async function withTranscript(fn) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "tfx-transcript-"));
  const transcriptPath = path.join(root, "session.jsonl");
  try {
    await fn(transcriptPath, root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
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

test("daemon-attach rejects an over-limit transcript before input", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "tfx-daemon-"));
  const configDir = path.join(root, "config");
  const tmpRoot = tmpdir();
  const paths = deriveClaudeDaemonPaths({ configDir, tmpRoot });
  const sessionId = "daemon-session";
  const cwd = "/work/project.test";
  const transcriptPath = path.join(
    configDir,
    "projects",
    "-work-project-test",
    `${sessionId}.jsonl`,
  );
  await fs.mkdir(path.dirname(paths.controlSock), { recursive: true });
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  await fs.writeFile(
    transcriptPath,
    `${JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-fable-5-1",
        usage: { input_tokens: 899_999, cache_read_input_tokens: 1 },
        content: [{ type: "text", text: "ready" }],
      },
    })}\n`,
  );
  const requests = [];
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", (data) => {
      const request = JSON.parse(String(data).split("\n")[0]);
      requests.push(request.op);
      if (request.op === "list") {
        socket.end(
          `${JSON.stringify({ ok: true, jobs: [{ short: "abc12345", sessionId, cwd, state: "idle" }] })}\n`,
        );
      }
    });
  });
  await new Promise((resolve) => server.listen(paths.controlSock, resolve));
  try {
    const result = await runBridge("daemon-attach", {
      configDir,
      tmpRoot,
      short: "abc12345",
      prompt: "do not send",
      noWait: true,
    });
    assert.equal(result.errorCode, "context-limit");
    assert.equal(result.estimatedContextTokens, 900_000);
    assert.equal(result.contextPct, 90);
    assert.equal(result.inputSent, false);
    assert.deepEqual(requests, ["list"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(path.dirname(paths.controlSock), {
      recursive: true,
      force: true,
    });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("transcript lookup uses Claude slug and searches other projects", async () => {
  await withTranscript(async (_transcriptPath, root) => {
    const cwd = "/work/a_b.c";
    const slug = "-work-a-b-c";
    const project = path.join(root, "projects", slug);
    await fs.mkdir(project, { recursive: true });
    const expected = path.join(project, "session.jsonl");
    await fs.writeFile(expected, "");
    assert.equal(
      await findClaudeTranscript({
        configDir: root,
        sessionId: "session",
        cwd,
      }),
      expected,
    );
    assert.equal(
      await findClaudeTranscript({
        configDir: root,
        sessionId: "session",
        cwd: "/other",
      }),
      expected,
    );
  });
});

test("transcript skips synthetic and sidechain entries", async () => {
  await withTranscript(async (transcriptPath) => {
    await fs.writeFile(
      transcriptPath,
      [
        {
          type: "assistant",
          message: {
            model: "claude-fable-5-1",
            usage: { input_tokens: 30 },
            content: [],
          },
        },
        {
          type: "assistant",
          isSidechain: true,
          message: {
            model: "claude-fable-5-1",
            usage: { input_tokens: 999 },
            content: [],
          },
        },
        { type: "user", message: { content: "[tfx-live req=one] task" } },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "answer" }] },
        },
        {
          type: "user",
          message: {
            content: [{ type: "tool_result", content: "[tfx-live req=one]" }],
          },
        },
        {
          type: "assistant",
          isApiErrorMessage: true,
          message: {
            model: "<synthetic>",
            usage: { input_tokens: 0 },
            content: [{ type: "text", text: "Prompt is too long" }],
          },
        },
      ]
        .map(JSON.stringify)
        .join("\n") + "\n",
    );
    const result = await readClaudeTranscript(transcriptPath, {
      requestId: "one",
    });
    assert.equal(result.context.estimatedContextTokens, 30);
    assert.equal(result.response, "answer");
    assert.equal(result.error, "Prompt is too long");
  });
});

test("queued marker follows dequeue, remove, and attachment to its turn", async () => {
  for (const operation of ["dequeue", "remove", "attachment"]) {
    await withTranscript(async (transcriptPath) => {
      const entries = [
        {
          type: "queue-operation",
          operation: "enqueue",
          content: "[tfx-live req=queued] task",
        },
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "old answer" }],
            stop_reason: "end_turn",
          },
        },
        operation === "attachment"
          ? {
              type: "attachment",
              attachment: {
                type: "queued_command",
                prompt: "[tfx-live req=queued] task",
              },
            }
          : {
              type: "queue-operation",
              operation,
              ...(operation === "remove"
                ? { content: "[tfx-live req=queued] task" }
                : {}),
            },
        ...(operation === "dequeue"
          ? [
              {
                type: "user",
                message: { content: "[tfx-live req=queued] task" },
              },
            ]
          : []),
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "새 응답" }],
            stop_reason: "end_turn",
          },
        },
      ];
      const unrelated = [
        ...entries.splice(0, 2),
        { type: "queue-operation", operation: "dequeue" },
        { type: "user", message: { content: "other task" } },
        {
          type: "assistant",
          isApiErrorMessage: true,
          message: { content: "old error" },
        },
      ];
      await fs.writeFile(
        transcriptPath,
        unrelated.map(JSON.stringify).join("\n") + "\n",
      );
      const pending = await readClaudeTranscript(transcriptPath, {
        requestId: "queued",
      });
      assert.equal(pending.userSeen, false);
      assert.equal(pending.error, null);
      const bytes = Buffer.from(entries.map(JSON.stringify).join("\n") + "\n");
      const split = bytes.indexOf(Buffer.from("새")) + 1;
      await fs.appendFile(transcriptPath, bytes.subarray(0, split));
      await readClaudeTranscript(transcriptPath, { requestId: "queued" });
      await fs.appendFile(transcriptPath, bytes.subarray(split));
      const result = await readClaudeTranscript(transcriptPath, {
        requestId: "queued",
      });
      assert.equal(result.userSeen, true);
      assert.equal(result.response, "새 응답");
      assert.equal(result.turnEnded, true);
    });
  }
});

test("compact boundary metadata survives incremental transcript reads", async () => {
  await withTranscript(async (transcriptPath) => {
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
