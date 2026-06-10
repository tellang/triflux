import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  extractClaudeAgentSessions,
  normalizeClaudeAgentSession,
} from "./claude-agent-session-normalizer.mjs";
import {
  buildClaudeSessionProjection,
  removeClaudeSessionProjection,
  writeClaudeSessionProjection,
} from "./claude-session-projection.mjs";
import {
  extractClaudeAgentSessions,
  normalizeClaudeAgentSession,
} from "./claude-agent-session-normalizer.mjs";

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
    rendezvousDir: path.join(daemonDir, "rv"),
    ptyDir: path.join(daemonDir, "pty"),
    rosterPath: path.join(resolvedConfigDir, "daemon", "roster.json"),
    sessionsDir: path.join(resolvedConfigDir, "sessions"),
    jobsDir: path.join(resolvedConfigDir, "jobs"),
  };
}

export function getProcStart(pid = process.pid) {
  if (!Number.isInteger(pid) || pid <= 0)
    throw new Error(`invalid pid: ${pid}`);
  return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  }).trim();
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
  cols = DEFAULT_DAEMON_ATTACH_COLS,
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

const CLAUDE_ATTACH_SPINNER_RE = /^[✻✶✳✢✽·]/u;
const DEFAULT_DAEMON_ATTACH_COLS = 240;
const DEFAULT_ATTACH_COMPLETION_QUIESCENCE_MS = 750;

function normalizeTerminalCols(cols) {
  const value = Number(cols);
  if (!Number.isFinite(value)) return DEFAULT_DAEMON_ATTACH_COLS;
  return Math.max(1, Math.floor(value));
}

function terminalCellWidth(char) {
  const cp = char.codePointAt(0);
  if (
    cp === 0 ||
    cp === 0xad ||
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  ) {
    return 0;
  }

  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x2eff) ||
    (cp >= 0x2f00 && cp <= 0x2fff) ||
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0x3040 && cp <= 0x309f) ||
    (cp >= 0x30a0 && cp <= 0x30ff) ||
    (cp >= 0x3100 && cp <= 0x312f) ||
    (cp >= 0x3130 && cp <= 0x318f) ||
    (cp >= 0x3190 && cp <= 0x319f) ||
    (cp >= 0x31c0 && cp <= 0x31ef) ||
    (cp >= 0x3200 && cp <= 0x32ff) ||
    (cp >= 0x3300 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa48f) ||
    (cp >= 0xa490 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe1f) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1b000 && cp <= 0x1b0ff) ||
    (cp >= 0x1f004 && cp <= 0x1f0cf) ||
    (cp >= 0x1f200 && cp <= 0x1f2ff) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  ) {
    return 2;
  }

  return 1;
}

function parseCsiParams(params) {
  const normalized = params.replace(/[?<=>]/g, "");
  if (!normalized) return [];
  return normalized.split(";").map((entry) => {
    const value = Number.parseInt(entry, 10);
    return Number.isFinite(value) ? value : 0;
  });
}

function readTerminalEscape(text, offset) {
  if (text[offset] !== "\x1b") return null;
  const next = text[offset + 1];
  if (next === undefined) return { end: offset + 1, type: "escape" };

  if (next === "]") {
    let index = offset + 2;
    while (index < text.length) {
      if (text[index] === "\x07") {
        return { end: index + 1, type: "osc" };
      }
      if (text[index] === "\x1b" && text[index + 1] === "\\") {
        return { end: index + 2, type: "osc" };
      }
      index += 1;
    }
    return { end: text.length, type: "osc" };
  }

  if (next === "[") {
    let index = offset + 2;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) {
        return {
          end: index + 1,
          type: "csi",
          final: text[index],
          params: text.slice(offset + 2, index),
        };
      }
      index += 1;
    }
    return { end: text.length, type: "csi" };
  }

  return { end: offset + 2, type: "escape", final: next };
}

