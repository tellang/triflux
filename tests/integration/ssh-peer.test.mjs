import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { it } from "node:test";
import { main } from "../../bin/tfx-peer.mjs";
import {
  PEER_RECEIVER_COMMAND,
  PEER_WIRE_LIMIT,
  readPeerInput,
  resolveRemoteHost,
  sendRemotePeer,
  validatePeerEnvelope,
} from "../../hub/team/ssh-peer.mjs";

const senderId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const receiverId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const envelope = () => ({
  version: 1,
  correlationId: "11111111-2222-4333-8444-555555555555",
  to: "codex:수신",
  message: "본문",
  originHost: "m2",
  replyHost: "m5",
  sender: { cli: "claude", name: "발신 이름", id: senderId },
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-peer-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hostsPath = path.join(dir, "hosts.json");
  fs.writeFileSync(
    hostsPath,
    JSON.stringify({
      hosts: {
        m2: { os: "darwin", ssh: { host: "m2.test", user: "fixture" } },
        m5: {
          os: "linux",
          aliases: ["five"],
          ssh: { host: "m5.test", user: "fixture", port: 2222 },
        },
      },
    }),
  );
  return { dir, hostsPath };
}

// 테스트 전용 SSH stub으로 실제 SSH, tmux, daemon 호출을 막는다.
function sshStub(
  t,
  mode = "deliver",
  targetCli = "codex",
  targetId = receiverId,
  localHost = "m2",
) {
  const f = fixture(t);
  const registered = JSON.parse(fs.readFileSync(f.hostsPath, "utf8")).hosts;
  const destination = localHost === "m2" ? "m5" : "m2";
  fs.writeFileSync(
    f.hostsPath,
    JSON.stringify({ hosts: { [destination]: registered[destination] } }),
  );
  const remoteHostsPath = path.join(f.dir, "remote-hosts.json");
  fs.writeFileSync(
    remoteHostsPath,
    JSON.stringify({ hosts: { [localHost]: registered[localHost] } }),
  );
  const script = path.join(f.dir, "ssh-stub.mjs");
  const log = path.join(f.dir, "wire.jsonl");
  const entry = new URL("../../bin/tfx-peer.mjs", import.meta.url).href;
  fs.writeFileSync(
    script,
    `
import fs from 'node:fs';
import { main } from ${JSON.stringify(entry)};
const chunks=[]; for await(const chunk of process.stdin) chunks.push(chunk);
const input=Buffer.concat(chunks).toString('utf8');
const envelope=JSON.parse(input);
fs.appendFileSync(process.env.PEER_TEST_LOG, JSON.stringify({args:process.argv.slice(2),envelope})+'\\n');
const mode=process.env.PEER_TEST_MODE;
if(mode==='timeout'){setTimeout(()=>{}, 60000);}
else if(mode==='empty'){process.exitCode=255;}
else if(mode==='garbage'){console.log('old peer usage');process.exitCode=1;}
else if(mode==='large'){console.log('x'.repeat(70000));}
else if(mode==='wrong-version'){console.log(JSON.stringify({version:0,correlationId:envelope.correlationId}));}
else if(mode==='wrong-id'){console.log(JSON.stringify({version:1,correlationId:'other'}));}
else if(mode==='early-close'){process.exitCode=255;}
else if(mode==='wrong-status'){console.log(JSON.stringify({version:1,correlationId:envelope.correlationId,stage:'delivery',result:{status:'sent',retrySafe:true,modelReceipt:true}}));}
else {
  const deliver=(payload)=>{
    payload.onWriteStart?.();
    fs.appendFileSync(process.env.PEER_TEST_LOG, JSON.stringify({payload})+'\\n');
    if(mode==='throw')throw new Error('write outcome unclear');
    return {status:mode==='partial'?'partial':'written',msgId:'adapter-id',retrySafe:false,modelReceipt:false};
  };
  const result=await main(['_receive'],{
    hostsPath:process.env.TFX_HOSTS_USER_STATE,
    input:(await import('node:stream')).Readable.from([input]),
    env:{CLAUDECODE:'1',CODEX_THREAD_ID:'receiver-only'},
    discover:async()=>[{cli:process.env.PEER_TEST_CLI,name:'수신',aliases:['수신',${JSON.stringify(targetId)}],threadId:${JSON.stringify(targetId)},conversationId:${JSON.stringify(targetId)},appDataDir:'/receiver/app',pid:321,raw:{threadSource:'registry'}}],
    resolveClaudeRegistryTarget:()=>({sessionId:${JSON.stringify(targetId)},receiver:{socketPath:'/receiver/321.sock'}}),
    resolveCodexTmuxThread:async()=>({threadId:${JSON.stringify(targetId)},threadSource:'registry'}),
    resolveAgyConversation:async()=>({conversationId:${JSON.stringify(targetId)},appDataDir:'/receiver/app'}),
    deliverClaude:deliver,deliverCodex:deliver,deliverAgy:deliver,
  });
  if(mode!=='lost'){ console.log(JSON.stringify(result));process.exitCode=result.result.status==='rejected'?1:['partial','unknown'].includes(result.result.status)?2:0; }
  else process.exitCode=255;
  if(mode==='exit-mismatch')process.exitCode=255;
}
`,
  );
  let sends = 0;
  const spawnStub = (command, args, options) => {
    sends++;
    assert.equal(command, "ssh");
    assert.equal(options.shell, false);
    return spawn(process.execPath, [script, ...args], {
      ...options,
      env: {
        PATH: process.env.PATH,
        HOME: f.dir,
        CODEX_HOME: path.join(f.dir, "codex"),
        XDG_CONFIG_HOME: path.join(f.dir, "config"),
        TFX_HOSTS_USER_STATE: remoteHostsPath,
        PEER_TEST_LOG: log,
        PEER_TEST_MODE: mode,
        PEER_TEST_CLI: targetCli,
      },
    });
  };
  return {
    ...f,
    remoteHostsPath,
    spawn: spawnStub,
    logs: () =>
      fs.existsSync(log)
        ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse)
        : [],
    sends: () => sends,
  };
}

