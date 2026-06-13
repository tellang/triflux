#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join as pathJoin, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  escapePwshSingleQuoted as escapeRemotePwshSingleQuoted,
  probeRemoteEnv as probeRemoteHostEnv,
  shellQuote as remoteShellQuote,
  validateHost as validateRemoteHost,
} from "../hub/team/remote-session.mjs";

const execFileAsync = promisify(execFile);

const DEFAULT_SETTLE_MS = 1500;
const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_ANSWER_TIMEOUT_MS = 60_000;
const FALLBACK_QUIET_POLLS = 3;
const CAPTURE_START = "-200";
const MAX_BUFFER = 10 * 1024 * 1024;
// execFile timeout for a bridge verb = attach timeout + this buffer, so the
// helper's own timeoutMs fires first and returns {timedOut:true} rather than
// execFile killing the process with a less useful error.
const BRIDGE_TIMEOUT_BUFFER_MS = 15_000;
// Above this size an argv-passed --payload risks E2BIG on some platforms;
// spill the JSON to a temp file and pass --payload-file instead.
const PAYLOAD_FILE_THRESHOLD = 96 * 1024;
const VALID_TRANSPORTS = ["tmux", "uds", "auto"];
const BOOLEAN_FLAGS = new Set(["json"]);
// uds-fallback diagnostics land here, written async so a failed daemon attach
// never blocks the tmux fallback path (see writeUdsBugReport / doAskAuto).
const BUG_REPORT_DIR =
  process.env.TFX_LIVE_BUG_REPORT_DIR ??
  pathJoin(homedir(), ".claude", "cache", "triflux", "tfx-live", "bug-reports");

function usage() {
  return [
    "Usage:",
    "  tfx-live start --session NAME [--cli codex|claude] [--cwd DIR] [--remote HOST] [--resume ID] [--resume-last 1] [--ready-timeout 30] [--poll-interval 1500]",
    "  tfx-live ask --session NAME --prompt TEXT [--cli codex|claude] [--timeout 60] [--remote HOST] [--settle 1500] [--poll-interval 1500]",
    "  tfx-live ask --transport uds|auto (--short SHORT | --session-id ID) --prompt TEXT [--config-dir DIR] [--bridge ABS] [--session NAME (auto fallback)] [--timeout 60]",
    "    transport: auto is the default for Claude when --short/--session-id is present; otherwise tmux. bridge path: --bridge > $TFX_BRIDGE > $TFX_REPO_ROOT/hub/bridge.mjs > bundled Triflux hub/bridge.mjs.",
    "  tfx-live interrupt --session NAME [--cli codex|claude] [--transport tmux|uds|auto] [--short SHORT | --session-id ID] [--config-dir DIR] [--bridge ABS] [--timeout 5]",
    "  tfx-live stop --session NAME [--cli codex|claude] [--remote HOST]",
    "  tfx-live probe [--short SHORT] [--session-id ID] [--config-dir DIR] [--bridge ABS] [--timeout 10]",
    "  tfx-live converse --session NAME --prompts-file PATH [--cli codex|claude] [--remote HOST] [--cwd DIR] [--timeout 60] [--settle 1500]",
    "  tfx-live goal-driven --session NAME --goal TEXT [--cli codex|claude] [--remote HOST] [--cwd DIR] [--timeout 60] [--settle 1500] [--max-rounds 8] [--done-token DONE]",
    "  tfx-live peer [--cli-a codex] [--cli-b claude] [--session-a peerA] [--session-b peerB] [--transport-a tmux|uds|auto] [--transport-b tmux|uds|auto] [--short-a SHORT] [--short-b SHORT] [--session-id-a ID] [--session-id-b ID] [--bridge ABS] [--remote HOST] [--cwd DIR] [--rounds 4] [--mode counting|freeform] [--seed TEXT] [--timeout 60]",
    "  tfx-live orchestrate --task TEXT [--mode peer|codex-led|claude-led] [--codex-transport exec|app-server-uds] [--cwd DIR] [--timeout 120]",
    "    Runs the Claude(UDS)+Codex orchestration engine. --codex-transport app-server-uds drives a real `codex app-server` over WebSocket-over-UDS (experimental); default exec keeps the codex stdio one-shot path.",
  ].join("\n");
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    return { command: "help", flags: {} };
  }

  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const key = arg.slice(2);
    if (!key) {
      throw new Error("Empty flag is not valid");
    }

    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = "1";
      continue;
    }

    const value = rest[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for --${key}`);
    }
    flags[key] = value;
    index += 1;
  }

  return { command, flags };
}

function requireFlag(flags, name) {
  const value = flags[name];
  if (!value) {
    throw new Error(`Missing required flag --${name}`);
  }
  return value;
}

function secondsFlag(flags, name, defaultMs) {
  if (flags[name] === undefined) {
    return defaultMs;
  }
  const seconds = Number(flags[name]);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`--${name} must be a positive number of seconds`);
  }
  return Math.round(seconds * 1000);
}

function msFlag(flags, name, defaultMs) {
  if (flags[name] === undefined) {
    return defaultMs;
  }
  const ms = Number(flags[name]);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`--${name} must be a positive number of milliseconds`);
  }
  return Math.round(ms);
}

function integerFlag(flags, name, defaultValue) {
  if (flags[name] === undefined) {
    return defaultValue;
  }
  const value = Number(flags[name]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

function selectAdapter(flags) {
  const cli = flags.cli ?? "codex";
  const adapter = ADAPTERS[cli];
  if (!adapter) {
    throw new Error(
      `--cli must be one of: ${Object.keys(ADAPTERS).join(", ")}`,
    );
  }
  return adapter;
}

function selectAdapterName(cli, flagName) {
  const adapter = ADAPTERS[cli];
  if (!adapter) {
    throw new Error(
      `--${flagName} must be one of: ${Object.keys(ADAPTERS).join(", ")}`,
    );
  }
  return adapter;
}

function shellQuote(args) {
  return args
    .map((arg) => {
      const text = String(arg);
      if (/^[A-Za-z0-9_/:.,@%+=-]+$/.test(text)) {
        return text;
      }
      return `'${text.replace(/'/g, `'"'"'`)}'`;
    })
    .join(" ");
}

function buildTmuxCommand(remote, tmuxArgs) {
  if (!remote) {
    return { command: "tmux", args: tmuxArgs };
  }

  return {
    command: "ssh",
    args: [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      remote,
      shellQuote(["tmux", ...tmuxArgs]),
    ],
  };
}

function timeoutSeconds(timeoutMs) {
  return String(Math.max(1, Math.ceil((timeoutMs ?? 1000) / 1000)));
}

function buildRemoteLiveArgv(verb, opts) {
  const args = [
    "tfx-live",
    verb,
    "--cli",
    "claude",
    "--transport",
    opts.transport ?? "uds",
  ];
  if (opts.short) args.push("--short", opts.short);
  if (opts.sessionId) args.push("--session-id", opts.sessionId);
  if (opts.session) args.push("--session", opts.session);
  if (opts.configDir) args.push("--config-dir", opts.configDir);
  if (verb === "ask") args.push("--prompt", opts.prompt ?? "");
  args.push("--timeout", timeoutSeconds(opts.timeoutMs));
  if (verb === "ask" && opts.settleMs) {
    args.push("--settle", String(opts.settleMs));
  }
  if (verb === "ask" && opts.pollIntervalMs) {
    args.push("--poll-interval", String(opts.pollIntervalMs));
  }
  return args;
}

function buildRemoteLiveCommand(host, verb, opts, env = {}) {
  validateRemoteHost(host);
  const argv = buildRemoteLiveArgv(verb, opts);
  if (env.os === "win32") {
    const [commandPath, ...args] = argv;
    const command = [
      `& '${escapeRemotePwshSingleQuoted(commandPath)}'`,
      ...args.map((arg) => `'${escapeRemotePwshSingleQuoted(arg)}'`),
    ].join(" ");
    // Live-unverified for Windows remotes; apply the same SSH single-argument
    // contract proven on darwin so the remote login shell does not re-split it.
    const remoteCmd = `pwsh -NoProfile -Command ${remoteShellQuote(command)}`;
    return {
      command: "ssh",
      args: [host, remoteCmd],
    };
  }

  const shell = env.os === "darwin" && env.shell === "zsh" ? "zsh" : "sh";
  const inner = argv.map(remoteShellQuote).join(" ");
  const remoteCmd = `${shell} -lc ${remoteShellQuote(inner)}`;
  return {
    command: "ssh",
    args: [host, remoteCmd],
  };
}

function tryParseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseRemoteLiveJson(stdout) {
  const text = String(stdout).trim();
  if (!text) {
    throw new Error("remote tfx-live returned empty output");
  }

  const direct = tryParseJsonObject(text);
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    return direct;
  }

  let parsed = null;
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let end = start; end < text.length; end += 1) {
      const char = text[end];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = tryParseJsonObject(text.slice(start, end + 1));
          if (
            candidate &&
            typeof candidate === "object" &&
            !Array.isArray(candidate)
          ) {
            parsed = candidate;
          }
          break;
        }
      }
    }
  }

  if (parsed) return parsed;
  throw new Error(`remote tfx-live output is not JSON: ${text.slice(0, 200)}`);
}

async function callRemoteLive(verb, opts, deps = {}) {
  const host = validateRemoteHost(opts.remote);
  const probeRemoteEnv = deps.probeRemoteEnv ?? probeRemoteHostEnv;
  const execRemote = deps.sshExec ?? execFileAsync;
  const env = await probeRemoteEnv(host);
  const plan = buildRemoteLiveCommand(host, verb, opts, env);
  const execOptions = {
    timeout: (opts.timeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS) + 30_000,
    maxBuffer: MAX_BUFFER,
  };

  try {
    const { stdout } = await execRemote(plan.command, plan.args, execOptions);
    return parseRemoteLiveJson(stdout);
  } catch (error) {
    if (error?.stdout) {
      try {
        return parseRemoteLiveJson(error.stdout);
      } catch {
        // stdout was not a tfx-live JSON result; fall through.
      }
    }
    const stderr = error?.stderr ? String(error.stderr).trim() : "";
    throw new Error(
      `remote tfx-live ${verb} failed: ${stderr || error.message}`,
    );
  }
}

