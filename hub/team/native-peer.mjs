import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { JsonRpcWsUdsClient } from "../workers/lib/jsonrpc-ws-uds.mjs";

const WAKE =
  "A peer agent_message was delivered immediately before this tool output. Read it and respond within this session.";

export function parsePeerArgs(args) {
  if (args[0] !== "send") throw new Error("Only send is supported");
  const parsed = {};
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i],
      value = args[i + 1];
    if (!["--to", "--message"].includes(flag) || !value || parsed[flag])
      throw new Error(`Invalid peer argument: ${flag}`);
    parsed[flag] = value;
  }
  if (
    !parsed["--to"] ||
    !parsed["--message"] ||
    parsed["--message"].length > 8000
  )
    throw new Error("send requires --to and --message (max 8000 chars)");
  if (!/^(claude|codex):[^:]+$/.test(parsed["--to"]))
    throw new Error("Use exact claude:NAME or codex:NAME target");
  return { to: parsed["--to"], message: parsed["--message"] };
}

export function validateCodexTarget(thread, id) {
  if (
    thread?.id !== id ||
    thread.canAcceptDirectInput !== true ||
    thread.threadSource !== "user" ||
    thread.parentThreadId ||
    thread.agentRole
  )
    throw new Error("Codex thread is not an eligible loaded root user thread");
}

export async function sendCodexPeer({ client, threadId, message }) {
  let cursor;
  let loaded = false;
  do {
    const page = await client.request(
      "thread/loaded/list",
      cursor ? { cursor } : {},
    );
    loaded ||= (page.data || []).some(
      (entry) => entry === threadId || entry?.id === threadId,
    );
    cursor = page.nextCursor;
  } while (!loaded && cursor);
  if (!loaded)
    throw new Error(
      "Codex target is not loaded in this app-server; start TUI with --remote unix://...",
    );
  const read = await client.request("thread/read", {
    threadId,
    includeTurns: false,
  });
  validateCodexTarget(read.thread, threadId);
  try {
    await client.request("thread/inject_items", {
      threadId,
      items: [
        {
          type: "agent_message",
          author: "/tfx-peer",
          recipient: "/root",
          content: [{ type: "input_text", text: message }],
        },
      ],
    });
  } catch (error) {
    return {
      status: "unknown",
      retrySafe: false,
      modelReceipt: false,
      error: `injection outcome unknown: ${error.message}`,
    };
  }
  try {
    await client.request("turn/start", {
      threadId,
      input: [],
      toolOutput: { name: "tfx_peer_wake", output: WAKE, retain: true },
    });
    return { status: "sent", retrySafe: false, modelReceipt: false };
  } catch (error) {
    return {
      status: "partial",
      retrySafe: false,
      modelReceipt: false,
      error: `wake failed after injection: ${error.message}`,
    };
  }
}

export function assertPrivateFile(
  file,
  kind,
  { socket = false, privateMode = true } = {},
) {
  const meta = fs.lstatSync(file);
  if (
    meta.isSymbolicLink() ||
    meta.uid !== process.getuid() ||
    (socket ? !meta.isSocket() : !meta.isFile()) ||
    (meta.mode & 0o022) !== 0 ||
    (privateMode && (meta.mode & 0o077) !== 0)
  )
    throw new Error(`Unsafe ${kind}`);
  return meta;
}

export function resolveCodexSocket(home = os.homedir()) {
  const link = path.join(
    home,
    ".codex",
    "app-server-control",
    "app-server-control.sock",
  );
  const resolved = fs.realpathSync(link);
  assertPrivateFile(resolved, "Codex app-server socket", { socket: true });
  return resolved;
}

export async function deliverCodex({
  threadId,
  message,
  home = os.homedir(),
  clientFactory = (socketPath) => new JsonRpcWsUdsClient({ socketPath }),
}) {
  const client = clientFactory(resolveCodexSocket(home));
  try {
    await client.connect();
    await client.request("initialize", {
      clientInfo: { name: "triflux-peer", version: "1" },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized", {});
    return await sendCodexPeer({ client, threadId, message });
  } finally {
    client.close();
  }
}

function actualProcStart(pid) {
  return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    timeout: 2000,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  })
    .trim()
    .replace(/\s+/g, " ");
}

