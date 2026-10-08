#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join as pathJoin, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  codexThreadNames,
  readCodexSessionRecords,
  registryDir,
} from "../hub/lib/codex-session-registry.mjs";
import { resolveHardCeilingMs } from "../hub/lib/worker-lifecycle.mjs";
import { exposeLiveSession } from "../hub/team/agents-row.mjs";
import {
  claudeWaitVerdict,
  findClaudeTranscript,
  readClaudeTranscript,
} from "../hub/team/claude-transcript.mjs";
import {
  codexThreadIdByName,
  countCodexTuiInCwd,
  deleteCodexQueueItems,
  findCodexThreadByCwd,
  isCodexThreadId,
  listCodexQueue,
  queueCodexMessage,
  resolveSenderName,
  waitCodexRequest,
} from "../hub/team/codex-queue.mjs";
import {
  escapePwshSingleQuoted as escapeRemotePwshSingleQuoted,
  probeRemoteEnv as probeRemoteHostEnv,
  shellQuote as remoteShellQuote,
  validateHost as validateRemoteHost,
} from "../hub/team/remote-session.mjs";
import {
  CONTEXT_THRESHOLDS,
  contextGuard,
  findCodexRollout,
  modelContext,
  readCodexContext,
} from "../hub/team/session-context.mjs";

const execFileAsync = promisify(execFile);

const DEFAULT_SETTLE_MS = 1500;
const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_ANSWER_TIMEOUT_MS = 60_000;
const FALLBACK_QUIET_POLLS = 3;
const PROMPT_SUBMIT_MAX_ATTEMPTS = 3;
const PROMPT_SUBMIT_RETRY_DELAY_MS = 100;
const PROMPT_COMPOSER_NEEDLE_LENGTH = 30;
// Capture the complete pane history so a long TUI response does not lose its
// leading lines. runTmux's MAX_BUFFER remains the memory/output ceiling.
const CAPTURE_START = "-";
const MAX_BUFFER = 10 * 1024 * 1024;
// execFile timeout for a bridge verb = attach timeout + this buffer, so the
// helper's own timeoutMs fires first and returns {timedOut:true} rather than
// execFile killing the process with a less useful error.
const BRIDGE_TIMEOUT_BUFFER_MS = 15_000;
// Above this size an argv-passed --payload risks E2BIG on some platforms;
// spill the JSON to a temp file and pass --payload-file instead.
const PAYLOAD_FILE_THRESHOLD = 96 * 1024;
const VALID_TRANSPORTS = ["tmux", "uds", "auto", "queue"];
const BOOLEAN_FLAGS = new Set([
  "json",
  "attach-a",
  "attach-b",
  "no-wait",
  "no-relay-tag",
]);
const PEER_HOP_DONE_MARKER = "<<<TFX_PEER_HOP_DONE>>>";
// uds-fallback diagnostics land here, written async so a failed daemon attach
// never blocks the tmux fallback path (see writeUdsBugReport / doAskAuto).
const BUG_REPORT_DIR =
  process.env.TFX_LIVE_BUG_REPORT_DIR ??
  pathJoin(homedir(), ".claude", "cache", "triflux", "tfx-live", "bug-reports");

function usage(command) {
  const lines = [
    "Usage:",
    "  tfx-live start --session NAME [--name NAME] [--cli codex|claude] [--model ID] [--effort TIER] [--cwd DIR] [--remote HOST] [--resume ID] [--resume-last 1] [--ready-timeout 30] [--poll-interval 1500]",
    "  tfx-live ask --session NAME[:WINDOW.PANE] --prompt TEXT [--cli codex|claude] [--if-busy wait|fail|interrupt] [--busy-timeout 60] [--timeout 60] [--remote HOST] [--settle 1500] [--poll-interval 1500]",
    "  tfx-live ask --cli codex [--transport queue|tmux] (--session NAME[:WINDOW.PANE] | --thread UUID) --prompt TEXT [--from NAME] [--timeout 60] [--no-wait]",
    "    Codex ask defaults to `codex queue` (queued, delivered when the TUI picks it up); tmux paste is the reported fallback and the path for slash commands.",
    "  tfx-live ask --cli codex --transport uds --thread ID|auto --prompt TEXT [--codex-socket PATH|default] [--cwd DIR] [--if-busy wait|fail|steer] [--busy-timeout 60] [--timeout 60] [--max-turn SECONDS]",
    "  tfx-live ask --transport uds|auto (--short SHORT | --session-id ID) --prompt TEXT [--config-dir DIR] [--bridge ABS] [--session NAME (auto fallback)] [--timeout 60]",
    "    ask options: --no-wait --no-relay-tag --warn-context-pct N --max-context-pct N (0 disables; Claude 60/90, Codex 15/22).",
    "  tfx-live compact --cli claude --session NAME [--instructions TEXT] [--if-busy fail|wait] [--timeout 60]",
    "  tfx-live wait --cli claude (--short SHORT | --session-id ID | --session NAME[:WINDOW.PANE]) [--request-id ID] [--config-dir DIR] [--bridge ABS] [--timeout 60] [--poll-interval 1500]",
    "  tfx-live wait --cli codex (--session NAME[:WINDOW.PANE] | --thread UUID) --request-id ID [--timeout 60] [--poll-interval 1500]",
    "  tfx-live queue --cli codex (--session NAME[:WINDOW.PANE] | --thread UUID) [--request-id ID] [--delete QUEUED_ID|all]",
    "    queue lists or deletes items the TUI has not picked up yet (official app-server thread/queue API); missing means already delivered or gone.",
    "  tfx-live rename --cli codex --transport uds --thread ID --name NAME [--codex-socket PATH|default]",
    "    transport: auto is the default for Claude when --short/--session-id is present; otherwise tmux. bridge path: --bridge > $TFX_BRIDGE > $TFX_REPO_ROOT/hub/bridge.mjs > bundled Triflux hub/bridge.mjs.",
    "  tfx-live interrupt --session NAME [--cli codex|claude] [--transport tmux|uds|auto] [--short SHORT | --session-id ID] [--config-dir DIR] [--bridge ABS] [--timeout 5]",
    "  tfx-live stop --session NAME [--cli codex|claude] [--remote HOST]",
    "  tfx-live stop --cli claude (--short SHORT | --session-id ID) [--config-dir DIR]",
    "  tfx-live probe [--short SHORT] [--session-id ID] [--config-dir DIR] [--bridge ABS] [--timeout 10]",
    "  tfx-live list-sessions --cli codex|claude [--transport tmux|uds] [--codex-socket PATH|default] [--cwd DIR] [--remote HOST (codex tmux only)]",
    "    Claude list-sessions supports local tmux only; --transport uds requires --cli codex.",
    "  tfx-live converse --session NAME --prompts-file PATH [--cli codex|claude] [--remote HOST] [--cwd DIR] [--timeout 60] [--settle 1500]",
    "  tfx-live goal-driven --session NAME --goal TEXT [--cli codex|claude] [--remote HOST] [--cwd DIR] [--timeout 60] [--settle 1500] [--max-rounds 8] [--done-token DONE]",
    "  tfx-live peer [--cli-a codex] [--cli-b claude] [--model-a ID] [--model-b ID] [--effort-a TIER] [--effort-b TIER] [--session-a NAME[:WINDOW.PANE]] [--session-b NAME[:WINDOW.PANE]] [--attach-a] [--attach-b] [--transport-a tmux|uds|auto] [--transport-b tmux|uds|auto] [--short-a SHORT] [--short-b SHORT] [--session-id-a ID] [--session-id-b ID] [--thread-a ID|auto] [--thread-b ID|auto] [--codex-socket-a PATH|default] [--codex-socket-b PATH|default] [--bridge ABS] [--remote HOST] [--cwd DIR] [--if-busy wait|fail] [--if-busy-a POLICY] [--if-busy-b POLICY] [--busy-timeout 60] [--max-turn SECONDS] [--rounds 4] [--mode counting|freeform] [--seed TEXT] [--timeout 60]",
    "    Codex TUI may use a shared app-server daemon. UDS ask resumes the thread to receive answer events; sending to an active thread with --if-busy steer merges input into that turn.",
  ];
  if (!command) return lines.join("\n");
  const selected = lines.filter(
    (line) =>
      line.startsWith(`  tfx-live ${command} `) ||
      (command === "ask" && line.startsWith("    ask options:")),
  );
  return selected.length
    ? ["Usage:", ...selected].join("\n")
    : lines.join("\n");
}