for (const cli of ["claude", "codex", "agy"])
  it(`비대칭 registry의 SSH stub으로 ${cli} origin과 본문을 보존하고 역방향 회신을 실행한다`, async (t) => {
    const f = sshStub(t, "deliver", cli);
    assert.deepEqual(
      Object.keys(JSON.parse(fs.readFileSync(f.hostsPath, "utf8")).hosts),
      ["m5"],
    );
    assert.deepEqual(
      Object.keys(JSON.parse(fs.readFileSync(f.remoteHostsPath, "utf8")).hosts),
      ["m2"],
    );
    const body =
      ' 日本語 한글 O\'Reilly "quote"\n$(touch /tmp/peer-bad); `touch /tmp/peer-bad2`\n마지막';
    const run = (args, env, discover) => main(args, { ...f, env, discover });
    const result = await run(
      [
        "remote-send",
        "--host",
        "m5",
        "--reply-host",
        "m2",
        "--to",
        `${cli}:수신`,
        "--message",
        body,
      ],
      { CODEX_THREAD_ID: senderId },
      async () => [
        { cli: "codex", name: "10.30 O'Reilly 한글", threadId: senderId },
      ],
    );
    assert.equal(result.status, "written");
    assert.equal(result.msgId, "adapter-id");
    assert.equal(result.retrySafe, false);
    assert.equal(result.modelReceipt, false);
    const [wire, native] = f.logs();
    assert.equal(wire.args.at(-1), PEER_RECEIVER_COMMAND);
    assert.equal(wire.args.at(-2), "fixture@m5.test");
    assert.equal(wire.args.includes(body), false);
    assert.equal(wire.envelope.message, body);
    assert.equal(wire.envelope.sender.id, senderId);
    assert.equal(wire.envelope.sender.name, "10.30 O'Reilly 한글");
    assert.equal(wire.envelope.correlationId, result.correlationId);
    assert.ok(native.payload.message.includes(body));
    assert.match(native.payload.message, /origin=m2/);
    if (cli === "agy") assert.equal(native.payload.appDataDir, "/receiver/app");
    const command = native.payload.message
      .split("\n")
      .at(-1)
      .slice("회신: ".length);
    // 고정 명령을 stub으로 바꿔 안내의 셸 인용과 공개 인자를 실행한다.
    const argvFile = path.join(f.dir, "args.mjs");
    fs.writeFileSync(
      argvFile,
      "console.log(JSON.stringify(process.argv.slice(2)))",
    );
    const { execFileSync } = await import("node:child_process");
    const start = command.indexOf(" remote-send ");
    const argv = JSON.parse(
      execFileSync(
        "/bin/sh",
        ["-c", `'${process.execPath}' '${argvFile}'${command.slice(start)}`],
        { env: { PATH: process.env.PATH, HOME: f.dir }, encoding: "utf8" },
      ),
    );
    assert.deepEqual(argv.slice(0, 7), [
      "remote-send",
      "--host",
      "m2",
      "--reply-host",
      "m5",
      "--to",
      `codex:${senderId}`,
    ]);
    // receiver fixture의 정확한 UUID로 회신한다.
    const replyFixture = sshStub(t, "deliver", "codex", senderId, "m5");
    assert.deepEqual(
      Object.keys(
        JSON.parse(fs.readFileSync(replyFixture.hostsPath, "utf8")).hosts,
      ),
      ["m2"],
    );
    assert.deepEqual(
      Object.keys(
        JSON.parse(fs.readFileSync(replyFixture.remoteHostsPath, "utf8")).hosts,
      ),
      ["m5"],
    );
    const originalId = argv[6];
    const reply = await main(argv, {
      ...replyFixture,
      env: { TFX_LIVE_FROM: `${cli}:회신자` },
      discover: async () => [],
    });
    assert.equal(originalId, `codex:${senderId}`);
    assert.equal(reply.status, "written");
    assert.equal(replyFixture.logs()[0].args.at(-2), "fixture@m2.test");
    assert.match(replyFixture.logs()[1].payload.message, /origin=m5/);
  });

