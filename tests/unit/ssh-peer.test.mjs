import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { it } from "node:test";
import { main } from "../../bin/tfx-peer.mjs";
import { parsePeerArgs } from "../../hub/team/native-peer.mjs";

it("명시 from과 원격 왕복 플래그를 파싱한다", () => {
  assert.deepEqual(
    parsePeerArgs([
      "remote-send",
      "--from",
      "codex:10.30 발신",
      "--host",
      "m5",
      "--reply-host",
      "m2",
      "--to",
      "agy:수신",
      "--message",
      "본문",
    ]),
    {
      from: "codex:10.30 발신",
      host: "m5",
      replyHost: "m2",
      to: "agy:수신",
      message: "본문",
    },
  );
});

it("명시 from은 환경 변수보다 우선하고 로컬 회신에도 쓰인다", async () => {
  let payload;
  await main(
    [
      "send",
      "--from",
      "agy:명시 발신",
      "--to",
      "claude:수신",
      "--message",
      "본문",
    ],
    {
      env: { TFX_LIVE_FROM: "codex:환경" },
      discover: async () => [],
      resolveClaudeRegistryTarget: () => ({ sessionId: "수신" }),
      deliverClaude: (p) => {
        payload = p;
        return { status: "written" };
      },
    },
  );
  assert.match(payload.message, /from=agy:명시 발신/);
  assert.match(payload.message, /--to 'agy:명시 발신'/);
});

it("원격 receiver는 origin을 보존하고 수신 환경으로 발신자를 다시 찾지 않는다", async () => {
  const correlationId = "11111111-2222-4333-8444-555555555555";
  let payload;
  const envelope = {
    version: 1,
    correlationId,
    to: "claude:수신",
    message: "줄1\n$(touch nope); `echo nope` ' 한글",
    originHost: "m2",
    replyHost: "m5",
    sender: {
      cli: "codex",
      name: "원래 발신",
      id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    },
  };
  const result = await main(["_receive"], {
    env: { CLAUDECODE: "1" },
    input: PassThrough.from([JSON.stringify(envelope)]),
    hostsPath: "/not-used",
    resolveRemoteHost: () => ({ os: "darwin" }),
    discover: async () => {
      throw new Error("Claude receiver needs no sender discovery");
    },
    resolveClaudeRegistryTarget: () => ({ sessionId: "수신" }),
    deliverClaude: (p) => {
      payload = p;
      return {
        status: "written",
        msgId: "native-id",
        retrySafe: false,
        modelReceipt: false,
      };
    },
  });
  assert.equal(result.correlationId, correlationId);
  assert.equal(result.result.msgId, "native-id");
  assert.ok(payload.message.includes(envelope.message));
  assert.match(payload.message, /origin=m2/);
  assert.match(
    payload.message,
    /remote-send --host 'm2' --reply-host 'm5' --to 'codex:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'/,
  );
});

it("원격 발신자가 불명확하면 SSH 전에 --from을 요구한다", async () => {
  let calls = 0;
  await assert.rejects(
    main(
      [
        "remote-send",
        "--host",
        "m5",
        "--reply-host",
        "m2",
        "--to",
        "codex:수신",
        "--message",
        "본문",
      ],
      {
        env: {},
        discover: async () => [],
        resolveSenderName: async () => null,
        spawn: () => {
          calls++;
        },
      },
    ),
    /--from/,
  );
  assert.equal(calls, 0);
});

it("self와 로컬에는 원격 플래그를 허용하지 않는다", () => {
  for (const args of [
    ["self", "--session", "s", "--message", "m", "--remote", "m5"],
    ["self", "--session", "s", "--message", "m", "--host", "m5"],
    ["self", "--session", "s", "--message", "m", "--reply-host", "m2"],
    ["self", "--session", "s", "--message", "m", "--from", "claude:s"],
    ["send", "--to", "codex:s", "--message", "m", "--reply-host", "m2"],
    ["send", "--to", "codex:s", "--message", "m", "--remote", "m5"],
  ])
    assert.throws(() => parsePeerArgs(args));
});

