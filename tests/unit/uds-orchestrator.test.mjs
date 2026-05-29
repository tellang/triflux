import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { deriveClaudeDaemonPaths } from "../../hub/team/claude-daemon-control.mjs";
import {
  createClaudeUdsEndpoint,
  createCodexExecEndpoint,
  extractClaudeUdsText,
  runUdsOrchestration,
} from "../../hub/team/uds-orchestrator.mjs";

function scriptedEndpoint(name, replies) {
  const calls = [];
  return {
    name,
    calls,
    async ask(prompt, meta = {}) {
      calls.push({ prompt, meta });
      return { endpoint: name, text: replies.shift(), done: true };
    },
  };
}

test("codex-led mode asks Codex, then Claude UDS, then Codex final", async () => {
  const codex = scriptedEndpoint("codex", ["CODEX_PLAN", "CODEX_FINAL"]);
  const claude = scriptedEndpoint("claude-uds", ["CLAUDE_REVIEW"]);

  const result = await runUdsOrchestration({
    mode: "codex-led",
    task: "demo task",
    codex,
    claude,
  });

  assert.equal(result.mode, "codex-led");
  assert.equal(result.final.text, "CODEX_FINAL");
  assert.deepEqual(
    result.turns.map((turn) => turn.endpoint),
    ["codex", "claude-uds", "codex"],
  );
  assert.match(codex.calls[0].prompt, /Lead as Codex/);
  assert.match(claude.calls[0].prompt, /Review Codex/);
});

test("claude-led mode asks Claude UDS, then Codex, then Claude final", async () => {
  const codex = scriptedEndpoint("codex", ["CODEX_REVIEW"]);
  const claude = scriptedEndpoint("claude-uds", [
    "CLAUDE_PLAN",
    "CLAUDE_FINAL",
  ]);

  const result = await runUdsOrchestration({
    mode: "claude-led",
    task: "demo task",
    codex,
    claude,
  });

  assert.equal(result.final.text, "CLAUDE_FINAL");
  assert.deepEqual(
    result.turns.map((turn) => turn.endpoint),
    ["claude-uds", "codex", "claude-uds"],
  );
  assert.match(claude.calls[0].prompt, /Lead as Claude/);
  assert.match(codex.calls[0].prompt, /Review Claude/);
});

test("peer mode asks Claude UDS and Codex as peers, then synthesizes", async () => {
  const codex = scriptedEndpoint("codex", ["CODEX_PEER"]);
  const claude = scriptedEndpoint("claude-uds", ["CLAUDE_PEER", "PEER_FINAL"]);

  const result = await runUdsOrchestration({
    mode: "peer",
    task: "demo task",
    codex,
    claude,
  });

  assert.equal(result.final.text, "PEER_FINAL");
  assert.deepEqual(
    result.turns.map((turn) => turn.endpoint),
    ["claude-uds", "codex", "claude-uds"],
  );
  assert.match(claude.calls[1].prompt, /Synthesize peer answers/);
});

