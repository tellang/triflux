import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { resolveCodexTmuxThread } from "../../bin/tfx-live.mjs";
import { main as peerMain } from "../../bin/tfx-peer.mjs";
import {
  deliverClaude,
  parsePeerArgs,
  resolveClaudeReceiver,
  resolveClaudeRegistryTarget,
  sendCodexPeer,
  validateCodexTarget,
} from "../../hub/team/native-peer.mjs";

it("peer CLI accepts only fixed send contract; shell text is data", () => {
  assert.deepEqual(
    parsePeerArgs([
      "send",
      "--to",
      "codex:target",
      "--message",
      "hi; rm -rf /",
    ]),
    { to: "codex:target", message: "hi; rm -rf /" },
  );
  for (const args of [
    ["ask", "--to", "x"],
    ["send", "--remote", "x"],
    ["send", "--to", "x", "--message", "y", "--sandbox", "off"],
    ["send", "--to", "x"],
  ])
    assert.throws(() => parsePeerArgs(args));
});

for (const cli of ["claude", "codex"]) {
  it(`peer CLI delivers sender header and reply route to ${cli} without truncating 8000 chars`, async () => {
    const body = ` ${"가".repeat(7998)} `;
    let delivered;
    const deliver = (payload) => {
      delivered = payload;
      return { status: "sent" };
    };
    const deps = {
      env: { TFX_LIVE_FROM: "codex:10.16 구현" },
      resolveClaudeRegistryTarget: () => ({ sessionId: "claude-target" }),
      discover: async () => [
        {
          cli: "codex",
          name: "target",
          threadId: "wanted",
          raw: { threadSource: "registry" },
        },
      ],
      resolveCodexTmuxThread: async () => ({
        threadId: "wanted",
        threadSource: "registry",
      }),
      deliverClaude: deliver,
      deliverCodex: deliver,
    };
    await peerMain(["send", "--to", `${cli}:target`, "--message", body], deps);
    assert.match(
      delivered.message,
      /^\[tfx-peer from=codex:10\.16 구현 msg=[^\]\n]+\]\n/,
    );
    assert.equal(delivered.message.split("\n")[1], body);
    if (cli === "codex") assert.equal(delivered.env, deps.env);
    assert.equal(
      delivered.message.split("\n")[2],
      `회신: ${path.join(os.homedir(), ".claude", "scripts", "tfx-peer")} send --to 'codex:10.16 구현' --message '...'`,
    );
    await assert.rejects(
      peerMain(
        ["send", "--to", `${cli}:target`, "--message", `${body}x`],
        deps,
      ),
      /max 8000/,
    );
  });
}

it("Claude-to-Claude peer CLI remains refused before delivery", async () => {
  await assert.rejects(
    peerMain(["send", "--to", "claude:target", "--message", "hello"], {
      env: { CLAUDECODE: "1" },
      discover: async () => [],
    }),
    /native SendMessage/,
  );
});

for (const sessionId of [undefined, "exact-session"]) {
  it(`unnamed Claude header falls back to ${sessionId || "unknown"}`, async () => {
    let message;
    await peerMain(["send", "--to", "codex:target", "--message", "hello"], {
      env: { CLAUDECODE: "1", TMUX_PANE: "%7" },
      discover: async () => [
        { cli: "claude", name: null, paneId: "%7", sessionId },
        {
          cli: "codex",
          name: "target",
          threadId: "wanted",
          raw: { threadSource: "registry" },
        },
      ],
      resolveCodexTmuxThread: async () => ({
        threadId: "wanted",
        threadSource: "registry",
      }),
      deliverCodex: (payload) => {
        message = payload.message;
        return { status: "sent" };
      },
    });
    assert.ok(
      message.startsWith(
        `[tfx-peer from=claude:${sessionId || "unknown"} msg=`,
      ),
    );
  });
}