function parseCli(argv) {
  if (argv.some((arg) => arg === "--help" || arg === "-h")) {
    return { command: "help", flags: { subcommand: argv[0] } };
  }
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

function contextPctFlag(flags, name, defaultValue) {
  const value = flags[name] === undefined ? defaultValue : Number(flags[name]);
  if (!Number.isFinite(value) || value < 0 || value > 100)
    throw new Error(`--${name} must be between 0 and 100`);
  return value;
}

function contextOpts(flags, cli) {
  return {
    warnContextPct: contextPctFlag(
      flags,
      "warn-context-pct",
      CONTEXT_THRESHOLDS[cli].warnContextPct,
    ),
    maxContextPct: contextPctFlag(
      flags,
      "max-context-pct",
      CONTEXT_THRESHOLDS[cli].maxContextPct,
    ),
  };
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
    opts.cli ?? "claude",
    "--transport",
    opts.transport ?? "uds",
  ];
  if (opts.short) args.push("--short", opts.short);
  if (opts.sessionId) args.push("--session-id", opts.sessionId);
  if (opts.session) args.push("--session", opts.session);
  if (opts.configDir) args.push("--config-dir", opts.configDir);
  if (opts.threadId) args.push("--thread", opts.threadId);
  if (opts.codexSocket) args.push("--codex-socket", opts.codexSocket);
  if (opts.cwd) args.push("--cwd", opts.cwd);
  if (opts.ifBusy) args.push("--if-busy", opts.ifBusy);
  if (opts.busyTimeoutMs)
    args.push("--busy-timeout", String(opts.busyTimeoutMs / 1000));
  if (opts.maxTurnMs) args.push("--max-turn", String(opts.maxTurnMs / 1000));
  if (verb === "ask") {
    args.push("--prompt", opts.prompt ?? "");
    if (opts.noWait) args.push("--no-wait");
    if (opts.noRelayTag) args.push("--no-relay-tag");
    if (opts.requestId) args.push("--request-id", opts.requestId);
    if (opts.maxContextPct !== undefined)
      args.push("--max-context-pct", String(opts.maxContextPct));
    if (opts.warnContextPct !== undefined)
      args.push("--warn-context-pct", String(opts.warnContextPct));
  }
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
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS;
  const codexUds =
    verb === "ask" &&
    opts.cli === "codex" &&
    (opts.transport ?? "uds") === "uds";
  const maxTurnMs = codexUds
    ? (opts.maxTurnMs ?? Math.min(resolveHardCeilingMs(), 15 * 60_000))
    : 0;
  const execOptions = {
    timeout:
      (verb === "ask" ? (opts.busyTimeoutMs ?? timeoutMs) : 0) +
      // Codex checks its hard ceiling on a timeoutMs tick.
      maxTurnMs +
      timeoutMs +
      30_000,
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

function normalizeCwd(value) {
  if (!value) return null;
  const resolved = pathResolve(value);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function splitTmuxTarget(value) {
  const target = String(value ?? "");
  const session = target.split(":", 1)[0];
  if (!session)
    throw new Error("tmux target requires a session name before ':'");
  return { session, target };
}

function tmuxBufferName(target) {
  return `tfx-live-prompt-${target.replace(/[^A-Za-z0-9_-]/g, "_")}-${Date.now()}`;
}

function resolveCodexDaemonSocket(value = "default") {
  const socketPath =
    value === "default"
      ? pathJoin(
          process.env.CODEX_HOME ?? pathJoin(homedir(), ".codex"),
          "app-server-control",
          "app-server-control.sock",
        )
      : pathResolve(value);
  try {
    if (statSync(socketPath).isSocket()) return socketPath;
  } catch {
    /* handled below */
  }
  throw new Error(
    `Codex daemon socket unavailable: ${socketPath}. Start it with codex app-server daemon start`,
  );
}

function isCodexTmuxPane(currentCommand, startCommand) {
  const current = String(currentCommand ?? "").trim();
  const currentBase = current.split("/").at(-1);
  if (currentBase === "codex") {
    return true;
  }

  const started = String(startCommand ?? "").trim();
  const directStart = started
    .replace(/^exec\s+/, "")
    .replace(/^['"]|['"]$/g, "");
  if (/^(?:\S*\/)?codex(?:\s|$)/.test(directStart)) {
    return true;
  }

  return (
    /\bomx_codex_pid\b/.test(started) &&
    /(?:^|[\s'""])(?:[^'" \t]+\/)?codex(?:[\s'"]|$)/.test(started)
  );
}

function isCodexProcessCommand(command) {
  const argv = (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((arg) =>
    arg.replace(/^["']|["']$/g, ""),
  );
  const isCodexPath = (arg) => /^(?:.*\/)?codex(?:\.js)?$/.test(arg ?? "");
  const executable = argv.shift();
  if (isCodexPath(executable)) return true;
  if (!/^(?:.*\/)?node(?:js)?$/.test(executable ?? "")) return false;
  const valueOptions = new Set([
    "-r",
    "--require",
    "--import",
    "--loader",
    "--experimental-loader",
    "--icu-data-dir",
  ]);
  const booleanOptions = new Set([
    "--no-warnings",
    "--enable-source-maps",
    "--preserve-symlinks",
    "--preserve-symlinks-main",
  ]);
  while (argv.length) {
    const arg = argv.shift();
    if (arg === "--") return isCodexPath(argv[0]);
    if (/^(?:-[ep]|--eval(?:=|$)|--print(?:=|$))/.test(arg)) return false;
    if (!arg.startsWith("-")) return isCodexPath(arg);
    if (valueOptions.has(arg.split("=", 1)[0])) {
      if (!arg.includes("=")) argv.shift();
    } else if (!booleanOptions.has(arg)) {
      // Unknown Node options may consume the next token as a value.
      return false;
    }
  }
  return false;
}

async function inspectCodexTmuxPane(pane, deps = {}) {
  if (isCodexTmuxPane(pane.currentCommand, pane.startCommand))
    return { isCodex: true };
  if (!pane.panePid && !pane.paneTty) return { isCodex: false };
  const args = ["-ax", "-o", "pid=,ppid=,tty=,args="];
  const command = pane.remote ? "ssh" : "ps";
  const commandArgs = pane.remote
    ? [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        pane.remote,
        shellQuote(["ps", ...args]),
      ]
    : args;
  let stdout;
  try {
    ({ stdout } = await (deps.psExec ?? execFileAsync)(command, commandArgs, {
      timeout: 15_000,
      maxBuffer: MAX_BUFFER,
    }));
  } catch (error) {
    return {
      isCodex: false,
      preflightWarning: `Codex pane process inspection unavailable: ${error.message}`,
    };
  }
  const processes = String(stdout)
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      return match
        ? [{ pid: match[1], ppid: match[2], tty: match[3], command: match[4] }]
        : [];
    });
  const descendants = new Set([String(pane.panePid)]);
  let added;
  do {
    added = false;
    for (const process of processes) {
      if (descendants.has(process.ppid) && !descendants.has(process.pid)) {
        descendants.add(process.pid);
        added = true;
      }
    }
  } while (added);
  const tty = String(pane.paneTty ?? "").replace(/^\/dev\//, "");
  return {
    isCodex: processes.some(
      (process) =>
        (descendants.has(process.pid) ||
          (tty && tty !== "?" && tty !== "??" && process.tty === tty)) &&
        isCodexProcessCommand(process.command),
    ),
  };
}

const TMUX_DISCOVERY_FORMAT = [
  "#{session_name}",
  "#{session_created}",
  "#{session_attached}",
  "#{window_index}",
  "#{pane_index}",
  "#{pane_current_path}",
  "#{pane_current_command}",
  "#{pane_start_command}",
  "#{pane_tty}",
  "#{pane_pid}",
  "#{pane_id}",
].join("\t");

function parseCodexTmuxSessions(
  stdout,
  cwd = null,
  codexTargets = null,
  paneThreads = new Map(),
) {
  const cwdFilter = normalizeCwd(cwd);
  const sessions = new Map();

  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line) continue;
    const [
      session,
      createdRaw,
      attachedRaw,
      windowIndex,
      paneIndex,
      paneCwd,
      currentCommand,
      startCommand,
      ,
      ,
      paneId,
    ] = line.split("\t");
    if (
      !session ||
      !(codexTargets
        ? codexTargets.has(`${session}:${windowIndex}.${paneIndex}`)
        : isCodexTmuxPane(currentCommand, startCommand))
    ) {
      continue;
    }

    const normalizedPaneCwd = normalizeCwd(paneCwd);
    if (cwdFilter && normalizedPaneCwd !== cwdFilter) {
      continue;
    }

    const startedAtEpoch = Number.parseInt(createdRaw, 10);
    const startedAt = Number.isSafeInteger(startedAtEpoch)
      ? new Date(startedAtEpoch * 1000).toISOString()
      : null;
    const existing = sessions.get(session);
    const pane = {
      target: `${session}:${windowIndex}.${paneIndex}`,
      cwd: normalizedPaneCwd,
      command: currentCommand,
      ...(paneThreads.get(paneId) ?? {}),
    };
    if (existing) {
      if (!existing.cwd && normalizedPaneCwd) {
        existing.cwd = normalizedPaneCwd;
      }
      existing.panes.push(pane);
      continue;
    }

    sessions.set(session, {
      session,
      startedAt,
      startedAtEpoch: Number.isSafeInteger(startedAtEpoch)
        ? startedAtEpoch
        : null,
      cwd: normalizedPaneCwd,
      attached: Number.parseInt(attachedRaw, 10) > 0,
      target: pane.target,
      panes: [pane],
    });
  }

  return [...sessions.values()].sort((left, right) =>
    left.session.localeCompare(right.session),
  );
}

async function discoverCodexTmuxSessions(
  { cwd = null, remote = null } = {},
  deps = {},
) {
  try {
    const { stdout } = await (deps.runTmux ?? runTmux)(remote, [
      "list-panes",
      "-a",
      "-F",
      TMUX_DISCOVERY_FORMAT,
    ]);
    const codexTargets = new Set();
    const panePids = new Map();
    for (const line of String(stdout).split(/\r?\n/)) {
      if (!line) continue;
      const [
        session,
        ,
        ,
        window,
        pane,
        ,
        currentCommand,
        startCommand,
        paneTty,
        panePid,
        paneId,
      ] = line.split("\t");
      panePids.set(paneId, Number(panePid));
      const result = await inspectCodexTmuxPane(
        { currentCommand, startCommand, paneTty, panePid, remote },
        deps,
      );
      if (result.isCodex) codexTargets.add(`${session}:${window}.${pane}`);
    }
    const paneThreads = new Map();
    if (!remote) {
      const env = deps.env ?? process.env;
      const records = (deps.readCodexSessionRecords ?? readCodexSessionRecords)(
        {
          dir: registryDir(env),
        },
      );
      const parents = new Map();
      try {
        const processes = await (deps.psExec ?? execFileAsync)(
          "ps",
          ["-eo", "pid=,ppid="],
          { timeout: 1000, maxBuffer: MAX_BUFFER },
        );
        for (const line of String(processes.stdout).split(/\r?\n/)) {
          const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
          if (match) parents.set(Number(match[1]), Number(match[2]));
        }
      } catch {
        // Without ancestry evidence only the pane process itself can match.
      }
      const names = codexThreadNames({
        indexPath: pathJoin(
          env.CODEX_HOME || pathJoin(env.HOME || homedir(), ".codex"),
          "session_index.jsonl",
        ),
      });
      for (const record of records) {
        const panePid = panePids.get(record.tmuxPane);
        if (!Number.isSafeInteger(panePid) || panePid <= 0) continue;
        let ancestor = record.pid;
        for (let depth = 0; depth < 8 && ancestor !== panePid; depth++) {
          ancestor = parents.get(ancestor);
        }
        if (ancestor !== panePid) continue;
        paneThreads.set(record.tmuxPane, {
          threadId: record.sessionId,
          name: names.get(record.sessionId) ?? null,
        });
      }
    }
    return {
      ok: true,
      cli: "codex",
      cwd: normalizeCwd(cwd),
      sessions: parseCodexTmuxSessions(stdout, cwd, codexTargets, paneThreads),
    };
  } catch (error) {
    return {
      ok: false,
      cli: "codex",
      cwd: normalizeCwd(cwd),
      reason: "tmux-unavailable",
      error: error.message,
      sessions: [],
    };
  }
}

function isSessionPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function claudeConversationTitle(sessionId, env) {
  if (!sessionId || /[/\\]/.test(sessionId)) return null;
  const projectsDir =
    env.TFX_CLAUDE_PROJECTS_DIR ||
    pathJoin(env.HOME || homedir(), ".claude", "projects");
  let projects;
  try {
    projects = await readdir(projectsDir);
  } catch {
    return null;
  }
  for (const project of projects.sort()) {
    let handle;
    try {
      handle = await open(
        pathJoin(projectsDir, project, `${sessionId}.jsonl`),
        "r",
      );
      const stat = await handle.stat();
      if (!stat.isFile()) continue;
      const length = Math.min(stat.size, 262144);
      const buffer = Buffer.alloc(length);
      const start = stat.size - length;
      let total = 0;
      while (total < length) {
        const { bytesRead } = await handle.read(
          buffer,
          total,
          length - total,
          start + total,
        );
        if (!bytesRead) break;
        total += bytesRead;
      }
      const lines = buffer.subarray(0, total).toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const record = JSON.parse(lines[i]);
          if (record?.type !== "custom-title" && record?.type !== "ai-title")
            continue;
          const title = record.customTitle ?? record.aiTitle;
          if (typeof title === "string" && title.trim()) return title.trim();
        } catch {
          // The tail may start mid-line or end with a concurrent partial write.
        }
      }
    } catch {
      // Missing or unreadable transcripts cannot break session discovery.
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return null;
}

async function discoverClaudeTmuxSessions({ cwd = null } = {}, deps = {}) {
  const result = {
    ok: true,
    cli: "claude",
    cwd: normalizeCwd(cwd),
    sessions: [],
  };
  let stdout;
  try {
    ({ stdout } = await (deps.runTmux ?? runTmux)(null, [
      "list-panes",
      "-a",
      "-F",
      TMUX_DISCOVERY_FORMAT,
    ]));
  } catch (error) {
    return {
      ...result,
      ok: false,
      reason: "tmux-unavailable",
      error: error.message,
    };
  }
  const panes = new Map();
  for (const line of String(stdout).split(/\r?\n/)) {
    const [session, , , window, pane, paneCwd, , , , pid, paneId] =
      line.split("\t");
    if (paneId)
      panes.set(paneId, {
        session,
        target: `${session}:${window}.${pane}`,
        cwd: normalizeCwd(paneCwd),
        pid: Number(pid),
      });
  }
  const parents = new Map();
  try {
    const processes = await (deps.psExec ?? execFileAsync)(
      "ps",
      ["-eo", "pid=,ppid="],
      {
        timeout: 1000,
        maxBuffer: MAX_BUFFER,
      },
    );
    for (const line of String(processes.stdout).split(/\r?\n/)) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
      if (match) parents.set(Number(match[1]), Number(match[2]));
    }
  } catch {
    // Without ancestry evidence only the pane process itself can match.
  }
  const env = deps.env ?? process.env;
  const dir =
    env.TFX_CLAUDE_SESSIONS_DIR ||
    pathJoin(env.HOME || homedir(), ".claude", "sessions");
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return result;
  }
  for (const file of files.sort()) {
    if (!file.endsWith(".json")) continue;
    try {
      const record = JSON.parse(await readFile(pathJoin(dir, file), "utf8"));
      // Match from the right: session names may themselves contain ':' and '.'.
      const coordinate =
        typeof record.tmux === "string"
          ? record.tmux.match(/^(.*):@(\d+)\.(%\d+)$/)
          : null;
      if (
        !coordinate ||
        typeof record.sessionId !== "string" ||
        !record.sessionId ||
        !Number.isSafeInteger(record.pid) ||
        record.pid <= 0
      )
        continue;
      const pane = panes.get(coordinate[3]);
      if (!pane || (result.cwd && pane.cwd !== result.cwd)) continue;
      if (!(deps.isAlive ?? isSessionPidAlive)(record.pid)) continue;
      let ancestor = record.pid;
      for (let depth = 0; depth < 4 && ancestor !== pane.pid; depth++) {
        ancestor = parents.get(ancestor);
      }
      if (ancestor !== pane.pid) continue;
      const name = record.name ?? null;
      const title =
        record.nameSource === "derived" ||
        !name ||
        (typeof name === "string" && !name.trim())
          ? await claudeConversationTitle(record.sessionId, env)
          : name;
      result.sessions.push({
        session: pane.session,
        target: pane.target,
        paneId: coordinate[3],
        cwd: pane.cwd,
        pid: record.pid,
        sessionId: record.sessionId,
        short: record.sessionId.slice(0, 8),
        name,
        title,
        nameSource: record.nameSource ?? null,
        status: record.status ?? null,
      });
    } catch {
      // A malformed or concurrently removed record cannot break discovery.
    }
  }
  return result;
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

function isCodexLoadingCapture(text) {
  const headers = [
    ...stripAnsi(text).matchAll(/^\s*(?:│\s*)?model:\s*([^\n]*)/gim),
  ];
  return /^loading\b/i.test(headers.at(-1)?.[1] ?? "");
}

function isCodexTimeLine(line) {
  return (
    /^\s*\d{1,2}:\d{2}(?:\s?[AP]M)?\s*$/.test(line) ||
    /^\s*(?:오전|오후)\s?\d{1,2}:\d{2}\s*$/.test(line)
  );
}

function trimResponseLines(adapter, lines) {
  while (
    lines.length &&
    (!lines.at(-1).trim() ||
      (adapter.cli === "codex" && isCodexTimeLine(lines.at(-1))))
  )
    lines.pop();
  return lines.join("\n").trim();
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
  return (
    !isBusyByEsc(text) &&
    !isCodexLoadingCapture(text) &&
    hasCodexComposerPrompt(text)
  );
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

function promptLineIndex(lines, prompt) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (composerLineMatchesPrompt(lines[index], prompt)) {
      return index;
    }
  }

  return -1;
}

function isComposerPromptLine(line) {
  return hasCodexComposerPrompt(line) || hasClaudeComposerPrompt(line);
}

function promptComposerNeedle(prompt) {
  const firstContentLine = String(prompt)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  // 발신자 머리말이 길어도 요청별로 가려지도록 표식을 바늘로 쓴다.
  const tag = firstContentLine?.match(/\[tfx-live req=[^\]]+\]/)?.[0];
  return (tag ?? firstContentLine ?? "").slice(
    0,
    PROMPT_COMPOSER_NEEDLE_LENGTH,
  );
}

function composerLineMatchesPrompt(line, prompt) {
  const needle = promptComposerNeedle(prompt);
  return (
    Boolean(needle) &&
    isComposerPromptLine(line) &&
    String(line).includes(needle)
  );
}

function composerShowsPrompt(text, prompt) {
  const activeComposerLine = String(text)
    .split("\n")
    .filter(isComposerPromptLine)
    .at(-1);
  return composerLineMatchesPrompt(activeComposerLine, prompt);
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

  return trimResponseLines(adapter, response);
}

function extractResponseSinceMarker({ beforeRaw, raw, doneMarker, adapter }) {
  if (!doneMarker) {
    return "";
  }

  const beforeLines = String(beforeRaw)
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""));
  const rawLines = String(raw)
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""));
  let sharedPrefixLength = 0;
  while (
    sharedPrefixLength < beforeLines.length &&
    sharedPrefixLength < rawLines.length &&
    beforeLines[sharedPrefixLength] === rawLines[sharedPrefixLength]
  ) {
    sharedPrefixLength += 1;
  }

  const newLines =
    sharedPrefixLength > 0 ? rawLines.slice(sharedPrefixLength) : rawLines;
  const markerIndex = newLines.findIndex((line) => line.trim() === doneMarker);
  if (markerIndex === -1) {
    return "";
  }

  const candidateLines = newLines.slice(0, markerIndex);
  const responseStart = candidateLines.findIndex((line) =>
    adapter.isResponseLine(line),
  );
  const responseLines =
    responseStart === -1 ? candidateLines : candidateLines.slice(responseStart);

  return trimResponseLines(
    adapter,
    responseLines
      .filter(
        (line) =>
          !adapter.isChromeLine(line) &&
          !isWarningLine(line) &&
          !adapter.isStatusLine(line) &&
          !hasCodexComposerPrompt(line) &&
          !hasClaudeComposerPrompt(line),
      )
      .map((line) =>
        adapter.isResponseLine(line) ? adapter.stripResponseMarker(line) : line,
      ),
  );
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