it("스킴, 중복 플래그, 제어 문자, 선행 대시를 거부한다", () => {
  const base = ["send", "--to", "codex:수신", "--message", "본문"];
  for (const extra of [
    ["--from", "user:누군가"],
    ["--from", "codex:-option"],
    ["--from", "codex:이름\n본문"],
    ["--from", "codex:이름\u0000"],
    ["--from", "codex:a:b"],
    ["--from", "codex: "],
    ["--from", "codex:정상", "--from", "agy:다름"],
    ["--unknown", "값"],
    ["--to", "claude:다름"],
    ["--remote", "-m5", "--reply-host", "m2"],
    ["--remote", "m5", "--reply-host", "m2\n악성"],
  ])
    assert.throws(() => parsePeerArgs([...base, ...extra]));
});

it("원격 UUID 회신은 같은 표시 이름을 가진 다른 세션보다 실제 UUID를 선택한다", async () => {
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  let target;
  const envelope = {
    version: 1,
    correlationId: "11111111-2222-4333-8444-555555555555",
    to: `codex:${id}`,
    message: "회신",
    originHost: "m2",
    replyHost: "m5",
    sender: { cli: "agy", name: "발신" },
  };
  const result = await main(["_receive"], {
    env: {},
    input: PassThrough.from([JSON.stringify(envelope)]),
    resolveRemoteHost: () => ({ os: "darwin" }),
    discover: async () => [
      {
        cli: "codex",
        name: id,
        threadId: "other",
        raw: { threadSource: "registry" },
      },
      {
        cli: "codex",
        name: "원래 발신",
        aliases: [id],
        threadId: id,
        raw: { threadSource: "registry" },
      },
    ],
    resolveCodexTmuxThread: async () => ({
      threadId: id,
      threadSource: "registry",
    }),
    deliverCodex: (p) => {
      target = p.threadId;
      return { status: "sent" };
    },
  });
  assert.equal(result.result.status, "sent");
  assert.equal(target, id);
});

for (const failure of ["threadSource:null", "stale-thread", "stale-agy"])
  it(`원격 origin으로 ${failure} 수신 경계를 건너뛰지 않는다`, async () => {
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const cli = failure === "stale-agy" ? "agy" : "codex";
    let deliveries = 0;
    const e = {
      version: 1,
      correlationId: "11111111-2222-4333-8444-555555555555",
      to: `${cli}:수신`,
      message: "본문",
      originHost: "m2",
      replyHost: "m5",
      sender: { cli: "claude", name: "발신" },
    };
    const result = await main(["_receive"], {
      env: {},
      input: PassThrough.from([JSON.stringify(e)]),
      resolveRemoteHost: () => ({ os: "darwin" }),
      discover: async () => [
        {
          cli,
          name: "수신",
          threadId: id,
          conversationId: id,
          appDataDir: "/receiver",
          pid: 321,
          raw: {
            threadSource: failure === "threadSource:null" ? null : "registry",
          },
        },
      ],
      resolveCodexTmuxThread: async () => ({
        threadId: "changed",
        threadSource: "registry",
      }),
      resolveAgyConversation: async () => ({
        conversationId: id,
        appDataDir: "/sender-env",
      }),
      deliverCodex: () => {
        deliveries++;
      },
      deliverAgy: () => {
        deliveries++;
      },
    });
    assert.equal(result.result.status, "rejected");
    assert.equal(result.stage, "preflight");
    assert.equal(deliveries, 0);
  });

it("원격에 등록되지 않은 reply alias는 native 전달 전에 거부한다", async () => {
  let deliveries = 0;
  const e = {
    version: 1,
    correlationId: "11111111-2222-4333-8444-555555555555",
    to: "claude:수신",
    message: "본문",
    originHost: "m2",
    replyHost: "m5",
    sender: { cli: "codex", name: "발신" },
  };
  const result = await main(["_receive"], {
    input: PassThrough.from([JSON.stringify(e)]),
    resolveRemoteHost: (alias) => {
      if (alias === "m2") throw new Error("unregistered");
      return { os: "linux" };
    },
    deliverClaude: () => {
      deliveries++;
    },
  });
  assert.equal(result.result.status, "rejected");
  assert.equal(deliveries, 0);
});