async function runTmux(remote, tmuxArgs, options = {}) {
  const { command, args } = buildTmuxCommand(remote, tmuxArgs);
  try {
    return await execFileAsync(command, args, {
      timeout: options.timeout ?? 15_000,
      maxBuffer: MAX_BUFFER,
    });
  } catch (error) {
    const detail = [
      error.message,
      error.stdout ? `stdout: ${error.stdout}` : "",
      error.stderr ? `stderr: ${error.stderr}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    throw new Error(detail);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripAnsi(text) {
  return String(text)
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function parseCodexContextPct(text) {
  const matches = [...String(text).matchAll(/Context\s+(\d+)%\s+used/g)];
  if (matches.length === 0) {
    return null;
  }
  return Number(matches[matches.length - 1][1]);
}

function parseClaudeContextPct(text) {
  const matches = [...String(text).matchAll(/CTX:[^()]*\((\d+)%\)/g)];
  if (matches.length === 0) {
    return null;
  }
  return Number(matches[matches.length - 1][1]);
}

function isBusyByEsc(text) {
  return String(text).includes("esc to interrupt");
}

function hasCodexComposerPrompt(text) {
  return /^\s*[›❯▶▸>]\s*/m.test(text);
}

function hasClaudeComposerPrompt(text) {
  return /^\s*❯\s*/m.test(text);
}

function isCodexBulletLine(line) {
  return /^\s*[•●]\s+/.test(line);
}

function isCodexStatusBulletLine(line) {
  if (!isCodexBulletLine(line)) {
    return false;
  }

  const body = line.replace(/^\s*[•●]\s+/, "");
  return (
    body.includes("esc to interrupt") ||
    /\bWorking\b/.test(body) ||
    /\bStarting MCP servers\b/.test(body) ||
    /\(\d+s\b/.test(body)
  );
}

function isCodexResponseLine(line) {
  return isCodexBulletLine(line) && !isCodexStatusBulletLine(line);
}

function isClaudeResponseLine(line) {
  return /^\s*⏺\s*/.test(line);
}

function isCodexReadyCapture(text) {
  return !isBusyByEsc(text) && hasCodexComposerPrompt(text);
}

function hasClaudeLoginGuard(text) {
  return /Not logged in|Please run \/login/.test(String(text));
}

function isClaudeReadyCapture(text) {
  return (
    !hasClaudeLoginGuard(text) &&
    !isBusyByEsc(text) &&
    hasClaudeComposerPrompt(text)
  );
}

function isCodexChromeLine(line) {
  return (
    /Context\s+\d+%\s+used/.test(line) ||
    /^\s*[›❯▶▸>]\s*/.test(line) ||
    /^\s*(gpt-|GPT-)/.test(line) ||
    /^\s*[─-╿]{8,}\s*$/.test(line)
  );
}

function isClaudeStatusLine(line) {
  return /^\s*✻/.test(line) || line.includes("esc to interrupt");
}

function isClaudeChromeLine(line) {
  return (
    /^\s*[╭╮╰╯│─┌┐└┘├┤┬┴┼]{3,}\s*$/.test(line) ||
    /^\s*[╭╮╰╯│].*[╭╮╰╯│]\s*$/.test(line) ||
    /^\s*[cxg]:/.test(line) ||
    /CTX:|auto mode|\/remote-control|MCP server/.test(line) ||
    /Welcome to Claude/.test(line) ||
    isClaudeStatusLine(line)
  );
}

function isWarningLine(line) {
  return /^\s*(?:\u26A0|\(warning\))/i.test(line);
}

function hasAssistantResponseLine(adapter, text) {
  return String(text)
    .split("\n")
    .some((line) => adapter.isResponseLine(line));
}

function promptLineIndex(lines, prompt) {
  if (!prompt) {
    return -1;
  }

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (
      (hasCodexComposerPrompt(line) || hasClaudeComposerPrompt(line)) &&
      line.includes(prompt)
    ) {
      return index;
    }
  }

  return -1;
}

function isComposerPromptLine(line) {
  return hasCodexComposerPrompt(line) || hasClaudeComposerPrompt(line);
}

function nextComposerPromptIndex(lines, startIndex) {
  for (
    let index = Math.max(0, startIndex + 1);
    index < lines.length;
    index += 1
  ) {
    if (isComposerPromptLine(lines[index])) {
      return index;
    }
  }

  return lines.length;
}

function responseLineIndexForPrompt(adapter, lines, promptIndex) {
  const endIndex = nextComposerPromptIndex(lines, promptIndex);
  for (let index = endIndex - 1; index > promptIndex; index -= 1) {
    const line = lines[index];
    if (adapter.isResponseLine(line)) {
      return index;
    }
  }

  return -1;
}

function hasAssistantResponseAfterPrompt(adapter, text, prompt) {
  const lines = String(text).split("\n");
  const promptIndex = promptLineIndex(lines, prompt);
  if (promptIndex === -1) {
    return hasAssistantResponseLine(adapter, text);
  }

  return responseLineIndexForPrompt(adapter, lines, promptIndex) !== -1;
}

function extractAssistantResponse(adapter, text, prompt = null) {
  const lines = String(text)
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""));

  const promptIndex = promptLineIndex(lines, prompt);
  const start =
    promptIndex === -1
      ? lines.findLastIndex((line) => adapter.isResponseLine(line))
      : responseLineIndexForPrompt(adapter, lines, promptIndex);
  if (start === -1) {
    return "";
  }

  const response = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (
      index > start &&
      (adapter.isChromeLine(line) ||
        isWarningLine(line) ||
        adapter.isStatusLine(line) ||
        hasCodexComposerPrompt(line) ||
        hasClaudeComposerPrompt(line))
    ) {
      break;
    }

    if (index === start) {
      response.push(adapter.stripResponseMarker(line));
    } else {
      response.push(line);
    }
  }

  return response.join("\n").trim();
}

function normalizeClaudeTaskText(text) {
  return String(text)
    .replace(/[.…]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isTaskListBoundary(line) {
  const trimmed = line.trim();
  return (
    !trimmed ||
    trimmed === "Working" ||
    trimmed === "Completed" ||
    /^[─-]{8,}$/.test(trimmed) ||
    hasClaudeComposerPrompt(line) ||
    /enter to open|space to reply|ctrl\+x to delete|\? for shortcuts/i.test(
      trimmed,
    )
  );
}

function parseClaudeCompletedTaskListEntries(text) {
  const lines = String(text)
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""));
  const entries = [];
  let inCompleted = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "Completed") {
      inCompleted = true;
      continue;
    }
    if (!inCompleted) {
      continue;
    }
    if (isTaskListBoundary(line)) {
      if (trimmed) {
        inCompleted = false;
      }
      continue;
    }
    if (!/^\s*✻\s+/.test(line)) {
      continue;
    }

    const body = trimmed.replace(/^✻\s+/, "");
    const columns = body
      .split(/\s{2,}/)
      .map((column) => column.trim())
      .filter(Boolean);
    if (columns.length < 2) {
      continue;
    }

    let responseIndex = columns.length - 1;
    const tail = columns[responseIndex];
    if (/^(?:\d+\s*[smhdw]|now|just now)$/i.test(tail)) {
      responseIndex -= 1;
    }
    if (responseIndex <= 0) {
      continue;
    }

    const summary = columns.slice(0, responseIndex).join(" ").trim();
    const response = columns[responseIndex].trim();
    if (!summary || !response) {
      continue;
    }
    entries.push({
      summary,
      response,
      key: `${normalizeClaudeTaskText(summary)}\0${normalizeClaudeTaskText(
        response,
      )}`,
    });
  }

  return entries;
}

function claudeTaskMatchesPrompt(entry, prompt) {
  if (!prompt) {
    return true;
  }
  const summary = normalizeClaudeTaskText(entry.summary);
  const normalizedPrompt = normalizeClaudeTaskText(prompt);
  return (
    Boolean(summary && normalizedPrompt) &&
    (summary.includes(normalizedPrompt) || normalizedPrompt.includes(summary))
  );
}

function extractClaudeCompletedTaskListResponse(text, options = {}) {
  const beforeEntries = parseClaudeCompletedTaskListEntries(options.beforeText);
  const beforeKeys = new Set(beforeEntries.map((entry) => entry.key));
  const newEntries = parseClaudeCompletedTaskListEntries(text).filter(
    (entry) => !beforeKeys.has(entry.key),
  );
  if (newEntries.length === 0) {
    return "";
  }
  const promptMatches = options.prompt
    ? newEntries.filter((entry) =>
        claudeTaskMatchesPrompt(entry, options.prompt),
      )
    : [];
  if (promptMatches.length > 0) {
    return promptMatches[0].response;
  }
  if (newEntries.length === 1) {
    return newEntries[0].response;
  }
  return newEntries.at(-1).response;
}

function hasClaudeCompletedTaskListResponse(text, options = {}) {
  return extractClaudeCompletedTaskListResponse(text, options).length > 0;
}

function hasTmuxAssistantResponseAfterPrompt(
  adapter,
  text,
  prompt,
  beforeText,
) {
  return (
    hasAssistantResponseAfterPrompt(adapter, text, prompt) ||
    (adapter.cli === "claude" &&
      hasClaudeCompletedTaskListResponse(text, {
        beforeText,
        prompt,
      }))
  );
}

async function capturePane(remote, session) {
  const { stdout } = await runTmux(remote, [
    "capture-pane",
    "-t",
    session,
    "-p",
    "-S",
    CAPTURE_START,
  ]);
  return stripAnsi(stdout);
}

async function captureVisible(remote, session) {
  // Visible pane only (no scrollback). Used for state detection so a stale
  // screen that scrolled off (e.g. the update prompt) cannot cause a false match.
  const { stdout } = await runTmux(remote, [
    "capture-pane",
    "-t",
    session,
    "-p",
  ]);
  return stripAnsi(stdout);
}

function isUpdatePrompt(text) {
  return /Update available/.test(text) && /Skip until next version/.test(text);
}

function isCodexTrustPrompt(text) {
  return String(text).includes("Do you trust the contents of this directory");
}

function isClaudeTrustPrompt(text) {
  return /Quick safety check|trust this folder/i.test(String(text));
}

function selectedLine(text) {
  // Menu selector glyphs only (exclude ASCII '>' which appears in codex's
  // "> You are in ..." trust-prompt header and would mis-target navigation).
  return (
    String(text)
      .split("\n")
      .find((line) => /^\s*[›❯▶▸]\s*/.test(line)) ?? ""
  );
}

function isUpdateNowLine(line) {
  return /Update now/.test(line);
}

function isSkipUntilNextVersionLine(line) {
  return /Skip until next version/.test(line) && !isUpdateNowLine(line);
}

function isSafeSkipLine(line) {
  return /\bSkip\b/.test(line) && !isUpdateNowLine(line);
}

async function dismissCodexTrustPrompt(remote, session) {
  let raw = await captureVisible(remote, session);
  if (!isCodexTrustPrompt(raw)) {
    return { dismissed: false, raw };
  }

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const selected = selectedLine(raw);
    if (/Yes, continue/.test(selected) && !/No, quit/.test(selected)) {
      await runTmux(remote, ["send-keys", "-t", session, "Enter"]);
      return { dismissed: true, raw };
    }

    await runTmux(remote, ["send-keys", "-t", session, "Down"]);
    await sleep(200);
    raw = await captureVisible(remote, session);
  }

  const selected = selectedLine(raw);
  if (/\bYes\b/.test(selected) && !/\bNo\b/.test(selected)) {
    await runTmux(remote, ["send-keys", "-t", session, "Enter"]);
    return { dismissed: true, raw };
  }

  return { dismissed: false, raw };
}

async function dismissCodexUpdatePrompt(remote, session) {
  let raw = await captureVisible(remote, session);
  if (!isUpdatePrompt(raw)) {
    return { dismissed: false, raw };
  }

  for (let iteration = 0; iteration < 4; iteration += 1) {
    await runTmux(remote, ["send-keys", "-t", session, "Down"]);
    await sleep(200);
    raw = await captureVisible(remote, session);

    const selected = selectedLine(raw);
    if (isSkipUntilNextVersionLine(selected)) {
      await runTmux(remote, ["send-keys", "-t", session, "Enter"]);
      return { dismissed: true, raw };
    }
  }

  const selected = selectedLine(raw);
  if (isSafeSkipLine(selected)) {
    await runTmux(remote, ["send-keys", "-t", session, "Enter"]);
    return { dismissed: true, raw };
  }

  return { dismissed: false, raw };
}

async function dismissClaudeTrustPrompt(remote, session) {
  let raw = await captureVisible(remote, session);
  if (!isClaudeTrustPrompt(raw)) {
    return { dismissed: false, raw };
  }

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const selected = selectedLine(raw);
    if (
      /(Yes, I trust this folder|\bYes\b)/.test(selected) &&
      !/(No, exit|\bNo\b)/.test(selected)
    ) {
      await runTmux(remote, ["send-keys", "-t", session, "Enter"]);
      return { dismissed: true, raw };
    }

    await runTmux(remote, ["send-keys", "-t", session, "Down"]);
    await sleep(200);
    raw = await captureVisible(remote, session);
  }

  const selected = selectedLine(raw);
  if (
    /(Yes, I trust this folder|\bYes\b)/.test(selected) &&
    !/(No, exit|\bNo\b)/.test(selected)
  ) {
    await runTmux(remote, ["send-keys", "-t", session, "Enter"]);
    return { dismissed: true, raw };
  }

  return { dismissed: false, raw };
}

const ADAPTERS = {
  codex: {
    cli: "codex",
    launchArgv: ["codex"],
    launchKeys: ["codex", "Enter"],
    resumeById: (id) => shellQuote(["codex", "resume", id]),
    resumeLast: () => shellQuote(["codex", "resume", "--last"]),
    composerGlyph: "›",
    isReady: isCodexReadyCapture,
    contextPct: parseCodexContextPct,
    isBusy: isBusyByEsc,
    isResponseLine: isCodexResponseLine,
    isStatusLine: isCodexStatusBulletLine,
    isChromeLine: isCodexChromeLine,
    stripResponseMarker: (line) => line.replace(/^\s*[•●]\s+/, ""),
    hasLoginGuard: () => false,
    startupScreens: [
      {
        name: "trust",
        isPresent: isCodexTrustPrompt,
        dismiss: dismissCodexTrustPrompt,
      },
      {
        name: "update",
        isPresent: isUpdatePrompt,
        dismiss: dismissCodexUpdatePrompt,
      },
    ],
  },
  claude: {
    cli: "claude",
    launchArgv: [
      "env",
      "DISABLE_OMC=1",
      "OMC_SKIP_HOOKS=all",
      "TFX_SKIP_HOOKS=1",
      "claude",
    ],
    launchKeys: [
      "DISABLE_OMC=1 OMC_SKIP_HOOKS=all TFX_SKIP_HOOKS=1 claude",
      "Enter",
    ],
    resumeById: (id) =>
      shellQuote([
        "DISABLE_OMC=1",
        "OMC_SKIP_HOOKS=all",
        "TFX_SKIP_HOOKS=1",
        "claude",
        "--resume",
        id,
      ]),
    resumeLast: () =>
      shellQuote([
        "DISABLE_OMC=1",
        "OMC_SKIP_HOOKS=all",
        "TFX_SKIP_HOOKS=1",
        "claude",
        "--continue",
      ]),
    composerGlyph: "❯",
    isReady: isClaudeReadyCapture,
    contextPct: parseClaudeContextPct,
    isBusy: isBusyByEsc,
    isResponseLine: isClaudeResponseLine,
    isStatusLine: isClaudeStatusLine,
    isChromeLine: isClaudeChromeLine,
    stripResponseMarker: (line) => line.replace(/^\s*⏺\s*/, ""),
    hasLoginGuard: hasClaudeLoginGuard,
    startupScreens: [
      {
        name: "trust",
        isPresent: isClaudeTrustPrompt,
        dismiss: dismissClaudeTrustPrompt,
      },
    ],
  },
};

async function dismissStartupScreens(adapter, remote, session) {
  let raw = "";
  let dismissed = false;

  for (let iteration = 0; iteration < 6; iteration += 1) {
    raw = await captureVisible(remote, session);

    const startupScreen = adapter.startupScreens.find((screen) =>
      screen.isPresent(raw),
    );
    if (!startupScreen) {
      break;
    }

    const result = await startupScreen.dismiss(remote, session);
    raw = result.raw;
    dismissed = dismissed || result.dismissed;
    if (!result.dismissed) {
      break;
    }
    await sleep(200);
  }

  return { dismissed, raw };
}

function isStartupScreen(adapter, text) {
  return adapter.startupScreens.some((screen) => screen.isPresent(text));
}

function addLoginGuard(adapter, raw, value) {
  if (!adapter.hasLoginGuard(raw)) {
    return value;
  }
  return {
    ...value,
    loginRequired: true,
  };
}

async function waitForReady(
  adapter,
  remote,
  session,
  timeoutMs,
  pollIntervalMs,
) {
  const startedAt = Date.now();
  let raw = "";

  while (Date.now() - startedAt < timeoutMs) {
    raw = await captureVisible(remote, session);
    if (isStartupScreen(adapter, raw)) {
      await dismissStartupScreens(adapter, remote, session);
      await sleep(pollIntervalMs);
      continue;
    }
    if (adapter.hasLoginGuard(raw)) {
      return { ready: false, raw };
    }
    if (adapter.isReady(raw)) {
      return { ready: true, raw };
    }
    await sleep(pollIntervalMs);
  }

  return { ready: false, raw };
}

function bundledBridgePath() {
  return fileURLToPath(new URL("../hub/bridge.mjs", import.meta.url));
}

function resolveBridgePath(flags) {
  // Resolution order: explicit flag, env override, repo root, then this
  // Triflux package's bundled hub/bridge.mjs. The bundled fallback is what
  // lets tfx-live be a first-class Triflux skill instead of depending on a
  // separate installed codex-live checkout.
  if (flags.bridge) {
    return flags.bridge;
  }
  if (process.env.TFX_BRIDGE) {
    return process.env.TFX_BRIDGE;
  }
  if (process.env.TFX_REPO_ROOT) {
    return pathJoin(process.env.TFX_REPO_ROOT, "hub", "bridge.mjs");
  }
  return bundledBridgePath();
}

function parseBridgeJson(stdout) {
  // Bridge verbs print one normalized JSON object. Tolerate leading log lines
  // by scanning from the end for the last complete JSON object.
  const text = String(stdout).trim();
  if (!text) {
    throw new Error("bridge returned empty output");
  }
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (line.startsWith("{") && line.endsWith("}")) {
        return JSON.parse(line);
      }
    }
    throw new Error(`bridge output is not JSON: ${text.slice(0, 200)}`);
  }
}

async function callBridgeVerb(bridgePath, verb, payload, timeoutMs) {
  if (!bridgePath) {
    throw new Error(
      "no bridge path resolved (set --bridge, TFX_BRIDGE, or TFX_REPO_ROOT)",
    );
  }
  const json = JSON.stringify(payload ?? {});
  const execTimeout =
    (timeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS) + BRIDGE_TIMEOUT_BUFFER_MS;
  let payloadFile = null;
  let args;
  if (json.length > PAYLOAD_FILE_THRESHOLD) {
    payloadFile = pathJoin(
      tmpdir(),
      `codex-live-payload-${process.pid}-${Date.now()}.json`,
    );
    await writeFile(payloadFile, json, "utf8");
    args = [bridgePath, verb, "--payload-file", payloadFile];
  } else {
    args = [bridgePath, verb, "--payload", json];
  }

  try {
    const { stdout } = await execFileAsync("node", args, {
      timeout: execTimeout,
      maxBuffer: MAX_BUFFER,
    });
    return parseBridgeJson(stdout);
  } catch (error) {
    // Bridge verbs report a failed request as a {ok:false,error} JSON on stdout
    // with a non-zero exit code. execFile rejects on non-zero exit, so recover
    // that structured result from error.stdout before treating it as a crash.
    if (error?.stdout) {
      try {
        return parseBridgeJson(error.stdout);
      } catch {
        // stdout was not JSON; fall through to the hard error below.
      }
    }
    const stderr = error?.stderr ? String(error.stderr).trim() : "";
    throw new Error(`bridge ${verb} failed: ${stderr || error.message}`);
  } finally {
    if (payloadFile) {
      await rm(payloadFile, { force: true }).catch(() => {});
    }
  }
}

async function probeDaemon(bridgePath, ref, timeoutMs) {
  if (!bridgePath) {
    return { ok: false, reason: "no-bridge-path" };
  }
  try {
    const payload = {};
    if (ref?.short) payload.short = ref.short;
    if (ref?.sessionId) payload.sessionId = ref.sessionId;
    if (ref?.configDir) payload.configDir = ref.configDir;
    const result = await callBridgeVerb(
      bridgePath,
      "daemon-probe",
      payload,
      timeoutMs,
    );
    return {
      ok: result?.ok === true,
      reason: result?.reason,
      sessions: result?.sessions,
      raw: result,
    };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

async function hasTmuxSession(adapter, opts) {
  if (!opts.session) return false;
  try {
    await runTmux(opts.remote, ["has-session", "-t", opts.session]);
    return true;
  } catch {
    return false;
  }
}

function daemonProbeUnavailableReason(probe, targetAttachable) {
  if (targetAttachable) return null;
  if (!probe?.ok) return probe?.reason ?? "probe-failed";
  return "target-not-found";
}

async function resolveAskTransport(adapter, opts, deps = {}) {
  const transport = opts.transport ?? "tmux";
  if (transport !== "auto") {
    return {
      transport,
      transportSelected: transport,
      transportProbe: null,
    };
  }

  const tmuxProbe = deps.hasTmuxSession ?? hasTmuxSession;
  const daemonProbe = deps.probeDaemon ?? probeDaemon;
  const [tmux, probe] = await Promise.all([
    tmuxProbe(adapter, opts),
    daemonProbe(
      opts.bridgePath,
      {
        short: opts.short,
        sessionId: opts.sessionId,
        configDir: opts.configDir,
      },
      opts.timeoutMs,
    ),
  ]);
  const daemon = daemonProbeTargetAttachable(probe, opts);
  const daemonReason = daemonProbeUnavailableReason(probe, daemon);
  const transportProbe = {
    tmux: tmux === true,
    daemon,
    ...(daemonReason ? { daemonReason } : {}),
  };

  return {
    transport: "auto",
    transportSelected: daemon ? "uds" : tmux ? "tmux" : "none",
    transportProbe,
    daemonProbe: probe,
    daemonConfigDir: opts.configDir ?? probe?.raw?.daemon?.configDir ?? null,
  };
}

async function doStart(adapter, opts) {
  const {
    session,
    remote,
    cwd,
    resume,
    resumeLast,
    readyTimeoutMs,
    pollIntervalMs,
  } = opts;
  const launchKeys = resume
    ? [adapter.resumeById(resume), "Enter"]
    : resumeLast
      ? [adapter.resumeLast(), "Enter"]
      : adapter.launchKeys;
  const resumed = Boolean(resume || resumeLast);
  const resumeTarget = resume ?? (resumeLast ? "last" : null);

  await runTmux(remote, [
    "new-session",
    "-d",
    "-s",
    session,
    ...(cwd ? ["-c", cwd] : []),
  ]);
  await runTmux(remote, ["send-keys", "-t", session, ...launchKeys]);
  await dismissStartupScreens(adapter, remote, session);

  const { ready, raw } = await waitForReady(
    adapter,
    remote,
    session,
    readyTimeoutMs,
    pollIntervalMs,
  );
  return addLoginGuard(adapter, raw, {
    cli: adapter.cli,
    session,
    remote: remote ?? null,
    resumed,
    resumeTarget,
    ready,
    raw,
  });
}

async function doAskViaTmux(adapter, opts) {
  const { session, prompt, remote, timeoutMs, settleMs, pollIntervalMs } = opts;
  const beforeRaw = await capturePane(remote, session);
  const contextPctBefore = adapter.contextPct(beforeRaw);

  await runTmux(remote, ["send-keys", "-t", session, "--", prompt]);
  await sleep(settleMs);
  await runTmux(remote, ["send-keys", "-t", session, "Enter"]);

  const startedAt = Date.now();
  let raw = "";
  let visible = "";
  let response = "";
  let contextPctAfter = null;
  let quietPolls = 0;
  let previousVisible = "";
  let done = false;

  while (Date.now() - startedAt < timeoutMs) {
    visible = await captureVisible(remote, session);
    contextPctAfter = adapter.contextPct(visible);

    quietPolls = visible === previousVisible ? quietPolls + 1 : 0;
    previousVisible = visible;

    const ready = adapter.isReady(visible);
    const doneSignal =
      !adapter.isBusy(visible) &&
      ready &&
      hasTmuxAssistantResponseAfterPrompt(adapter, visible, prompt, beforeRaw);
    if (doneSignal && quietPolls >= FALLBACK_QUIET_POLLS) {
      done = true;
      break;
    }

    await sleep(pollIntervalMs);
  }

  raw = await capturePane(remote, session);
  response = extractAssistantResponse(adapter, raw, prompt);
  if (!response && adapter.cli === "claude") {
    response = extractClaudeCompletedTaskListResponse(raw, {
      beforeText: beforeRaw,
      prompt,
    });
    if (response) {
      done = true;
    }
  }
  contextPctAfter = adapter.contextPct(raw);

  return addLoginGuard(adapter, raw, {
    cli: adapter.cli,
    session,
    remote: remote ?? null,
    transport: "tmux",
    response,
    contextPctBefore,
    contextPctAfter,
    matchedCompletion: done,
    done,
    raw,
  });
}

async function doAsk(adapter, opts) {
  const transport = opts.transport ?? "tmux";
  if (transport === "tmux") {
    return doAskViaTmux(adapter, opts);
  }

  // uds/auto attach a live background Claude daemon, not a tmux TUI.
  if (adapter.cli !== "claude") {
    throw new Error(
      `--transport ${transport} is only supported with --cli claude (daemon attach target)`,
    );
  }
  if (!opts.short && !opts.sessionId) {
    throw new Error(
      `--transport ${transport} requires --short or --session-id`,
    );
  }

  if (opts.remote) {
    return doAskViaRemoteLive(adapter, opts);
  }

  if (transport === "uds") {
    if (!opts.bridgePath) {
      throw new Error(
        "--transport uds requires a bridge path (--bridge, TFX_BRIDGE, or TFX_REPO_ROOT)",
      );
    }
    return doAskViaDaemon(opts);
  }

  return doAskAuto(adapter, opts);
}

async function doAskViaRemoteLive(adapter, opts, deps = {}) {
  const result = await callRemoteLive("ask", opts, deps);
  return {
    ...result,
    cli: result.cli ?? adapter.cli,
    remote: opts.remote,
    remoteRelay: true,
  };
}

async function doAskViaDaemon(opts, meta = {}) {
  const { bridgePath, prompt, timeoutMs, short, sessionId, configDir } = opts;
  const payload = { prompt, timeoutMs };
  if (short) payload.short = short;
  if (sessionId) payload.sessionId = sessionId;
  if (configDir) payload.configDir = configDir;

  const result = await callBridgeVerb(
    bridgePath,
    "daemon-attach",
    payload,
    timeoutMs,
  );
  // Contract: UDS success is matchedCompletion === true only. timedOut/closed
  // are surfaced but never counted as done.
  const matchedCompletion = result?.matchedCompletion === true;
  return {
    cli: "claude",
    transport: "uds",
    short: short ?? null,
    sessionId: sessionId ?? null,
    response: result?.text ?? "",
    raw: result?.raw ?? result?.responseRaw ?? "",
    matchedCompletion,
    timedOut: result?.timedOut === true,
    closed: result?.closed === true,
    inputSent: result?.inputSent === true,
    daemon: result?.daemon ?? null,
    daemons: result?.daemons ?? [],
    matches: result?.matches ?? [],
    candidateResults: result?.candidateResults ?? [],
    callerProvenance: result?.callerProvenance ?? null,
    done: matchedCompletion,
    ...(result?.error ? { error: result.error } : {}),
    ...meta,
  };
}

function daemonProbeTargetAttachable(probe, opts) {
  if (!probe?.ok) return false;
  // New bridge responses carry `target`; daemon-control owns selection policy.
  if (probe.raw?.target) return true;
  // Compatibility only for older bridge binaries that list sessions but do not
  // expose `target` yet. Do not add new selection semantics here.
  if (!Array.isArray(probe.sessions)) return false;
  return probe.sessions.some(
    (entry) =>
      (opts.short && entry?.short === opts.short) ||
      (opts.sessionId &&
        (entry?.sessionId === opts.sessionId ||
          entry?.session_id === opts.sessionId ||
          entry?.dispatch?.sessionId === opts.sessionId ||
          entry?.d?.sessionId === opts.sessionId)),
  );
}

async function ensureTmuxSession(adapter, opts) {
  if (!opts.session) return false;
  try {
    await runTmux(opts.remote, ["has-session", "-t", opts.session]);
    return false;
  } catch {
    await doStart(adapter, {
      session: opts.session,
      remote: opts.remote,
      cwd: opts.cwd,
      readyTimeoutMs: opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    });
    return true;
  }
}

function writeUdsBugReport(reason, context) {
  // Fire-and-forget structured report so a uds failure is never silently
  // swallowed. Returns a promise the caller flushes before returning, but the
  // tmux fallback runs in parallel without awaiting report I/O.
  const report = {
    ts: new Date().toISOString(),
    kind: "uds-fallback",
    reason,
    target: {
      short: context.short ?? null,
      sessionId: context.sessionId ?? null,
    },
    bridgePath: context.bridgePath ?? null,
    probe: context.probe
      ? {
          ok: context.probe.ok === true,
          reason: context.probe.reason ?? null,
          sessionCount: Array.isArray(context.probe.sessions)
            ? context.probe.sessions.length
            : 0,
          availableShorts: Array.isArray(context.probe.sessions)
            ? context.probe.sessions
                .map((entry) => entry?.short)
                .filter(Boolean)
            : [],
          // Diagnostic-only bridge metadata; callers should not depend on this
          // shape as a versioned control contract.
          daemon: context.probe.raw?.daemon ?? null,
          daemons: context.probe.raw?.daemons ?? [],
          matches: context.probe.raw?.matches ?? [],
          candidateResults: context.probe.raw?.candidateResults ?? [],
          callerProvenance: context.probe.raw?.callerProvenance ?? null,
        }
      : null,
    attachError: context.attachError ?? null,
    env: {
      TFX_BRIDGE: process.env.TFX_BRIDGE ?? null,
      TFX_REPO_ROOT: process.env.TFX_REPO_ROOT ?? null,
    },
  };
  const file = pathJoin(
    BUG_REPORT_DIR,
    `uds-fallback-${Date.now()}-${process.pid}.json`,
  );
  return mkdir(BUG_REPORT_DIR, { recursive: true })
    .then(() => writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8"))
    .then(() => file)
    .catch(() => null);
}

async function runTmuxFallback(adapter, opts, reason, udsResult) {
  const udsError = udsResult?.error ? { udsError: udsResult.error } : {};
  if (!opts.session) {
    return {
      cli: adapter.cli,
      transport: "auto",
      transportSelected: "none",
      transportProbe: reason,
      response: "",
      done: false,
      error: `uds unavailable (${reason}) and no --session for tmux fallback`,
      ...udsError,
    };
  }
  // Lazy start so a successful UDS run never leaves a blank extra session.
  const tmuxStartedOnDemand = await ensureTmuxSession(adapter, opts);
  const tmuxResult = await doAskViaTmux(adapter, opts);
  return {
    ...tmuxResult,
    transport: "auto",
    transportSelected: "tmux",
    transportProbe: reason,
    tmuxStartedOnDemand,
    ...udsError,
  };
}

async function doAskAuto(adapter, opts) {
  const resolution = await resolveAskTransport(adapter, opts);
  const probe = resolution.daemonProbe;

  if (resolution.transportSelected === "tmux") {
    const tmuxResult = await doAskViaTmux(adapter, opts);
    return {
      ...tmuxResult,
      transport: "auto",
      transportSelected: "tmux",
      transportProbe: resolution.transportProbe,
    };
  }

  if (resolution.transportSelected === "uds") {
    const daemonConfigDir = resolution.daemonConfigDir;
    const udsResult = await doAskViaDaemon(
      { ...opts, configDir: daemonConfigDir },
      {
        transportSelected: "uds",
        transportProbe: resolution.transportProbe,
      },
    );
    if (udsResult.matchedCompletion) {
      return udsResult;
    }
    // Daemon was reachable but the attach round did not complete (error,
    // timeout, or socket close). File a report async, then keep the user moving
    // on tmux instead of returning a dead uds result.
    const attachError = udsResult.error ?? {
      timedOut: udsResult.timedOut === true,
      closed: udsResult.closed === true,
    };
    const reportPromise = writeUdsBugReport("uds-attach-incomplete", {
      short: opts.short,
      sessionId: opts.sessionId,
      bridgePath: opts.bridgePath,
      probe,
      attachError,
    });
    const fallback =
      resolution.transportProbe?.tmux === true
        ? await runTmuxFallback(
            adapter,
            opts,
            "uds-attach-incomplete",
            udsResult,
          )
        : {
            cli: adapter.cli,
            transport: "auto",
            transportSelected: "none",
            transportProbe: resolution.transportProbe,
            response: "",
            done: false,
            error:
              "uds unavailable (uds-attach-incomplete) and no tmux session for fallback",
            udsError: udsResult.error ?? attachError,
          };
    await reportPromise.catch(() => {});
    return fallback;
  }

  // uds is unavailable: daemon unreachable, or reachable but target not listed.
  const reason = resolution.transportProbe?.daemonReason ?? "target-not-found";
  const reportPromise = writeUdsBugReport(reason, {
    short: opts.short,
    sessionId: opts.sessionId,
    bridgePath: opts.bridgePath,
    probe,
  });
  const fallback = {
    cli: adapter.cli,
    transport: "auto",
    transportSelected: "none",
    transportProbe: resolution.transportProbe,
    response: "",
    done: false,
    error: opts.session
      ? `uds unavailable (${reason}) and tmux session unavailable`
      : `uds unavailable (${reason}) and no --session for tmux fallback`,
  };
  await reportPromise.catch(() => {});
  return fallback;
}

async function doStop(adapter, opts) {
  const { session, remote } = opts;
  await runTmux(remote, ["kill-session", "-t", session]);
  return {
    cli: adapter.cli,
    session,
    remote: remote ?? null,
    stopped: true,
  };
}

async function doInterruptViaTmux(adapter, opts) {
  await runTmux(opts.remote, ["send-keys", "-t", opts.session, "Escape"]);
  return {
    cli: adapter.cli,
    session: opts.session,
    remote: opts.remote ?? null,
    transport: "tmux",
    done: false,
    aborted: true,
    reason: "user_interrupt",
  };
}

async function doInterruptViaDaemon(opts, meta = {}) {
  const { bridgePath, timeoutMs, short, sessionId, configDir } = opts;
  const payload = { timeoutMs };
  if (short) payload.short = short;
  if (sessionId) payload.sessionId = sessionId;
  if (configDir) payload.configDir = configDir;
  const result = await callBridgeVerb(
    bridgePath,
    "daemon-interrupt",
    payload,
    timeoutMs,
  );
  const aborted = result?.aborted === true;
  return {
    cli: "claude",
    transport: "uds",
    short: short ?? null,
    sessionId: sessionId ?? null,
    done: false,
    aborted,
    reason: result?.reason ?? (aborted ? "user_interrupt" : "interrupt_failed"),
    inputSent: result?.inputSent === true,
    timedOut: result?.timedOut === true,
    closed: result?.closed === true,
    daemon: result?.daemon ?? null,
    daemons: result?.daemons ?? [],
    matches: result?.matches ?? [],
    candidateResults: result?.candidateResults ?? [],
    callerProvenance: result?.callerProvenance ?? null,
    ...(result?.error ? { error: result.error } : {}),
    ...meta,
  };
}

async function doInterruptViaRemoteLive(adapter, opts, deps = {}) {
  const result = await callRemoteLive("interrupt", opts, deps);
  return {
    ...result,
    cli: result.cli ?? adapter.cli,
    remote: opts.remote,
    remoteRelay: true,
  };
}

async function doInterrupt(adapter, opts) {
  const transport = opts.transport ?? "tmux";
  if (transport === "tmux") {
    return doInterruptViaTmux(adapter, opts);
  }
  if (adapter.cli !== "claude") {
    throw new Error(
      `--transport ${transport} is only supported with --cli claude (daemon interrupt target)`,
    );
  }
  if (!opts.short && !opts.sessionId) {
    throw new Error(
      `--transport ${transport} requires --short or --session-id`,
    );
  }
  if (opts.remote) {
    return doInterruptViaRemoteLive(adapter, opts);
  }
  if (!opts.bridgePath) {
    throw new Error(
      `--transport ${transport} requires a bridge path (--bridge, TFX_BRIDGE, or TFX_REPO_ROOT)`,
    );
  }
  if (transport === "uds") {
    return doInterruptViaDaemon(opts);
  }

  const udsResult = await doInterruptViaDaemon(opts, {
    transportSelected: "uds",
  });
  if (udsResult.aborted) {
    return { ...udsResult, transport: "auto" };
  }
  if (opts.session) {
    const tmuxResult = await doInterruptViaTmux(adapter, opts);
    return {
      ...tmuxResult,
      transport: "auto",
      transportSelected: "tmux",
      transportProbe: "uds-interrupt-failed",
      udsError: udsResult.error ?? udsResult.reason,
    };
  }
  return {
    ...udsResult,
    transport: "auto",
    transportSelected: "none",
  };
}

function startOpts(flags) {
  return {
    session: requireFlag(flags, "session"),
    remote: flags.remote,
    cwd: flags.cwd,
    resume: flags.resume,
    resumeLast: Object.hasOwn(flags, "resume-last"),
    readyTimeoutMs: secondsFlag(
      flags,
      "ready-timeout",
      DEFAULT_READY_TIMEOUT_MS,
    ),
    pollIntervalMs: msFlag(flags, "poll-interval", DEFAULT_POLL_INTERVAL_MS),
  };
}

function hasDaemonRef(short, sessionId) {
  return Boolean(short || sessionId);
}

function defaultTransportFor(adapter, short, sessionId) {
  // UDS-first by default only when a Claude daemon ref exists. Everything else
  // keeps the historical tmux path, so Codex targets and ordinary Claude tmux
  // sessions remain backwards compatible.
  return adapter.cli === "claude" && hasDaemonRef(short, sessionId)
    ? "auto"
    : "tmux";
}

function transportFlag(flags, adapter, short, sessionId) {
  const transport =
    flags.transport ?? defaultTransportFor(adapter, short, sessionId);
  if (!VALID_TRANSPORTS.includes(transport)) {
    throw new Error(
      `--transport must be one of: ${VALID_TRANSPORTS.join(", ")}`,
    );
  }
  return transport;
}

function askOpts(flags, adapter) {
  const short = flags.short;
  const sessionId = flags["session-id"];
  const transport = transportFlag(flags, adapter, short, sessionId);
  if (transport !== "tmux" && !short && !sessionId) {
    throw new Error(
      `--transport ${transport} requires --short or --session-id`,
    );
  }
  return {
    // tmux needs a tmux session name; uds needs a daemon ref (short/sessionId);
    // auto can take both (daemon ref to probe, tmux session for fallback).
    session:
      transport === "tmux" ? requireFlag(flags, "session") : flags.session,
    short,
    sessionId,
    configDir: flags["config-dir"],
    transport,
    bridgePath: resolveBridgePath(flags),
    prompt: requireFlag(flags, "prompt"),
    remote: flags.remote,
    timeoutMs: secondsFlag(flags, "timeout", DEFAULT_ANSWER_TIMEOUT_MS),
    settleMs: msFlag(flags, "settle", DEFAULT_SETTLE_MS),
    pollIntervalMs: msFlag(flags, "poll-interval", DEFAULT_POLL_INTERVAL_MS),
  };
}

function stopOpts(flags) {
  return {
    session: requireFlag(flags, "session"),
    remote: flags.remote,
  };
}

function interruptOpts(flags, adapter) {
  const short = flags.short;
  const sessionId = flags["session-id"];
  const transport = transportFlag(flags, adapter, short, sessionId);
  return {
    session:
      transport === "tmux" ? requireFlag(flags, "session") : flags.session,
    short,
    sessionId,
    configDir: flags["config-dir"],
    transport,
    bridgePath: resolveBridgePath(flags),
    remote: flags.remote,
    timeoutMs: secondsFlag(flags, "timeout", 5000),
  };
}

async function start(flags) {
  const adapter = selectAdapter(flags);
  printJson(await doStart(adapter, startOpts(flags)));
}

async function ask(flags) {
  const adapter = selectAdapter(flags);
  printJson(await doAsk(adapter, askOpts(flags, adapter)));
}

async function stop(flags) {
  const adapter = selectAdapter(flags);
  printJson(await doStop(adapter, stopOpts(flags)));
}

async function interrupt(flags) {
  const adapter = selectAdapter(flags);
  printJson(await doInterrupt(adapter, interruptOpts(flags, adapter)));
}

async function probe(flags) {
  const payload = {};
  if (flags.short) payload.short = flags.short;
  if (flags["session-id"]) payload.sessionId = flags["session-id"];
  if (flags["config-dir"]) payload.configDir = flags["config-dir"];
  const timeoutMs = secondsFlag(flags, "timeout", 10_000);
  printJson(
    await callBridgeVerb(
      resolveBridgePath(flags),
      "daemon-probe",
      payload,
      timeoutMs,
    ),
  );
}

function startOptsForSession(flags, session) {
  return {
    session,
    remote: flags.remote,
    cwd: flags.cwd,
    readyTimeoutMs: secondsFlag(
      flags,
      "ready-timeout",
      DEFAULT_READY_TIMEOUT_MS,
    ),
    pollIntervalMs: msFlag(flags, "poll-interval", DEFAULT_POLL_INTERVAL_MS),
  };
}

function askOptsForSession(flags, session, prompt) {
  return {
    session,
    prompt,
    remote: flags.remote,
    timeoutMs: secondsFlag(flags, "timeout", DEFAULT_ANSWER_TIMEOUT_MS),
    settleMs: msFlag(flags, "settle", DEFAULT_SETTLE_MS),
    pollIntervalMs: msFlag(flags, "poll-interval", DEFAULT_POLL_INTERVAL_MS),
  };
}

function stopOptsForSession(flags, session) {
  return {
    session,
    remote: flags.remote,
  };
}

async function readPromptsFile(path) {
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function stopAfterLifecycle(stopSpecs, primaryError = null) {
  let stopError = null;
  for (const { adapter, opts } of stopSpecs) {
    try {
      await doStop(adapter, opts);
    } catch (error) {
      stopError ??= error;
    }
  }

  if (primaryError) {
    throw primaryError;
  }
  if (stopError) {
    throw stopError;
  }
}

function turnFromAsk(prompt, result) {
  return {
    prompt,
    response: result.response,
    done: result.done,
  };
}

function hasDoneToken(response, doneToken) {
  return String(response)
    .split(/\r?\n/)
    .some((line) => line.trim() === doneToken);
}

function parseFirstInteger(response) {
  const match = String(response).match(/-?\d+/);
  return match ? Number(match[0]) : null;
}

async function converse(flags) {
  const adapter = selectAdapter(flags);
  const session = requireFlag(flags, "session");
  const promptsFile = requireFlag(flags, "prompts-file");
  const prompts = await readPromptsFile(promptsFile);
  const turns = [];
  let primaryError = null;

  try {
    await doStart(adapter, startOptsForSession(flags, session));
    for (const prompt of prompts) {
      const result = await doAsk(
        adapter,
        askOptsForSession(flags, session, prompt),
      );
      turns.push(turnFromAsk(prompt, result));
    }
  } catch (error) {
    primaryError = error;
  } finally {
    await stopAfterLifecycle(
      [{ adapter, opts: stopOptsForSession(flags, session) }],
      primaryError,
    );
  }

  printJson({
    cli: adapter.cli,
    session,
    remote: flags.remote ?? null,
    turns,
    stopped: true,
  });
}

async function goalDriven(flags) {
  const adapter = selectAdapter(flags);
  const session = requireFlag(flags, "session");
  const goal = requireFlag(flags, "goal");
  const maxRounds = integerFlag(flags, "max-rounds", 8);
  const doneToken = flags["done-token"] ?? "DONE";
  const turns = [];
  let doneTokenSeen = false;
  let primaryError = null;

  try {
    await doStart(adapter, startOptsForSession(flags, session));
    for (let round = 1; round <= maxRounds; round += 1) {
      const prompt =
        round === 1
          ? `${goal}\n\nWhen you have FULLY completed this, reply with a line containing only the token ${doneToken}. Otherwise do the next step and end by asking to proceed.`
          : `Continue. Reply with only ${doneToken} on its own line when fully complete.`;
      const result = await doAsk(
        adapter,
        askOptsForSession(flags, session, prompt),
      );
      turns.push(turnFromAsk(prompt, result));
      if (hasDoneToken(result.response, doneToken)) {
        doneTokenSeen = true;
        break;
      }
    }
  } catch (error) {
    primaryError = error;
  } finally {
    await stopAfterLifecycle(
      [{ adapter, opts: stopOptsForSession(flags, session) }],
      primaryError,
    );
  }

  printJson({
    cli: adapter.cli,
    session,
    rounds: turns.length,
    doneTokenSeen,
    turns,
    stopped: true,
  });
}

function peerMode(flags) {
  const mode = flags.mode ?? "counting";
  if (!["counting", "freeform"].includes(mode)) {
    throw new Error("--mode must be one of: counting, freeform");
  }
  return mode;
}

function peerPrompt(mode, hopIndex, previous) {
  if (mode === "counting") {
    if (hopIndex === 0) {
      return "Reply with only the integer 1.";
    }
    return `The current integer is ${previous}. Add 1 to it and reply with ONLY the resulting integer, nothing else.`;
  }

  if (hopIndex === 0) {
    return previous;
  }
  return `The other party said: ${previous}\nReply briefly in 1-2 sentences and ask one short follow-up question.`;
}

function sideFlag(flags, side, name, fallback = undefined) {
  const sideValue = flags[`${name}-${side}`];
  if (sideValue !== undefined) return sideValue;
  return flags[name] !== undefined ? flags[name] : fallback;
}

function peerSideTransport(flags, side, adapter) {
  const explicit = flags[`transport-${side}`];
  const globalTransport = flags.transport;
  const short = sideFlag(flags, side, "short");
  const sessionId = sideFlag(flags, side, "session-id");
  const transport =
    explicit ??
    (adapter.cli === "claude"
      ? (globalTransport ?? defaultTransportFor(adapter, short, sessionId))
      : undefined) ??
    "tmux";
  if (!VALID_TRANSPORTS.includes(transport)) {
    throw new Error(
      `--transport-${side} must be one of: ${VALID_TRANSPORTS.join(", ")}`,
    );
  }
  if (transport !== "tmux" && adapter.cli !== "claude") {
    throw new Error(
      `--transport-${side} ${transport} is only supported when --cli-${side} is claude`,
    );
  }
  return transport;
}

function peerSideBaseOpts(flags, side, adapter, session) {
  const transport = peerSideTransport(flags, side, adapter);
  const short = sideFlag(flags, side, "short");
  const sessionId = sideFlag(flags, side, "session-id");
  if (transport !== "tmux" && !short && !sessionId) {
    throw new Error(
      `--transport-${side} ${transport} requires --short-${side} or --session-id-${side}`,
    );
  }
  return {
    session,
    short,
    sessionId,
    transport,
    bridgePath: sideFlag(flags, side, "bridge", resolveBridgePath(flags)),
    remote: flags.remote,
    cwd: flags.cwd,
    timeoutMs: secondsFlag(flags, "timeout", DEFAULT_ANSWER_TIMEOUT_MS),
    settleMs: msFlag(flags, "settle", DEFAULT_SETTLE_MS),
    pollIntervalMs: msFlag(flags, "poll-interval", DEFAULT_POLL_INTERVAL_MS),
    readyTimeoutMs: secondsFlag(
      flags,
      "ready-timeout",
      DEFAULT_READY_TIMEOUT_MS,
    ),
  };
}

function askOptsFromPeerBase(base, prompt) {
  return { ...base, prompt };
}

function shouldPrestartPeerSide(base) {
  return base.transport === "tmux";
}

function addStopSpecOnce(stopSpecs, adapter, opts) {
  if (!opts.session) return;
  const exists = stopSpecs.some(
    (spec) =>
      spec.adapter === adapter &&
      spec.opts.session === opts.session &&
      spec.opts.remote === opts.remote,
  );
  if (!exists) {
    stopSpecs.push({
      adapter,
      opts: stopOptsForSession({ remote: opts.remote }, opts.session),
    });
  }
}

async function peer(flags) {
  const adapterA = selectAdapterName(flags["cli-a"] ?? "codex", "cli-a");
  const adapterB = selectAdapterName(flags["cli-b"] ?? "claude", "cli-b");
  const sessionA = flags["session-a"] ?? "peerA";
  const sessionB = flags["session-b"] ?? "peerB";
  const baseA = peerSideBaseOpts(flags, "a", adapterA, sessionA);
  const baseB = peerSideBaseOpts(flags, "b", adapterB, sessionB);
  const rounds = integerFlag(flags, "rounds", 4);
  const mode = peerMode(flags);
  const hops = [];
  const numbers = [];
  const stopSpecs = [];
  let previous =
    mode === "freeform"
      ? (flags.seed ??
        "Introduce yourself in one sentence, then ask the other party one short question.")
      : null;
  let primaryError = null;

  try {
    if (shouldPrestartPeerSide(baseA)) {
      await doStart(adapterA, startOptsForSession(flags, sessionA));
      addStopSpecOnce(stopSpecs, adapterA, baseA);
    }
    if (shouldPrestartPeerSide(baseB)) {
      await doStart(adapterB, startOptsForSession(flags, sessionB));
      addStopSpecOnce(stopSpecs, adapterB, baseB);
    }

    // A round is one full A+B cycle, so total hops are rounds * 2.
    // Each hop sends the previous hop's response as a real prompt into the
    // opposite agent via that side's selected transport. The final response is
    // returned in JSON, but all intermediate collaboration happens as prompts.
    for (let hopIndex = 0; hopIndex < rounds * 2; hopIndex += 1) {
      const isA = hopIndex % 2 === 0;
      const adapter = isA ? adapterA : adapterB;
      const base = isA ? baseA : baseB;
      const sent = peerPrompt(mode, hopIndex, previous);
      const result = await doAsk(adapter, askOptsFromPeerBase(base, sent));
      if (result.tmuxStartedOnDemand) {
        addStopSpecOnce(stopSpecs, adapter, base);
      }

      hops.push({
        hop: hopIndex + 1,
        from: isA ? "a" : "b",
        cli: adapter.cli,
        transport: result.transport ?? base.transport,
        transportSelected: result.transportSelected,
        transportProbe: result.transportProbe,
        sent,
        response: result.response,
        done: result.done,
        aborted: result.aborted === true ? true : undefined,
        reason: result.reason,
      });

      if (mode === "counting") {
        const parsed = parseFirstInteger(result.response);
        if (parsed === null) {
          throw new Error(
            `Could not parse integer from ${adapter.cli} response at hop ${hopIndex + 1}`,
          );
        }
        numbers.push(parsed);
        previous = parsed;
      } else {
        previous = result.response;
      }
    }
  } catch (error) {
    primaryError = error;
  } finally {
    await stopAfterLifecycle(stopSpecs, primaryError);
  }

  const output = {
    mode,
    rounds,
    cliA: adapterA.cli,
    cliB: adapterB.cli,
    transportA: baseA.transport,
    transportB: baseB.transport,
    hops,
  };
  if (mode === "counting") {
    output.numbers = numbers;
  }
  output.stoppedA = true;
  output.stoppedB = true;
  printJson(output);
}

const ORCHESTRATION_MODES = ["peer", "codex-led", "claude-led"];
const CODEX_ORCH_TRANSPORTS = ["exec", "app-server-uds"];

async function orchestrate(flags) {
  const mode = flags.mode ?? "peer";
  if (!ORCHESTRATION_MODES.includes(mode)) {
    throw new Error(`--mode must be one of: ${ORCHESTRATION_MODES.join(", ")}`);
  }
  const task = requireFlag(flags, "task");
  const codexTransport = flags["codex-transport"] ?? "exec";
  if (!CODEX_ORCH_TRANSPORTS.includes(codexTransport)) {
    throw new Error(
      `--codex-transport must be one of: ${CODEX_ORCH_TRANSPORTS.join(", ")}`,
    );
  }
  const cwd = flags.cwd ?? process.cwd();
  const timeoutMs = secondsFlag(flags, "timeout", 120_000);

  // Lazy import keeps the orchestration engine (and its hub/team deps) off the
  // hot path for every other thin-CLI verb; only `orchestrate` pays the cost.
  const orchestratorUrl = new URL(
    "../hub/team/uds-orchestrator.mjs",
    import.meta.url,
  ).href;
  const {
    runUdsOrchestration,
    createClaudeUdsEndpoint,
    createCodexExecEndpoint,
    createCodexAppServerUdsEndpoint,
  } = await import(orchestratorUrl);

  const claude = createClaudeUdsEndpoint({ cwd, timeoutMs });
  const codex =
    codexTransport === "app-server-uds"
      ? createCodexAppServerUdsEndpoint({ cwd, timeoutMs })
      : createCodexExecEndpoint({ workdir: cwd, timeout: timeoutMs });

  const result = await runUdsOrchestration({ mode, task, claude, codex });
  printJson({ codexTransport, ...result });
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const { command, flags } = parseCli(process.argv.slice(2));

  if (command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (command === "start") {
    await start(flags);
  } else if (command === "ask") {
    await ask(flags);
  } else if (command === "stop") {
    await stop(flags);
  } else if (command === "interrupt") {
    await interrupt(flags);
  } else if (command === "probe") {
    await probe(flags);
  } else if (command === "converse") {
    await converse(flags);
  } else if (command === "goal-driven") {
    await goalDriven(flags);
  } else if (command === "peer") {
    await peer(flags);
  } else if (command === "orchestrate") {
    await orchestrate(flags);
  } else {
    throw new Error(`Unknown subcommand: ${command}\n${usage()}`);
  }
}

export {
  ADAPTERS,
  buildRemoteLiveCommand,
  callRemoteLive,
  extractAssistantResponse,
  extractClaudeCompletedTaskListResponse,
  hasClaudeCompletedTaskListResponse,
  parseRemoteLiveJson,
  resolveAskTransport,
};

const isDirectRun =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === pathResolve(process.argv[1]);

if (isDirectRun) {
  main().catch((error) => {
    printJson({
      ok: false,
      error: error.message,
    });
    process.exitCode = 1;
  });
}