for (const mode of [
  "lost",
  "empty",
  "garbage",
  "large",
  "wrong-version",
  "wrong-id",
  "wrong-status",
  "exit-mismatch",
  "early-close",
  "partial",
  "throw",
  "timeout",
])
  it(`SSH ${mode}에서 한 번만 전송하고 ID와 재송신 금지를 유지한다`, async (t) => {
    const f = sshStub(t, mode);
    const e = envelope();
    const result = await sendRemotePeer(e, {
      ...f,
      timeoutMs: mode === "timeout" ? 300 : 3000,
    });
    assert.equal(f.sends(), 1);
    assert.equal(result.status, mode === "partial" ? "partial" : "unknown");
    assert.equal(result.correlationId, e.correlationId);
    assert.equal(result.retrySafe, false);
    assert.equal(result.modelReceipt, false);
    if (mode === "partial" || mode === "exit-mismatch")
      assert.equal(result.msgId, "adapter-id");
  });

it("user-state만 읽고 등록 오류는 파일 쓰기와 SSH 전에 거부한다", async (t) => {
  const f = fixture(t);
  assert.equal(resolveRemoteHost("five", f).name, "m5");
  const original = fs.readFileSync(f.hostsPath, "utf8");
  for (const alias of ["unknown", "-m5", "m5\n", "fixture@m5.test", "m5.test"])
    assert.throws(() => resolveRemoteHost(alias, f));
  assert.throws(() =>
    resolveRemoteHost("m5", {
      hostsPath: path.join(f.dir, "absent", "hosts.json"),
    }),
  );
  assert.equal(fs.existsSync(path.join(f.dir, "absent")), false);
  let sends = 0;
  await assert.rejects(
    sendRemotePeer(
      { ...envelope(), replyHost: "missing" },
      {
        ...f,
        spawn: () => {
          sends++;
        },
      },
    ),
  );
  for (const host of [
    { os: "windows" },
    { os: "unknown" },
    { os: "linux", ssh: { host: "-evil" } },
    { os: "linux", ssh: { host: "m5.test", user: "-evil" } },
    { os: "linux", ssh: { host: "m5.test", user: "a\nother" } },
    { os: "linux", ssh: { host: "m5.test", port: "22;evil" } },
  ]) {
    fs.writeFileSync(
      f.hostsPath,
      JSON.stringify({ hosts: { m2: { os: "darwin" }, m5: host } }),
    );
    await assert.rejects(
      sendRemotePeer(envelope(), {
        ...f,
        spawn: () => {
          sends++;
        },
      }),
    );
  }
  assert.equal(sends, 0);
  fs.writeFileSync(f.hostsPath, original);
});

