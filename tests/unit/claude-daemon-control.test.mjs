import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  attachClaudeDaemonSession,
  buildDaemonAttachRequest,
  buildDaemonExecDispatchPayload,
  deriveClaudeDaemonPaths,
  extractClaudeDaemonAttachText,
  findDaemonJobByShort,
  resolveDaemonBridgeSessionId,
  sendClaudeControlRequest,
  sendKillBySessionId,
} from "../../hub/team/claude-daemon-control.mjs";

function listenJsonServer(sockPath, handler) {
  const requests = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let data = "";
    socket.on("data", async (chunk) => {
      data += chunk;
      if (!data.includes("\n")) return;
      const line = data.slice(0, data.indexOf("\n"));
      const request = JSON.parse(line);
      requests.push(request);
      const response = await handler(request);
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, () => resolve({ server, requests }));
  });
}

test("deriveClaudeDaemonPaths matches Claude daemon hash convention", () => {
  const configDir = path.join(os.tmpdir(), "claude-control-test");
  const hash = crypto
    .createHash("sha256")
    .update(path.resolve(configDir))
    .digest("hex")
    .slice(0, 8);

  const paths = deriveClaudeDaemonPaths({
    configDir,
    uid: 501,
    tmpRoot: "/tmp",
  });

  assert.equal(paths.configDir, path.resolve(configDir));
  assert.equal(paths.daemonDir, `/tmp/cc-daemon-501/${hash}`);
  assert.equal(paths.controlSock, `/tmp/cc-daemon-501/${hash}/control.sock`);
  assert.equal(
    paths.sessionsDir,
    path.join(path.resolve(configDir), "sessions"),
  );
  assert.equal(paths.jobsDir, path.join(path.resolve(configDir), "jobs"));
});

