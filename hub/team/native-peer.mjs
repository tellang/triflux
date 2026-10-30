import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  assertWindowsAcl,
  readWindowsAcls,
  readWindowsPeerState,
} from "../../scripts/lib/native-peer-windows.mjs";
import { JsonRpcWsUdsClient } from "../workers/lib/jsonrpc-ws-uds.mjs";

const WAKE =
  "A peer agent_message was delivered immediately before this tool output. Read it and respond within this session.";

export function parsePeerSpec(value) {
  if (
    typeof value !== "string" ||
    /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(value) ||
    !/^(claude|codex|agy|antigravity):[^:]+$/i.test(value)
  )
    throw new Error("Use exact claude:NAME, codex:NAME, or agy:NAME target");
  const [rawCli, name] = value.split(":");
  if (
    !name.trim() ||
    name !== name.trim() ||
    name.startsWith("-") ||
    name.length > 512
  )
    throw new Error("Invalid peer name");
  const cli =
    rawCli.toLowerCase() === "antigravity" ? "agy" : rawCli.toLowerCase();
  return `${cli}:${name}`;
}

export function parsePeerArgs(args) {
  if (!["send", "self", "remote-send"].includes(args[0]))
    throw new Error("Only send, remote-send and self are supported");
  const remote = args[0] === "remote-send";
  const target = args[0] === "self" ? "--session" : "--to";
  const allowed =
    target === "--session"
      ? [target, "--message"]
      : remote
        ? [target, "--message", "--from", "--host", "--reply-host"]
        : [target, "--message", "--from"];
  const parsed = {};
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i],
      value = args[i + 1];
    if (
      !allowed.includes(flag) ||
      typeof value !== "string" ||
      !value ||
      Object.hasOwn(parsed, flag)
    )
      throw new Error(`Invalid peer argument: ${flag}`);
    parsed[flag] = value;
  }
  if (
    !parsed[target] ||
    !parsed["--message"] ||
    parsed["--message"].length > 8000
  )
    throw new Error(
      `${args[0]} requires ${target} and --message (max 8000 chars)`,
    );
  if (target === "--session")
    return { sessionId: parsed["--session"], message: parsed["--message"] };
  if (remote && (!parsed["--host"] || !parsed["--reply-host"]))
    throw new Error("remote-send requires --host and --reply-host");
  for (const flag of ["--host", "--reply-host"]) {
    if (parsed[flag] && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(parsed[flag]))
      throw new Error(`Invalid host alias: ${flag}`);
  }
  return {
    to: parsePeerSpec(parsed["--to"]),
    message: parsed["--message"],
    ...(parsed["--from"] ? { from: parsePeerSpec(parsed["--from"]) } : {}),
    ...(remote
      ? { host: parsed["--host"], replyHost: parsed["--reply-host"] }
      : {}),
  };
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