it("명시 UUID 발신자는 UUID와 같은 표시 이름 후보로 바뀌지 않는다", async () => {
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  let input;
  const { EventEmitter } = await import("node:events");
  await main(
    [
      "remote-send",
      "--from",
      `codex:${id}`,
      "--host",
      "m5",
      "--reply-host",
      "m2",
      "--to",
      "claude:수신",
      "--message",
      "본문",
    ],
    {
      env: {},
      discover: async () => [
        {
          cli: "codex",
          name: id,
          threadId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
        },
        { cli: "codex", name: "원래 발신", aliases: [id], threadId: id },
      ],
      resolveRemoteHost: () => ({ name: "m5", os: "linux" }),
      spawn: () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        const chunks = [];
        child.stdin.on("data", (c) => chunks.push(c));
        child.stdin.on("finish", () => {
          input = JSON.parse(Buffer.concat(chunks).toString());
          child.stdout.end(
            JSON.stringify({
              version: 1,
              correlationId: input.correlationId,
              stage: "delivery",
              result: { status: "sent", retrySafe: false, modelReceipt: false },
            }),
          );
          child.emit("close", 0);
        });
        return child;
      },
    },
  );
  assert.equal(input.sender.id, id);
  assert.equal(input.sender.name, "원래 발신");
});

it("native Codex 적격성 거부는 기록 전 확정 거부로 구분한다", async () => {
  const { sendCodexPeer } = await import("../../hub/team/native-peer.mjs");
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  let injected = 0;
  const e = {
    version: 1,
    correlationId: "11111111-2222-4333-8444-555555555555",
    to: "codex:수신",
    message: "본문",
    originHost: "m2",
    replyHost: "m5",
    sender: { cli: "claude", name: "발신" },
  };
  const result = await main(["_receive"], {
    input: PassThrough.from([JSON.stringify(e)]),
    resolveRemoteHost: () => ({ os: "darwin" }),
    discover: async () => [
      {
        cli: "codex",
        name: "수신",
        threadId: id,
        raw: { threadSource: "registry" },
      },
    ],
    resolveCodexTmuxThread: async () => ({
      threadId: id,
      threadSource: "registry",
    }),
    deliverCodex: (p) =>
      sendCodexPeer({
        ...p,
        client: {
          request: async (method) => {
            if (method === "thread/loaded/list") return { data: [id] };
            if (method === "thread/read")
              return {
                thread: {
                  id,
                  canAcceptDirectInput: false,
                  threadSource: "user",
                },
              };
            injected++;
          },
        },
      }),
  });
  assert.equal(result.result.status, "rejected");
  assert.equal(result.stage, "preflight");
  assert.equal(injected, 0);
});

it("로컬 send의 원격 플래그는 탐색과 SSH 전에 거부한다", async () => {
  for (const flags of [
    ["--remote", "m5", "--reply-host", "m2"],
    ["--host", "m5", "--reply-host", "m2"],
    ["--reply-host", "m2"],
  ]) {
    let effects = 0;
    await assert.rejects(
      main(["send", "--to", "codex:수신", "--message", "본문", ...flags], {
        env: { TFX_LIVE_FROM: "codex:발신" },
        discover: async () => {
          effects++;
          return [];
        },
        resolveRemoteHost: () => ({ name: "m5", os: "linux" }),
        spawn: () => {
          effects++;
          throw new Error("unexpected SSH");
        },
      }),
      /Invalid peer argument/,
    );
    assert.equal(effects, 0);
  }
});

it("remote-send는 host와 reply-host를 모두 요구한다", () => {
  for (const flags of [
    [],
    ["--host", "m5"],
    ["--reply-host", "m2"],
    ["--remote", "m5", "--reply-host", "m2"],
    ["--host", "-m5", "--reply-host", "m2"],
    ["--host", "m5", "--reply-host", "m2\n"],
    ["--host", "m5", "--host", "m2", "--reply-host", "m2"],
    ["--host", "m5", "--reply-host", "m2", "--reply-host", "m5"],
    ["--host", "m5", "--reply-host", "m2", "--unknown", "value"],
  ])
    assert.throws(() =>
      parsePeerArgs([
        "remote-send",
        "--to",
        "codex:수신",
        "--message",
        "본문",
        ...flags,
      ]),
    );
});