function renderTerminalText(text, { cols = DEFAULT_DAEMON_ATTACH_COLS } = {}) {
  const width = normalizeTerminalCols(cols);
  const rows = [[]];
  const softWrappedRows = new Set();
  let row = 0;
  let col = 0;
  let pendingWrap = false;
  let savedCursor = { row: 0, col: 0 };

  const ensureRow = (targetRow = row) => {
    while (rows.length <= targetRow) rows.push([]);
  };

  const setCursor = (nextRow, nextCol) => {
    row = Math.max(0, nextRow);
    col = Math.max(0, Math.min(width - 1, nextCol));
    pendingWrap = false;
    ensureRow(row);
  };

  const clearLine = (mode = 0) => {
    ensureRow();
    if (mode === 2) {
      rows[row] = [];
      return;
    }
    if (mode === 1) {
      for (let index = 0; index <= col; index += 1) rows[row][index] = " ";
      return;
    }
    rows[row].length = col;
  };

  const clearScreen = (mode = 0) => {
    if (mode === 2 || mode === 3) {
      rows.length = 1;
      rows[0] = [];
      row = 0;
      col = 0;
      pendingWrap = false;
    }
  };

  const applyCsi = ({ final, params = "" }) => {
    const values = parseCsiParams(params);
    const first = values[0] || 1;
    switch (final) {
      case "A":
        setCursor(row - first, col);
        break;
      case "B":
        setCursor(row + first, col);
        break;
      case "C":
        setCursor(row, col + first);
        break;
      case "D":
        setCursor(row, col - first);
        break;
      case "G":
        setCursor(row, first - 1);
        break;
      case "H":
      case "f":
        setCursor((values[0] || 1) - 1, (values[1] || 1) - 1);
        break;
      case "J":
        clearScreen(values[0] || 0);
        break;
      case "K":
        clearLine(values[0] || 0);
        break;
      case "s":
        savedCursor = { row, col };
        break;
      case "u":
        setCursor(savedCursor.row, savedCursor.col);
        break;
    }
  };

  const clearWideAt = (targetCol) => {
    ensureRow();
    if (rows[row][targetCol] === "" && targetCol > 0) {
      rows[row][targetCol - 1] = " ";
    }
    if (rows[row][targetCol + 1] === "") {
      rows[row][targetCol + 1] = " ";
    }
  };

  const writeCell = (char, cellWidth) => {
    if (pendingWrap) {
      row += 1;
      col = 0;
      pendingWrap = false;
      softWrappedRows.add(row);
      ensureRow();
    }
    if (col + cellWidth > width && col > 0) {
      row += 1;
      col = 0;
      softWrappedRows.add(row);
      ensureRow();
    }

    clearWideAt(col);
    rows[row][col] = char;
    if (cellWidth === 2 && col + 1 < width) {
      clearWideAt(col + 1);
      rows[row][col + 1] = "";
    }
    col += cellWidth;
    if (col >= width) {
      col = width;
      pendingWrap = true;
    }
  };

  const appendCombining = (char) => {
    ensureRow();
    for (let index = Math.min(col - 1, width - 1); index >= 0; index -= 1) {
      if (rows[row][index] && rows[row][index] !== "") {
        rows[row][index] += char;
        return;
      }
    }
  };

  const writeChar = (char) => {
    if (char === "\n") {
      row += 1;
      col = 0;
      pendingWrap = false;
      ensureRow();
      return;
    }
    if (char === "\r") {
      col = 0;
      pendingWrap = false;
      return;
    }
    if (char === "\b") {
      col = Math.max(0, col - 1);
      pendingWrap = false;
      return;
    }
    if (char === "\t") {
      const spaces = 8 - (col % 8);
      for (let index = 0; index < spaces; index += 1) writeCell(" ", 1);
      return;
    }

    const cellWidth = terminalCellWidth(char);
    if (cellWidth === 0) {
      appendCombining(char);
      return;
    }
    writeCell(char, cellWidth);
  };

  const input = String(text);
  for (let index = 0; index < input.length; ) {
    const char = input[index];
    if (char === "\x1b") {
      const sequence = readTerminalEscape(input, index);
      if (sequence?.type === "csi") applyCsi(sequence);
      else if (sequence?.final === "7") savedCursor = { row, col };
      else if (sequence?.final === "8")
        setCursor(savedCursor.row, savedCursor.col);
      index = sequence?.end ?? index + 1;
      continue;
    }
    const code = input.charCodeAt(index);
    if (
      code <= 0x1f &&
      char !== "\n" &&
      char !== "\r" &&
      char !== "\b" &&
      char !== "\t"
    ) {
      index += 1;
      continue;
    }
    const cp = input.codePointAt(index);
    const charLength = cp > 0xffff ? 2 : 1;
    writeChar(input.slice(index, index + charLength));
    index += charLength;
  }

  const trailingSpaceRows = new Set();
  const lines = rows.map((cells, index) => {
    let last = cells.length - 1;
    while (
      last >= 0 &&
      (cells[last] === undefined || cells[last] === null || cells[last] === "")
    ) {
      last -= 1;
    }
    if (last >= 0 && cells[last] === " ") trailingSpaceRows.add(index);
    const line = Array.from({ length: last + 1 }, (_, cellIndex) => {
      const cell = cells[cellIndex];
      if (cell === undefined || cell === null || cell === "") return "";
      return cell;
    }).join("");
    return line.replace(/[^\S\n]+$/g, "");
  });

  return {
    text: lines.join("\n"),
    softWrappedRows,
    trailingSpaceRows,
  };
}