it("Codex adapter rejects inferred thread identities before delivery", async () => {
  let delivered = false;
  for (const threadSource of [undefined, "rollout-cwd", "process-args"]) {
    await assert.rejects(
      peerMain(["send", "--to", "codex:target", "--message", "hello"], {
        env: { TFX_LIVE_FROM: "codex:fixture" },
        discover: async () => [
          {
            cli: "codex",
            name: "target",
            aliases: ["target"],
            threadId: "wanted",
            raw: { threadSource },
          },
        ],
        deliverCodex: () => {
          delivered = true;
        },
      }),
      /exact thread provenance/,
    );
  }
  assert.equal(delivered, false);
  const result = await peerMain(
    ["send", "--to", "codex:target", "--message", "hello"],
    {
      env: { TFX_LIVE_FROM: "codex:fixture" },
      discover: async () => [
        {
          cli: "codex",
          name: "target",
          aliases: ["target"],
          threadId: "wanted",
          raw: { threadSource: "tmux-option" },
        },
      ],
      resolveCodexTmuxThread: async () => ({
        threadId: "wanted",
        threadSource: "tmux-option",
      }),
      deliverCodex: () => ({ status: "sent" }),
    },
  );
  assert.equal(result.status, "sent");
});

it("current pane option changing to an unloaded thread blocks old loaded registry target", async () => {
  let deliveries = 0;
  await assert.rejects(
    peerMain(["send", "--to", "codex:target", "--message", "hello"], {
      env: { TFX_LIVE_FROM: "codex:fixture" },
      discover: async () => [
        {
          cli: "codex",
          name: "target",
          aliases: ["target"],
          target: "pane",
          threadId: "old-loaded",
          raw: { threadSource: "registry" },
        },
      ],
      resolveCodexTmuxThread: async () => ({
        threadId: "new-unloaded",
        threadSource: "tmux-option",
      }),
      deliverCodex: () => {
        deliveries++;
      },
    }),
    /pane thread changed/,
  );
  assert.equal(deliveries, 0);
});

it("registry resolver selects newest same-pane record and refuses timestamp ties", async () => {
  const old = "11111111-1111-4111-8111-111111111111";
  const recent = "22222222-2222-4222-8222-222222222222";
  const records = [
    { tmuxPane: "%7", sessionId: old, updatedAt: 10 },
    { tmuxPane: "%7", sessionId: recent, updatedAt: 20 },
  ];
  const deps = {
    runTmux: async () => ({ stdout: "\t%7\t/tmp\t1\t123" }),
    readCodexSessionRecords: () => records,
  };
  assert.equal((await resolveCodexTmuxThread("pane", deps)).threadId, recent);
  const withOption = {
    ...deps,
    runTmux: async () => ({ stdout: `${old}\t%7\t/tmp\t1\t123` }),
    requireRegistryAgreement: true,
  };
  assert.equal(
    (await resolveCodexTmuxThread("pane", withOption)).reason,
    "pane-thread-conflict",
  );
  records[0].updatedAt = 20;
  assert.equal((await resolveCodexTmuxThread("pane", deps)).threadId, null);
  delete records[0].updatedAt;
  delete records[1].updatedAt;
  assert.equal(
    (await resolveCodexTmuxThread("pane", deps)).reason,
    "registry-ambiguous",
  );
});

it("Codex unloaded or subagent target is rejected before injection", async () => {
  for (const loaded of [[], ["other"]]) {
    const calls = [];
    const client = {
      request: async (method) => {
        calls.push(method);
        return method === "thread/loaded/list"
          ? { data: loaded, nextCursor: null }
          : {
              thread: {
                id: "wanted",
                canAcceptDirectInput: true,
                threadSource: "user",
              },
            };
      },
    };
    await assert.rejects(
      sendCodexPeer({ client, threadId: "wanted", message: "hello" }),
      /공유 데몬에 붙어 있지 않다.*tfx-live start --cli codex/,
    );
    assert.ok(!calls.includes("thread/inject_items"));
    assert.ok(!calls.includes("thread/resume"));
  }
  assert.throws(() =>
    validateCodexTarget(
      { id: "wanted", canAcceptDirectInput: false, threadSource: "user" },
      "wanted",
    ),
  );
  assert.throws(() =>
    validateCodexTarget(
      { id: "wanted", canAcceptDirectInput: true, threadSource: "subagent" },
      "wanted",
    ),
  );
});