test("sendClaudeControlRequest sends one JSON line and parses first response line", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-control-"));
  const sockPath = path.join(dir, "control.sock");
  const { server, requests } = await listenJsonServer(sockPath, (request) => ({
    ok: true,
    op: request.op,
    jobs: [],
  }));

  try {
    const response = await sendClaudeControlRequest(sockPath, {
      proto: 1,
      op: "list",
    });

    assert.deepEqual(response, { ok: true, op: "list", jobs: [] });
    assert.deepEqual(requests, [{ proto: 1, op: "list" }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("buildDaemonExecDispatchPayload names a Triflux worker and launches shell exec", () => {
  const payload = buildDaemonExecDispatchPayload({
    short: "a1b2c3d4",
    cwd: "/tmp/project",
    command: "printf ok",
    name: "Triflux codex executor",
    createdAt: 1234,
    cols: 100,
    rows: 30,
  });

  assert.equal(payload.proto, 1);
  assert.equal(payload.short, "a1b2c3d4");
  assert.match(payload.sessionId, /^a1b2c3d4-/);
  assert.equal(payload.source, "shell");
  assert.equal(payload.cwd, "/tmp/project");
  assert.deepEqual(payload.launch, {
    mode: "exec",
    cmd: "/bin/zsh",
    args: ["-lc", "printf ok"],
  });
  assert.equal(payload.seed.name, "Triflux codex executor");
});

test("buildDaemonAttachRequest creates the live PTY attach request shape", () => {
  assert.deepEqual(
    buildDaemonAttachRequest({
      short: "deadbeef",
      cols: 140,
      rows: 45,
    }),
    {
      proto: 1,
      op: "attach",
      short: "deadbeef",
      cols: 140,
      rows: 45,
      caps: { terminal: null, mux: null, ssh: false },
    },
  );
  assert.throws(() => buildDaemonAttachRequest(), /short is required/);
});

test("extractClaudeDaemonAttachText returns the last assistant block without chrome", () => {
  const text = [
    "❯ echoed prompt",
    "⏺ first answer",
    "✻ Brewed for 1s",
    "❯ another prompt",
    "⏺ final answer",
    "  continuation line",
    "✻ Brewed for 2s",
    "Image in clipboard · ctrl+v to paste",
    "──────────────── Claude ────────────────",
    "❯ ",
  ].join("\n");

  assert.equal(
    extractClaudeDaemonAttachText(text),
    "final answer\ncontinuation line",
  );
});

test("extractClaudeDaemonAttachText stops before settings overlays", () => {
  const text = [
    "⏺ ACK",
    "- keep UDS and tmux separate",
    "▔▔▔▔▔▔▔▔▔▔",
    "SettingsStatus Config UsageStats",
    "╭────────────────────╮",
    "│⌕ Search settings…│",
    "╰────────────────────╯",
    "❯ Auto-compactfalse",
    "Showtipsfalse",
    "Space to change · Enter to save · Esc to cancel",
  ].join("\n");

  assert.equal(
    extractClaudeDaemonAttachText(text),
    "ACK\n- keep UDS and tmux separate",
  );
});

test("extractClaudeDaemonAttachText stops before transient runtime status lines", () => {
  const text = [
    "⏺ STRUCTURED_RETURN_OK",
    "2",
    "·3",
    "W(3s · ↓1 tokens)",
    "Undulating…(1s · ↓1 tokens)",
    "Smooshing…",
    "2 MCP servers failed · /mcp",
    "❯ ",
  ].join("\n");

  assert.equal(extractClaudeDaemonAttachText(text), "STRUCTURED_RETURN_OK");
});

test("extractClaudeDaemonAttachText strips transient status lines after numeric replies", () => {
  assert.equal(
    extractClaudeDaemonAttachText(
      [
        "⏺ 2",
        "Harmonizing…(1s · ↓1 tokens)",
        "·Harmonizing…2",
        "Harmonizing…3",
        "❯ ",
      ].join("\n"),
    ),
    "2",
  );

  assert.equal(
    extractClaudeDaemonAttachText(
      ["⏺ 4", "Baking…(1s · ↓1 tokens)", "❯ "].join("\n"),
    ),
    "4",
  );

  assert.equal(
    extractClaudeDaemonAttachText(["⏺ 4", "lin…", "❯ "].join("\n")),
    "4",
  );

  assert.equal(
    extractClaudeDaemonAttachText(
      [
        "⏺ SELF_PEER_OK",
        "Thought for 4s)",
        "RaccoonJuggling for 4s)",
        "Zorbling…7",
        "❯ ",
      ].join("\n"),
    ),
    "SELF_PEER_OK",
  );
});

test("extractClaudeDaemonAttachText rejoins soft-wrapped rows without dropping boundary spaces", () => {
  const text = ["⏺ 캡처에서 completion까지 보존", "✻ Brewed for 1s", "❯ "].join(
    "\n",
  );

  assert.equal(
    extractClaudeDaemonAttachText(text, { cols: 8 }),
    "캡처에서 completion까지 보존",
  );
});

test("extractClaudeDaemonAttachText keeps hard newlines after full-width rows", () => {
  const fullWidthCodeLine = "x".repeat(80);
  const text = [
    "⏺ generated code:",
    fullWidthCodeLine,
    "return result;",
    "✻ Brewed for 1s",
    "❯ ",
  ].join("\n");

  assert.equal(
    extractClaudeDaemonAttachText(text, { cols: 80 }),
    ["generated code:", fullWidthCodeLine, "return result;"].join("\n"),
  );
});

test("extractClaudeDaemonAttachText applies repaint overwrites before extracting", () => {
  const text = ["⏺ latency 750s\x1b[Dms", "✻ Brewed for 1s", "❯ "].join("\n");

  assert.equal(extractClaudeDaemonAttachText(text), "latency 750ms");
});

test("extractClaudeDaemonAttachText respects Hangul cell width at soft-wrap boundaries", () => {
  const text = ["⏺ 한글한 글 경계 보존", "✻ Brewed for 1s", "❯ "].join("\n");

  assert.equal(
    extractClaudeDaemonAttachText(text, { cols: 6 }),
    "한글한 글 경계 보존",
  );
});

test("attachClaudeDaemonSession pastes into a live daemon PTY and returns response text", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-attach-"));
  const sockPath = path.join(dir, "control.sock");
  let attachedRequest = null;
  let attachedInput = "";
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let firstLine = "";
    socket.on("data", (chunk) => {
      if (!attachedRequest) {
        firstLine += chunk;
        if (!firstLine.includes("\n")) return;
        const line = firstLine.slice(0, firstLine.indexOf("\n"));
        attachedRequest = JSON.parse(line);
        socket.write(
          `${JSON.stringify({
            ok: true,
            op: "attach",
            via: "spare",
            tempo: "idle",
            state: "done",
          })}\n`,
        );
        return;
      }

      attachedInput += chunk;
      if (!attachedInput.includes("\r")) return;
      socket.write("❯ relayed prompt\n");
      socket.write("✻ Fermenting… (esc to interrupt)\n");
      socket.write("⏺ ATTACH_RESPONSE\n");
      socket.write("✻ Brewed for 1s\n");
      socket.write("❯ \n");
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, resolve);
    });

    const result = await attachClaudeDaemonSession({
      controlSock: sockPath,
      short: "da387370",
      input: "hello peer",
      timeoutMs: 1000,
    });

    assert.deepEqual(attachedRequest, {
      proto: 1,
      op: "attach",
      short: "da387370",
      cols: 240,
      rows: 40,
      caps: { terminal: null, mux: null, ssh: false },
    });
    assert.match(attachedInput, /\x15/);
    assert.match(attachedInput, /\x1b\[200~hello peer\x1b\[201~/);
    assert.match(attachedInput, /\r/);
    assert.equal(result.handshake.ok, true);
    assert.equal(result.inputSent, true);
    assert.equal(result.matchedCompletion, true);
    assert.equal(result.text, "ATTACH_RESPONSE");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("attachClaudeDaemonSession extracts only the response after injected input", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-attach-delta-"));
  const sockPath = path.join(dir, "control.sock");
  let attachedInput = "";
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let firstLine = "";
    socket.on("data", (chunk) => {
      if (!firstLine.includes("\n")) {
        firstLine += chunk;
        if (!firstLine.includes("\n")) return;
        socket.write(
          `${JSON.stringify({
            ok: true,
            op: "attach",
            via: "spare",
            tempo: "idle",
            state: "done",
          })}\n`,
        );
        socket.write("⏺ OLD_READY_TEXT\n");
        socket.write("❯ \n");
        return;
      }

      attachedInput += chunk;
      if (!attachedInput.includes("\r")) return;
      socket.write("❯ injected prompt\n");
      socket.write("✻ Fermenting… (esc to interrupt)\n");
      socket.write("⏺ STRUCTURED_RETURN_OK\n");
      socket.write("❯ \n");
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, resolve);
    });

    const result = await attachClaudeDaemonSession({
      controlSock: sockPath,
      short: "df3d9c2d",
      input: "Reply with exactly STRUCTURED_RETURN_OK and then stop.",
      timeoutMs: 1000,
    });

    assert.equal(result.inputSent, true);
    assert.equal(result.matchedCompletion, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.text, "STRUCTURED_RETURN_OK");
    assert.doesNotMatch(result.text, /OLD_READY_TEXT/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("attachClaudeDaemonSession waits for post-input busy before matching completion", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-attach-busy-"));
  const sockPath = path.join(dir, "control.sock");
  let attachedInput = "";
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let firstLine = "";
    socket.on("data", (chunk) => {
      if (!firstLine.includes("\n")) {
        firstLine += chunk;
        if (!firstLine.includes("\n")) return;
        socket.write(
          `${JSON.stringify({
            ok: true,
            op: "attach",
            via: "spare",
            tempo: "idle",
            state: "done",
          })}\n`,
        );
        socket.write("⏺ OLD_SELF_PEER_REPLY\n");
        socket.write("❯ \n");
        return;
      }

      attachedInput += chunk;
      if (!attachedInput.includes("\r")) return;
      socket.write("⏺ OLD_SELF_PEER_REPLY\n");
      socket.write("❯ \n");
      setTimeout(() => {
        socket.write("✻ Fermenting… (esc to interrupt)\n");
        socket.write("⏺ NEW_SELF_PEER_REPLY\n");
        socket.write("❯ \n");
      }, 20);
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, resolve);
    });

    const result = await attachClaudeDaemonSession({
      controlSock: sockPath,
      short: "busy001",
      input: "Reply with NEW_SELF_PEER_REPLY",
      timeoutMs: 1000,
    });

    assert.equal(result.inputSent, true);
    assert.equal(result.matchedCompletion, true);
    assert.equal(result.postInputBusySeen, true);
    assert.equal(result.text, "NEW_SELF_PEER_REPLY");
    assert.doesNotMatch(result.text, /OLD_SELF_PEER_REPLY/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("attachClaudeDaemonSession waits through dynamic progress before returning multi-paragraph response", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "claude-attach-partial-"),
  );
  const sockPath = path.join(dir, "control.sock");
  let attachedInput = "";
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let firstLine = "";
    socket.on("data", (chunk) => {
      if (!firstLine.includes("\n")) {
        firstLine += chunk;
        if (!firstLine.includes("\n")) return;
        socket.write(
          `${JSON.stringify({
            ok: true,
            op: "attach",
            via: "spare",
            tempo: "idle",
            state: "done",
          })}\n`,
        );
        return;
      }

      attachedInput += chunk;
      if (!attachedInput.includes("\r")) return;
      socket.write("✻ Fermenting… (esc to interrupt)\n");
      socket.write("⏺ First paragraph only.\n");
      socket.write("❯ \n");
      setTimeout(() => socket.write("✶ Fermenting…1\n"), 15);
      setTimeout(() => socket.write("✳ Fermenting…2\n"), 30);
      setTimeout(() => {
        socket.write(
          "⏺ First paragraph only.\n\nSecond paragraph with design opinion.\n\nQuestion for Codex?\n",
        );
        socket.write("❯ \n");
      }, 45);
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, resolve);
    });

    const result = await attachClaudeDaemonSession({
      controlSock: sockPath,
      short: "partial1",
      input: "Reply with three paragraphs.",
      timeoutMs: 1000,
      completionQuiescenceMs: 80,
    });

    assert.equal(result.inputSent, true);
    assert.equal(result.matchedCompletion, true);
    assert.equal(
      result.text,
      [
        "First paragraph only.",
        "",
        "Second paragraph with design opinion.",
        "",
        "Question for Codex?",
      ].join("\n"),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("attachClaudeDaemonSession accepts prompt echo as post-input transition", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-attach-echo-"));
  const sockPath = path.join(dir, "control.sock");
  let attachedInput = "";
  const prompt = "Reply with exactly PROMPT_ECHO_OK";
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let firstLine = "";
    socket.on("data", (chunk) => {
      if (!firstLine.includes("\n")) {
        firstLine += chunk;
        if (!firstLine.includes("\n")) return;
        socket.write(
          `${JSON.stringify({
            ok: true,
            op: "attach",
            via: "spare",
            tempo: "active",
            state: "working",
          })}\n`,
        );
        socket.write("⏺ OLD_IDLE_REPLY\n");
        socket.write("❯ \n");
        return;
      }

      attachedInput += chunk;
      if (!attachedInput.includes("\r")) return;
      socket.write("⏺ OLD_IDLE_REPLY\n");
      socket.write("❯ \n");
      socket.write(`❯ ${prompt}\n`);
      socket.write("⏺ PROMPT_ECHO_OK\n");
      socket.write("❯ \n");
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, resolve);
    });

    const result = await attachClaudeDaemonSession({
      controlSock: sockPath,
      short: "echo001",
      input: prompt,
      timeoutMs: 1000,
    });

    assert.equal(result.inputSent, true);
    assert.equal(result.matchedCompletion, true);
    assert.equal(result.postInputBusySeen, false);
    assert.equal(result.postInputPromptEchoSeen, true);
    assert.equal(result.text, "PROMPT_ECHO_OK");
    assert.doesNotMatch(result.text, /OLD_IDLE_REPLY/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("attachClaudeDaemonSession accepts elapsed summary completion without verb allowlist", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "claude-attach-elapsed-"),
  );
  const sockPath = path.join(dir, "control.sock");
  let attachedInput = "";
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let firstLine = "";
    socket.on("data", (chunk) => {
      if (!firstLine.includes("\n")) {
        firstLine += chunk;
        if (!firstLine.includes("\n")) return;
        socket.write(
          `${JSON.stringify({
            ok: true,
            op: "attach",
            via: "spare",
            tempo: "idle",
            state: "done",
          })}\n`,
        );
        return;
      }

      attachedInput += chunk;
      if (!attachedInput.includes("\r")) return;
      socket.write("❯ elapsed prompt\n");
      socket.write("✻ Zorbling… (esc to interrupt)\n");
      socket.write("⏺ ELAPSED_SUMMARY_OK\n");
      socket.write("(2s · ↓1 tokens)\n");
      socket.write("Wombatizing…8\n");
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, resolve);
    });

    const result = await attachClaudeDaemonSession({
      controlSock: sockPath,
      short: "elapsed1",
      input: "Reply with ELAPSED_SUMMARY_OK",
      timeoutMs: 1000,
    });

    assert.equal(result.inputSent, true);
    assert.equal(result.matchedCompletion, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.text, "ELAPSED_SUMMARY_OK");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("attachClaudeDaemonSession does not treat settings selector as completed composer", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "claude-attach-settings-"),
  );
  const sockPath = path.join(dir, "control.sock");
  let attachedInput = "";
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let firstLine = "";
    socket.on("data", (chunk) => {
      if (!firstLine.includes("\n")) {
        firstLine += chunk;
        if (!firstLine.includes("\n")) return;
        socket.write(
          `${JSON.stringify({
            ok: true,
            op: "attach",
            via: "spare",
            tempo: "idle",
            state: "done",
          })}\n`,
        );
        return;
      }

      attachedInput += chunk;
      if (!attachedInput.includes("\r")) return;
      socket.write("⏺ ACK_FROM_CLAUDE\n");
      socket.write("SettingsStatus Config UsageStats\n");
      socket.write("❯ Auto-compactfalse\n");
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, resolve);
    });

    const result = await attachClaudeDaemonSession({
      controlSock: sockPath,
      short: "52059f6d",
      input: "hello peer",
      initialDrainMs: 0,
      timeoutMs: 50,
    });

    assert.equal(result.inputSent, true);
    assert.equal(result.timedOut, true);
    assert.equal(result.matchedCompletion, false);
    assert.equal(result.text, "ACK_FROM_CLAUDE");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("attachClaudeDaemonSession marks socket close before completion as closed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-attach-closed-"));
  const sockPath = path.join(dir, "control.sock");
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let firstLine = "";
    socket.on("data", (chunk) => {
      if (firstLine.includes("\n")) return;
      firstLine += chunk;
      if (!firstLine.includes("\n")) return;
      socket.write(`${JSON.stringify({ ok: true, op: "attach" })}\n`);
      socket.end("⏺ PARTIAL_RESPONSE\n");
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, resolve);
    });

    const result = await attachClaudeDaemonSession({
      controlSock: sockPath,
      short: "closed01",
      input: "hello",
      initialDrainMs: 0,
      timeoutMs: 1000,
    });

    assert.equal(result.inputSent, false);
    assert.equal(result.closed, true);
    assert.equal(result.matchedCompletion, false);
    assert.equal(result.timedOut, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("attachClaudeDaemonSession rejects malformed daemon attach handshakes", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "claude-attach-malformed-"),
  );
  const sockPath = path.join(dir, "control.sock");
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", () => {
      socket.end("{not-json}\n");
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, resolve);
    });

    await assert.rejects(
      attachClaudeDaemonSession({
        controlSock: sockPath,
        short: "badjson1",
        input: "hello",
        initialDrainMs: 0,
        timeoutMs: 1000,
      }),
      /Expected property name|JSON/u,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("findDaemonJobByShort returns a daemon list job by short id", () => {
  const job = findDaemonJobByShort(
    { ok: true, jobs: [{ short: "11111111" }, { short: "22222222", pid: 42 }] },
    "22222222",
  );

  assert.deepEqual(job, { short: "22222222", pid: 42 });
  assert.equal(findDaemonJobByShort({ ok: true, jobs: [] }, "missing"), null);
});

test("resolveDaemonBridgeSessionId reads Claude job state bridge id", async () => {
  const configDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "claude-bridge-session-"),
  );
  const paths = deriveClaudeDaemonPaths({ configDir });
  await fs.mkdir(path.join(paths.jobsDir, "deadbeef"), { recursive: true });
  await fs.writeFile(
    path.join(paths.jobsDir, "deadbeef", "state.json"),
    `${JSON.stringify({ bridgeSessionId: "cse_01NativeBridge" })}\n`,
    "utf8",
  );

  try {
    const bridgeSessionId = await resolveDaemonBridgeSessionId({
      daemonPaths: paths,
      short: "deadbeef",
      job: { short: "deadbeef", pid: 123 },
      timeoutMs: 10,
    });

    assert.equal(bridgeSessionId, "cse_01NativeBridge");
  } finally {
    await fs.rm(configDir, { recursive: true, force: true });
  }
});

test("killDaemonJobBySessionId resolves short then sends kill", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-kill-session-"));
  const sockPath = path.join(dir, "control.sock");
  const seen = [];
  const { server } = await listenJsonServer(sockPath, (request) => {
    seen.push(request);
    if (request.op === "list") {
      return {
        ok: true,
        op: "list",
        jobs: [
          { short: "keep1111", sessionId: "other-session" },
          { short: "kill2222", sessionId: "session-target" },
        ],
      };
    }
    return { ok: true, op: request.op, killed: request.short };
  });

  try {
    const result = await sendKillBySessionId({
      daemonPaths: { controlSock: sockPath },
      sessionId: "session-target",
    });

    assert.equal(result.ok, true);
    assert.equal(result.killed, "kill2222");
    assert.deepEqual(seen, [
      { proto: 1, op: "list" },
      { proto: 1, op: "kill", short: "kill2222" },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