function stripTerminalControl(text, options) {
  return renderTerminalText(text, options).text.replace(/\x7f/g, "");
}

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

function normalizeClaudeAttachResponseLine(line) {
  return line.replace(/^ {2}/, "");
}

function shouldJoinSoftWrappedLine({ rendered, lineIndex }) {
  return rendered.softWrappedRows.has(lineIndex);
}

function joinSoftWrappedLine(previous, current, previousHadTrailingSpace) {
  if (previous.endsWith(" ") || current.startsWith(" ")) {
    return `${previous}${current}`;
  }
  if (previousHadTrailingSpace) return `${previous} ${current}`;
  return `${previous}${current}`;
}

export function extractClaudeDaemonAttachText(
  text,
  { cols = DEFAULT_DAEMON_ATTACH_COLS } = {},
) {
  const rendered = renderTerminalText(text, { cols });
  const cleaned = rendered.text;
  const lines = cleaned.split("\n").map((line) => line.trimEnd());
  const assistantIndex = lines.findLastIndex((line) => /^\s*⏺\s*/.test(line));
  if (assistantIndex < 0) return cleaned.trim();

  const response = [];
  let lastAcceptedLineIndex = -1;
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
    if (
      response.length > 0 &&
      lastAcceptedLineIndex === index - 1 &&
      shouldJoinSoftWrappedLine({
        rendered,
        lineIndex: index,
      })
    ) {
      response[response.length - 1] = joinSoftWrappedLine(
        response[response.length - 1],
        line,
        rendered.trailingSpaceRows.has(index - 1),
      );
      lastAcceptedLineIndex = index;
      continue;
    }
    response.push(normalizeClaudeAttachResponseLine(line));
    lastAcceptedLineIndex = index;
  }

  return response.join("\n").trim();
}

function isClaudeAttachBusyLine(line) {
  const trimmed = line.trim();
  if (/esc to interrupt/i.test(trimmed)) return true;
  if (!CLAUDE_ATTACH_SPINNER_RE.test(trimmed)) return false;
  return !isClaudeAttachElapsedStatusLine(trimmed);
}

function findClaudeAttachBusySignalIndex(text, options) {
  const cleaned = stripTerminalControl(text, options);
  let offset = 0;
  for (const line of cleaned.split("\n")) {
    if (isClaudeAttachBusyLine(line)) return offset;
    offset += line.length + 1;
  }
  return -1;
}

function findClaudeAttachPromptEchoIndex(text, input, options) {
  const prompt = String(input ?? "").trim();
  if (!prompt) return -1;
  const cleaned = stripTerminalControl(text, options);
  const exact = cleaned.indexOf(prompt);
  if (exact >= 0) return exact;
  const prefix = prompt.slice(0, Math.min(40, prompt.length));
  if (prefix.length >= 12) return cleaned.indexOf(prefix);
  return -1;
}