it("receiver의 사전 거부와 기록 후 불명을 구분한다", async (t) => {
  const f = fixture(t);
  const e = envelope();
  const result = await main(["_receive"], {
    ...f,
    input: PassThrough.from([JSON.stringify(e)]),
    discover: async () => [],
  });
  assert.equal(result.stage, "preflight");
  assert.equal(result.result.status, "rejected");
  const f2 = sshStub(t);
  const result2 = await sendRemotePeer({ ...e, to: "codex:absent" }, f2);
  assert.equal(result2.status, "rejected");
  assert.equal(result2.correlationId, e.correlationId);
});

it("잘못된 envelope는 native 호출 전에 거부한다", async () => {
  for (const patch of [
    { version: 0 },
    { correlationId: "wrong" },
    { originHost: "-evil" },
    { replyHost: "m5\n" },
    { sender: { cli: "user", name: "spoof" } },
    { sender: { cli: "codex", name: "a\n" } },
    { sender: { cli: "codex", name: null } },
    { sender: { cli: "codex", name: "ok", id: "not-uuid" } },
    { message: "x".repeat(8001) },
    { command: "evil" },
    { to: "codex:-option" },
  ])
    assert.throws(() => validatePeerEnvelope({ ...envelope(), ...patch }));
  await assert.rejects(
    readPeerInput(PassThrough.from(["x".repeat(PEER_WIRE_LIMIT + 1)])),
    /too large/,
  );
  await assert.rejects(readPeerInput(PassThrough.from(["not JSON"])));
});

it("Windows 신규 조합을 전송 전에 거부한다", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    sendRemotePeer(envelope(), { ...f, platform: "win32" }),
    /Darwin/,
  );
  const result = await main(["_receive"], {
    ...f,
    platform: "win32",
    input: PassThrough.from([JSON.stringify(envelope())]),
  });
  assert.equal(result.result.status, "rejected");
});

it("회신 호스트의 잘못된 사용자명도 native 기록 전에 거부한다", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    f.hostsPath,
    JSON.stringify({
      hosts: {
        m2: { os: "darwin", ssh: { host: "m2.test", user: "-evil" } },
        m5: { os: "linux" },
      },
    }),
  );
  let writes = 0;
  const result = await main(["_receive"], {
    ...f,
    input: PassThrough.from([
      JSON.stringify({ ...envelope(), to: "claude:수신" }),
    ]),
    resolveClaudeRegistryTarget: () => ({ sessionId: receiverId }),
    deliverClaude: () => {
      writes++;
      return { status: "written" };
    },
  });
  assert.equal(result.result.status, "rejected");
  assert.equal(writes, 0);
});