export async function sendCodexPeer({
  client,
  threadId,
  message,
  onWriteStart,
}) {
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
      "Codex target is not loaded in this app-server. 이 Codex 는 공유 데몬에 붙어 있지 않다. tfx-live start --cli codex (또는 --resume)로 다시 띄워라",
    );
  const read = await client.request("thread/read", {
    threadId,
    includeTurns: false,
  });
  validateCodexTarget(read.thread, threadId);
  try {
    onWriteStart?.();
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
  {
    socket = false,
    privateMode = true,
    platform = process.platform,
    fs: io = fs,
    acls,
  } = {},
) {
  const meta = io.lstatSync(file);
  if (platform === "win32") {
    if (meta.isSymbolicLink() || !meta.isFile())
      throw new Error(`Unsafe ${kind}`);
    assertWindowsAcl((acls || readWindowsAcls([file])).get(file), kind, {
      privateMode,
    });
    return meta;
  }
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

export function resolveCodexSocket(home = os.homedir(), env = process.env) {
  const link = path.join(
    env.CODEX_HOME ?? path.join(home, ".codex"),
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
  onWriteStart,
  home = os.homedir(),
  env = process.env,
  platform = process.platform,
  clientFactory = (socketPath) => new JsonRpcWsUdsClient({ socketPath }),
}) {
  if (platform === "win32")
    throw new Error("Windows 에서는 Codex 대상을 아직 지원하지 않는다");
  const client = clientFactory(resolveCodexSocket(home, env));
  try {
    await client.connect();
    await client.request("initialize", {
      clientInfo: { name: "triflux-peer", version: "1" },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized", {});
    return await sendCodexPeer({ client, threadId, message, onWriteStart });
  } finally {
    client.close();
  }
}

function actualProcStart(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("Invalid process id");
  return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    timeout: 2000,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  })
    .trim()
    .replace(/\s+/g, " ");
}

function readClaudeRegistry({ home, platform, fs: io, readWindowsState }) {
  const paths = platform === "win32" ? path.win32 : path;
  const dir = paths.join(home, ".claude", "sessions");
  const names = io.readdirSync(dir);
  let acls, procStarts;
  if (platform === "win32") {
    const parents = [home, paths.join(home, ".claude"), dir];
    ({ acls, procStarts } = readWindowsState(
      [
        ...parents,
        ...names
          .filter(
            (name) => /^\d+\.json$/.test(name) || /^\d+\..*\.key$/.test(name),
          )
          .map((name) => paths.join(dir, name)),
      ],
      {
        pids: names
          .filter((name) => /^\d+\.json$/.test(name))
          .map((name) => Number(name.slice(0, -5)))
          .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
      },
    ));
    for (const parent of parents) {
      const meta = io.lstatSync(parent);
      if (!meta.isDirectory() || meta.isSymbolicLink())
        throw new Error("Unsafe Claude sessions directory");
      assertWindowsAcl(acls.get(parent), "Claude sessions directory", {
        privateMode: false,
      });
    }
  }
  const records = [];
  for (const name of names.filter((name) => /^\d+\.json$/.test(name))) {
    const file = paths.join(dir, name);
    try {
      assertPrivateFile(file, "Claude session", {
        privateMode: false,
        platform,
        fs: io,
        acls,
      });
      const record = JSON.parse(io.readFileSync(file, "utf8"));
      if (
        `${record.pid}.json` === name &&
        typeof record.sessionId === "string" &&
        record.sessionId
      )
        records.push(record);
    } catch {}
  }
  return { dir, names, records, acls, procStarts };
}

export function resolveClaudeReceiver({
  sessionId,
  home = os.homedir(),
  platform = process.platform,
  hostname = os.hostname(),
  getProcStart,
  fs: io = fs,
  readWindowsState = readWindowsPeerState,
  registry = readClaudeRegistry({
    home,
    platform,
    fs: io,
    readWindowsState,
  }),
}) {
  const { dir, names, records, acls, procStarts } = registry;
  getProcStart ??= (pid) =>
    platform === "win32" ? procStarts.get(pid) : actualProcStart(pid);
  const matches = records.filter((record) => record.sessionId === sessionId);
  if (matches.length !== 1)
    throw new Error("Claude session identity missing or ambiguous");
  const record = matches[0];
  if (record.parkedJobId)
    throw new Error(
      "Claude session is a parked parent; use its live continuation name",
    );
  const pid = Number(record.pid);
  const windows = platform === "win32";
  const normalizeStart = (start) =>
    typeof start === "string"
      ? windows
        ? start
        : start.replace(/\s+/g, " ")
      : null;
  const domainMatches = (domain) =>
    windows
      ? typeof domain === "string" &&
        domain.toLowerCase() === `win32:${hostname}`.toLowerCase()
      : domain === platform;
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !domainMatches(record.pidDomain) ||
    (windows && !/^\d+$/.test(record.procStart)) ||
    normalizeStart(record.procStart) !== getProcStart(pid)
  )
    throw new Error("Claude process identity stale");
  const keyFiles = names.filter((name) =>
    windows
      ? new RegExp(`^${pid}\\.[0-9a-f]{64}\\.key$`).test(name)
      : name.startsWith(`${pid}.`) && name.endsWith(".key"),
  );
  if (keyFiles.length !== 1)
    throw new Error("Claude peer key missing or ambiguous");
  const keyFile = (windows ? path.win32 : path).join(dir, keyFiles[0]);
  assertPrivateFile(keyFile, "Claude peer key", { platform, fs: io, acls });
  const key = JSON.parse(io.readFileSync(keyFile, "utf8"));
  if (
    normalizeStart(windows ? key.procStartFt : key.procStart) !==
      normalizeStart(record.procStart) ||
    !domainMatches(key.pidDomain) ||
    typeof key.peerToken !== "string" ||
    !key.peerToken
  )
    throw new Error("Claude peer key identity mismatch");
  const socketPath = record.messagingSocketPath;
  if (windows) {
    if (
      typeof socketPath !== "string" ||
      !/^\\\\\.\\pipe\\LOCAL\\cc-msg-[0-9a-f]{32}$/.test(socketPath)
    )
      throw new Error("Invalid Claude peer socket");
    return { socketPath, peerToken: key.peerToken };
  }
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
  {
    home = os.homedir(),
    platform = process.platform,
    hostname = os.hostname(),
    getProcStart,
    fs: io = fs,
    readWindowsState = readWindowsPeerState,
  } = {},
) {
  const registry = readClaudeRegistry({
    home,
    platform,
    fs: io,
    readWindowsState,
  });
  const { records } = registry;
  const exactId = records.filter(
    (x) => x.sessionId.toLowerCase() === query.toLowerCase(),
  );
  const named = exactId.length
    ? exactId
    : records.filter((x) => x.name?.toLowerCase() === query.toLowerCase());
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
  const live = [];
  for (const x of eligible) {
    try {
      const receiver = resolveClaudeReceiver({
        sessionId: x.sessionId,
        home,
        platform,
        hostname,
        getProcStart,
        fs: io,
        registry,
      });
      live.push({ ...x, receiver });
    } catch {}
  }
  if (live.length !== 1)
    throw new Error(
      live.length
        ? "Ambiguous live Claude targets"
        : "No live Claude continuation; parked parent is not a delivery target",
    );
  return {
    sessionId: live[0].sessionId,
    name: live[0].name,
    receiver: live[0].receiver,
  };
}

