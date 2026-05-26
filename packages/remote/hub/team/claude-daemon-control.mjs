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

const CLAUDE_ATTACH_SPINNER_RE = /^[✻✶✳✢✽·]/u;
const DEFAULT_ATTACH_COMPLETION_QUIESCENCE_MS = 750;

function isClaudeAttachElapsedStatusLine(line) {
  const trimmed = line.trim();
  return (
    /\bfor\s+\d+s\)?$/i.test(trimmed) ||
    /^\(?\d+s\b(?:\s*[·•]\s*.*\btokens?\s*)?\)?$/i.test(trimmed) ||
    /\(\d+s\b.*\btokens?\)/i.test(trimmed)
  );
}

function isClaudeAttachTransientStatusLine(line) {
  const trimmed = line.trim();
  return (
    isClaudeAttachElapsedStatusLine(trimmed) ||
    /esc to interrupt/i.test(trimmed) ||
    CLAUDE_ATTACH_SPINNER_RE.test(trimmed) ||
    /^·?[\p{L}\w-]+…(?:$|\s|\(|\d+$)/u.test(trimmed) ||
    /^[\p{L}\w-]+\s+for\s+\d+s\)?$/u.test(trimmed)
  );
}

function isClaudeAttachChromeLine(line) {
  const trimmed = line.trim();
  return (
    trimmed.length === 0 ||
    trimmed === "❯" ||
    /^❯\s/.test(trimmed) ||
    /^⏵/.test(trimmed) ||
    isClaudeAttachTransientStatusLine(trimmed) ||
    /^Ran \d+ shell command/.test(trimmed) ||
    /^Image in clipboard/.test(trimmed) ||
    /^SettingsStatus Config UsageStats/.test(trimmed) ||
    /^Space to change · Enter to save · Esc to cancel/.test(trimmed) ||
    /^⌕ Search settings/.test(trimmed) ||
    /^W\(\d+s\b/.test(trimmed) ||
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
    if (index > assistantIndex && line.trim().length === 0) {
      response.push("");
      continue;
    }
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

function isClaudeAttachBusyLine(line) {
  const trimmed = line.trim();
  if (/esc to interrupt/i.test(trimmed)) return true;
  if (!CLAUDE_ATTACH_SPINNER_RE.test(trimmed)) return false;
  return !isClaudeAttachElapsedStatusLine(trimmed);
}

function findClaudeAttachBusySignalIndex(text) {
  const cleaned = stripTerminalControl(text);
  let offset = 0;
  for (const line of cleaned.split("\n")) {
    if (isClaudeAttachBusyLine(line)) return offset;
    offset += line.length + 1;
  }
  return -1;
}

function findClaudeAttachPromptEchoIndex(text, input) {
  const prompt = String(input ?? "").trim();
  if (!prompt) return -1;
  const cleaned = stripTerminalControl(text);
  const exact = cleaned.indexOf(prompt);
  if (exact >= 0) return exact;
  const prefix = prompt.slice(0, Math.min(40, prompt.length));
  if (prefix.length >= 12) return cleaned.indexOf(prefix);
  return -1;
}

function claudeAttachDynamicProgressSignature(text) {
  const cleaned = stripTerminalControl(text);
  const spinnerGlyphs = [...cleaned.matchAll(/[✻✶✳✢✽·]/gu)]
    .map((match) => match[0])
    .join("")
    .slice(-32);
  const elapsedSeconds = [...cleaned.matchAll(/\b(\d+)s\b/gi)]
    .map((match) => match[1])
    .join(",")
    .slice(-64);
  if (!spinnerGlyphs && !elapsedSeconds) return "";
  return `${spinnerGlyphs}|${elapsedSeconds}`;
}

function hasClaudeAttachPreInputScreen(text) {
  const cleaned = stripTerminalControl(text);
  return /(^|\n)\s*(⏺|❯|⏵)\s*/.test(cleaned);
}

function defaultClaudeAttachCompletionMatched(streamText) {
  const cleaned = stripTerminalControl(streamText);
  const assistantIndex = cleaned.lastIndexOf("⏺");
  if (assistantIndex < 0) return false;
  const tail = cleaned.slice(assistantIndex);
  if (/esc to interrupt/i.test(tail)) return false;
  return (
    /(^|\n)\s*❯\s*(?:\n|$)/.test(tail) ||
    (extractClaudeDaemonAttachText(tail).length > 0 &&
      tail.split("\n").some((line) => isClaudeAttachElapsedStatusLine(line)))
  );
}

function writeClaudeAttachInput(socket, input) {
  socket.write("\x15");
  socket.write(`\x1b[200~${String(input)}\x1b[201~`);
  socket.write("\r");
}

function requiresPostInputTransition(handshake) {
  return (
    handshake?.active === true ||
    handshake?.tempo === "active" ||
    handshake?.state === "working" ||
    handshake?.source === "slash" ||
    handshake?.source === "fleet"
  );
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
  completionQuiescenceMs = DEFAULT_ATTACH_COMPLETION_QUIESCENCE_MS,
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
    let postInputBusySeen = input === undefined;
    let postInputPromptEchoSeen = false;
    let responseReadyText = "";
    let requirePostInputTransition = false;
    let sendInputTimer = null;
    let completionTimer = null;
    let pendingCompletion = null;
    let dynamicProgressSignature = "";
    let postInputDynamicProgressSeen = false;

    const cancelCompletionTimer = () => {
      if (completionTimer) clearTimeout(completionTimer);
      completionTimer = null;
      pendingCompletion = null;
    };

    const scheduleCompletion = (extra) => {
      pendingCompletion = extra;
      if (completionTimer) clearTimeout(completionTimer);
      if (completionQuiescenceMs <= 0) {
        const completion = pendingCompletion;
        pendingCompletion = null;
        finish(completion);
        return;
      }
      completionTimer = setTimeout(() => {
        const completion = pendingCompletion;
        completionTimer = null;
        pendingCompletion = null;
        finish(completion);
      }, completionQuiescenceMs);
    };

    const noteDynamicProgress = (text) => {
      const signature = claudeAttachDynamicProgressSignature(text);
      if (signature && signature !== dynamicProgressSignature) {
        dynamicProgressSignature = signature;
        postInputDynamicProgressSeen = true;
      }
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (sendInputTimer) clearTimeout(sendInputTimer);
      cancelCompletionTimer();
      socket.destroy();
      error.inputSent = inputSent;
      reject(error);
    };

    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (sendInputTimer) clearTimeout(sendInputTimer);
      cancelCompletionTimer();
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
        text: extractClaudeDaemonAttachText(
          responseReadyText || responseStreamText || streamText,
        ),
        postInputBusySeen,
        postInputPromptEchoSeen,
        postInputDynamicProgressSeen,
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
        requirePostInputTransition = requiresPostInputTransition(handshake);
        if (input !== undefined) {
          sendInputTimer = setTimeout(() => {
            if (settled) return;
            requirePostInputTransition ||= hasClaudeAttachPreInputScreen(
              stream.toString("utf8"),
            );
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
      noteDynamicProgress(responseStreamText);
      if (input !== undefined && !responseReadyText) {
        const busyIndex = findClaudeAttachBusySignalIndex(responseStreamText);
        const promptEchoIndex = findClaudeAttachPromptEchoIndex(
          responseStreamText,
          input,
        );
        const transitionIndexes = [busyIndex, promptEchoIndex].filter(
          (index) => index >= 0,
        );
        if (transitionIndexes.length > 0) {
          const transitionIndex = Math.min(...transitionIndexes);
          responseReadyText =
            stripTerminalControl(responseStreamText).slice(transitionIndex);
          postInputBusySeen = busyIndex >= 0;
          postInputPromptEchoSeen = promptEchoIndex >= 0;
        }
      } else if (responseReadyText) {
        const busyIndex = findClaudeAttachBusySignalIndex(responseStreamText);
        const promptEchoIndex = findClaudeAttachPromptEchoIndex(
          responseStreamText,
          input,
        );
        const transitionIndexes = [busyIndex, promptEchoIndex].filter(
          (index) => index >= 0,
        );
        if (transitionIndexes.length > 0) {
          responseReadyText = stripTerminalControl(responseStreamText).slice(
            Math.min(...transitionIndexes),
          );
          postInputBusySeen ||= busyIndex >= 0;
          postInputPromptEchoSeen ||= promptEchoIndex >= 0;
        }
      }
      const completionText = responseReadyText || responseStreamText;
      const readyToMatch =
        (input === undefined ||
          !requirePostInputTransition ||
          responseReadyText) &&
        completionMatched?.(completionText);
      if (readyToMatch) {
        scheduleCompletion({
          timedOut: false,
          matchedCompletion: true,
          closed: false,
        });
      } else {
        cancelCompletionTimer();
      }
    });
    socket.on("close", () => {
      if (!settled) {
        if (pendingCompletion) {
          finish(pendingCompletion);
          return;
        }
        finish({ timedOut: false, matchedCompletion: false, closed: true });
      }
    });
  });
}

export function interruptClaudeDaemonSession({
  controlSock,
  short,
  cols = 120,
  rows = 40,
  caps,
  initialDrainMs = 50,
  timeoutMs = 5000,
} = {}) {
  if (!controlSock) throw new Error("controlSock is required");
  return new Promise((resolve, reject) => {
    const socket = net.connect(controlSock);
    let settled = false;
    let buffer = Buffer.alloc(0);
    let handshake = null;
    let stream = Buffer.alloc(0);
    let inputSent = false;
    let sendInterruptTimer = null;

    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (sendInterruptTimer) clearTimeout(sendInterruptTimer);
      socket.destroy();
      const streamText = stream.toString("utf8");
      resolve({
        handshake,
        inputSent,
        streamText,
        streamBytes: stream.length,
        ...extra,
      });
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (sendInterruptTimer) clearTimeout(sendInterruptTimer);
      socket.destroy();
      error.inputSent = inputSent;
      reject(error);
    };

    const timer = setTimeout(
      () => finish({ timedOut: true, closed: false }),
      timeoutMs,
    );

    socket.on("error", fail);
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
          finish({ timedOut: false, closed: false });
          return;
        }
        sendInterruptTimer = setTimeout(() => {
          if (settled) return;
          socket.write("\x1b", () => {
            inputSent = true;
            setTimeout(() => finish({ timedOut: false, closed: false }), 25);
          });
        }, initialDrainMs);
        return;
      }
      stream = Buffer.concat([stream, buffer]);
      buffer = Buffer.alloc(0);
    });
    socket.on("close", () => {
      if (!settled) {
        finish({ timedOut: false, closed: true });
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