async function withFakeClaudeDaemon(handler, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "uds-orchestrator-"));
  const paths = deriveClaudeDaemonPaths({ configDir: path.join(dir, "claude") });
  await fs.mkdir(paths.daemonDir, { recursive: true });
  const requests = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
      while (data.includes("\n")) {
        const index = data.indexOf("\n");
        const line = data.slice(0, index).trim();
        data = data.slice(index + 1);
        if (!line) continue;
        const request = JSON.parse(line);
        requests.push(request);
        handler(request, socket);
      }
    });
  });

  try {
    server.listen(paths.controlSock);
    await once(server, "listening");
    await fn(paths, requests);
  } finally {
    server.close();
    await once(server, "close").catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function writeJson(socket, value, { end = false } = {}) {
  const line = `${JSON.stringify(value)}\n`;
  if (end) socket.end(line);
  else socket.write(line);
}

test("createClaudeUdsEndpoint dispatches with shared daemon helper, captures marker text, and tears down", async () => {
  await withFakeClaudeDaemon(
    (request, socket) => {
      if (request.op === "dispatch") {
        writeJson(
          socket,
          {
            ok: true,
            op: "dispatch",
            short: request.d.short,
            via: "spare",
            pid: process.pid,
          },
          { end: true },
        );
      } else if (request.op === "list") {
        writeJson(
          socket,
          {
            ok: true,
            jobs: [
              {
                short: "fixed123",
                pid: process.pid,
                sessionId: "fixed123-session",
                bridgeSessionId: "cse_uds_orch",
                startedAt: 1234,
              },
            ],
          },
          { end: true },
        );
      } else if (request.op === "subscribe") {
        writeJson(socket, { type: "snapshot", streamTail: ["boot\n"] });
        writeJson(socket, { type: "stream", line: "⏺ ANSWER_TEXT\n" });
        writeJson(socket, { type: "stream", line: `${request.marker || ""}\n` });
      } else if (request.op === "kill") {
        writeJson(socket, { ok: true, op: "kill" }, { end: true });
      } else {
        writeJson(socket, { ok: true, op: request.op }, { end: true });
      }
    },
    async (paths, requests) => {
      const endpoint = createClaudeUdsEndpoint({
        daemonPaths: paths,
        markerFactory: () => "DONE_MARKER",
        timeoutMs: 1000,
        shortFactory: () => "fixed123",
        sessionIdFactory: () => "fixed123-session",
      });

      const result = await endpoint.ask("say answer");

      assert.equal(result.done, true);
      assert.equal(result.text, "ANSWER_TEXT");
      assert.equal(result.dispatch?.ok, true);
      assert.ok(requests.find((request) => request.op === "dispatch"));
      assert.ok(requests.find((request) => request.op === "subscribe"));
      assert.ok(requests.find((request) => request.op === "kill"));
      assert.equal(requests.find((request) => request.op === "dispatch").d.short, "fixed123");
      assert.match(
        requests.find((request) => request.op === "dispatch").d.launch.args.join(" "),
        /DONE_MARKER/,
      );
    },
  );
});

test("createClaudeUdsEndpoint throws before subscribe when daemon dispatch is not ok", async () => {
  await withFakeClaudeDaemon(
    (request, socket) => {
      if (request.op === "dispatch") {
        writeJson(socket, { ok: false, op: "dispatch" }, { end: true });
        return;
      }
      writeJson(socket, { ok: true, op: request.op }, { end: true });
    },
    async (paths, requests) => {
      const endpoint = createClaudeUdsEndpoint({
        daemonPaths: paths,
        markerFactory: () => "DONE_MARKER",
        timeoutMs: 1000,
        shortFactory: () => "fail1234",
        sessionIdFactory: () => "fail1234-session",
      });

      await assert.rejects(() => endpoint.ask("say answer"), /dispatch failed/u);
      assert.deepEqual(
        requests.map((request) => request.op),
        ["dispatch"],
      );
    },
  );
});

test("createClaudeUdsEndpoint ignores echoed marker instructions before completion", async () => {
  await withFakeClaudeDaemon(
    (request, socket) => {
      if (request.op === "dispatch") {
        writeJson(
          socket,
          { ok: true, op: "dispatch", short: request.d.short, pid: process.pid },
          { end: true },
        );
      } else if (request.op === "list") {
        writeJson(
          socket,
          {
            ok: true,
            jobs: [
              {
                short: "echo1234",
                pid: process.pid,
                sessionId: "echo1234-session",
                bridgeSessionId: "cse_echo",
                startedAt: 1234,
              },
            ],
          },
          { end: true },
        );
      } else if (request.op === "subscribe") {
        writeJson(socket, {
          type: "snapshot",
          streamTail: [
            "When finished, print this exact completion marker on its own line: DONE_MARKER\n",
          ],
        });
        writeJson(socket, { type: "stream", line: "⏺ ACTUAL_ANSWER\n" });
        writeJson(socket, { type: "stream", line: "DONE_MARKER\n" });
      } else if (request.op === "kill") {
        writeJson(socket, { ok: true, op: "kill" }, { end: true });
      } else {
        writeJson(socket, { ok: true, op: request.op }, { end: true });
      }
    },
    async (paths) => {
      const endpoint = createClaudeUdsEndpoint({
        daemonPaths: paths,
        markerFactory: () => "DONE_MARKER",
        timeoutMs: 1000,
        shortFactory: () => "echo1234",
        sessionIdFactory: () => "echo1234-session",
      });

      const result = await endpoint.ask("say answer");

      assert.equal(result.done, true);
      assert.equal(result.text, "ACTUAL_ANSWER");
    },
  );
});

test("extractClaudeUdsText filters status noise after assistant marker", () => {
  const text = [
    "Claude Code",
    "⏺ FINAL_ANSWER",
    "✳ Crunching tokens",
    "Opus",
    "╭────────╮",
    "DONE_MARKER",
  ].join("\n");

  assert.equal(extractClaudeUdsText(text, "DONE_MARKER"), "FINAL_ANSWER");
});

test("createCodexExecEndpoint normalizes Codex exec success and failure", async () => {
  const success = createCodexExecEndpoint({
    executeCodex: async ({ prompt }) => ({
      ok: true,
      output: `codex:${prompt}`,
    }),
  });
  assert.deepEqual(await success.ask("ping"), {
    endpoint: "codex",
    text: "codex:ping",
    done: true,
  });

  const stdoutFallback = createCodexExecEndpoint({
    executeCodex: async () => ({ ok: true, stdout: "legacy stdout" }),
  });
  assert.equal((await stdoutFallback.ask("ping")).text, "legacy stdout");

  const failure = createCodexExecEndpoint({
    executeCodex: async () => ({ ok: false, stderr: "boom" }),
  });
  await assert.rejects(() => failure.ask("ping"), /Codex exec failed: boom/);
});
