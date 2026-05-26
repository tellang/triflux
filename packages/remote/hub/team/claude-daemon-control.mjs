import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export function resolveClaudeConfigDir(env = process.env) {
  if (env.CLAUDE_CONFIG_DIR) return path.resolve(env.CLAUDE_CONFIG_DIR);
  return path.join(os.homedir(), ".claude");
}

export function deriveClaudeDaemonPaths({
  configDir = resolveClaudeConfigDir(),
  uid = typeof process.getuid === "function" ? process.getuid() : 0,
  tmpRoot = "/tmp",
} = {}) {
  const resolvedConfigDir = path.resolve(configDir);
  const hash = crypto
    .createHash("sha256")
    .update(resolvedConfigDir)
    .digest("hex")
    .slice(0, 8);
  const daemonDir = path.join(tmpRoot, `cc-daemon-${uid}`, hash);
  return {
    configDir: resolvedConfigDir,
    hash,
    daemonDir,
    controlSock: path.join(daemonDir, "control.sock"),
    rosterPath: path.join(resolvedConfigDir, "daemon", "roster.json"),
    sessionsDir: path.join(resolvedConfigDir, "sessions"),
    jobsDir: path.join(resolvedConfigDir, "jobs"),
  };
}

export function readFirstJsonLine(text) {
  const line = String(text)
    .split("\n")
    .find((entry) => entry.trim().length > 0);
  if (!line) throw new Error("empty daemon response");
  return JSON.parse(line);
}

export function sendClaudeControlRequest(
  sockPath,
  request,
  { timeoutMs = 6000 } = {},
) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sockPath);
    let settled = false;
    let data = "";
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    socket.setTimeout(timeoutMs, () => {
      finish(
        new Error(`Timed out waiting for Claude daemon response: ${sockPath}`),
      );
    });
    socket.on("error", finish);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (!data.includes("\n")) return;
      try {
        finish(null, readFirstJsonLine(data));
      } catch (error) {
        finish(error);
      }
    });
    socket.on("close", () => {
      if (settled) return;
      if (data.length === 0) {
        finish(
          new Error("Claude daemon closed control socket without a response"),
        );
        return;
      }
      try {
        finish(null, readFirstJsonLine(data));
      } catch (error) {
        finish(error);
      }
    });
  });
}

export function buildDaemonAttachRequest({
  short,
  cols = 120,
  rows = 40,
  caps = { terminal: null, mux: null, ssh: false },
} = {}) {
  if (!short) throw new Error("short is required");
  return {
    proto: 1,
    op: "attach",
    short,
    cols,
    rows,
    caps,
  };
}