export function resolveClaudeReceiver({
  sessionId,
  home = os.homedir(),
  getProcStart = actualProcStart,
}) {
  const dir = path.join(home, ".claude", "sessions");
  const records = fs.readdirSync(dir).filter((x) => /^\d+\.json$/.test(x));
  const matches = [];
  for (const name of records) {
    const file = path.join(dir, name);
    let record;
    try {
      assertPrivateFile(file, "Claude session", { privateMode: false });
      record = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (record.sessionId === sessionId && `${record.pid}.json` === name)
      matches.push(record);
  }
  if (matches.length !== 1)
    throw new Error("Claude session identity missing or ambiguous");
  const record = matches[0];
  if (record.parkedJobId)
    throw new Error(
      "Claude session is a parked parent; use its live continuation name",
    );
  const pid = Number(record.pid);
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    record.pidDomain !== process.platform ||
    record.procStart?.replace(/\s+/g, " ") !== getProcStart(pid)
  )
    throw new Error("Claude process identity stale");
  const keyFiles = fs
    .readdirSync(dir)
    .filter((x) => x.startsWith(`${pid}.`) && x.endsWith(".key"));
  if (keyFiles.length !== 1)
    throw new Error("Claude peer key missing or ambiguous");
  const keyFile = path.join(dir, keyFiles[0]);
  assertPrivateFile(keyFile, "Claude peer key");
  const key = JSON.parse(fs.readFileSync(keyFile, "utf8"));
  if (
    key.procStart?.replace(/\s+/g, " ") !==
      record.procStart?.replace(/\s+/g, " ") ||
    key.pidDomain !== record.pidDomain ||
    typeof key.peerToken !== "string" ||
    !key.peerToken
  )
    throw new Error("Claude peer key identity mismatch");
  const socketPath = record.messagingSocketPath;
  if (
    typeof socketPath !== "string" ||
    !path.isAbsolute(socketPath) ||
    path.basename(socketPath) !== `${pid}.sock`
  )
    throw new Error("Invalid Claude peer socket");
  assertPrivateFile(socketPath, "Claude peer socket", { socket: true });
  return { socketPath, peerToken: key.peerToken };
}

export function resolveClaudeRegistryTarget(
  query,
  { home = os.homedir(), getProcStart = actualProcStart } = {},
) {
  const dir = path.join(home, ".claude", "sessions");
  const records = [];
  for (const name of fs.readdirSync(dir).filter((x) => /^\d+\.json$/.test(x))) {
    const file = path.join(dir, name);
    try {
      assertPrivateFile(file, "Claude session", { privateMode: false });
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      if (`${record.pid}.json` === name && record.sessionId && record.name)
        records.push(record);
    } catch {}
  }
  const exactId = records.filter(
    (x) => x.sessionId.toLowerCase() === query.toLowerCase(),
  );
  const named = exactId.length
    ? exactId
    : records.filter((x) => x.name.toLowerCase() === query.toLowerCase());
  if (!named.length)
    throw new Error("Claude target not found in local session registry");
  if (exactId.length && exactId[0].parkedJobId)
    throw new Error(
      "Claude target is a parked parent; specify the live continuation name",
    );
  const parked = named.filter((x) => x.parkedJobId);
  if (parked.length > 1) throw new Error("Ambiguous parked Claude parents");
  const eligible = named.filter(
    (x) =>
      !x.parkedJobId && (!parked.length || x.jobId === parked[0].parkedJobId),
  );
  const live = eligible.filter((x) => {
    try {
      resolveClaudeReceiver({ sessionId: x.sessionId, home, getProcStart });
      return true;
    } catch {
      return false;
    }
  });
  if (live.length !== 1)
    throw new Error(
      live.length
        ? "Ambiguous live Claude targets"
        : "No live Claude continuation; parked parent is not a delivery target",
    );
  return { sessionId: live[0].sessionId, name: live[0].name };
}

export async function deliverClaude({
  sessionId,
  message,
  home = os.homedir(),
  receiver = resolveClaudeReceiver({ sessionId, home }),
  socketDir = path.dirname(receiver.socketPath),
  // 150ms 유지 후 리드의 peer 수신·응답을 확인해 8초 고정 대기를 줄였다.
  holdMs = 150,
}) {
  const own = path.join(socketDir, `${process.pid}.sock`);
  // 이 일회성 송신자는 회신을 라우팅하지 않는다. 열린 reply 소켓을 즉시 닫는다.
  const server = net.createServer((connection) => connection.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(own, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const inode = fs.lstatSync(own).ino;
  fs.chmodSync(own, 0o600);
  const from = `uds:${own}`;
  const safe = message.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  const frame = {
    type: "user",
    message: {
      role: "user",
      content: `<cross-session-message from="${from}" from-name="Triflux peer adapter" from-mode="prompting">\n${safe}\n</cross-session-message>`,
    },
    uuid: randomUUID(),
    msg_id: randomUUID(),
    from,
  };
  try {
    try {
      await new Promise((resolve, reject) => {
        const conn = net.connect(receiver.socketPath);
        conn.setTimeout(5000, () =>
          conn.destroy(new Error("Claude peer connect timed out")),
        );
        conn.once("error", reject);
        conn.once("connect", () => {
          conn.write(
            `${JSON.stringify({ type: "auth", token: receiver.peerToken })}\n${JSON.stringify(frame)}\n`,
          );
          conn.end();
        });
        conn.once("close", () => resolve());
      });
    } catch (error) {
      return {
        status: "unknown",
        retrySafe: false,
        modelReceipt: false,
        error: `peer write outcome unknown: ${error.message}`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    return {
      status: "written",
      retrySafe: false,
      modelReceipt: false,
      msgId: frame.msg_id,
    };
  } finally {
    server.close();
    try {
      if (fs.lstatSync(own).ino === inode) fs.unlinkSync(own);
    } catch {}
  }
}