it("wake failure is partial, never reinjects", async () => {
  const calls = [];
  const client = {
    request: async (method) => {
      calls.push(method);
      if (method === "thread/loaded/list")
        return { data: ["wanted"], nextCursor: null };
      if (method === "thread/read")
        return {
          thread: {
            id: "wanted",
            canAcceptDirectInput: true,
            threadSource: "user",
          },
        };
      if (method === "turn/start") throw new Error("wake denied");
      return {};
    },
  };
  const result = await sendCodexPeer({
    client,
    threadId: "wanted",
    message: "hello",
  });
  assert.equal(result.status, "partial");
  assert.equal(result.retrySafe, false);
  assert.equal(calls.filter((x) => x === "thread/inject_items").length, 1);
  assert.equal(calls.filter((x) => x === "turn/start").length, 1);
});

it("Claude receiver links exact session, process start, private key and socket", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tfx-peer-claude-"));
  const dir = path.join(home, ".claude", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const socketPath = path.join(home, "123.sock");
  const server = net.createServer();
  await new Promise((r) => server.listen(socketPath, r));
  fs.chmodSync(socketPath, 0o600);
  const record = {
    pid: 123,
    pidDomain: process.platform,
    sessionId: "exact",
    procStart: "Fri Oct 16 02:23:26 2026",
    messagingSocketPath: socketPath,
  };
  try {
    fs.writeFileSync(path.join(dir, "123.json"), JSON.stringify(record), {
      mode: 0o644,
    });
    fs.writeFileSync(
      path.join(dir, "123.x.key"),
      JSON.stringify({
        peerToken: "secret",
        procStart: record.procStart,
        pidDomain: process.platform,
      }),
      { mode: 0o600 },
    );
    const lookup = () =>
      resolveClaudeReceiver({
        sessionId: "exact",
        home,
        getProcStart: () => record.procStart,
      });
    assert.equal(lookup().peerToken, "secret");
    assert.equal(
      resolveClaudeRegistryTarget("exact", {
        home,
        getProcStart: () => record.procStart,
      }).sessionId,
      "exact",
    );
    fs.chmodSync(path.join(dir, "123.json"), 0o666);
    assert.throws(lookup);
    fs.chmodSync(path.join(dir, "123.json"), 0o644);
    assert.throws(() =>
      resolveClaudeReceiver({
        sessionId: "exact",
        home,
        getProcStart: () => "different",
      }),
    );
    fs.unlinkSync(path.join(dir, "123.x.key"));
    fs.symlinkSync("/dev/null", path.join(dir, "123.x.key"));
    assert.throws(lookup);
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
it("Codex success paginates loaded list, never resumes, injects once and wakes once", async () => {
  const calls = [];
  const client = {
    request: async (method, params) => {
      calls.push([method, params]);
      if (method === "thread/loaded/list")
        return params.cursor
          ? { data: ["wanted"], nextCursor: null }
          : { data: ["other"], nextCursor: "next" };
      if (method === "thread/read")
        return {
          thread: {
            id: "wanted",
            canAcceptDirectInput: true,
            threadSource: "user",
          },
        };
      return {};
    },
  };
  const r = await sendCodexPeer({
    client,
    threadId: "wanted",
    message: "hello",
  });
  assert.equal(r.status, "sent");
  assert.equal(r.modelReceipt, false);
  assert.deepEqual(
    calls.map((x) => x[0]),
    [
      "thread/loaded/list",
      "thread/loaded/list",
      "thread/read",
      "thread/inject_items",
      "turn/start",
    ],
  );
  assert.equal(calls[3][1].items[0].type, "agent_message");
  assert.deepEqual(calls[4][1].input, []);
});
it("npm-style symlink CLI entrypoint executes and rejects unknown subcommand", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tfx-peer-bin-"));
  try {
    const link = path.join(temp, "tfx-peer");
    fs.symlinkSync(path.resolve("bin/tfx-peer.mjs"), link);
    const p = spawnSync(process.execPath, [link, "ask"], { encoding: "utf8" });
    assert.equal(p.status, 1);
    assert.match(p.stderr, /Only send is supported/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
it("injection timeout has unknown outcome and no wake or reinjection", async () => {
  const calls = [];
  const client = {
    request: async (method) => {
      calls.push(method);
      if (method === "thread/loaded/list") return { data: ["wanted"] };
      if (method === "thread/read")
        return {
          thread: {
            id: "wanted",
            canAcceptDirectInput: true,
            threadSource: "user",
          },
        };
      if (method === "thread/inject_items") throw new Error("timeout");
      return {};
    },
  };
  const result = await sendCodexPeer({
    client,
    threadId: "wanted",
    message: "hello",
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.retrySafe, false);
  assert.equal(calls.filter((x) => x === "thread/inject_items").length, 1);
  assert.ok(!calls.includes("turn/start"));
});
it("parked Claude parent is never delivered to; live background continuation wins by jobId", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tfx-peer-continuation-"));
  const dir = path.join(home, ".claude", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const servers = [];
  const add = async (pid, sessionId, extra = {}) => {
    const sock = path.join(home, `${pid}.sock`);
    const server = net.createServer();
    await new Promise((r) => server.listen(sock, r));
    servers.push(server);
    fs.chmodSync(sock, 0o600);
    const record = {
      pid,
      sessionId,
      name: "lead",
      procStart: "Fri Oct 16 02:23:26 2026",
      pidDomain: process.platform,
      messagingSocketPath: sock,
      ...extra,
    };
    fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify(record), {
      mode: 0o644,
    });
    fs.writeFileSync(
      path.join(dir, `${pid}.key`),
      JSON.stringify({
        peerToken: "secret",
        procStart: record.procStart,
        pidDomain: record.pidDomain,
      }),
      { mode: 0o600 },
    );
  };
  const resolve = (query) =>
    resolveClaudeRegistryTarget(query, {
      home,
      getProcStart: () => "Fri Oct 16 02:23:26 2026",
    });
  try {
    await add(123, "old", { parkedJobId: "job-1" });
    await add(124, "new", { kind: "bg", jobId: "job-1" });
    assert.equal(resolve("lead").sessionId, "new");
    assert.throws(() => resolve("old"), /parked parent/);
    await add(125, "other", { kind: "bg", jobId: "job-1" });
    assert.throws(() => resolve("lead"), /Ambiguous live/);
    fs.unlinkSync(path.join(dir, "124.json"));
    fs.unlinkSync(path.join(dir, "125.json"));
    assert.throws(() => resolve("lead"), /No live Claude continuation/);
  } finally {
    for (const server of servers) server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
it("one-shot Claude sender closes inbound native reply sockets instead of hanging", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfx-peer-reply-"));
  const receiverPath = path.join(dir, "receiver.sock");
  let replyClosed;
  const receiver = net.createServer((socket) => {
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
    });
    socket.on("end", () => {
      const lines = data.trim().split("\n");
      const frame = JSON.parse(lines[1]);
      const senderPath = frame.from.slice(4);
      const reply = net.connect(senderPath);
      reply.on("connect", () => reply.write("reply\n"));
      replyClosed = new Promise((resolve) => reply.on("close", resolve));
      reply.on("error", () => {});
      socket.end();
    });
  });
  await new Promise((resolve) => receiver.listen(receiverPath, resolve));
  try {
    const result = await deliverClaude({
      sessionId: "fixture",
      message: "hello",
      receiver: { socketPath: receiverPath, peerToken: "token" },
      socketDir: dir,
      holdMs: 100,
    });
    assert.equal(result.status, "written");
    assert.ok(replyClosed);
    await Promise.race([
      replyClosed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("reply socket remained open")), 1000),
      ),
    ]);
    assert.equal(fs.existsSync(path.join(dir, `${process.pid}.sock`)), false);
  } finally {
    receiver.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("tmux-identified Claude sender cannot send to Claude and discovery runs once", async () => {
  let discoveries = 0;
  await assert.rejects(
    peerMain(["send", "--to", "claude:target", "--message", "hello"], {
      env: { TMUX_PANE: "%7" },
      discover: async () => {
        discoveries++;
        return [
          { cli: "claude", name: "sender", paneId: "%7", sessionId: "exact" },
        ];
      },
    }),
    /native SendMessage/,
  );
  assert.equal(discoveries, 1);
});

it("unknown sender gets no guessed reply command", async () => {
  let delivered;
  await peerMain(["send", "--to", "claude:target", "--message", "hello"], {
    env: {},
    discover: async () => [],
    resolveSenderName: async () => null,
    resolveClaudeRegistryTarget: () => ({ sessionId: "target" }),
    deliverClaude: (payload) => {
      delivered = payload.message;
      return { status: "written" };
    },
  });
  assert.equal(
    delivered.split("\n").at(-1),
    "회신: 경로 불명(보낸 세션을 판별하지 못함)",
  );
});