function stripTerminalControl(text) {
  return String(text)
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B[78]/g, "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\r/g, "\n")
    .replace(/[^\S\n]+$/gm, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function isClaudeAttachChromeLine(line) {
  const trimmed = line.trim();
  return (
    trimmed.length === 0 ||
    trimmed === "❯" ||
    /^❯\s/.test(trimmed) ||
    /^⏵/.test(trimmed) ||
    /^✻|^✶|^✳|^✢/.test(trimmed) ||
    /^Ran \d+ shell command/.test(trimmed) ||
    /^Image in clipboard/.test(trimmed) ||
    /^SettingsStatus Config UsageStats/.test(trimmed) ||
    /^Space to change · Enter to save · Esc to cancel/.test(trimmed) ||
    /^⌕ Search settings/.test(trimmed) ||
    /^W\(\d+s\b/.test(trimmed) ||
    /^·?[A-Za-z]+…(?:$|\(\d+s\b|\d+$)/.test(trimmed) ||
    /^(Fermenting|Whirring|Smooshing|Undulating|Harmonizing|Baking|Churned|Baked for)/.test(
      trimmed,
    ) ||
    /^running stop hooks…/.test(trimmed) ||
    /^Tip: /.test(trimmed) ||
    /^\d+ MCP servers? failed\b/.test(trimmed) ||
    /^(Auto-compact|Showtips|Reducemotion|Thinkingmode|Promptsuggestions|Sessionrecap)/.test(
      trimmed,
    ) ||
    /^[-─━▔╭╮╰╯│┌┐└┘├┤┬┴┼\s]+$/.test(trimmed) ||
    /^(c|x|g):\s/.test(trimmed) ||
    /CTX:\d+/.test(trimmed) ||
    /auto mode on/.test(trimmed)
  );
}

export function extractClaudeDaemonAttachText(text) {
  const cleaned = stripTerminalControl(text);
  const lines = cleaned.split("\n").map((line) => line.trimEnd());
  const assistantIndex = lines.findLastIndex((line) => /^\s*⏺\s*/.test(line));
  if (assistantIndex < 0) return cleaned.trim();

  const response = [];
  for (let index = assistantIndex; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line =
      index === assistantIndex ? rawLine.replace(/^\s*⏺\s*/, "") : rawLine;
    if (
      response.length > 0 &&
      /^[A-Z0-9_./:-]+$/.test(response[0].trim()) &&
      /^[·\d\s]+$/.test(line.trim())
    ) {
      break;
    }
    if (index > assistantIndex && isClaudeAttachChromeLine(line)) break;
    if (isClaudeAttachChromeLine(line)) continue;
    response.push(line.trim());
  }

  return response.join("\n").trim();
}

function defaultClaudeAttachCompletionMatched(streamText) {
  const cleaned = stripTerminalControl(streamText);
  const assistantIndex = cleaned.lastIndexOf("⏺");
  if (assistantIndex < 0) return false;
  const tail = cleaned.slice(assistantIndex);
  return /(^|\n)\s*❯\s*(?:\n|$)/.test(tail);
}

function writeClaudeAttachInput(socket, input) {
  socket.write("\x15");
  socket.write(`\x1b[200~${String(input)}\x1b[201~`);
  socket.write("\r");
}

export function attachClaudeDaemonSession({
  controlSock,
  short,
  input,
  cols = 120,
  rows = 40,
  caps,
  initialDrainMs = 150,
  timeoutMs = 30_000,
  completionMatched = defaultClaudeAttachCompletionMatched,
} = {}) {
  if (!controlSock) throw new Error("controlSock is required");
  return new Promise((resolve, reject) => {
    const socket = net.connect(controlSock);
    let settled = false;
    let buffer = Buffer.alloc(0);
    let handshake = null;
    let stream = Buffer.alloc(0);
    let inputSent = false;
    let responseStartOffset = 0;
    let sendInputTimer = null;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (sendInputTimer) clearTimeout(sendInputTimer);
      socket.destroy();
      error.inputSent = inputSent;
      reject(error);
    };

    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (sendInputTimer) clearTimeout(sendInputTimer);
      socket.destroy();
      const streamText = stream.toString("utf8");
      const responseStreamText = stream
        .subarray(responseStartOffset)
        .toString("utf8");
      resolve({
        handshake,
        inputSent,
        streamText,
        responseStreamText,
        streamBytes: stream.length,
        text: extractClaudeDaemonAttachText(responseStreamText || streamText),
        ...extra,
      });
    };

    const timer = setTimeout(
      () => finish({ timedOut: true, matchedCompletion: false, closed: false }),
      timeoutMs,
    );

    socket.on("error", (error) => {
      fail(error);
    });
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify(buildDaemonAttachRequest({ short, cols, rows, caps }))}\n`,
      );
    });
    socket.on("data", (chunk) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshake) {
        const newline = buffer.indexOf(10);
        if (newline < 0) return;
        try {
          handshake = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        } catch (error) {
          fail(error);
          return;
        }
        stream = Buffer.concat([stream, buffer.subarray(newline + 1)]);
        buffer = Buffer.alloc(0);
        if (handshake.ok === false) {
          finish({ timedOut: false, matchedCompletion: false, closed: false });
          return;
        }
        if (input !== undefined) {
          sendInputTimer = setTimeout(() => {
            if (settled) return;
            responseStartOffset = stream.length;
            writeClaudeAttachInput(socket, input);
            inputSent = true;
          }, initialDrainMs);
        }
      } else {
        stream = Buffer.concat([stream, buffer]);
        buffer = Buffer.alloc(0);
      }

      if (input !== undefined && !inputSent) return;

      const responseStreamText = stream
        .subarray(responseStartOffset)
        .toString("utf8");
      if (completionMatched?.(responseStreamText)) {
        finish({ timedOut: false, matchedCompletion: true, closed: false });
      }
    });
    socket.on("close", () => {
      if (!settled) {
        finish({ timedOut: false, matchedCompletion: false, closed: true });
      }
    });
  });
}

export function buildDaemonExecDispatchPayload({
  short = crypto.randomBytes(4).toString("hex"),
  sessionId,
  cwd = process.cwd(),
  command,
  name,
  createdAt = Date.now(),
  cols = 120,
  rows = 40,
} = {}) {
  if (!command) throw new Error("command is required");
  if (!name) throw new Error("name is required");
  const uuid = crypto.randomUUID();
  const resolvedSessionId = sessionId || `${short}${uuid.slice(8)}`;
  return {
    proto: 1,
    short,
    sessionId: resolvedSessionId,
    createdAt,
    source: "shell",
    cwd,
    launch: {
      mode: "exec",
      cmd: "/bin/zsh",
      args: ["-lc", command],
    },
    env: {},
    isolation: "none",
    respawnFlags: [],
    seed: {
      intent: name,
      name,
    },
    cols,
    rows,
  };
}

export function findDaemonJobByShort(listResponse, short) {
  if (!Array.isArray(listResponse?.jobs)) return null;
  return listResponse.jobs.find((job) => job?.short === short) || null;
}

export function findDaemonJobBySessionId(listResponse, sessionId) {
  if (!Array.isArray(listResponse?.jobs)) return null;
  const expected = String(sessionId || "");
  if (!expected) return null;
  return (
    listResponse.jobs.find((job) => {
      const candidate =
        job?.sessionId ??
        job?.session_id ??
        job?.dispatch?.sessionId ??
        job?.d?.sessionId ??
        "";
      return String(candidate) === expected;
    }) || null
  );
}

export async function waitForDaemonJobPid(
  controlSock,
  short,
  { timeoutMs = 5000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await sendClaudeControlRequest(controlSock, {
      proto: 1,
      op: "list",
    });
    const job = findDaemonJobByShort(list, short);
    if (Number.isInteger(job?.pid) && job.pid > 0) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Claude daemon dispatch did not expose a pid for ${short}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bridgeSessionIdFromJob(job) {
  return (
    job?.bridgeSessionId ||
    job?.bridge_session_id ||
    job?.bridge?.sessionId ||
    job?.state?.bridgeSessionId ||
    ""
  );
}

async function readDaemonJobStateBridgeSessionId(jobsDir, short) {
  if (!jobsDir || !short) return "";
  try {
    const statePath = path.join(jobsDir, short, "state.json");
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
    return bridgeSessionIdFromJob(parsed);
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    if (error instanceof SyntaxError) return "";
    throw error;
  }
}

export async function resolveDaemonBridgeSessionId({
  daemonPaths = {},
  short,
  job,
  timeoutMs = 1000,
} = {}) {
  const direct = bridgeSessionIdFromJob(job);
  if (direct) return direct;

  const jobsDir =
    daemonPaths.jobsDir ||
    (daemonPaths.configDir ? path.join(daemonPaths.configDir, "jobs") : "");
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    const fromState = await readDaemonJobStateBridgeSessionId(jobsDir, short);
    if (fromState) return fromState;
    if (Date.now() >= deadline) return "";
    await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
  }
}

export async function killDaemonJob(controlSock, short) {
  return await sendClaudeControlRequest(controlSock, {
    proto: 1,
    op: "kill",
    short,
  });
}

export async function sendKillBySessionId({
  daemonPaths,
  sessionId,
  timeoutMs = 6000,
} = {}) {
  const controlSock = daemonPaths?.controlSock;
  if (!controlSock || !sessionId) {
    return { ok: true, killed: false, reason: "missing_target" };
  }

  try {
    const list = await sendClaudeControlRequest(
      controlSock,
      {
        proto: 1,
        op: "list",
      },
      { timeoutMs },
    );
    const job = findDaemonJobBySessionId(list, sessionId);
    if (!job?.short) {
      return { ok: true, killed: false, reason: "not_found" };
    }
    return await sendClaudeControlRequest(
      controlSock,
      {
        proto: 1,
        op: "kill",
        short: job.short,
      },
      { timeoutMs },
    );
  } catch (error) {
    return {
      ok: false,
      killed: false,
      reason: "control_unavailable",
      error: error?.message || String(error),
    };
  }
}