it("UUID가 없는 이름 회신도 따옴표와 셸 코드를 데이터로 보존한다", async (t) => {
  const f = sshStub(t, "deliver", "claude");
  const sentinel = path.join(f.dir, "must-not-exist");
  const name = `10.30 O'Reilly 한글 $(touch ${sentinel}); \`touch ${sentinel}\``;
  await main(
    [
      "remote-send",
      "--from",
      `codex:${name}`,
      "--host",
      "m5",
      "--reply-host",
      "m2",
      "--to",
      "claude:수신",
      "--message",
      "본문\n다음 줄",
    ],
    { ...f, env: {}, discover: async () => [] },
  );
  const command = f
    .logs()[1]
    .payload.message.split("\n")
    .at(-1)
    .slice("회신: ".length);
  const argsFile = path.join(f.dir, "quote-args.mjs");
  fs.writeFileSync(
    argsFile,
    "console.log(JSON.stringify(process.argv.slice(2)))",
  );
  const { execFileSync } = await import("node:child_process");
  const argv = JSON.parse(
    execFileSync(
      "/bin/sh",
      [
        "-c",
        `'${process.execPath}' '${argsFile}'${command.slice(command.indexOf(" remote-send "))}`,
      ],
      { env: { HOME: f.dir, PATH: process.env.PATH }, encoding: "utf8" },
    ),
  );
  assert.equal(argv[6], `codex:${name}`);
  assert.equal(fs.existsSync(sentinel), false);
  assert.equal(f.logs()[0].envelope.sender.id, undefined);
});

it("수신 registry에 자기 항목이 없어도 실제 회신 상대만 있으면 전달한다", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    f.hostsPath,
    JSON.stringify({
      hosts: {
        m2: { os: "darwin", ssh: { host: "m2.test", user: "fixture" } },
      },
    }),
  );
  let writes = 0;
  const result = await main(["_receive"], {
    ...f,
    input: PassThrough.from([
      JSON.stringify({ ...envelope(), to: "claude:수신" }),
    ]),
    resolveClaudeRegistryTarget: () => ({ sessionId: receiverId }),
    deliverClaude: () => {
      writes++;
      return { status: "written" };
    },
  });
  assert.equal(result.result.status, "written");
  assert.equal(writes, 1);
});

it("실제 회신 상대가 수신 registry에 없으면 native 전달 전에 거부한다", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.hostsPath, JSON.stringify({ hosts: {} }));
  let writes = 0;
  const result = await main(["_receive"], {
    ...f,
    input: PassThrough.from([
      JSON.stringify({ ...envelope(), to: "claude:수신" }),
    ]),
    resolveClaudeRegistryTarget: () => ({ sessionId: receiverId }),
    deliverClaude: () => {
      writes++;
      return { status: "written" };
    },
  });
  assert.equal(result.result.status, "rejected");
  assert.equal(result.stage, "preflight");
  assert.equal(writes, 0);
});

it("등록 OS 값은 대소문자만 정규화하고 미상과 Windows는 거부한다", async (t) => {
  const f = fixture(t);
  for (const osValue of [
    "Darwin",
    "macOS",
    "Linux",
    "darwin",
    "macos",
    "linux",
  ]) {
    fs.writeFileSync(
      f.hostsPath,
      JSON.stringify({
        hosts: {
          m5: { os: osValue, ssh: { host: "m5.test", user: "fixture" } },
        },
      }),
    );
    const host = resolveRemoteHost("m5", f);
    assert.equal(
      host.os,
      osValue.toLowerCase() === "linux" ? "linux" : "darwin",
    );
    assert.equal(host.ssh.host, "m5.test");
  }
  for (const osValue of [
    "Windows",
    "unknown",
    "",
    null,
    undefined,
    " Linux ",
  ]) {
    fs.writeFileSync(
      f.hostsPath,
      JSON.stringify({ hosts: { m5: { os: osValue } } }),
    );
    assert.throws(() => resolveRemoteHost("m5", f), /Darwin/);
  }
});