function claudeAttachDynamicProgressSignature(text, options) {
  const cleaned = stripTerminalControl(text, options);
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

function hasClaudeAttachPreInputScreen(text, options) {
  const cleaned = stripTerminalControl(text, options);
  return /(^|\n)\s*(⏺|❯|⏵)\s*/.test(cleaned);
}

function defaultClaudeAttachCompletionMatched(
  streamText,
  { cols = DEFAULT_DAEMON_ATTACH_COLS } = {},
) {
  const cleaned = stripTerminalControl(streamText, { cols });
  const assistantIndex = cleaned.lastIndexOf("⏺");
  if (assistantIndex < 0) return false;
  const tail = cleaned.slice(assistantIndex);
  if (/esc to interrupt/i.test(tail)) return false;
  return (
    /(^|\n)\s*❯\s*(?:\n|$)/.test(tail) ||
    (extractClaudeDaemonAttachText(tail, { cols }).length > 0 &&
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
  cols = DEFAULT_DAEMON_ATTACH_COLS,
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
      const signature = claudeAttachDynamicProgressSignature(text, { cols });
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
          { cols },
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
              { cols },
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
        const busyIndex = findClaudeAttachBusySignalIndex(responseStreamText, {
          cols,
        });
        const promptEchoIndex = findClaudeAttachPromptEchoIndex(
          responseStreamText,
          input,
          { cols },
        );
        const transitionIndexes = [busyIndex, promptEchoIndex].filter(
          (index) => index >= 0,
        );
        if (transitionIndexes.length > 0) {
          const transitionIndex = Math.min(...transitionIndexes);
          responseReadyText = stripTerminalControl(responseStreamText, {
            cols,
          }).slice(transitionIndex);
          postInputBusySeen = busyIndex >= 0;
          postInputPromptEchoSeen = promptEchoIndex >= 0;
        }
      } else if (responseReadyText) {
        const busyIndex = findClaudeAttachBusySignalIndex(responseStreamText, {
          cols,
        });
        const promptEchoIndex = findClaudeAttachPromptEchoIndex(
          responseStreamText,
          input,
          { cols },
        );
        const transitionIndexes = [busyIndex, promptEchoIndex].filter(
          (index) => index >= 0,
        );
        if (transitionIndexes.length > 0) {
          responseReadyText = stripTerminalControl(responseStreamText, {
            cols,
          }).slice(Math.min(...transitionIndexes));
          postInputBusySeen ||= busyIndex >= 0;
          postInputPromptEchoSeen ||= promptEchoIndex >= 0;
        }
      }
      const completionText = responseReadyText || responseStreamText;
      const readyToMatch =
        (input === undefined ||
          !requirePostInputTransition ||
          responseReadyText) &&
        completionMatched?.(completionText, { cols, rows });
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
  cols = DEFAULT_DAEMON_ATTACH_COLS,
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

export function buildClaudePromptDispatchPayload({
  short = crypto.randomBytes(4).toString("hex"),
  sessionId,
  cwd = process.cwd(),
  prompt,
  name = "tfx uds claude prompt",
  createdAt = Date.now(),
  cols = 120,
  rows = 40,
} = {}) {
  if (!prompt) throw new Error("prompt is required");
  const uuid = crypto.randomUUID();
  const resolvedSessionId = sessionId || `${short}${uuid.slice(8)}`;
  return {
    proto: 1,
    short,
    sessionId: resolvedSessionId,
    createdAt,
    source: "shell",
    cwd,
    agent: "claude",
    launch: {
      mode: "prompt",
      args: [
        "--session-id",
        resolvedSessionId,
        "--agent",
        "claude",
        "--permission-mode",
        "auto",
        "--",
        prompt,
      ],
    },
    env: {},
    isolation: "none",
    respawnFlags: [],
    seed: {
      intent: "[redacted uds orchestration prompt]",
      name,
    },
    cols,
    rows,
  };
}

export function findDaemonJobByShort(listResponse, short) {
  const expected = String(short || "").trim();
  if (!expected) return null;
  return (
    extractClaudeAgentSessions(listResponse).find(
      (job) => job.short === expected || job.id === expected,
    ) || null
  );
}

export function findDaemonJobBySessionId(listResponse, sessionId) {
  const expected = String(sessionId || "").trim();
  if (!expected) return null;
  return (
    extractClaudeAgentSessions(listResponse).find(
      (job) => String(job.sessionId || job.session_id || "") === expected,
    ) || null
  );
}

export { extractClaudeAgentSessions, normalizeClaudeAgentSession };

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

/**
 * Claude 데몬 dispatch 한 건의 공통 시퀀스를 캡슐화한다.
 * dispatch → waitForDaemonJobPid → resolveDaemonBridgeSessionId →
 * buildClaudeSessionProjection → writeClaudeSessionProjection.
 *
 * 호출 측이 reference 로 들고 있는 record 를 헬퍼가 새로 만들지 않도록
 * plain 필드만 반환한다. caller 는 이 결과를 자기 record 에 Object.assign 한다.
 *
 * @returns {Promise<{ok:boolean, short:string, sessionId:string, job:object,
 *   pid:number, bridgeSessionId:string, sessionProjectionPath:string,
 *   controlSock:string, paths:object}>}
 */
export async function dispatchClaudeDaemonJob({
  paths,
  controlSock,
  payload,
  agent,
  name,
  cwd,
  projection = "write",
  dispatchTimeoutMs = 5000,
  pidTimeoutMs,
  bridgeTimeoutMs,
  accessControlSock,
  _deps = {},
} = {}) {
  if (!payload) throw new Error("payload is required");
  if (!payload.short) throw new Error("payload.short is required");
  const resolvedControlSock = controlSock || paths?.controlSock;
  if (!resolvedControlSock) throw new Error("controlSock is required");

  const sendControl =
    _deps.sendClaudeControlRequest || sendClaudeControlRequest;
  const waitForPid = _deps.waitForDaemonJobPid || waitForDaemonJobPid;
  const resolveBridgeSessionId =
    _deps.resolveDaemonBridgeSessionId || resolveDaemonBridgeSessionId;
  const buildProjection =
    _deps.buildClaudeSessionProjection || buildClaudeSessionProjection;
  const writeProjection =
    _deps.writeClaudeSessionProjection || writeClaudeSessionProjection;
  const readProcStart = _deps.getProcStart || getProcStart;

  const short = payload.short;
  const sessionsDir =
    paths?.sessionsDir ||
    (paths?.configDir ? path.join(paths.configDir, "sessions") : "");

  // native-bridge 는 control.sock 존재를 미리 점검한다 (없으면 fast-fail).
  if (accessControlSock) await accessControlSock(resolvedControlSock);

  const dispatch = await sendControl(
    resolvedControlSock,
    {
      proto: 1,
      op: "dispatch",
      d: payload,
      timeoutMs: dispatchTimeoutMs,
    },
    { timeoutMs: dispatchTimeoutMs },
  );
  if (dispatch?.ok !== true) {
    throw new Error(`Claude daemon dispatch failed for ${name || short}`);
  }

  const pidOpts =
    pidTimeoutMs === undefined ? undefined : { timeoutMs: pidTimeoutMs };
  const job = await waitForPid(resolvedControlSock, short, pidOpts);
  const pid = job.pid;
  const bridgeSessionId = await resolveBridgeSessionId({
    daemonPaths: paths,
    short,
    job,
    ...(bridgeTimeoutMs === undefined ? {} : { timeoutMs: bridgeTimeoutMs }),
  });

  let sessionProjectionPath = "";
  if (projection !== "skip") {
    const projectionRecord = buildProjection({
      pid,
      procStart: readProcStart(pid),
      sessionId: payload.sessionId,
      short,
      cwd,
      name,
      agent,
      startedAt: job.startedAt || Date.now(),
      updatedAt: Date.now(),
      bridgeSessionId,
    });
    sessionProjectionPath = await writeProjection(
      sessionsDir,
      projectionRecord,
    );
  }

  return {
    ok: true,
    short,
    sessionId: payload.sessionId,
    job,
    pid,
    bridgeSessionId,
    sessionProjectionPath,
    controlSock: resolvedControlSock,
    paths,
  };
}

/**
 * dispatchClaudeDaemonJob 의 대칭 정리 경로.
 * removeProjection + killDaemonJob (+ optional removeClaudeJobState) 를
 * 모두 시도하며, 각 스텝 오류는 기존 close()/cleanupDaemonDispatches 와
 * 동일하게 .catch 로 삼킨다.
 */
export async function teardownClaudeDaemonJob({
  controlSock,
  paths,
  short,
  sessionProjectionPath,
  sessionId,
  jobsDir,
  removeJobState = false,
  _deps = {},
} = {}) {
  const removeProjection =
    _deps.removeClaudeSessionProjection || removeClaudeSessionProjection;
  const killJob = _deps.killDaemonJob || killDaemonJob;
  const removeJobStateImpl = _deps.removeClaudeJobState;
  const resolvedControlSock = controlSock || paths?.controlSock;
  const resolvedJobsDir =
    jobsDir ||
    paths?.jobsDir ||
    (paths?.configDir ? path.join(paths.configDir, "jobs") : "");

  const steps = [];
  if (sessionProjectionPath) {
    steps.push(removeProjection(sessionProjectionPath).catch(() => {}));
  }
  if (sessionId && (paths?.controlSock || resolvedControlSock)) {
    const daemonPaths = paths || { controlSock: resolvedControlSock };
    steps.push(sendKillBySessionId({ daemonPaths, sessionId }).catch(() => {}));
  }
  if (resolvedControlSock && short) {
    steps.push(killJob(resolvedControlSock, short).catch(() => {}));
  }
  if (removeJobState && removeJobStateImpl && resolvedJobsDir && short) {
    steps.push(removeJobStateImpl(resolvedJobsDir, short).catch(() => {}));
  }
  await Promise.all(steps);
}