export async function deliverClaude({
  sessionId,
  message,
  onWriteStart,
  home = os.homedir(),
  platform = process.platform,
  receiver = resolveClaudeReceiver({ sessionId, home, platform }),
  net: transport = net,
  socketDir = path.dirname(receiver.socketPath),
  // 150ms 유지 후 리드의 peer 수신·응답을 확인해 8초 고정 대기를 줄였다.
  holdMs = 150,
}) {
  const own =
    platform === "win32"
      ? `\\\\.\\pipe\\LOCAL\\cc-msg-${randomBytes(16).toString("hex")}`
      : path.join(socketDir, `${process.pid}.sock`);
  // 이 일회성 송신자는 회신을 라우팅하지 않는다. 열린 reply 소켓을 즉시 닫는다.
  const server = transport.createServer((connection) => connection.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(own, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const inode = platform === "win32" ? null : fs.lstatSync(own).ino;
  if (platform !== "win32") fs.chmodSync(own, 0o600);
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
        const conn = transport.connect(receiver.socketPath);
        conn.setTimeout(5000, () =>
          conn.destroy(new Error("Claude peer connect timed out")),
        );
        conn.once("error", reject);
        conn.once("connect", () => {
          onWriteStart?.();
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
      if (platform !== "win32" && fs.lstatSync(own).ino === inode)
        fs.unlinkSync(own);
    } catch {}
  }
}

export function deliverAgy({
  conversationId,
  appDataDir: targetAppDataDir = null,
  requireExisting = false,
  message,
  onWriteStart,
  sender = "unknown",
  env = process.env,
  home = null,
  fs: io = fs,
} = {}) {
  if (
    typeof conversationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      conversationId,
    )
  )
    throw new Error("Invalid agy conversationId");
  const normalizedId = conversationId.toLowerCase();
  const resolvedHome = home || env.HOME || os.homedir();
  const appDataDir =
    targetAppDataDir ||
    (home
      ? path.join(home, ".gemini", "antigravity-cli")
      : env.ANTIGRAVITY_APP_DATA_DIR ||
        path.join(resolvedHome, ".gemini", "antigravity-cli"));
  if (requireExisting) {
    const hasConversation = [
      path.join(appDataDir, "presence", `${normalizedId}.lock`),
      path.join(appDataDir, "conversations", `${normalizedId}.db`),
      path.join(appDataDir, "brain", normalizedId),
    ].some((p) => io.existsSync(p));
    if (!hasConversation) {
      throw new Error("agy target conversation not found in appDataDir");
    }
  }
  const messagesDir = path.join(
    appDataDir,
    "brain",
    normalizedId,
    ".system_generated",
    "messages",
  );
  const undeliveredDir = path.join(messagesDir, "undelivered");
  io.mkdirSync(undeliveredDir, { recursive: true, mode: 0o700 });
  const msgId = randomUUID();
  const payload = {
    id: msgId,
    recipient: normalizedId,
    sender,
    priority: "MESSAGE_PRIORITY_HIGH",
    timestamp: new Date().toISOString(),
    renderDetails: {
      messageTitle: `Message from ${sender}`,
    },
    content: message,
  };
  const jsonPath = path.join(messagesDir, `${msgId}.json`);
  const markerPath = path.join(undeliveredDir, msgId);
  try {
    onWriteStart?.();
    io.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), {
      mode: 0o600,
    });
  } catch (error) {
    try {
      io.unlinkSync?.(jsonPath);
    } catch {}
    throw error;
  }
  try {
    io.writeFileSync(markerPath, "", { mode: 0o600 });
  } catch (error) {
    const markerExists = Boolean(io.existsSync?.(markerPath));
    return {
      status: markerExists ? "unknown" : "partial",
      retrySafe: false,
      modelReceipt: false,
      msgId,
      error: error.message,
    };
  }
  return {
    status: "written",
    retrySafe: false,
    modelReceipt: false,
    msgId,
  };
}