function hasTmuxAssistantResponseAfterCurrentPrompt(
  adapter,
  text,
  prompt,
  beforeText,
) {
  if (adapter.cli === "claude") {
    return hasClaudeCompletedTaskListResponse(text, {
      beforeText,
      prompt,
    });
  }

  const lines = String(text).split("\n");
  const promptIndex = promptLineIndex(lines, prompt);
  if (promptIndex === -1) {
    return false;
  }

  const beforePromptCount = String(beforeText)
    .split("\n")
    .filter((line) => composerLineMatchesPrompt(line, prompt)).length;
  const currentPromptCount = lines.filter((line) =>
    composerLineMatchesPrompt(line, prompt),
  ).length;

  return (
    currentPromptCount > beforePromptCount &&
    responseLineIndexForPrompt(adapter, lines, promptIndex) !== -1
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

function isClaudeExternalImportsPrompt(text) {
  return /Allow external CLAUDE\.md file imports|allow external imports/i.test(
    String(text),
  );
}

function isClaudeTourPrompt(text) {
  // Claude's post-update welcome/tour screen ("Take the tour" / "Skip for now").
  // Claude has no codex-style "Update available / Skip until next version" menu
  // (its update is a non-blocking background auto-updater), so the recurring
  // startup screen that needs a "skip" is this tour prompt. Require both labels
  // so a stray "Skip for now" elsewhere cannot false-match.
  return (
    /Take the tour/i.test(String(text)) && /Skip for now/i.test(String(text))
  );
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

function isCodexDaemonSettingsPrompt(text) {
  return /Background server has incompatible feature settings/.test(
    String(text),
  );
}

// 공유 daemon 을 다시 띄우면 다른 클라이언트 설정이 바뀌므로 이번 실행만 daemon 없이 간다.
async function dismissCodexDaemonSettingsPrompt(remote, session) {
  let raw = await captureVisible(remote, session);
  if (!isCodexDaemonSettingsPrompt(raw)) return { dismissed: false, raw };
  for (let iteration = 0; iteration < 4; iteration += 1) {
    if (/Run without daemon/.test(selectedLine(raw))) {
      await runTmux(remote, ["send-keys", "-t", session, "Enter"]);
      return { dismissed: true, raw };
    }
    await runTmux(remote, ["send-keys", "-t", session, "Up"]);
    await sleep(200);
    raw = await captureVisible(remote, session);
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

async function dismissClaudeExternalImportsPrompt(remote, session) {
  let raw = await captureVisible(remote, session);
  if (!isClaudeExternalImportsPrompt(raw)) {
    return { dismissed: false, raw };
  }

  for (let iteration = 0; iteration < 4; iteration += 1) {
    if (/Yes, allow external imports/.test(selectedLine(raw))) {
      await runTmux(remote, ["send-keys", "-t", session, "Enter"]);
      return { dismissed: true, raw };
    }

    await runTmux(remote, ["send-keys", "-t", session, "Up"]);
    await sleep(200);
    raw = await captureVisible(remote, session);
  }

  await runTmux(remote, ["send-keys", "-t", session, "Enter"]);
  return { dismissed: true, raw };
}

async function dismissClaudeTourPrompt(remote, session) {
  let raw = await captureVisible(remote, session);
  if (!isClaudeTourPrompt(raw)) {
    return { dismissed: false, raw };
  }

  for (let iteration = 0; iteration < 4; iteration += 1) {
    if (/Skip for now/.test(selectedLine(raw))) {
      await runTmux(remote, ["send-keys", "-t", session, "Enter"]);
      return { dismissed: true, raw };
    }

    await runTmux(remote, ["send-keys", "-t", session, "Down"]);
    await sleep(200);
    raw = await captureVisible(remote, session);
  }

  // Fallback: Escape cancels the welcome/tour dialog (equivalent to "Skip for
  // now"). Never blind-Enter here — the default selection may be "Take the
  // tour", and Enter would launch the tour instead of skipping it.
  await runTmux(remote, ["send-keys", "-t", session, "Escape"]);
  return { dismissed: true, raw };
}

const ADAPTERS = {
  codex: {
    cli: "codex",
    launchArgv: ["codex"],
    launchKeys: ["codex --dangerously-bypass-approvals-and-sandbox", "Enter"],
    resumeById: (id) =>
      shellQuote([
        "codex",
        "resume",
        id,
        "--dangerously-bypass-approvals-and-sandbox",
      ]),
    resumeLast: () =>
      shellQuote([
        "codex",
        "resume",
        "--last",
        "--dangerously-bypass-approvals-and-sandbox",
      ]),
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
      {
        name: "daemon-settings",
        isPresent: isCodexDaemonSettingsPrompt,
        dismiss: dismissCodexDaemonSettingsPrompt,
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
      {
        name: "external-imports",
        isPresent: isClaudeExternalImportsPrompt,
        dismiss: dismissClaudeExternalImportsPrompt,
      },
      {
        name: "tour",
        isPresent: isClaudeTourPrompt,
        dismiss: dismissClaudeTourPrompt,
      },
    ],
  },
};

function buildLaunchKeys(adapter, { model, effort, name } = {}) {
  const hasModel = model !== undefined;
  const hasEffort = effort !== undefined;
  if (!hasModel && !hasEffort && !(adapter.cli === "claude" && name)) {
    return adapter.launchKeys;
  }

  const overrideArgs = [];
  if (adapter.cli === "codex") {
    if (hasModel) {
      overrideArgs.push("-c", `model=${JSON.stringify(String(model))}`);
    }
    if (hasEffort) {
      overrideArgs.push(
        "-c",
        `model_reasoning_effort=${JSON.stringify(String(effort))}`,
      );
    }
  } else if (adapter.cli === "claude") {
    if (name) overrideArgs.push("-n", name);
    if (hasModel) {
      overrideArgs.push("--model", model);
    }
    if (hasEffort) {
      overrideArgs.push("--effort", effort);
    }
  } else {
    throw new Error(`Unsupported adapter: ${adapter.cli}`);
  }

  const [command, ...remainingKeys] = adapter.launchKeys;
  return [`${command} ${shellQuote(overrideArgs)}`, ...remainingKeys];
}

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
    await runTmux(opts.remote, [
      "has-session",
      "-t",
      splitTmuxTarget(opts.session).session,
    ]);
    return true;
  } catch {
    return false;
  }
}

function daemonProbeUnavailableReason(probe, targetAttachable) {
  if (targetAttachable) return null;
  if (!probe?.ok) {
    const candidateCodes = Array.isArray(probe?.raw?.candidateResults)
      ? probe.raw.candidateResults
          .map((entry) => entry?.errorCode)
          .filter(Boolean)
      : [];
    if (candidateCodes.includes("stale-control-socket")) {
      return "stale-control-socket";
    }
    if (candidateCodes.includes("daemon-dir-missing")) {
      return "daemon-dir-missing";
    }
    return probe?.reason ?? "probe-failed";
  }
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

// 공유 app-server daemon 에 로드된 thread 중 cwd 가 같은 것. daemon 이 없거나 늦으면 빈 목록.
async function loadedCodexThreadIds(cwd, timeoutMs) {
  try {
    const { listCodexAppServerThreads } = await import(
      "../hub/team/uds-orchestrator.mjs"
    );
    const threads = await listCodexAppServerThreads({
      socketPath: resolveCodexDaemonSocket("default"),
      cwd,
      timeoutMs,
    });
    return threads.map((thread) => thread.threadId);
  } catch {
    return [];
  }
}

const ROLLOUT_TAIL_BYTES = 256 * 1024;

// thread_settings_applied 는 resume 과 설정 변경 때 쓰인다. 끝부분이 sinceMs 이후를 다 덮지
// 못하면 "unknown" 이다.
async function resumedSince(rollout, sinceMs) {
  const info = await stat(rollout).catch(() => null);
  if (!info || info.mtimeMs < sinceMs) return "no";
  const handle = await open(rollout, "r");
  let text;
  try {
    const length = Math.min(info.size, ROLLOUT_TAIL_BYTES);
    const { buffer } = await handle.read(
      Buffer.alloc(length),
      0,
      length,
      info.size - length,
    );
    text = buffer.toString("utf8");
  } finally {
    await handle.close();
  }
  let covered = info.size <= ROLLOUT_TAIL_BYTES;
  for (const line of text.split("\n")) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(entry.timestamp);
    if (at < sinceMs) covered = true;
    else if (entry.payload?.type === "thread_settings_applied")
      return "resumed";
  }
  return covered ? "no" : "unknown";
}

// resume --last 는 pane 인자에 UUID 가 남지 않아 Codex 가 실제로 연 thread 를 사후에 찾는다.
// 띄운 뒤 기록이 생긴 thread 가 정확히 하나이고 나머지 후보가 모두 확인됐을 때만 인정한다.
async function resumedCodexThread(
  { cwd, launchedAtMs, timeoutMs },
  { loadedIds = loadedCodexThreadIds, findRollout = findCodexRollout } = {},
) {
  const matches = [];
  for (const id of await loadedIds(cwd, timeoutMs)) {
    const rollout = isCodexThreadId(id) && (await findRollout(id));
    const state = rollout ? await resumedSince(rollout, launchedAtMs) : "no";
    if (state === "unknown") return null;
    if (state === "resumed") matches.push(id);
  }
  return matches.length === 1 ? matches[0] : null;
}

async function doStart(adapter, opts) {
  const {
    session,
    remote,
    cwd,
    resume,
    resumeLast,
    model,
    effort,
    readyTimeoutMs,
    pollIntervalMs,
  } = opts;
  if (session.includes(":"))
    throw new Error("start --session accepts only a session name without ':'");
  const now = new Date();
  const resumed = Boolean(resume || resumeLast);
  const name =
    opts.name ??
    (resumed ? null : `${now.getMonth() + 1}.${now.getDate()} ${session}`);
  if (
    name !== null &&
    (!/^\d{1,2}\.\d{1,2} \S/u.test(name) || /[\r\n]/u.test(name))
  )
    throw new Error("--name must use '<month>.<day> <topic>' on one line");
  const launchKeys = resume
    ? [adapter.resumeById(resume), "Enter"]
    : resumeLast
      ? [adapter.resumeLast(), "Enter"]
      : buildLaunchKeys(adapter, { model, effort, name });
  if (resumed && name && adapter.cli === "claude")
    launchKeys[0] += ` ${shellQuote(["-n", name])}`;
  const resumeTarget = resume ?? (resumeLast ? "last" : null);
  const trackResumeLast = resumeLast && adapter.cli === "codex" && !remote;
  const launchedAtMs = Date.now();

  // 분리 세션 기본 80x24 에서는 긴 입력이 화면 높이를 넘으므로 넓게 만든다. 붙으면 클라이언트 크기를 따른다.
  await runTmux(remote, [
    "new-session",
    "-d",
    "-s",
    session,
    "-x",
    "240",
    "-y",
    "60",
    ...(cwd ? ["-c", cwd] : []),
  ]);
  // Default tmux history-limit (2000) is far too small for long tool-heavy
  // CLI sessions (file reads, test runs) — the actual response can scroll
  // out of scrollback before capturePane() runs, producing an empty extract.
  await runTmux(remote, [
    "set-option",
    "-t",
    session,
    "history-limit",
    "100000",
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
  let nameApplied = Boolean(name) && adapter.cli === "claude" && ready;
  let threadId =
    adapter.cli === "codex" && isCodexThreadId(resume) ? resume : null;
  // 입력창이 뜬 직후에는 resume 기록이 아직 없을 수 있어 5초 안에서 다시 본다.
  const threadDeadline = Date.now() + 5000;
  while (trackResumeLast && ready && !threadId) {
    const timeoutMs = threadDeadline - Date.now();
    if (timeoutMs <= 0) break;
    threadId = await resumedCodexThread({
      cwd: cwd ?? process.cwd(),
      launchedAtMs,
      timeoutMs,
    });
    if (!threadId) await sleep(Math.min(500, threadDeadline - Date.now()));
  }
  if (name && adapter.cli === "codex" && ready) {
    try {
      const command = `/rename ${name}`;
      await runTmux(remote, ["send-keys", "-t", session, "-l", "--", command]);
      await submitComposerLine(remote, session, command);
      const deadline = Date.now() + Math.min(readyTimeoutMs, 5000);
      while (!remote && Date.now() < deadline) {
        const named = await codexThreadIdByName(name, {
          sinceMs: now.getTime() - 1000,
        });
        if (named) {
          threadId = named;
          nameApplied = true;
          break;
        }
        await sleep(Math.min(pollIntervalMs, 200));
      }
    } catch {
      nameApplied = false;
    }
  }
  // ask 의 queue 전송이 레지스트리 없이도 thread 를 찾도록 세션에 남긴다.
  if (threadId && !remote)
    await runTmux(null, [
      "set-option",
      "-t",
      session,
      "@tfx_codex_thread",
      threadId,
    ]).catch(() => {});
  return addLoginGuard(adapter, raw, {
    cli: adapter.cli,
    session,
    remote: remote ?? null,
    resumed,
    resumeTarget,
    ready,
    name,
    nameGenerated: !resumed && opts.name === undefined,
    nameApplied,
    ...(adapter.cli === "codex" ? { threadId } : {}),
    ...(name && adapter.cli === "codex" && !nameApplied
      ? {
          nameWarning:
            "name update could not be confirmed from Codex session_index",
        }
      : {}),
    ...(await exposeLiveSession({
      cli: adapter.cli,
      session,
      name,
      cwd,
      remote,
      ready,
    })),
    raw,
  });
}

// 빠른 입력 직후의 Enter 는 Codex 입력창이 버릴 수 있어 입력창이 빌 때까지 다시 누른다.
async function submitComposerLine(remote, session, line) {
  await sleep(300);
  for (let attempt = 1; attempt <= PROMPT_SUBMIT_MAX_ATTEMPTS; attempt += 1) {
    await runTmux(remote, ["send-keys", "-t", session, "Enter"]);
    await sleep(300);
    if (!composerShowsPrompt(await captureVisible(remote, session), line))
      return true;
  }
  return false;
}

async function waitForTmuxIdle(adapter, opts) {
  const { session, remote, pollIntervalMs, busyTimeoutMs, ifBusy } = opts;
  if (!["wait", "fail", "interrupt"].includes(ifBusy)) {
    throw new Error("--if-busy must be wait, fail, or interrupt for tmux");
  }
  const startedAt = Date.now();
  let interrupted = false;
  while (true) {
    const visible = await captureVisible(remote, session);
    const elapsedMs = Date.now() - startedAt;
    const busy =
      isBusyByEsc(visible) ||
      (adapter.cli === "codex" && isCodexLoadingCapture(visible));
    if (!busy) return elapsedMs;
    if (ifBusy === "fail") throw new Error("target busy (--if-busy fail)");
    if (elapsedMs >= busyTimeoutMs) {
      throw new Error(
        `target busy after ${Math.ceil(busyTimeoutMs / 1000)}s (--if-busy ${ifBusy})`,
      );
    }
    if (ifBusy === "interrupt" && !interrupted) {
      await runTmux(remote, ["send-keys", "-t", session, "Escape"]);
      interrupted = true;
    }
    await sleep(
      Math.min(pollIntervalMs, Math.max(1, busyTimeoutMs - elapsedMs)),
    );
  }
}

async function doAskViaTmux(adapter, opts) {
  const {
    session,
    prompt,
    remote,
    timeoutMs,
    settleMs,
    pollIntervalMs,
    doneMarker,
    ifBusy = "wait",
    busyTimeoutMs = timeoutMs,
  } = opts;
  const busyWaitedMs = await waitForTmuxIdle(adapter, {
    session,
    remote,
    pollIntervalMs,
    busyTimeoutMs,
    ifBusy,
  });
  const beforeRaw = await capturePane(remote, session);
  const contextPctBefore = adapter.contextPct(beforeRaw);
  const context = opts.skipContextGuard ? {} : await tmuxContext(adapter, opts);
  const guard = opts.skipContextGuard
    ? {}
    : contextGuard(adapter.cli, context, opts);
  if (guard.ok === false)
    return {
      ...guard,
      status: "failed",
      done: false,
      cli: adapter.cli,
      session,
      transport: "tmux",
    };

  const bufferName = tmuxBufferName(session);
  await runTmux(remote, ["set-buffer", "-b", bufferName, "--", prompt]);
  await runTmux(remote, [
    "paste-buffer",
    "-b",
    bufferName,
    "-d",
    "-p",
    "-t",
    session,
  ]);
  await sleep(settleMs);

  let promptSubmitted = !doneMarker;
  if (doneMarker || opts.noWait) {
    for (let attempt = 1; attempt <= PROMPT_SUBMIT_MAX_ATTEMPTS; attempt += 1) {
      await runTmux(remote, ["send-keys", "-t", session, "Enter"]);
      await sleep(PROMPT_SUBMIT_RETRY_DELAY_MS);
      const submissionVisible = await captureVisible(remote, session);
      if (!composerShowsPrompt(submissionVisible, prompt)) {
        promptSubmitted = true;
        break;
      }
    }
    if (!promptSubmitted) {
      throw new Error(
        `Prompt did not submit after ${PROMPT_SUBMIT_MAX_ATTEMPTS} attempts`,
      );
    }
  } else {
    await runTmux(remote, ["send-keys", "-t", session, "Enter"]);
  }

  if (opts.noWait) {
    return {
      ...context,
      ...guard,
      ok: true,
      cli: adapter.cli,
      transport: "tmux",
      session,
      remote: remote ?? null,
      status: "submitted",
      inputSent: true,
      done: false,
      submittedAt: new Date().toISOString(),
      target: session,
      ifBusy,
      busyWaitedMs,
    };
  }

  const startedAt = Date.now();
  let raw = "";
  let visible = "";
  let response = "";
  let contextPctAfter = null;
  let quietPolls = 0;
  let previousVisible = "";
  let done = false;

  while (Date.now() - startedAt < timeoutMs) {
    visible = doneMarker
      ? await capturePane(remote, session)
      : await captureVisible(remote, session);
    contextPctAfter = adapter.contextPct(visible);

    quietPolls = visible === previousVisible ? quietPolls + 1 : 0;
    previousVisible = visible;

    const markerDone =
      promptSubmitted &&
      Boolean(
        extractResponseSinceMarker({
          beforeRaw,
          raw: visible,
          doneMarker,
          adapter,
        }),
      );
    const fallbackDone =
      !doneMarker &&
      !adapter.isBusy(visible) &&
      adapter.isReady(visible) &&
      quietPolls >= FALLBACK_QUIET_POLLS &&
      hasTmuxAssistantResponseAfterCurrentPrompt(
        adapter,
        await capturePane(remote, session),
        prompt,
        beforeRaw,
      );
    if (markerDone || fallbackDone) {
      done = true;
      break;
    }

    await sleep(pollIntervalMs);
  }

  raw = await capturePane(remote, session);
  const markerResponse = promptSubmitted
    ? extractResponseSinceMarker({
        beforeRaw,
        raw,
        doneMarker,
        adapter,
      })
    : "";
  if (markerResponse) {
    response = markerResponse;
    done = true;
  } else {
    response = extractAssistantResponse(adapter, raw, prompt);
  }
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
    ifBusy,
    busyWaitedMs,
    response,
    contextPctBefore,
    contextPctAfter,
    ...context,
    ...guard,
    matchedCompletion: done,
    done,
    raw,
  });
}

async function doAsk(adapter, opts) {
  const requestId = opts.requestId ?? randomBytes(6).toString("hex");
  const tag = `[tfx-live req=${requestId}]`;
  // Codex 는 접힌 발신자 표시가 없어 첫 줄 머리말로 보낸 세션을 드러낸다.
  // 슬래시 명령은 첫 글자가 / 여야 실행되므로 표식을 붙이지 않는다.
  const bare =
    opts.noRelayTag || (adapter.cli === "codex" && isSlashCommand(opts.prompt));
  const from =
    adapter.cli === "codex" && !bare
      ? (opts.from ?? (await resolveSenderName()))
      : null;
  const header = from ? `[from ${from}] ${tag}` : tag;
  const prompt =
    bare || opts.prompt.split("\n", 1)[0].includes(tag)
      ? opts.prompt
      : `${header}\n${opts.prompt}`;
  try {
    return {
      ...(await dispatchAsk(adapter, { ...opts, prompt, requestId })),
      requestId,
      ...(opts.transportReason
        ? { transportReason: opts.transportReason }
        : {}),
    };
  } catch (error) {
    error.requestId = requestId;
    throw error;
  }
}

async function dispatchAsk(adapter, opts) {
  const transport = opts.transport ?? "tmux";
  if (transport === "tmux") {
    return doAskViaTmux(adapter, opts);
  }
  if (transport === "queue") return doAskViaQueue(adapter, opts);

  if (adapter.cli === "codex" && transport === "uds") {
    if (opts.remote) return doAskViaRemoteLive(adapter, opts);
    const { askCodexAppServerThread } = await import(
      "../hub/team/uds-orchestrator.mjs"
    );
    return askCodexAppServerThread({
      socketPath: opts.socketPath,
      threadId: opts.threadId,
      cwd: opts.cwd,
      prompt: opts.prompt,
      timeoutMs: opts.timeoutMs,
      maxTurnMs: opts.maxTurnMs,
      ifBusy: opts.ifBusy,
      busyTimeoutMs: opts.busyTimeoutMs,
      pollIntervalMs: opts.pollIntervalMs,
      noWait: opts.noWait,
      maxContextPct: opts.maxContextPct,
      warnContextPct: opts.warnContextPct,
    });
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

async function codexPaneArgs(panePid) {
  if (!/^\d+$/.test(String(panePid ?? ""))) return null;
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-ax", "-o", "pid=,ppid=,args="],
      {
        timeout: 5000,
        maxBuffer: MAX_BUFFER,
      },
    );
    const rows = String(stdout)
      .split("\n")
      .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
      .filter(Boolean);
    const tree = new Set([String(panePid)]);
    for (let depth = 0; depth < 8; depth += 1)
      for (const [, pid, ppid] of rows) if (tree.has(ppid)) tree.add(pid);
    return (
      rows.find(
        ([, pid, , args]) => tree.has(pid) && isCodexProcessCommand(args),
      )?.[3] ?? null
    );
  } catch {
    return null;
  }
}

// tfx-live start 가 남긴 tmux 옵션, 세션 레지스트리, 프로세스 인자, rollout cwd 순으로 찾는다.
async function resolveCodexTmuxThread(session, deps = {}) {
  const tmux = deps.runTmux ?? runTmux;
  let fields;
  try {
    const { stdout } = await tmux(null, [
      "display-message",
      "-p",
      "-t",
      session,
      "#{@tfx_codex_thread}\t#{pane_id}\t#{pane_current_path}\t#{session_created}\t#{pane_pid}",
    ]);
    fields = String(stdout).trim().split("\t");
  } catch (error) {
    return { threadId: null, reason: `tmux-unavailable: ${error.message}` };
  }
  const [stored, paneId, cwd, created, panePid] = fields;
  if (isCodexThreadId(stored))
    return { threadId: stored, threadSource: "tmux-option" };
  const record = (deps.readCodexSessionRecords ?? readCodexSessionRecords)({
    dir: registryDir(),
  }).find((entry) => entry.tmuxPane === paneId);
  if (isCodexThreadId(record?.sessionId))
    return { threadId: record.sessionId, threadSource: "registry" };
  // resume 한 thread 는 rollout 이 세션보다 오래돼 cwd 대응에서 빠지므로 프로세스 인자로 찾는다.
  const args = await (deps.codexPaneArgs ?? codexPaneArgs)(panePid);
  if (/\bresume\b/.test(args ?? "")) {
    const resumed = args.match(/\bresume\s+([0-9a-f-]{36})\b/i)?.[1];
    return isCodexThreadId(resumed)
      ? { threadId: resumed, threadSource: "process-args" }
      : { threadId: null, reason: "resumed-thread-unknown" };
  }
  if (!cwd) return { threadId: null, reason: "cwd-unknown" };
  // 같은 cwd 에 Codex TUI 가 둘 이상이면 rollout 만으로 누구 것인지 알 수 없다.
  const live = await (deps.countCodexTuiInCwd ?? countCodexTuiInCwd)(cwd);
  if (live !== 1)
    return {
      threadId: null,
      reason: live === null ? "cwd-unverified" : "thread-ambiguous",
    };
  const createdMs = Number.parseInt(created, 10) * 1000;
  const byCwd = await findCodexThreadByCwd(cwd, {
    sinceMs: Number.isFinite(createdMs) ? createdMs : 0,
  });
  return byCwd.threadId
    ? { threadId: byCwd.threadId, threadSource: "rollout-cwd" }
    : byCwd;
}

async function doAskViaQueue(adapter, opts, deps = {}) {
  // queue 를 못 쓰면 tmux 붙여넣기로 보내고 그 이유를 결과에 남긴다.
  const fallback = async (reason) => ({
    ...(await doAskViaTmux(adapter, { ...opts, transport: "tmux" })),
    transportRequested: "queue",
    fallbackReason: reason,
  });
  if (opts.remote) return fallback("remote-host");
  const thread = opts.threadId
    ? { threadId: opts.threadId, threadSource: "flag" }
    : await resolveCodexTmuxThread(opts.session, deps);
  if (!thread.threadId) {
    if (!opts.session)
      throw new Error(`Codex thread unavailable: ${thread.reason}`);
    return fallback(thread.reason);
  }
  const context = opts.skipContextGuard
    ? {}
    : await readCodexContext(null, thread.threadId);
  const guard = opts.skipContextGuard
    ? {}
    : contextGuard("codex", context, opts);
  const base = {
    cli: "codex",
    transport: "queue",
    session: opts.session ?? null,
    threadId: thread.threadId,
    threadSource: thread.threadSource,
    ...context,
    ...guard,
  };
  if (guard.ok === false) return { ...base, status: "failed", done: false };
  let queued;
  try {
    queued = await (deps.queueCodexMessage ?? queueCodexMessage)({
      threadId: thread.threadId,
      message: opts.prompt,
    });
  } catch (error) {
    if (error.maybeQueued)
      return {
        ...base,
        ok: false,
        status: "unknown",
        inputSent: null,
        done: false,
        error: error.message,
      };
    if (!opts.session) throw error;
    return fallback(`queue-error: ${error.message}`);
  }
  const sent = {
    ...base,
    ok: true,
    inputSent: true,
    queuedMessageId: queued.queuedMessageId,
    submittedAt: new Date().toISOString(),
  };
  // 표식이 없으면 rollout 에서 이 요청의 턴을 가려낼 수 없다.
  if (opts.noWait || opts.noRelayTag)
    return { ...sent, status: "queued", delivered: false, done: false };
  const result = await waitCodexRequest({
    threadId: thread.threadId,
    requestId: opts.requestId,
    timeoutMs: opts.timeoutMs,
    pollIntervalMs: opts.pollIntervalMs,
  });
  return { ...sent, ...result, transport: "queue" };
}

async function doAskViaRemoteLive(adapter, opts, deps = {}) {
  const result = await callRemoteLive(
    "ask",
    { ...opts, cli: adapter.cli },
    deps,
  );
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
  if (opts.noWait) payload.noWait = true;
  if (opts.maxContextPct !== undefined)
    payload.maxContextPct = opts.maxContextPct;
  if (opts.warnContextPct !== undefined)
    payload.warnContextPct = opts.warnContextPct;

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
    ...result,
    status:
      result?.status ??
      (matchedCompletion
        ? "completed"
        : result?.inputSent === false
          ? "failed"
          : "unknown"),
    cli: "claude",
    transport: "uds",
    short: short ?? null,
    sessionId: sessionId ?? null,
    response: result?.text ?? "",
    raw: result?.raw ?? result?.responseRaw ?? "",
    matchedCompletion,
    ...(result?.status === "submitted"
      ? {}
      : { timedOut: result?.timedOut === true }),
    closed: result?.closed === true,
    inputSent: result?.inputSent ?? null,
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
    await runTmux(opts.remote, [
      "has-session",
      "-t",
      splitTmuxTarget(opts.session).session,
    ]);
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
        ...(probe?.raw?.recoveredFrom
          ? { recoveredFrom: probe.raw.recoveredFrom }
          : {}),
      },
    );
    if (
      udsResult.matchedCompletion ||
      udsResult.status === "submitted" ||
      udsResult.errorCode === "context-limit"
    ) {
      return udsResult;
    }
    if (udsResult.inputSent !== false) {
      return { ...udsResult, status: "unknown", done: false };
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
  if (opts.short || opts.sessionId) {
    let sessionId = opts.sessionId;
    let configDir = opts.configDir;
    if (!sessionId) {
      const probe = await callBridgeVerb(
        opts.bridgePath,
        "daemon-probe",
        {
          short: opts.short,
          configDir: opts.configDir,
        },
        10_000,
      );
      if (!probe.ok || !probe.target?.sessionId)
        throw new Error(
          probe.error || probe.reason || "Claude session not found",
        );
      sessionId = probe.target.sessionId;
      configDir = probe.daemon?.configDir ?? configDir;
    }
    await execFileAsync("claude", ["stop", sessionId], {
      timeout: 15_000,
      env: configDir
        ? { ...process.env, CLAUDE_CONFIG_DIR: configDir }
        : process.env,
    });
    return { cli: "claude", sessionId, stopped: true, conversationKept: true };
  }
  const { session, remote } = opts;
  if (/[:.]|^[%@]\d+$/.test(session))
    throw new Error(
      "stop --session accepts only a session name; pass the session name without a pane target",
    );
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
  const session = requireFlag(flags, "session");
  if (session.includes(":"))
    throw new Error("start --session accepts only a session name without ':'");
  return {
    session,
    remote: flags.remote,
    cwd: flags.cwd,
    resume: flags.resume,
    resumeLast: Object.hasOwn(flags, "resume-last"),
    model: flags.model,
    effort: flags.effort,
    name: flags.name,
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

// 절대 경로로 시작하는 프롬프트는 슬래시 명령이 아니다.
function isSlashCommand(prompt) {
  return /^\/[a-z][\w-]*(?:\s|$)/i.test(String(prompt ?? ""));
}

function askOpts(flags, adapter) {
  const short = flags.short;
  const sessionId = flags["session-id"];
  // Codex 메시지는 queue 가 기본이다. 슬래시 명령과 바쁠 때 거부·중단은 tmux 만 할 수 있다.
  const slash = isSlashCommand(flags.prompt);
  const busyPolicy = ["fail", "interrupt"].includes(flags["if-busy"]);
  const transportReason =
    adapter.cli === "codex" && !flags.transport && (slash || busyPolicy)
      ? slash
        ? "slash-command"
        : `if-busy-${flags["if-busy"]}`
      : null;
  const transport = transportFlag(
    adapter.cli === "codex" && !flags.transport
      ? { ...flags, transport: transportReason ? "tmux" : "queue" }
      : flags,
    adapter,
    short,
    sessionId,
  );
  const codexUds = adapter.cli === "codex" && transport === "uds";
  const codexQueue = transport === "queue";
  if (adapter.cli === "codex" && transport === "auto")
    throw new Error("--transport auto is only supported with --cli claude");
  if (codexQueue && adapter.cli !== "codex")
    throw new Error("--transport queue is only supported with --cli codex");
  if (codexQueue && (slash || busyPolicy))
    throw new Error(
      "queue cannot run slash commands or --if-busy fail|interrupt; use --transport tmux",
    );
  if (codexQueue && flags.thread && !isCodexThreadId(flags.thread))
    throw new Error("--thread for queue must be a Codex session UUID");
  if (codexQueue && !flags.thread && !flags.session)
    throw new Error("Codex queue ask requires --session or --thread");
  if (
    transport !== "tmux" &&
    !codexUds &&
    !codexQueue &&
    !short &&
    !sessionId
  ) {
    throw new Error(
      `--transport ${transport} requires --short or --session-id`,
    );
  }
  return {
    // tmux needs a tmux session name; uds needs a daemon ref (short/sessionId);
    // auto can take both (daemon ref to probe, tmux session for fallback).
    session:
      transport === "tmux" || (codexQueue && flags.session)
        ? splitTmuxTarget(requireFlag(flags, "session")).target
        : flags.session,
    short,
    sessionId,
    configDir: flags["config-dir"],
    transport,
    transportReason,
    from: flags.from,
    threadId: codexUds
      ? requireFlag(flags, "thread")
      : codexQueue
        ? (flags.thread ?? null)
        : null,
    codexSocket: codexUds ? (flags["codex-socket"] ?? "default") : null,
    socketPath:
      codexUds && !flags.remote
        ? resolveCodexDaemonSocket(flags["codex-socket"] ?? "default")
        : null,
    cwd: flags.cwd,
    ifBusy: flags["if-busy"] ?? "wait",
    busyTimeoutMs: secondsFlag(
      flags,
      "busy-timeout",
      secondsFlag(flags, "timeout", DEFAULT_ANSWER_TIMEOUT_MS),
    ),
    bridgePath: resolveBridgePath(flags),
    prompt: requireFlag(flags, "prompt"),
    requestId: flags["request-id"],
    noWait: Object.hasOwn(flags, "no-wait"),
    noRelayTag: Object.hasOwn(flags, "no-relay-tag"),
    ...contextOpts(flags, adapter.cli),
    remote: flags.remote,
    timeoutMs: secondsFlag(flags, "timeout", DEFAULT_ANSWER_TIMEOUT_MS),
    maxTurnMs: codexUds
      ? secondsFlag(
          flags,
          "max-turn",
          Math.min(resolveHardCeilingMs(), 15 * 60_000),
        )
      : undefined,
    settleMs: msFlag(flags, "settle", DEFAULT_SETTLE_MS),
    pollIntervalMs: msFlag(flags, "poll-interval", DEFAULT_POLL_INTERVAL_MS),
  };
}

function stopOpts(flags) {
  const targetCount = [flags.session, flags.short, flags["session-id"]].filter(
    Boolean,
  ).length;
  if (targetCount !== 1)
    throw new Error("stop requires one of --session, --short, or --session-id");
  if (
    (flags.short || flags["session-id"]) &&
    (flags.remote || (flags.cli && flags.cli !== "claude"))
  )
    throw new Error("stop --short/--session-id supports local Claude only");
  return {
    session: flags.session,
    short: flags.short,
    sessionId: flags["session-id"],
    configDir: flags["config-dir"],
    bridgePath: flags.short ? resolveBridgePath(flags) : undefined,
    remote: flags.remote,
  };
}

function interruptOpts(flags, adapter) {
  const short = flags.short;
  const sessionId = flags["session-id"];
  const transport = transportFlag(flags, adapter, short, sessionId);
  if (transport === "queue")
    throw new Error("interrupt uses tmux; queue cannot send keys");
  if (adapter.cli === "codex" && transport === "uds")
    throw new Error(
      "active turnId unavailable; cannot interrupt Codex UDS thread",
    );
  return {
    session:
      transport === "tmux"
        ? splitTmuxTarget(requireFlag(flags, "session")).target
        : flags.session,
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

async function codexThreadFromFlags(flags) {
  if (flags.thread) {
    if (!isCodexThreadId(flags.thread))
      throw new Error("--thread must be a Codex session UUID");
    return { threadId: flags.thread, threadSource: "flag" };
  }
  const thread = await resolveCodexTmuxThread(
    splitTmuxTarget(requireFlag(flags, "session")).target,
  );
  if (!thread.threadId)
    throw new Error(`Codex thread unavailable: ${thread.reason}`);
  return thread;
}

async function waitCodex(flags) {
  if (flags.remote) throw new Error("Codex wait supports local sessions only");
  const requestId = requireFlag(flags, "request-id");
  const thread = await codexThreadFromFlags(flags);
  printJson({
    ...(await waitCodexRequest({
      threadId: thread.threadId,
      requestId,
      timeoutMs: secondsFlag(flags, "timeout", DEFAULT_ANSWER_TIMEOUT_MS),
      pollIntervalMs: msFlag(flags, "poll-interval", DEFAULT_POLL_INTERVAL_MS),
    })),
    threadSource: thread.threadSource,
  });
}

// tmux 대화형 Claude 는 daemon 이 없어 pane 의 세션 레코드 status 와 transcript 로 판정한다.
async function waitClaudeTmux(flags) {
  if (flags.remote)
    throw new Error("Claude tmux wait supports local sessions only");
  const session = splitTmuxTarget(flags.session).target;
  const requestId = flags["request-id"] ?? null;
  const timeoutMs = secondsFlag(flags, "timeout", DEFAULT_ANSWER_TIMEOUT_MS);
  const pollIntervalMs = msFlag(
    flags,
    "poll-interval",
    DEFAULT_POLL_INTERVAL_MS,
  );
  const deadline = Date.now() + timeoutMs;
  let transcriptPath = null;
  for (;;) {
    const target = await claudeTmuxTarget(session);
    if (!target)
      throw new Error(`no live Claude session in tmux target ${session}`);
    // 처음 찾은 transcript 를 고정해 /clear 로 바뀐 세션을 따라가지 않는다.
    transcriptPath ??= await claudeTmuxTranscript(
      session,
      flags["config-dir"],
      target,
    );
    const transcript = await readClaudeTranscript(transcriptPath, {
      requestId,
    });
    const result = {
      ok: true,
      status: transcript?.userSeen ? "working" : "submitted",
      done: false,
      timedOut: false,
      response: transcript?.response || "",
      ...(transcript?.context ?? modelContext("claude", null)),
      requestId,
      target,
    };
    const verdict = claudeWaitVerdict(transcript, target.status === "idle");
    if (verdict) return { ...result, ...verdict };
    if (Date.now() >= deadline) return { ...result, timedOut: true };
    await sleep(Math.min(pollIntervalMs, deadline - Date.now()));
  }
}

// 배달 전 항목은 공식 app-server 큐 API 로만 보고 지운다. 큐 저장소 파일은 건드리지 않는다.
async function queue(flags) {
  if ((flags.cli ?? "codex") !== "codex" || flags.remote)
    throw new Error("queue supports local --cli codex only");
  const { threadId, threadSource } = await codexThreadFromFlags(flags);
  const requestId = flags["request-id"];
  const items = (await listCodexQueue(threadId)).filter(
    (item) => !requestId || item.requestId === requestId,
  );
  const result = { ok: true, cli: "codex", threadId, threadSource };
  if (!flags.delete) return printJson({ ...result, items });
  const ids =
    flags.delete === "all" ? items.map((item) => item.id) : [flags.delete];
  printJson({ ...result, ...(await deleteCodexQueueItems(threadId, ids)) });
}

async function wait(flags) {
  if (flags.cli === "codex") return waitCodex(flags);
  if ((flags.cli ?? "claude") !== "claude")
    throw new Error("wait supports --cli claude or codex");
  if (flags.session && !flags.short && !flags["session-id"])
    return printJson(await waitClaudeTmux(flags));
  if (!flags.short && !flags["session-id"])
    throw new Error("wait requires --short, --session-id or --session");
  if (flags.remote || (flags.transport && flags.transport !== "uds"))
    throw new Error("wait supports local Claude UDS only");
  const timeoutMs = secondsFlag(flags, "timeout", DEFAULT_ANSWER_TIMEOUT_MS);
  printJson(
    await callBridgeVerb(
      resolveBridgePath(flags),
      "daemon-wait",
      {
        short: flags.short,
        sessionId: flags["session-id"],
        configDir: flags["config-dir"],
        requestId: flags["request-id"],
        timeoutMs,
        pollIntervalMs: msFlag(
          flags,
          "poll-interval",
          DEFAULT_POLL_INTERVAL_MS,
        ),
      },
      timeoutMs,
    ),
  );
}

async function rename(flags) {
  if (flags.cli !== "codex" || flags.transport !== "uds" || flags.remote)
    throw new Error("rename requires local --cli codex --transport uds");
  const name = requireFlag(flags, "name").trim();
  if (!name) throw new Error("--name must not be blank");
  const threadId = requireFlag(flags, "thread");
  if (threadId === "auto")
    throw new Error("rename requires an explicit --thread ID");
  const { renameCodexAppServerThread } = await import(
    "../hub/team/uds-orchestrator.mjs"
  );
  printJson(
    await renameCodexAppServerThread({
      socketPath: resolveCodexDaemonSocket(flags["codex-socket"] ?? "default"),
      threadId,
      name,
    }),
  );
}

async function stop(flags) {
  const adapter = selectAdapter({
    ...flags,
    cli: flags.cli ?? (flags.short || flags["session-id"] ? "claude" : "codex"),
  });
  printJson(await doStop(adapter, stopOpts(flags)));
}

async function claudeTmuxTarget(session) {
  const { stdout: paneId } = await runTmux(null, [
    "display-message",
    "-p",
    "-t",
    session,
    "#{pane_id}",
  ]);
  const discovery = await discoverClaudeTmuxSessions();
  return (
    discovery.sessions.find((entry) => entry.paneId === paneId.trim()) ?? null
  );
}

async function claudeTmuxTranscript(session, configDir, target) {
  target ??= await claudeTmuxTarget(session);
  return findClaudeTranscript({
    configDir:
      configDir ||
      process.env.CLAUDE_CONFIG_DIR ||
      pathJoin(homedir(), ".claude"),
    sessionId: target?.sessionId,
    cwd: target?.cwd,
  });
}

async function tmuxContext(adapter, opts) {
  const unknown = modelContext(adapter.cli, null);
  if (opts.remote) return unknown;
  try {
    if (adapter.cli === "claude") {
      const transcript = await claudeTmuxTranscript(
        opts.session,
        opts.configDir,
      );
      return (await readClaudeTranscript(transcript))?.context ?? unknown;
    }
    const { threadId } = await resolveCodexTmuxThread(opts.session);
    return await readCodexContext(null, threadId);
  } catch {
    return unknown;
  }
}

async function compact(flags) {
  if (
    (flags.cli ?? "claude") !== "claude" ||
    flags.remote ||
    flags.short ||
    flags["session-id"] ||
    (flags.transport && flags.transport !== "tmux")
  )
    throw new Error(
      "compact supports local --cli claude --session NAME only; UDS slash execution is unverified",
    );
  const ifBusy = flags["if-busy"] ?? "fail";
  if (!["fail", "wait"].includes(ifBusy))
    throw new Error("compact --if-busy must be fail or wait");
  const opts = askOpts(
    {
      ...flags,
      cli: "claude",
      transport: "tmux",
      "if-busy": ifBusy,
      "no-wait": true,
      prompt: `/compact${flags.instructions ? ` ${flags.instructions}` : ""}`,
    },
    ADAPTERS.claude,
  );
  if (ifBusy === "wait") await waitForTmuxIdle(ADAPTERS.claude, opts);
  const transcriptPath = await claudeTmuxTranscript(
    opts.session,
    opts.configDir,
  );
  const before = await readClaudeTranscript(transcriptPath);
  if (!before)
    throw new Error(
      "compact requires a discoverable Claude transcript for this tmux pane",
    );
  await doAskViaTmux(ADAPTERS.claude, {
    ...opts,
    ifBusy: "fail",
    skipContextGuard: true,
  });
  const deadline = Date.now() + opts.timeoutMs;
  do {
    const snapshot = await readClaudeTranscript(transcriptPath);
    if (snapshot?.compactCount > before.compactCount) {
      printJson({
        cli: "claude",
        session: opts.session,
        compacted: true,
        ...snapshot.compact,
      });
      return;
    }
    await sleep(
      Math.min(opts.pollIntervalMs, Math.max(0, deadline - Date.now())),
    );
  } while (Date.now() < deadline);
  printJson({
    cli: "claude",
    session: opts.session,
    compacted: false,
    timedOut: true,
  });
}

async function interrupt(flags) {
  const adapter = selectAdapter(flags);
  printJson(await doInterrupt(adapter, interruptOpts(flags, adapter)));
}

async function probe(flags) {
  const payload = { includeContext: true };
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

async function listSessions(flags) {
  const adapter = selectAdapter(flags);
  if (adapter.cli === "claude") {
    if (flags.remote || flags.transport === "uds") {
      throw new Error(
        "Claude list-sessions supports local tmux only; --remote and --transport uds are unavailable",
      );
    }
    if (flags.transport && !["tmux", "auto"].includes(flags.transport)) {
      throw new Error("Claude list-sessions --transport must be tmux or auto");
    }
    printJson(await discoverClaudeTmuxSessions({ cwd: flags.cwd }));
    return;
  }
  if (adapter.cli !== "codex") {
    throw new Error("list-sessions supports --cli codex or --cli claude");
  }
  if (flags.transport === "uds") {
    const { listCodexAppServerThreads } = await import(
      "../hub/team/uds-orchestrator.mjs"
    );
    printJson(
      await listCodexAppServerThreads({
        socketPath: resolveCodexDaemonSocket(
          flags["codex-socket"] ?? "default",
        ),
        cwd: flags.cwd,
      }),
    );
    return;
  }
  if (flags.transport && flags.transport !== "tmux")
    throw new Error("list-sessions --transport must be tmux or uds");
  printJson(
    await discoverCodexTmuxSessions({ cwd: flags.cwd, remote: flags.remote }),
  );
}

function startOptsForSession(flags, session, side) {
  return {
    session,
    ...(!side ? { name: flags.name } : {}),
    remote: flags.remote,
    cwd: flags.cwd,
    ...(side
      ? {
          model: flags[`model-${side}`],
          effort: flags[`effort-${side}`],
        }
      : {}),
    readyTimeoutMs: secondsFlag(
      flags,
      "ready-timeout",
      DEFAULT_READY_TIMEOUT_MS,
    ),
    pollIntervalMs: msFlag(flags, "poll-interval", DEFAULT_POLL_INTERVAL_MS),
  };
}

function askOptsForSession(flags, session, prompt, cli) {
  return {
    session,
    prompt,
    ...contextOpts(flags, cli),
    noRelayTag: Object.hasOwn(flags, "no-relay-tag"),
    remote: flags.remote,
    timeoutMs: secondsFlag(flags, "timeout", DEFAULT_ANSWER_TIMEOUT_MS),
    settleMs: msFlag(flags, "settle", DEFAULT_SETTLE_MS),
    pollIntervalMs: msFlag(flags, "poll-interval", DEFAULT_POLL_INTERVAL_MS),
    ifBusy: flags["if-busy"] ?? "wait",
    busyTimeoutMs: secondsFlag(
      flags,
      "busy-timeout",
      secondsFlag(flags, "timeout", DEFAULT_ANSWER_TIMEOUT_MS),
    ),
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
  for (const spec of stopSpecs) {
    try {
      if (!spec.stopped) {
        const result = await doStop(spec.adapter, spec.opts);
        spec.stopped = result.stopped === true;
      }
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
    requestId: result.requestId,
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
        askOptsForSession(flags, session, prompt, adapter.cli),
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
        askOptsForSession(flags, session, prompt, adapter.cli),
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
  let prompt;
  if (mode === "counting") {
    if (hopIndex === 0) {
      prompt = "Reply with only the integer 1.";
    } else {
      prompt = `The current integer is ${previous}. Add 1 to it and reply with ONLY the resulting integer, nothing else.`;
    }
  } else if (hopIndex === 0) {
    prompt = previous;
  } else {
    prompt = `The other party said: ${previous}\nReply briefly in 1-2 sentences and ask one short follow-up question.`;
  }

  return [
    prompt,
    `After you have completely finished your response, print a new line containing only this token: \`${PEER_HOP_DONE_MARKER}\`. Do not put any other characters on that line.`,
  ].join("\n");
}

function buildPeerClosurePrompt(previous) {
  return [
    "This is the final closure turn. Based on the discussion so far, declare whether a final agreement was reached.",
    "First reply with exactly one JSON object and no markdown fences:",
    '{"agreement_status":"complete|partial","unresolved_questions":[],"needs_more_rounds":false,"summary":"short final agreement"}',
    "Use agreement_status=complete only when no unresolved question remains and no more rounds are needed.",
    `The other party's latest response was: ${previous ?? "(none)"}`,
    `After the JSON is complete, print a new line containing only this token: \`${PEER_HOP_DONE_MARKER}\`. Do not put any other characters on that line.`,
  ].join("\n");
}

function isCompleteDeclaration(value) {
  return ["complete", "completed", "agreed", "합의완료", "완료"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

function unstructuredPeerClosure() {
  return {
    structured: false,
    declaredComplete: false,
    unresolvedQuestions: [],
    needsMoreRounds: null,
  };
}

function parsePeerClosure(response) {
  const text = String(response ?? "").trim();
  const fenced = text.match(/```(?:json)?\s*({[\s\S]*})\s*```/i)?.[1];
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  const objectText =
    fenced ??
    (firstBrace >= 0 && lastBrace > firstBrace
      ? text.slice(firstBrace, lastBrace + 1)
      : null);

  if (objectText) {
    try {
      // Terminal word-wrap can inject a raw newline + indent mid-token in
      // compact JSON (e.g. "f\n  alse" for "false") since there's often no
      // space nearby to wrap at. Try the raw text first, then retry with
      // wrap artifacts collapsed before giving up as unstructured.
      let parsed;
      try {
        parsed = JSON.parse(objectText);
      } catch {
        parsed = JSON.parse(objectText.replace(/\n[ \t]*/g, ""));
      }
      const unresolvedQuestions = parsed.unresolved_questions;
      const needsMoreRounds = parsed.needs_more_rounds;
      const structured =
        Object.hasOwn(parsed, "agreement_status") &&
        Array.isArray(unresolvedQuestions) &&
        typeof needsMoreRounds === "boolean";
      if (structured) {
        return {
          structured: true,
          declaredComplete: isCompleteDeclaration(parsed.agreement_status),
          unresolvedQuestions: unresolvedQuestions.map(String),
          needsMoreRounds,
        };
      }
      return unstructuredPeerClosure();
    } catch {
      return unstructuredPeerClosure();
    }
  }

  const status = text.match(
    /(?:agreement_status|agreement status|합의상태|합의 상태)\s*[:=]\s*["']?([^\n,"'}]+)/i,
  )?.[1];
  const unresolved = text.match(
    /(?:unresolved_questions|unresolved questions|미해결 쟁점)\s*[:=]\s*([^\n]+)/i,
  )?.[1];
  const needsMore = text.match(
    /(?:needs_more_rounds|needs more rounds|추가 라운드 필요)\s*[:=]\s*(true|false)/i,
  )?.[1];
  const structured =
    status !== undefined && unresolved !== undefined && needsMore !== undefined;
  const unresolvedQuestions = /^(?:\[\s*\]|none|없음)$/i.test(
    String(unresolved ?? "").trim(),
  )
    ? []
    : String(unresolved ?? "")
        .replace(/^\[|\]$/g, "")
        .split(/[,;|]/)
        .map((item) => item.trim())
        .filter(Boolean);

  return {
    structured,
    declaredComplete: isCompleteDeclaration(status),
    unresolvedQuestions,
    needsMoreRounds:
      needsMore === undefined ? null : needsMore.toLowerCase() === "true",
  };
}

function derivePeerStatus({ hopsCompleted, closure, exitReason = null }) {
  if (hopsCompleted < 1) return "failed";
  if (exitReason) return "partial";
  if (
    closure?.structured === true &&
    closure.declaredComplete === true &&
    closure.needsMoreRounds === false &&
    closure.unresolvedQuestions.length === 0
  ) {
    return "complete";
  }
  return "partial";
}

function classifyPeerExitReason(error) {
  const fingerprint = [error?.name, error?.code, error?.message]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /timeout|timed out|etimedout|aborterror/.test(fingerprint)
    ? "timeout"
    : "transport_error";
}

function peerSignalExit(signal) {
  return signal === "SIGTERM"
    ? { exitReason: "terminated", exitCode: 143 }
    : { exitReason: "user_interrupt", exitCode: 130 };
}

function createPeerSignalController({
  output,
  persistTranscript,
  persistStatus,
  stopSessions,
  printOutput = printJson,
  exitProcess = (code) => process.exit(code),
  timeoutMs = 3000,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let signalCount = 0;
  let settled = false;

  const recordArtifactError = (kind, error) => {
    output.artifact_errors ??= [];
    output.artifact_errors.push(`${kind}: ${error.message}`);
  };

  return {
    async handle(signal) {
      if (settled) return;
      signalCount += 1;
      const { exitReason, exitCode } = peerSignalExit(signal);
      if (signalCount > 1) {
        settled = true;
        exitProcess(exitCode);
        return;
      }

      const startedAt = now();
      output.status = "aborted";
      output.exit_reason = exitReason;
      output.hops_completed = output.hops.length;

      try {
        persistTranscript(output);
      } catch (error) {
        recordArtifactError("transcript", error);
      }
      try {
        persistStatus(output);
      } catch (error) {
        recordArtifactError("status", error);
      }

      const remainingMs = Math.max(0, timeoutMs - (now() - startedAt));
      let timer;
      const graceExpired = new Promise((resolve) => {
        timer = setTimer(() => resolve("timeout"), remainingMs);
      });
      await Promise.race([
        Promise.resolve()
          .then(stopSessions)
          .then(
            () => "stopped",
            () => "stop_error",
          ),
        graceExpired,
      ]);
      clearTimer(timer);

      if (settled) return;
      settled = true;
      printOutput(output);
      exitProcess(exitCode);
    },
    dispose() {
      settled = true;
    },
  };
}

function peerArtifactPaths(sessionA, sessionB) {
  const preferredDir =
    process.env.TFX_LIVE_ARTIFACT_DIR ??
    pathJoin(homedir(), ".claude", "cache", "triflux", "tfx-live", "peer-runs");
  const fallbackDir = pathJoin(tmpdir(), "triflux-live");
  let artifactDir = preferredDir;
  try {
    mkdirSync(artifactDir, { recursive: true });
  } catch {
    artifactDir = fallbackDir;
    mkdirSync(artifactDir, { recursive: true });
  }
  const safe = (value) =>
    String(value)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .slice(0, 48);
  const runId = `peer-${safe(sessionA)}-${safe(sessionB)}-${Date.now()}-${process.pid}`;
  return {
    transcriptPath: pathJoin(artifactDir, `${runId}.transcript.json`),
    statusPath: pathJoin(artifactDir, `${runId}.status.json`),
  };
}

function persistPeerTranscript(paths, output) {
  writeFileSync(
    paths.transcriptPath,
    `${JSON.stringify(
      {
        mode: output.mode,
        rounds: output.rounds,
        cliA: output.cliA,
        cliB: output.cliB,
        hops_completed: output.hops.length,
        hops: output.hops,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function persistPeerStatus(paths, output) {
  const { hops: _hops, ...status } = output;
  writeFileSync(
    paths.statusPath,
    `${JSON.stringify(status, null, 2)}\n`,
    "utf8",
  );
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
  if (!VALID_TRANSPORTS.includes(transport) || transport === "queue") {
    throw new Error(`--transport-${side} must be one of: tmux, uds, auto`);
  }
  if (
    transport !== "tmux" &&
    adapter.cli !== "claude" &&
    !(adapter.cli === "codex" && transport === "uds")
  ) {
    throw new Error(
      `--transport-${side} ${transport} is only supported when --cli-${side} is claude`,
    );
  }
  return transport;
}

function peerSideBusyPolicy(flags, side, adapter, transport) {
  const allowed =
    adapter.cli === "codex" && transport === "uds"
      ? ["wait", "fail", "steer"]
      : ["wait", "fail", "interrupt"];
  for (const name of ["if-busy", `if-busy-${side}`]) {
    if (flags[name] !== undefined && !allowed.includes(flags[name]))
      throw new Error(
        `--${name} must be ${allowed.join("|")} for side ${side} (${adapter.cli} ${transport})`,
      );
  }
  return sideFlag(flags, side, "if-busy", "wait");
}

function peerSideBaseOpts(flags, side, adapter, session) {
  const transport = peerSideTransport(flags, side, adapter);
  const ifBusy = peerSideBusyPolicy(flags, side, adapter, transport);
  const short = sideFlag(flags, side, "short");
  const sessionId = sideFlag(flags, side, "session-id");
  const threadId = sideFlag(flags, side, "thread");
  if (transport === "uds" && adapter.cli === "codex" && !threadId)
    throw new Error(`--transport-${side} uds requires --thread-${side}`);
  if (
    transport !== "tmux" &&
    adapter.cli === "claude" &&
    !short &&
    !sessionId
  ) {
    throw new Error(
      `--transport-${side} ${transport} requires --short-${side} or --session-id-${side}`,
    );
  }
  return {
    session,
    noRelayTag: Object.hasOwn(flags, "no-relay-tag"),
    ...contextOpts(flags, adapter.cli),
    short,
    sessionId,
    threadId,
    codexSocket:
      adapter.cli === "codex" && transport === "uds"
        ? sideFlag(flags, side, "codex-socket", "default")
        : null,
    socketPath:
      adapter.cli === "codex" && transport === "uds" && !flags.remote
        ? resolveCodexDaemonSocket(
            sideFlag(flags, side, "codex-socket", "default"),
          )
        : null,
    transport,
    bridgePath: sideFlag(flags, side, "bridge", resolveBridgePath(flags)),
    remote: flags.remote,
    cwd: flags.cwd,
    timeoutMs: secondsFlag(flags, "timeout", DEFAULT_ANSWER_TIMEOUT_MS),
    maxTurnMs:
      adapter.cli === "codex" && transport === "uds"
        ? secondsFlag(
            flags,
            "max-turn",
            Math.min(resolveHardCeilingMs(), 15 * 60_000),
          )
        : undefined,
    settleMs: msFlag(flags, "settle", DEFAULT_SETTLE_MS),
    pollIntervalMs: msFlag(flags, "poll-interval", DEFAULT_POLL_INTERVAL_MS),
    ifBusy,
    busyTimeoutMs: secondsFlag(
      flags,
      "busy-timeout",
      secondsFlag(flags, "timeout", DEFAULT_ANSWER_TIMEOUT_MS),
    ),
    readyTimeoutMs: secondsFlag(
      flags,
      "ready-timeout",
      DEFAULT_READY_TIMEOUT_MS,
    ),
  };
}

function askOptsFromPeerBase(base, prompt) {
  return { ...base, prompt, doneMarker: PEER_HOP_DONE_MARKER };
}

function shouldPrestartPeerSide(base) {
  return base.transport === "tmux";
}

async function verifyAttachedPeerSide(adapter, base, deps = {}) {
  if (base.transport !== "tmux") return;
  const tmux = deps.runTmux ?? runTmux;
  const { session, target } = splitTmuxTarget(base.session);
  try {
    await tmux(base.remote, ["has-session", "-t", session]);
  } catch {
    throw new Error(`attached ${adapter.cli} session not found: ${session}`);
  }
  if (adapter.cli === "codex") {
    const { stdout } = await tmux(base.remote, [
      "display-message",
      "-p",
      "-t",
      target,
      "#{pane_current_command}\t#{pane_start_command}\t#{pane_tty}\t#{pane_pid}",
    ]);
    const [currentCommand, startCommand, paneTty, panePid] = stdout
      .trimEnd()
      .split("\t");
    const result = await inspectCodexTmuxPane(
      { currentCommand, startCommand, paneTty, panePid, remote: base.remote },
      deps,
    );
    if (result.preflightWarning) return result;
    if (!result.isCodex) {
      throw new Error(`attached target is not a Codex tmux pane: ${target}`);
    }
  }
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
  peerSideBusyPolicy(
    flags,
    "a",
    adapterA,
    peerSideTransport(flags, "a", adapterA),
  );
  peerSideBusyPolicy(
    flags,
    "b",
    adapterB,
    peerSideTransport(flags, "b", adapterB),
  );
  const sessionA = flags["session-a"] ?? "peerA";
  const sessionB = flags["session-b"] ?? "peerB";
  const baseA = peerSideBaseOpts(flags, "a", adapterA, sessionA);
  const baseB = peerSideBaseOpts(flags, "b", adapterB, sessionB);
  const attachedA =
    Object.hasOwn(flags, "attach-a") || baseA.transport === "uds";
  const attachedB =
    Object.hasOwn(flags, "attach-b") || baseB.transport === "uds";
  const rounds = integerFlag(flags, "rounds", 4);
  const mode = peerMode(flags);
  const hops = [];
  const numbers = [];
  const stopSpecs = [];
  const artifactPaths = peerArtifactPaths(sessionA, sessionB);
  const output = {
    mode,
    rounds,
    cliA: adapterA.cli,
    cliB: adapterB.cli,
    transportA: baseA.transport,
    transportB: baseB.transport,
    attachedA,
    attachedB,
    stoppedA: false,
    stoppedB: false,
    hops,
    transcript_path: artifactPaths.transcriptPath,
    status_path: artifactPaths.statusPath,
  };
  if (mode === "counting") {
    output.numbers = numbers;
  }
  let previous =
    mode === "freeform"
      ? (flags.seed ??
        "Introduce yourself in one sentence, then ask the other party one short question.")
      : null;
  let primaryError = null;
  let stopError = null;
  let closure = null;
  const stopPeerSessions = async () => {
    try {
      await stopAfterLifecycle(stopSpecs);
    } finally {
      output.stoppedA =
        !attachedA &&
        stopSpecs.some(
          (spec) => spec.opts.session === sessionA && spec.stopped,
        );
      output.stoppedB =
        !attachedB &&
        stopSpecs.some(
          (spec) => spec.opts.session === sessionB && spec.stopped,
        );
    }
  };
  const signalController = createPeerSignalController({
    output,
    persistTranscript: (value) => persistPeerTranscript(artifactPaths, value),
    persistStatus: (value) => persistPeerStatus(artifactPaths, value),
    stopSessions: stopPeerSessions,
  });
  const onSigint = () => {
    void signalController.handle("SIGINT");
  };
  const onSigterm = () => {
    void signalController.handle("SIGTERM");
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    for (const [side, adapter, base, attached] of [
      ["a", adapterA, baseA, attachedA],
      ["b", adapterB, baseB, attachedB],
    ]) {
      if (!attached) continue;
      const result = await verifyAttachedPeerSide(adapter, base);
      if (result?.preflightWarning) {
        output.preflightWarning ??= [];
        output.preflightWarning.push({
          side,
          message: result.preflightWarning,
        });
      }
    }
    if (!attachedA && shouldPrestartPeerSide(baseA)) {
      await doStart(adapterA, startOptsForSession(flags, sessionA, "a"));
      addStopSpecOnce(stopSpecs, adapterA, baseA);
    }
    if (!attachedB && shouldPrestartPeerSide(baseB)) {
      await doStart(adapterB, startOptsForSession(flags, sessionB, "b"));
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
      const isClosure = hopIndex === rounds * 2 - 1;
      const sent = isClosure
        ? buildPeerClosurePrompt(previous)
        : peerPrompt(mode, hopIndex, previous);
      const result = await doAsk(adapter, askOptsFromPeerBase(base, sent));
      if (
        (result.transportSelected ?? result.transport ?? base.transport) ===
        "uds"
      ) {
        result.response = String(result.response ?? "")
          .split(/\r?\n/)
          .filter((line) => line.trim() !== PEER_HOP_DONE_MARKER)
          .join("\n")
          .trim();
      }
      if (result.tmuxStartedOnDemand && !(isA ? attachedA : attachedB)) {
        addStopSpecOnce(stopSpecs, adapter, base);
      }
      if (
        result.done !== true ||
        result.error ||
        !String(result.response ?? "").trim()
      ) {
        throw new Error(
          (result.timedOut
            ? `Peer hop timed out at hop ${hopIndex + 1}`
            : result.error) ??
            `Empty response from ${adapter.cli} at hop ${hopIndex + 1}`,
        );
      }

      hops.push({
        hop: hopIndex + 1,
        requestId: result.requestId,
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
      if (isClosure) {
        closure = parsePeerClosure(result.response);
      }

      if (mode === "counting") {
        const parsed = parseFirstInteger(result.response);
        if (parsed === null && !isClosure) {
          throw new Error(
            `Could not parse integer from ${adapter.cli} response at hop ${hopIndex + 1}`,
          );
        }
        if (parsed !== null) {
          numbers.push(parsed);
          previous = parsed;
        } else {
          previous = result.response;
        }
      } else {
        previous = result.response;
      }
    }
  } catch (error) {
    primaryError = error;
  }

  try {
    await stopPeerSessions();
  } catch (error) {
    stopError = error;
  }
  signalController.dispose();
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);

  const terminalError = primaryError ?? stopError;
  const exitReason = terminalError
    ? classifyPeerExitReason(terminalError)
    : null;
  output.hops_completed = hops.length;
  output.closure = closure;
  output.status = derivePeerStatus({
    hopsCompleted: hops.length,
    closure,
    exitReason,
  });
  if (exitReason) {
    output.exit_reason = exitReason;
    output.error = terminalError.message;
  }

  try {
    persistPeerTranscript(artifactPaths, output);
  } catch (error) {
    output.artifact_errors ??= [];
    output.artifact_errors.push(`transcript: ${error.message}`);
  }
  try {
    persistPeerStatus(artifactPaths, output);
  } catch (error) {
    output.artifact_errors ??= [];
    output.artifact_errors.push(`status: ${error.message}`);
  }
  printJson(output);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const { command, flags } = parseCli(process.argv.slice(2));

  if (command === "help") {
    process.stdout.write(`${usage(flags.subcommand)}\n`);
    return;
  }

  if (command === "start") {
    await start(flags);
  } else if (command === "ask") {
    await ask(flags);
  } else if (command === "wait") {
    await wait(flags);
  } else if (command === "queue") {
    await queue(flags);
  } else if (command === "compact") {
    await compact(flags);
  } else if (command === "rename") {
    await rename(flags);
  } else if (command === "stop") {
    await stop(flags);
  } else if (command === "interrupt") {
    await interrupt(flags);
  } else if (command === "probe") {
    await probe(flags);
  } else if (command === "list-sessions") {
    await listSessions(flags);
  } else if (command === "converse") {
    await converse(flags);
  } else if (command === "goal-driven") {
    await goalDriven(flags);
  } else if (command === "peer") {
    await peer(flags);
  } else {
    throw new Error(`Unknown subcommand: ${command}\n${usage()}`);
  }
}

export {
  ADAPTERS,
  buildLaunchKeys,
  buildPeerClosurePrompt,
  buildRemoteLiveCommand,
  buildTmuxCommand,
  callRemoteLive,
  classifyPeerExitReason,
  createPeerSignalController,
  derivePeerStatus,
  discoverClaudeTmuxSessions,
  discoverCodexTmuxSessions,
  doAskViaTmux,
  extractAssistantResponse,
  extractClaudeCompletedTaskListResponse,
  extractResponseSinceMarker,
  hasClaudeCompletedTaskListResponse,
  inspectCodexTmuxPane,
  isCodexLoadingCapture,
  parseCodexTmuxSessions,
  parsePeerClosure,
  parseRemoteLiveJson,
  peerSideBaseOpts,
  resolveAskTransport,
  resolveCodexDaemonSocket,
  resumedCodexThread,
  splitTmuxTarget,
  stopOpts,
  tmuxBufferName,
  verifyAttachedPeerSide,
};

function isMainModule() {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === modulePath;
  } catch {
    // process.argv[1] doesn't resolve on disk (e.g. `node -e`) — fall back
    // to a non-symlink-aware comparison instead of treating it as not-main.
    return pathResolve(process.argv[1]) === modulePath;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    printJson({
      ok: false,
      error: error.message,
      ...(error.requestId ? { requestId: error.requestId } : {}),
    });
    process.exitCode = 1;
  });
}
