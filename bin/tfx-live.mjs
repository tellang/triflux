#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  join as pathJoin,
  resolve as pathResolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  codexThreadNames,
  readCodexSessionRecords,
  registryDir,
} from "../hub/lib/codex-session-registry.mjs";
import { privateTmpDir } from "../hub/lib/private-tmp.mjs";
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
import { resolveCodexSocket } from "../hub/team/native-peer.mjs";
import {
  escapePwshSingleQuoted as escapeRemotePwshSingleQuoted,
  probeRemoteEnv as probeRemoteHostEnv,
  shellQuote as remoteShellQuote,
  validateHost as validateRemoteHost,
} from "../hub/team/remote-session.mjs";
import {
  contextGuard,
  findCodexRollout,
  modelContext,
  readCodexContext,
} from "../hub/team/session-context.mjs";
import { JsonRpcWsUdsClient } from "../hub/workers/lib/jsonrpc-ws-uds.mjs";

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
  "via-tmux",
  "json",
  "attach-a",
  "attach-b",
  "attach-c",
  "no-wait",
  "no-relay-tag",
  "sandbox",
  "no-auto-trust",
]);
const PEER_HOP_DONE_MARKER = "<<<TFX_PEER_HOP_DONE>>>";
const TMUX_SET_BUFFER_MAX_BYTES = 8 * 1024;
const PEER_DEFAULT_SEED =
  "Introduce yourself in one sentence, then ask the other party one short question.";
// uds-fallback diagnostics land here, written async so a failed daemon attach
// never blocks the tmux fallback path (see writeUdsBugReport / doAskAuto).
const BUG_REPORT_DIR =
  process.env.TFX_LIVE_BUG_REPORT_DIR ??
  pathJoin(homedir(), ".claude", "cache", "triflux", "tfx-live", "bug-reports");

function usage(command) {
  const lines = [
    "Usage:",
    "  tfx-live start --session NAME [--name NAME] [--group NAME] [--cli codex|claude|agy] [--lead-session ID] [--sandbox] [--no-auto-trust] [--unset-env PATTERNS] [--model ID] [--effort TIER] [--cwd DIR] [--remote HOST] [--resume ID] [--resume-last 1] [--ready-timeout 30] [--poll-interval 1500]",
    "  tfx-live ask --session NAME[:WINDOW.PANE] --prompt TEXT [--cli codex|claude|agy] [--if-busy wait|fail|interrupt|queue] [--busy-timeout 60] [--timeout 60] [--remote HOST] [--settle 1500] [--poll-interval 1500]",
    "  tfx-live ask --cli codex [--transport queue|tmux] (--session NAME[:WINDOW.PANE] | --thread UUID) --prompt TEXT [--from NAME] [--timeout 60] [--no-wait]",
    "    Codex ask defaults to the app-server queue (thread/queue/add, `codex queue --message` only when add is unavailable; delivered when the TUI picks it up); tmux paste is the reported fallback and the path for slash commands. /rename and /status skip idle waiting only with --if-busy wait (default) or queue; explicit fail or interrupt policies are honored. /compact and /new wait for idle by default.",
    "  tfx-live ask --cli codex --transport uds --thread ID|auto --prompt TEXT [--codex-socket PATH|default] [--cwd DIR] [--if-busy wait|fail|steer] [--busy-timeout 60] [--timeout 60] [--max-turn SECONDS]",
    "  tfx-live ask --transport uds|auto (--short SHORT | --session-id ID) --prompt TEXT [--config-dir DIR] [--bridge ABS] [--session NAME (auto fallback)] [--timeout 60]",
    "    ask options: --no-wait --no-relay-tag --via-tmux (a Claude caller sending to a local Claude session is refused and told to use SendMessage unless set) --warn-context-pct N --max-context-pct N (0 disables; Claude 60/90, Codex 60/85 of rollout window or 15/22 of 1.05M).",
    "  tfx-live send --to NAME|CLI:NAME --message TEXT [--from NAME] [--no-wait] [--timeout 600] [--via-tmux (명시적 tmux 입력)]",
    "  tfx-live compact --session NAME [--cli claude|codex] [--instructions TEXT] [--then PROMPT] [--no-wait] [--if-busy fail|wait] [--timeout 60]",
    "  tfx-live goal set --session NAME [--cli claude|codex] --condition TEXT [--budget N]",
    "  tfx-live goal status --session NAME [--cli claude|codex]",
    "  tfx-live goal clear --session NAME [--cli claude|codex]",
    "  tfx-live wait --cli claude (--short SHORT | --session-id ID | --session NAME[:WINDOW.PANE]) [--request-id ID] [--config-dir DIR] [--bridge ABS] [--timeout 60] [--poll-interval 1500]",
    "  tfx-live wait --cli codex (--session NAME[:WINDOW.PANE] | --thread UUID) --request-id ID [--timeout 60] [--poll-interval 1500]",
    "  tfx-live wait --cli agy --session NAME[:WINDOW.PANE] [--request-id ID] [--timeout 60] [--poll-interval 1500]",
    "  tfx-live queue --cli codex (--session NAME[:WINDOW.PANE] | --thread UUID) [--request-id ID] [--delete QUEUED_ID|all]",
    "    queue lists or deletes items the TUI has not picked up yet (official app-server thread/queue API); missing means already delivered or gone.",
    "  tfx-live rename --cli codex --transport uds --thread ID --name NAME [--codex-socket PATH|default]",
    "  tfx-live adopt --session NAME[:WINDOW.PANE] [--cli codex] [--timeout 120] [--poll-interval 1500]",
    "    adopt types one nonce message into a hand-launched local Codex pane, finds the shared-daemon thread that received it, and records it so tfx-peer can reach the pane.",
    "    transport: auto is the default for Claude when --short/--session-id is present; otherwise tmux. bridge path: --bridge > $TFX_BRIDGE > $TFX_REPO_ROOT/hub/bridge.mjs > bundled Triflux hub/bridge.mjs.",
    "  tfx-live interrupt --session NAME [--cli codex|claude|agy] [--transport tmux|uds|auto] [--short SHORT | --session-id ID] [--config-dir DIR] [--bridge ABS] [--timeout 5]",
    "  tfx-live stop --session NAME [--cli codex|claude|agy] [--remote HOST]",
    "  tfx-live stop --cli claude (--short SHORT | --session-id ID) [--config-dir DIR]",
    "  tfx-live probe [--short SHORT] [--session-id ID] [--config-dir DIR] [--bridge ABS] [--timeout 10]",
    "  tfx-live list-sessions --cli codex|claude|agy [--transport tmux|uds] [--codex-socket PATH|default] [--cwd DIR] [--remote HOST (codex tmux only)]",
    "    Claude and agy list-sessions support local tmux only; --transport uds requires --cli codex.",
    "  tfx-live converse --session NAME --prompts-file PATH [--cli codex|claude] [--remote HOST] [--cwd DIR] [--timeout 60] [--settle 1500]",
    "  tfx-live goal-driven --session NAME --goal TEXT [--cli codex|claude] [--remote HOST] [--cwd DIR] [--timeout 60] [--settle 1500] [--max-rounds 8] [--done-token DONE]",
    "  tfx-live peer [--group NAME] [--cli-a codex] [--cli-b claude] [--cli-c CLI] [--model-a ID] [--model-b ID] [--effort-a TIER] [--effort-b TIER] [--model-c ID] [--effort-c TIER] [--session-a NAME[:WINDOW.PANE]] [--session-b NAME[:WINDOW.PANE]] [--session-c NAME[:WINDOW.PANE]] [--attach-a] [--attach-b] [--attach-c] [--transport-a tmux|queue|uds|auto] [--transport-b tmux|queue|uds|auto] [--transport-c tmux|queue|uds|auto] [--short-a SHORT] [--short-b SHORT] [--short-c SHORT] [--session-id-a ID] [--session-id-b ID] [--session-id-c ID] [--thread-a ID|auto] [--thread-b ID|auto] [--thread-c ID|auto] [--codex-socket-a PATH|default] [--codex-socket-b PATH|default] [--codex-socket-c PATH|default] [--bridge ABS] [--bridge-c ABS] [--remote HOST] [--cwd DIR] [--if-busy wait|fail] [--if-busy-a POLICY] [--if-busy-b POLICY] [--if-busy-c POLICY] [--busy-timeout 60] [--max-turn SECONDS] [--rounds 4] [--mode counting|freeform|debate] [--seed TEXT] [--timeout 60] [--via relay|message] [--report-to NAME]",
    "    --via message (Claude x Claude): sends each side the other's session name once, then they talk with SendMessage; reports to --report-to or the calling Claude session.",
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
  const action = command === "goal" ? rest.shift() : undefined;
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

  return { command, flags, action };
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

// 기본값은 contextGuard 가 읽은 실행 창에 맞춰 고른다.
function contextPctFlag(flags, name) {
  if (flags[name] === undefined) return undefined;
  const value = Number(flags[name]);
  if (!Number.isFinite(value) || value < 0 || value > 100)
    throw new Error(`--${name} must be between 0 and 100`);
  return value;
}

function contextOpts(flags, cli) {
  if (cli === "agy") return {};
  return {
    warnContextPct: contextPctFlag(flags, "warn-context-pct"),
    maxContextPct: contextPctFlag(flags, "max-context-pct"),
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
  if (cli === "agy" && flags.remote)
    throw new Error("agy supports local tmux only; --remote is unavailable");
  if (flags.sandbox && cli !== "agy")
    throw new Error("--sandbox is only supported with --cli agy");
  if (flags["if-busy"] === "queue" && cli !== "agy")
    throw new Error("--if-busy queue is only supported with --cli agy");
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
      // zsh 는 맨 앞 '=' 를 명령 경로로 바꾸므로 따옴표로 감싼다.
      if (/^[A-Za-z0-9_/:.,@%+-][A-Za-z0-9_/:.,@%+=-]*$/.test(text)) {
        return text;
      }
      return `'${text.replace(/'/g, `'"'"'`)}'`;
    })
    .join(" ");
}

// psmux 의 PowerShell(로컬 Windows, Windows 원격)은 POSIX 의 VAR=값 접두어를 모른다.
function withLeadSession(command, leadSession, os) {
  if (os === "win32")
    return `$env:TFX_LEAD_SESSION_ID='${escapeRemotePwshSingleQuoted(leadSession)}'; ${command}`;
  return `TFX_LEAD_SESSION_ID=${shellQuote([leadSession])} ${command}`;
}

function withUnsetEnv(command, patterns) {
  if (!patterns.length) return command;
  if (patterns.some((pattern) => !/^[A-Za-z_][A-Za-z0-9_]*\*?$/.test(pattern)))
    throw new Error(
      "--unset-env requires comma-separated environment names or prefixes ending in '*'",
    );
  if (process.platform === "win32")
    throw new Error("--unset-env is unavailable on Windows");
  const exact = patterns.filter((pattern) => !pattern.endsWith("*"));
  const prefixes = patterns.filter((pattern) => pattern.endsWith("*"));
  const expressions = prefixes.flatMap((pattern) => [
    "-e",
    `s/^\\(${pattern.slice(0, -1)}[A-Za-z0-9_]*\\)=.*/-u \\1/p`,
  ]);
  return [
    "env",
    ...exact.flatMap((name) => ["-u", name]),
    ...(expressions.length
      ? [`$(env | sed -n ${shellQuote(expressions)})`]
      : []),
    command,
  ].join(" ");
}

function inspectUnsetEnv(environment, patterns, platform) {
  const readable =
    platform === "darwin"
      ? /(?:^|\s)PATH=/.test(environment)
      : environment.length > 0;
  if (!readable) return { readable: false, remaining: [] };
  const names =
    platform === "darwin"
      ? [...environment.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)].map(
          (match) => match[1],
        )
      : environment.split("\0").map((entry) => entry.split("=", 1)[0]);
  return {
    readable,
    remaining: names.filter((name) =>
      patterns.some((pattern) =>
        pattern.endsWith("*")
          ? name.startsWith(pattern.slice(0, -1))
          : name === pattern,
      ),
    ),
  };
}

async function paneCliProcess(session, cli, panePid) {
  if (!panePid) {
    const { stdout } = await runTmux(null, [
      "display-message",
      "-p",
      "-t",
      exactTmuxTarget(session),
      "#{pane_pid}",
    ]);
    panePid = Number(stdout.trim());
  }
  const { stdout } = await execFileAsync(
    "ps",
    ["-eo", "pid=,ppid=,stat=,tty=,args="],
    {
      timeout: 5000,
      maxBuffer: MAX_BUFFER,
    },
  );
  const rows = stdout
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/))
    .filter(Boolean);
  const tree = new Map([[String(panePid), 0]]);
  let size;
  do {
    size = tree.size;
    for (const [, pid, ppid] of rows)
      if (!tree.has(pid) && tree.has(ppid)) tree.set(pid, tree.get(ppid) + 1);
  } while (tree.size !== size);
  const byPid = new Map(rows.map((row) => [row[1], row]));
  const paneTty = byPid.get(String(panePid))?.[4];
  // omx 처럼 CLI 를 분리 세션으로 띄우는 래퍼는 CLI 에 전면 그룹(+)이 없다. 그 CLI 의 조상 중
  // pane 의 TTY 에서 전면(+)인 첫 프로세스가 셸이 아닐 때만 그 래퍼가 입력을 중계한다고 본다.
  // 전면이 셸이면 입력이 셸로 가고, 다른 PTY 의 전면은 pane 입력과 무관하므로 거부한다.
  const isShell = (command) =>
    /^(?:\S*\/)?-?(?:zsh|bash|sh|fish|dash|ksh|csh|tcsh|login|nu|xonsh)(?:\s|$)/.test(
      command,
    );
  const relayedByWrapper = (pid) => {
    for (
      let cur = byPid.get(pid)?.[2];
      cur && tree.has(cur);
      cur = byPid.get(cur)?.[2]
    ) {
      const [, , , stat, tty, command] = byPid.get(cur) ?? [];
      if (!stat?.includes("+")) continue;
      return tty === paneTty && !isShell(command);
    }
    return false;
  };
  let selected = null;
  let selectedDepth = Infinity;
  for (const [, pid, , stat, tty, command] of rows) {
    const depth = tree.get(pid);
    if (depth === undefined) continue;
    if (
      cli === "codex"
        ? isCodexProcessCommand(command)
        : new RegExp(`^(?:\\S*/)?${cli}(?:\\s|$)`).test(command)
    ) {
      const attached = stat.includes("+") && tty === paneTty;
      const running =
        !/[TtZ]/.test(stat) && (attached || relayedByWrapper(pid));
      if (
        depth < selectedDepth ||
        (depth === selectedDepth && attached && !selected.attached)
      ) {
        selected = { pid: Number(pid), command, running, attached };
        selectedDepth = depth;
      }
    }
  }
  return selected;
}

async function agyConversation(pid) {
  if (!pid) return null;
  try {
    const { stdout } = await execFileAsync("lsof", ["-Fn", "-p", String(pid)], {
      timeout: 5000,
      maxBuffer: MAX_BUFFER,
    });
    const match = stdout.match(
      /^n(.*\/antigravity-cli)\/presence\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/im,
    );
    return match
      ? {
          conversationId: match[2],
          dbPath: pathJoin(match[1], "conversations", `${match[2]}.db`),
        }
      : null;
  } catch {
    return null;
  }
}

async function discoverAgyTmuxSessions({ cwd = null } = {}) {
  const result = { ok: true, cli: "agy", cwd: normalizeCwd(cwd), sessions: [] };
  let stdout;
  try {
    ({ stdout } = await runTmux(null, [
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
  for (const line of stdout.split(/\r?\n/)) {
    const [session, , , window, pane, paneCwd, , , , pid, paneId] =
      line.split("\t");
    if (!paneId || (result.cwd && normalizeCwd(paneCwd) !== result.cwd))
      continue;
    const target = `${session}:${window}.${pane}`;
    const agyProcess = await paneCliProcess(target, "agy", Number(pid));
    if (!agyProcess) continue;
    const conversation = await agyConversation(agyProcess.pid);
    result.sessions.push({
      session,
      name: session,
      target,
      paneId,
      cwd: normalizeCwd(paneCwd),
      ...agyProcess,
      conversationId: conversation?.conversationId ?? null,
    });
  }
  return result;
}

// 사용자 입력(14), 모델 응답(15), 오류(17) step 에서 화면에 보이는 문구가 든 필드 경로.
const AGY_STEP_TEXT_FIELDS = { 14: [19, 2], 15: [20, 1], 17: [24, 3, 1] };

function agyStepText(payload, stepType) {
  const fieldPath = AGY_STEP_TEXT_FIELDS[stepType];
  let bytes = Buffer.from(payload);
  for (const wanted of fieldPath) {
    let offset = 0;
    let found = null;
    const varint = () => {
      let value = 0;
      let factor = 1;
      for (let count = 0; count < 10 && offset < bytes.length; count++) {
        const byte = bytes[offset++];
        value += (byte & 127) * factor;
        if (!(byte & 128)) return value;
        factor *= 128;
      }
      throw new Error("Invalid agy protobuf varint");
    };
    while (offset < bytes.length) {
      const tag = varint();
      const field = Math.floor(tag / 8);
      const wire = tag % 8;
      if (!field) throw new Error("Invalid agy protobuf field");
      if (wire === 0) {
        varint();
      } else if (wire === 1 || wire === 5) {
        offset += wire === 1 ? 8 : 4;
        if (offset > bytes.length)
          throw new Error("Invalid agy protobuf length");
      } else if (wire === 2) {
        const length = varint();
        if (!Number.isSafeInteger(length) || offset + length > bytes.length)
          throw new Error("Invalid agy protobuf length");
        if (field === wanted) found = bytes.subarray(offset, offset + length);
        offset += length;
      } else {
        throw new Error(`Unsupported agy protobuf wire type: ${wire}`);
      }
    }
    if (!found) return "";
    bytes = found;
  }
  return bytes.toString("utf8");
}

// 3 은 완료, 6 과 7 은 도구 호출이 취소되거나 실패한 채 끝난 step 이다. 7 이어도 턴은 이어지므로
// 끝난 것으로 본다. 8(진행 중)과 2 는 아직 끝나지 않았다.
const AGY_SETTLED_STEP_STATUSES = new Set([3, 6, 7]);

function agyWaitVerdict(steps, requestId, visible) {
  const request = steps.findLastIndex(
    (step) =>
      step.step_type === 14 &&
      (!requestId ||
        agyStepText(step.step_payload, 14).includes(
          `[tfx-live req=${requestId}]`,
        )),
  );
  if (request < 0)
    return {
      status: isAgyQueuedCapture(visible) ? "queued" : "submitted",
      done: false,
      response: "",
    };
  const nextRequest = steps.findIndex(
    (step, index) => index > request && step.step_type === 14,
  );
  // 다음 사용자 입력이 시작됐으면 그 턴의 진행 상태는 이 요청의 완료를 막지 않는다.
  const turn = steps.slice(
    request + 1,
    nextRequest < 0 ? undefined : nextRequest,
  );
  let response = "";
  for (const step of turn) {
    if (step.step_type !== 15) continue;
    const text = agyStepText(step.step_payload, 15);
    if (text) response = text;
  }
  const settled =
    turn.every((step) => AGY_SETTLED_STEP_STATUSES.has(step.status)) &&
    (nextRequest >= 0 || !ADAPTERS.agy.isBusy(visible));
  // 네트워크 오류 같은 턴 실패는 오류 step(17)으로 끝나고 모델 응답이 뒤따르지 않는다.
  const lastError = turn.findLastIndex((step) => step.step_type === 17);
  if (
    settled &&
    lastError > turn.findLastIndex((step) => step.step_type === 15)
  )
    return {
      status: "failed",
      done: false,
      response,
      error:
        agyStepText(turn[lastError].step_payload, 17) ||
        "agy turn ended with an error step",
    };
  const done = settled && turn.some((step) => step.step_type === 15);
  return { status: done ? "completed" : "working", done, response };
}

async function waitAgy({
  session,
  requestId = null,
  timeoutMs,
  pollIntervalMs,
}) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    throw new Error("agy wait requires node:sqlite (Node 22.13+)");
  }
  const agyProcess = await paneCliProcess(session, "agy");
  if (!agyProcess)
    throw new Error(`no live agy process in tmux target ${session}`);
  const conversation = await agyConversation(agyProcess.pid);
  if (!conversation)
    throw new Error(`agy conversation unavailable in tmux target ${session}`);
  // 처음 연 DB 를 고정해 대기 중 /clear 로 바뀐 대화를 따라가지 않는다.
  const db = new DatabaseSync(conversation.dbPath, { readOnly: true });
  const deadline = Date.now() + timeoutMs;
  try {
    const query = db.prepare(
      "SELECT idx, step_type, status, step_payload FROM steps ORDER BY idx",
    );
    for (;;) {
      const visible = await captureVisible(null, session);
      const verdict = agyWaitVerdict(query.all(), requestId, visible);
      const settled = verdict.done || verdict.status === "failed";
      const timedOut = !settled && Date.now() >= deadline;
      const result = {
        ok: true,
        cli: "agy",
        ...verdict,
        timedOut,
        requestId,
        conversationId: conversation.conversationId,
        session,
      };
      if (settled || timedOut) return result;
      await sleep(Math.min(pollIntervalMs, deadline - Date.now()));
    }
  } finally {
    db.close();
  }
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

// tmux 는 -t 세션 이름이 없으면 접두어로 다른 세션을 잡는다. '=' 는 정확 일치만 허용하고,
// ':' 가 없으면 pane 대상 명령이 '=이름' 을 창 이름으로 읽어 실패하므로 붙인다.
// psmux 는 원래 정확히만 찾고 3.3.8 전에는 '=' 를 모른다.
function exactTmuxTarget(target) {
  const text = String(target);
  if (process.platform === "win32" || /^[=%@$]/.test(text)) return text;
  return text.includes(":") ? `=${text}` : `=${text}:`;
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
      const recordTime = (record) =>
        Number(record.updatedAt ?? record.startedAt) || 0;
      const ambiguousPanes = new Set();
      for (const record of [...records].sort(
        (a, b) => recordTime(b) - recordTime(a),
      )) {
        const panePid = panePids.get(record.tmuxPane);
        if (!Number.isSafeInteger(panePid) || panePid <= 0) continue;
        let ancestor = record.pid;
        for (let depth = 0; depth < 8 && ancestor !== panePid; depth++) {
          ancestor = parents.get(ancestor);
        }
        if (ancestor !== panePid) continue;
        if (paneThreads.has(record.tmuxPane)) {
          const prior = paneThreads.get(record.tmuxPane);
          if (
            prior.updatedAt === recordTime(record) &&
            prior.threadId !== record.sessionId
          )
            ambiguousPanes.add(record.tmuxPane);
          continue;
        }
        paneThreads.set(record.tmuxPane, {
          threadId: record.sessionId,
          name: names.get(record.sessionId) ?? null,
          threadSource: "registry",
          updatedAt: recordTime(record),
        });
      }
      for (const pane of ambiguousPanes) paneThreads.delete(pane);
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
    pathJoin(
      env.CLAUDE_CONFIG_DIR || pathJoin(env.HOME || homedir(), ".claude"),
      "sessions",
    );
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
    // 응답 추출용 글리프 허용 범위에는 셸 프롬프트도 있어 준비 판정에는 쓰지 않는다.
    /^\s*›(?:\s|$)/m.test(text)
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

function isComposerPromptLine(line, cli) {
  if (cli === "agy") return /^\s*>(?:\s|$)/.test(stripAnsi(line));
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

function composerLineMatchesPrompt(line, prompt, cli) {
  const needle = promptComposerNeedle(prompt);
  return (
    Boolean(needle) &&
    isComposerPromptLine(line, cli) &&
    String(line).includes(needle)
  );
}

function composerShowsPrompt(text, prompt, cli) {
  const activeComposerLine = String(text)
    .split("\n")
    .filter((line) => isComposerPromptLine(line, cli))
    .at(-1);
  return composerLineMatchesPrompt(activeComposerLine, prompt, cli);
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
    exactTmuxTarget(session),
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
    exactTmuxTarget(session),
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

// 승인 화면에서는 마지막 선택 글리프 줄이 메뉴 항목이다. 문구를 인용한 대화라면
// 그 아래 입력창이 마지막 글리프 줄이 되므로 걸러진다. 위쪽 문구는 테두리와
// 줄바꿈이 끊어도 맞도록 공백 하나로 접는다.
function splitAtLastSelector(text, glyph) {
  const lines = stripAnsi(text)
    .split("\n")
    .map((line) => line.replace(/^[\s│┃]+/, ""));
  const index = lines.findLastIndex((line) => line.startsWith(glyph));
  if (index < 0) return null;
  const isRule = (line = "") => /^─{3,}/.test(line);
  return {
    above: lines.slice(0, index).join(" ").replace(/\s+/g, " "),
    selected: lines[index],
    // Claude 입력창은 위아래 가로줄 상자다. 여러 줄 입력이면 아래 가로줄이 몇 줄 뒤에 온다.
    inComposerBox:
      isRule(lines[index - 1]) && lines.slice(index + 1).some(isRule),
  };
}

function isCodexTrustFolderPrompt(text) {
  const menu = splitAtLastSelector(text, "›");
  return (
    Boolean(menu) &&
    /trust this folder\?/i.test(menu.above) &&
    /^›\s*(?:\d+\.\s*)?(?:trust and continue|open restricted)/i.test(
      menu.selected,
    )
  );
}

// 신뢰 화면 판정. 자동 승인과 --no-auto-trust 차단이 같이 쓴다. 문구만 보면 재개 대화의 인용에도 걸리므로 메뉴 구조까지 본다.
// 항목 문구는 Claude 2.1.296 바이너리, 0.162.1 에 없는 예전 Codex 문구는 dismissCodexTrustPrompt 기준.
function isClaudeTrustMenu(text) {
  const menu = splitAtLastSelector(text, "❯");
  return (
    Boolean(menu) &&
    !menu.inComposerBox &&
    isClaudeTrustPrompt(menu.above) &&
    /^❯\s*(?:\d+\.\s*)?(?:yes, i trust this folder|no, exit|no, continue without these permissions)/i.test(
      menu.selected,
    )
  );
}

function isCodexTrustMenu(text) {
  const menu = splitAtLastSelector(text, "›");
  return (
    isCodexTrustFolderPrompt(text) ||
    (Boolean(menu) &&
      isCodexTrustPrompt(menu.above) &&
      /^›\s*(?:\d+\.\s*)?(?:yes, continue|no, quit)/i.test(menu.selected))
  );
}

// 다중 선택 항목은 한 글자 체크박스로 그린다. 바이너리 상수: [ ] [×] [✔] [√] ☐ ☒, 라디오 ( ) (*) ◯ ◉.
function isClaudeMcpApprovalPrompt(text) {
  const menu = splitAtLastSelector(text, "❯");
  return (
    Boolean(menu) &&
    !menu.inComposerBox &&
    /new MCP servers? found in this project/i.test(menu.above) &&
    /^❯\s*(?:\d+\.\s*)?(?:use this|continue without using this MCP server|enable selected|\[.\]|\(.\)|[☐☒◯◉])/iu.test(
      menu.selected,
    )
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
  if (!isCodexTrustMenu(raw)) {
    return { dismissed: false, raw };
  }

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const selected = selectedLine(raw);
    if (
      /Yes, continue|Trust and continue/.test(selected) &&
      !/No, quit/.test(selected)
    ) {
      await runTmux(remote, [
        "send-keys",
        "-t",
        exactTmuxTarget(session),
        "Enter",
      ]);
      return { dismissed: true, raw };
    }

    await runTmux(remote, [
      "send-keys",
      "-t",
      exactTmuxTarget(session),
      "Down",
    ]);
    await sleep(200);
    raw = await captureVisible(remote, session);
  }

  const selected = selectedLine(raw);
  if (/\bYes\b/.test(selected) && !/\bNo\b/.test(selected)) {
    await runTmux(remote, [
      "send-keys",
      "-t",
      exactTmuxTarget(session),
      "Enter",
    ]);
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
    await runTmux(remote, [
      "send-keys",
      "-t",
      exactTmuxTarget(session),
      "Down",
    ]);
    await sleep(200);
    raw = await captureVisible(remote, session);

    const selected = selectedLine(raw);
    if (isSkipUntilNextVersionLine(selected)) {
      await runTmux(remote, [
        "send-keys",
        "-t",
        exactTmuxTarget(session),
        "Enter",
      ]);
      return { dismissed: true, raw };
    }
  }

  const selected = selectedLine(raw);
  if (isSafeSkipLine(selected)) {
    await runTmux(remote, [
      "send-keys",
      "-t",
      exactTmuxTarget(session),
      "Enter",
    ]);
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
      await runTmux(remote, [
        "send-keys",
        "-t",
        exactTmuxTarget(session),
        "Enter",
      ]);
      return { dismissed: true, raw };
    }
    await runTmux(remote, ["send-keys", "-t", exactTmuxTarget(session), "Up"]);
    await sleep(200);
    raw = await captureVisible(remote, session);
  }
  return { dismissed: false, raw };
}

async function dismissClaudeTrustPrompt(remote, session) {
  let raw = await captureVisible(remote, session);
  if (!isClaudeTrustMenu(raw)) {
    return { dismissed: false, raw };
  }

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const selected = selectedLine(raw);
    if (
      /(Yes, I trust this folder|\bYes\b)/.test(selected) &&
      !/(No, exit|\bNo\b)/.test(selected)
    ) {
      await runTmux(remote, [
        "send-keys",
        "-t",
        exactTmuxTarget(session),
        "Enter",
      ]);
      return { dismissed: true, raw };
    }

    await runTmux(remote, [
      "send-keys",
      "-t",
      exactTmuxTarget(session),
      "Down",
    ]);
    await sleep(200);
    raw = await captureVisible(remote, session);
  }

  const selected = selectedLine(raw);
  if (
    /(Yes, I trust this folder|\bYes\b)/.test(selected) &&
    !/(No, exit|\bNo\b)/.test(selected)
  ) {
    await runTmux(remote, [
      "send-keys",
      "-t",
      exactTmuxTarget(session),
      "Enter",
    ]);
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
      await runTmux(remote, [
        "send-keys",
        "-t",
        exactTmuxTarget(session),
        "Enter",
      ]);
      return { dismissed: true, raw };
    }

    await runTmux(remote, ["send-keys", "-t", exactTmuxTarget(session), "Up"]);
    await sleep(200);
    raw = await captureVisible(remote, session);
  }

  await runTmux(remote, ["send-keys", "-t", exactTmuxTarget(session), "Enter"]);
  return { dismissed: true, raw };
}

async function dismissClaudeTourPrompt(remote, session) {
  let raw = await captureVisible(remote, session);
  if (!isClaudeTourPrompt(raw)) {
    return { dismissed: false, raw };
  }

  for (let iteration = 0; iteration < 4; iteration += 1) {
    if (/Skip for now/.test(selectedLine(raw))) {
      await runTmux(remote, [
        "send-keys",
        "-t",
        exactTmuxTarget(session),
        "Enter",
      ]);
      return { dismissed: true, raw };
    }

    await runTmux(remote, [
      "send-keys",
      "-t",
      exactTmuxTarget(session),
      "Down",
    ]);
    await sleep(200);
    raw = await captureVisible(remote, session);
  }

  // Fallback: Escape cancels the welcome/tour dialog (equivalent to "Skip for
  // now"). Never blind-Enter here — the default selection may be "Take the
  // tour", and Enter would launch the tour instead of skipping it.
  await runTmux(remote, [
    "send-keys",
    "-t",
    exactTmuxTarget(session),
    "Escape",
  ]);
  return { dismissed: true, raw };
}

function isAgyTrustPrompt(text) {
  return /Do you trust the contents of this project\?/.test(stripAnsi(text));
}

// --no-auto-trust 차단에만 쓴다. agy 1.3.3 바이너리에서 "No, exit" 가 신뢰 화면 항목인지 확정하지 못해 자동 승인과 isReady 는 문구 판정을 유지한다.
function isAgyTrustMenu(text) {
  const menu = splitAtLastSelector(text, ">");
  return (
    Boolean(menu) &&
    isAgyTrustPrompt(menu.above) &&
    /^>\s*(?:yes, i trust this folder|no, exit)/i.test(menu.selected)
  );
}

function isAgyQueuedCapture(text) {
  return /Press up to edit queued messages/i.test(stripAnsi(text));
}

async function dismissAgyTrustPrompt(remote, session) {
  let raw = await captureVisible(remote, session);
  for (let attempt = 0; attempt < 4 && isAgyTrustPrompt(raw); attempt++) {
    if (/^\s*>\s+Yes, I trust this folder\s*$/m.test(stripAnsi(raw))) {
      await runTmux(remote, [
        "send-keys",
        "-t",
        exactTmuxTarget(session),
        "Enter",
      ]);
      return { dismissed: true, raw };
    }
    await runTmux(remote, ["send-keys", "-t", exactTmuxTarget(session), "Up"]);
    await sleep(200);
    raw = await captureVisible(remote, session);
  }
  return { dismissed: false, raw };
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
        blockedBy: "codex-trust-folder",
        isPresent: isCodexTrustMenu,
        dismiss: dismissCodexTrustPrompt,
        warning:
          "Codex is asking whether to trust this folder; attach to the tmux session and answer it yourself",
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
        blockedBy: "claude-trust-folder",
        isPresent: isClaudeTrustMenu,
        dismiss: dismissClaudeTrustPrompt,
        warning:
          "Claude is asking whether to trust this folder; attach to the tmux session and answer it yourself",
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
    blockingScreens: [
      {
        name: "claude-mcp-approval",
        isPresent: isClaudeMcpApprovalPrompt,
        warning:
          "Claude is asking to approve project MCP servers; attach to the tmux session and answer it yourself",
      },
    ],
  },
  agy: {
    cli: "agy",
    launchKeys: ["agy", "Enter"],
    resumeById: (id) => shellQuote(["agy", "--conversation", id]),
    resumeLast: () => shellQuote(["agy", "--continue"]),
    isReady: (text) =>
      !isAgyTrustPrompt(text) && /^\s*>(?:\s|$)/m.test(stripAnsi(text)),
    isBusy: (text) =>
      /esc to cancel/i.test(stripAnsi(text)) || isAgyQueuedCapture(text),
    contextPct: () => null,
    hasLoginGuard: () => false,
    startupScreens: [
      {
        name: "trust",
        blockedBy: "agy-trust-folder",
        isBlocking: isAgyTrustMenu,
        isPresent: isAgyTrustPrompt,
        dismiss: dismissAgyTrustPrompt,
        warning:
          "agy is asking whether to trust this folder; attach to the tmux session and answer it yourself",
      },
    ],
  },
};

function buildLaunchKeys(adapter, { model, effort, name, sandbox } = {}) {
  const hasModel = model !== undefined;
  const hasEffort = effort !== undefined;
  if (
    !hasModel &&
    !hasEffort &&
    !sandbox &&
    !(adapter.cli === "claude" && name)
  ) {
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
  } else if (adapter.cli === "agy") {
    if (hasModel) overrideArgs.push("--model", model);
    if (hasEffort) {
      if (!["low", "medium", "high", "xhigh", "max"].includes(effort))
        throw new Error(
          "agy --effort must be low, medium, high, xhigh, or max",
        );
      overrideArgs.push("--effort", effort);
    }
    if (sandbox) overrideArgs.push("--sandbox");
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
  let startedAt = Date.now();
  let raw = "";
  let restartedAfterUpdate = false;

  while (Date.now() - startedAt < timeoutMs) {
    raw = await captureVisible(remote, session);
    // paneCliProcess는 로컬 전용이므로 원격 시작 동작은 유지한다.
    if (
      adapter.cli === "codex" &&
      !remote &&
      /Update ran successfully! Please restart Codex|Updating Codex via/.test(
        raw,
      ) &&
      // 조회가 실패하면(pane 소멸, ps 시간 초과) 재시작 키를 보내지 않도록 프로세스가 있는 것으로 본다.
      !(await paneCliProcess(session, adapter.cli).catch(() => ({})))
    ) {
      if (!restartedAfterUpdate) {
        await runTmux(remote, [
          "send-keys",
          "-t",
          exactTmuxTarget(session),
          ...adapter.launchKeys,
        ]);
        restartedAfterUpdate = true;
        startedAt = Date.now();
      }
      await sleep(pollIntervalMs);
      continue;
    }
    const blocking = adapter.blockingScreens?.find((screen) =>
      screen.isPresent(raw),
    );
    if (blocking) {
      return {
        ready: false,
        raw,
        restartedAfterUpdate,
        blockedBy: blocking.name,
        warning: blocking.warning,
      };
    }
    if (isStartupScreen(adapter, raw)) {
      await dismissStartupScreens(adapter, remote, session);
      await sleep(pollIntervalMs);
      continue;
    }
    if (adapter.hasLoginGuard(raw)) {
      return { ready: false, raw, restartedAfterUpdate };
    }
    if (adapter.isReady(raw)) {
      return { ready: true, raw, restartedAfterUpdate };
    }
    await sleep(pollIntervalMs);
  }

  return {
    ready: false,
    raw,
    restartedAfterUpdate,
    ...(restartedAfterUpdate
      ? {
          warning: (await paneCliProcess(session, adapter.cli).catch(
            () => ({}),
          ))
            ? "codex not ready after update restart"
            : "codex exited after update restart",
        }
      : {}),
  };
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
    // 페이로드에 프롬프트가 들어 있어 사용자별 0700 디렉터리에 쓴다.
    payloadFile = pathJoin(
      privateTmpDir("tfx-live"),
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
      exactTmuxTarget(splitTmuxTarget(opts.session).session),
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

const ITERM_TITLE_SCRIPT_NAME = "com.triflux.live-title.py";
const ITERM_TITLE_SCRIPT = String.raw`#!/usr/bin/env python3
import sys

import iterm2


async def main(connection):
    session_id, group, name = sys.argv[1:]
    app = await iterm2.async_get_app(connection)
    session = app.get_session_by_id(session_id)
    if session is None:
        raise RuntimeError(f"iTerm session not found: {session_id}")
    update = iterm2.LocalWriteOnlyProfile()
    update.set_allow_title_setting(False)
    update.set_name(name)
    # AppleScript 의 "with default profile command" 는 attach 명령을 세션 프로필에 남긴다.
    # 그대로 두면 사람이 Cmd+D 로 나눈 pane 이 같은 tmux 세션에 다시 붙어 복사본이 뜬다.
    # 이미 뜬 attach 프로세스는 영향받지 않고, 이후 분할만 보통 셸을 연다.
    update.set_use_custom_command("No")
    await session.async_set_profile_properties(update)
    await session.tab.async_set_variable("user.tfxLiveGroup", group)
    await session.tab.async_set_title(r"\(user.tfxLiveGroup)")
    await session.async_set_variable("user.tfxLiveTitleApplied", "1")


iterm2.run_until_complete(main)
`;

function appleScriptString(value) {
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value))
    throw new Error("iTerm values must not contain control characters");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function shouldUseIterm(
  remote,
  platform = process.platform,
  env = process.env,
) {
  return (
    !remote &&
    platform === "darwin" &&
    (env.LC_TERMINAL === "iTerm2" || env.TERM_PROGRAM === "iTerm.app")
  );
}

async function itermProject(cwd = process.cwd(), deps = {}) {
  const exec = deps.execFile ?? execFileAsync;
  const directory = realpathSync(cwd);
  let commonPath;
  try {
    const { stdout } = await exec(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: directory, timeout: 2000, env: { ...process.env, LC_ALL: "C" } },
    );
    commonPath = stdout.trim();
  } catch (error) {
    if (error.code !== 128 || !error.stderr?.includes("not a git repository"))
      throw error;
    return { key: directory, name: basename(directory) };
  }
  const commonDir = realpathSync(commonPath);
  const { stdout } = await exec(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-dir", "--show-toplevel"],
    { cwd: directory, timeout: 2000 },
  );
  const [gitDir, top] = stdout
    .trim()
    .split("\n")
    .map((path) => realpathSync(path));
  return {
    key: commonDir,
    name: basename(commonDir === gitDir ? top : dirname(commonDir)),
  };
}

async function openItermSession(session, group, project, deps = {}) {
  const exec = deps.execFile ?? execFileAsync;
  const tmux = deps.runTmux ?? runTmux;
  const env = deps.env ?? process.env;
  const projectLiteral = appleScriptString(project.key);
  const groupLiteral = appleScriptString(group);
  const sessionLiteral = appleScriptString(session);
  const leaderId = appleScriptString(env.ITERM_SESSION_ID?.split(":")[1] ?? "");
  // tmux 안의 리드는 ITERM_SESSION_ID 가 tmux 를 처음 띄운 터미널 값이라, 지금 붙어 있는 클라이언트 tty 로 창을 찾는다.
  const clients = env.TMUX_PANE
    ? await tmux(null, [
        "list-clients",
        "-t",
        env.TMUX_PANE,
        "-F",
        "#{client_activity} #{client_tty}",
      ]).catch(() => ({ stdout: "" }))
    : { stdout: "" };
  const leaderTty = appleScriptString(
    clients.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" "))
      .sort((a, b) => Number(b[0]) - Number(a[0]))[0]?.[1] ?? "",
  );
  const { stdout: tmuxPath } = await exec("which", ["tmux"], {
    timeout: 2000,
  });
  const command = appleScriptString(
    `${shellQuote([realpathSync(tmuxPath.trim()), "attach-session", "-t"])} '=${session.replace(/'/g, `'"'"'`)}'`,
  );
  const script = `tell application "iTerm2"
  set ttyWindow to missing value
  set idWindow to missing value
  set projectWindow to missing value
  repeat with candidateWindow in windows
    repeat with candidateTab in tabs of candidateWindow
      repeat with candidateSession in sessions of candidateTab
        try
          tell candidateSession to set candidateProject to variable named "user.tfx_project"
          if candidateProject is ${projectLiteral} and projectWindow is missing value then set projectWindow to candidateWindow
        end try
        if ${leaderTty} is not "" and tty of candidateSession is ${leaderTty} then set ttyWindow to candidateWindow
        if ${leaderId} is not "" and id of candidateSession is ${leaderId} then set idWindow to candidateWindow
      end repeat
    end repeat
  end repeat
  -- 리드가 이 기기의 iTerm 창에 없으면(ssh 로 LC_TERMINAL 만 넘어온 경우 등) 열지 않는다.
  if ttyWindow is not missing value then
    set leaderWindow to ttyWindow
  else if idWindow is not missing value then
    set leaderWindow to idWindow
  else
    return ""
  end if
  if projectWindow is not missing value then
    set targetWindow to projectWindow
  else
    set leaderHasOtherProject to false
    repeat with candidateTab in tabs of leaderWindow
      repeat with candidateSession in sessions of candidateTab
        try
          tell candidateSession to set candidateProject to variable named "user.tfx_project"
          if candidateProject is not "" and candidateProject is not missing value and candidateProject is not ${projectLiteral} then set leaderHasOtherProject to true
        end try
      end repeat
    end repeat
    if leaderHasOtherProject then
      set targetWindow to create window with default profile command ${command}
      set newSession to current session of current tab of targetWindow
      tell newSession
        set variable named "user.tfx_project" to ${projectLiteral}
        set variable named "user.tfx_group" to ${groupLiteral}
        set variable named "user.tfx_session" to ${sessionLiteral}
        set variable named "user.tfx_column" to "L"
      end tell
      return (id of newSession) & linefeed & "false"
    end if
    set targetWindow to leaderWindow
  end if
  -- 패인마다 열(L, R)을 표시하고 열별 개수로 나눌 곳을 정한다. 창 비율과 무관하게 1개에서 4개까지 2x2 가 되고,
  -- 2x2 에서 하나를 닫은 뒤 다시 늘려도 빈 칸을 채운다. 표시가 없는 옛 패인은 혼자일 때만 L 로 보고,
  -- 여럿이면 실제 열을 알 수 없어 그 탭을 나누지 않는다.
  set splitSession to missing value
  set splitDirection to ""
  set newColumn to "L"
  repeat with candidateTab in tabs of targetWindow
    if (count of sessions of candidateTab) < 4 then
      set leftSession to missing value
      set rightSession to missing value
      set leftCount to 0
      set rightCount to 0
      set unmarkedCount to 0
      repeat with candidateSession in sessions of candidateTab
        try
          tell candidateSession to set candidateGroup to variable named "user.tfx_group"
          if candidateGroup is ${groupLiteral} then
            set candidateColumn to ""
            try
              tell candidateSession to set candidateColumn to variable named "user.tfx_column"
            end try
            if candidateColumn is "R" then
              set rightCount to rightCount + 1
              set rightSession to candidateSession
            else
              if candidateColumn is not "L" then set unmarkedCount to unmarkedCount + 1
              set leftCount to leftCount + 1
              set leftSession to candidateSession
            end if
          end if
        end try
      end repeat
      if unmarkedCount > 0 and leftCount + rightCount > 1 then
        set leftCount to 0
        set rightCount to 0
      else if unmarkedCount > 0 then
        tell leftSession to set variable named "user.tfx_column" to "L"
      end if
      if leftCount + rightCount > 0 then
        if rightCount is 0 then
          set splitSession to leftSession
          set splitDirection to "vertical"
          set newColumn to "R"
        else if leftCount is 0 then
          set splitSession to rightSession
          set splitDirection to "vertical"
          set newColumn to "L"
        else if rightCount < leftCount then
          set splitSession to rightSession
          set splitDirection to "horizontal"
          set newColumn to "R"
        else
          set splitSession to leftSession
          set splitDirection to "horizontal"
          set newColumn to "L"
        end if
        exit repeat
      end if
    end if
  end repeat
  set didSplit to splitSession is not missing value
  if didSplit then
    if splitDirection is "vertical" then
      tell splitSession to set newSession to split vertically with default profile command ${command}
    else
      tell splitSession to set newSession to split horizontally with default profile command ${command}
    end if
  else
    tell targetWindow to set newTab to create tab with default profile command ${command}
    set newSession to current session of newTab
    set newColumn to "L"
  end if
  tell newSession
    set variable named "user.tfx_project" to ${projectLiteral}
    set variable named "user.tfx_group" to ${groupLiteral}
    set variable named "user.tfx_session" to ${sessionLiteral}
    set variable named "user.tfx_column" to newColumn
  end tell
  return (id of newSession) & linefeed & (didSplit as text)
end tell`;
  const { stdout } = await exec("/usr/bin/osascript", ["-e", script], {
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  if (!stdout.trim()) return null;
  const [sessionId, split] = stdout.trim().split("\n");
  if (!sessionId || !["true", "false"].includes(split))
    throw new Error("iTerm did not return a session ID and split status");
  return { sessionId, group, split: split === "true" };
}

async function closeItermSession(
  sessionId,
  session,
  allowNameFallback = true,
  killedTtys = [],
  deps = {},
) {
  const exec = deps.execFile ?? execFileAsync;
  const tmux = deps.runTmux ?? runTmux;
  const clients = await tmux(null, [
    "list-clients",
    "-F",
    "#{client_tty}",
  ]).catch(() => null);
  const attachedTtys = (clients?.stdout ?? "")
    .trim()
    .split("\n")
    .filter(Boolean);
  const script = `if application "iTerm2" is not running then return
tell application "iTerm2"
  set idSession to missing value
  set idTab to missing value
  set fallbackSession to missing value
  set fallbackTab to missing value
  set killedTtys to {${killedTtys.map(appleScriptString).join(", ")}}
  set killedIds to {}
  -- tmux 가 끝나며 패인과 창이 먼저 닫히면 순회 중 창 번호가 사라진다. 사라진 창은 건너뛴다.
  repeat with candidateWindow in windows
    try
    repeat with candidateTab in tabs of candidateWindow
      repeat with candidateSession in sessions of candidateTab
        if ${appleScriptString(sessionId ?? "")} is not "" and id of candidateSession is ${appleScriptString(sessionId ?? "")} then
          set idSession to candidateSession
          set idTab to candidateTab
        end if
        if killedTtys contains (tty of candidateSession) then set end of killedIds to (id of candidateSession)
        try
          tell candidateSession to set candidateName to variable named "user.tfx_session"
          if ${allowNameFallback ? "true" : "false"} and candidateName is ${appleScriptString(session)} then
            set fallbackSession to candidateSession
            set fallbackTab to candidateTab
          end if
        end try
      end repeat
    end repeat
    end try
  end repeat
  if idSession is not missing value then
    set targetSession to idSession
    set targetTab to idTab
  else if fallbackSession is not missing value then
    set targetSession to fallbackSession
    set targetTab to fallbackTab
  else
    set targetSession to missing value
  end if
  if targetSession is not missing value then
    -- tmux 가 끝나며 대상 패인이 먼저 닫혔어도 아래 tty 정리는 이어 간다.
    try
      tell targetSession to close
    end try
    -- 셸 통합이나 tmux 클라이언트 조회가 불확실하면 남은 탭을 보존한다.
    set shellsOnly to ${clients ? "true" : "false"}
    set attachedTtys to {${attachedTtys.map(appleScriptString).join(", ")}}
    try
      repeat with remainingSession in sessions of targetTab
        -- 사용자가 직접 연 패인은 tfx 표시가 없으므로 남은 패인이 모두 tfx-live 가 연 것일 때만 탭을 닫는다.
        set remainingName to ""
        try
          tell remainingSession to set remainingName to variable named "user.tfx_session"
        end try
        if remainingName is missing value or remainingName is "" then set shellsOnly to false
        if not (is at shell prompt of remainingSession) then set shellsOnly to false
        if attachedTtys contains (tty of remainingSession) then set shellsOnly to false
      end repeat
      if shellsOnly then tell targetTab to close
    end try
  end if
  -- 죽인 세션에 붙어 있던 패인은 표시가 없어도 닫는다. 순회 참조는 순번이라 앞선 닫기 뒤 옆 패인을 가리키므로 ID 로 매번 다시 찾는다.
  repeat with killedIndex from 1 to count of killedIds
    set killedId to item killedIndex of killedIds
    repeat with candidateWindow in windows
      try
      repeat with candidateTab in tabs of candidateWindow
        repeat with candidateSession in sessions of candidateTab
          if id of candidateSession is killedId then tell candidateSession to close
        end repeat
      end repeat
      end try
    end repeat
  end repeat
end tell`;
  await exec("/usr/bin/osascript", ["-e", script], {
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
}

async function doStart(launchAdapter, opts) {
  // --no-auto-trust 면 신뢰 화면을 고르지 않고 승인 화면과 같이 ready:false 로 끝낸다.
  const trustScreens = opts.noAutoTrust
    ? launchAdapter.startupScreens.filter((screen) => screen.blockedBy)
    : [];
  const adapter = {
    ...launchAdapter,
    startupScreens: launchAdapter.startupScreens.filter(
      (screen) => !trustScreens.includes(screen),
    ),
    blockingScreens: [
      ...trustScreens.map((screen) => ({
        name: screen.blockedBy,
        isPresent: screen.isBlocking ?? screen.isPresent,
        warning: screen.warning,
      })),
      ...(launchAdapter.blockingScreens ?? []),
    ],
  };
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
  const launchKeys = [
    ...(resume
      ? [adapter.resumeById(resume), "Enter"]
      : resumeLast
        ? [adapter.resumeLast(), "Enter"]
        : buildLaunchKeys(adapter, {
            model,
            effort,
            name,
            sandbox: opts.sandbox,
          })),
  ];
  if (resumed && adapter.cli === "agy") {
    const overrides = buildLaunchKeys(adapter, {
      model,
      effort,
      sandbox: opts.sandbox,
    });
    launchKeys[0] += overrides[0].slice("agy".length);
  }
  if (adapter.cli === "codex" && !remote && opts.nativePeer) {
    let socket;
    const env = opts.env || process.env;
    try {
      socket = resolveCodexSocket(env.HOME || homedir(), env);
    } catch (error) {
      throw new Error(
        `공유 Codex 데몬 소켓을 사용할 수 없다: ${error.message}. codex app-server daemon start 로 데몬을 띄워라.`,
      );
    }
    // --remote 세션의 셸은 데몬에서 돌아서 -C 로 작업 디렉터리를 지정한다.
    launchKeys[0] += ` ${shellQuote(["--remote", `unix://${socket}`, "-C", pathResolve(cwd || process.cwd())])}`;
  }
  launchKeys[0] = withUnsetEnv(launchKeys[0], opts.unsetEnv ?? []);
  // 받는 쪽 triflux mod 가 이 값을 저장해 자기를 띄운 리드의 tfx_control 요청만 실행한다.
  if (opts.leadSession)
    launchKeys[0] = withLeadSession(
      launchKeys[0],
      opts.leadSession,
      remote ? (await probeRemoteHostEnv(remote)).os : process.platform,
    );
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
  if (!remote) {
    await runTmux(null, [
      "set-option",
      "-t",
      exactTmuxTarget(session),
      "set-titles",
      "on",
    ]);
    // # 는 tmux 형식 시작 문자이므로 이름 그대로 표시되게 이스케이프한다.
    await runTmux(null, [
      "set-option",
      "-t",
      exactTmuxTarget(session),
      "set-titles-string",
      (name ?? session).replace(/#/g, "##"),
    ]);
  }
  // Default tmux history-limit (2000) is far too small for long tool-heavy
  // CLI sessions (file reads, test runs) — the actual response can scroll
  // out of scrollback before capturePane() runs, producing an empty extract.
  await runTmux(remote, [
    "set-option",
    "-t",
    exactTmuxTarget(session),
    "history-limit",
    "100000",
  ]);
  await runTmux(remote, [
    "send-keys",
    "-t",
    exactTmuxTarget(session),
    ...launchKeys,
  ]);
  await dismissStartupScreens(adapter, remote, session);

  const readiness = await waitForReady(
    { ...adapter, launchKeys },
    remote,
    session,
    readyTimeoutMs,
    pollIntervalMs,
  );
  const { raw, blockedBy, restartedAfterUpdate } = readiness;
  let { ready, warning } = readiness;
  let unsetEnvVerified = false;
  let unsetEnvWarning;
  if (ready && !remote && opts.unsetEnv?.length) {
    let environment = "";
    try {
      const target = await paneCliProcess(session, adapter.cli);
      if (target)
        environment =
          process.platform === "darwin"
            ? (
                await execFileAsync(
                  "ps",
                  ["-E", "-ww", "-o", "command=", "-p", String(target.pid)],
                  { timeout: 5000, maxBuffer: MAX_BUFFER },
                )
              ).stdout
            : await readFile(`/proc/${target.pid}/environ`, "utf8");
    } catch {
      // 읽기 실패는 변수 잔존의 증거가 아니므로 세션을 유지한다.
    }
    const { readable, remaining } = inspectUnsetEnv(
      environment,
      opts.unsetEnv,
      process.platform,
    );
    if (remaining.length) {
      await runTmux(null, ["kill-session", "-t", exactTmuxTarget(session)]);
      throw new Error(
        "--unset-env verification failed: matching variables remain in CLI environment",
      );
    }
    unsetEnvVerified = readable;
    if (!readable)
      unsetEnvWarning = "CLI environment unreadable; removal not verified";
  }
  let nameApplied = Boolean(name) && adapter.cli === "claude" && ready;
  let threadId =
    adapter.cli === "codex" && isCodexThreadId(resume) ? resume : null;
  // 우리 TUI 의 resume 기록이 늦게 반영되면 남의 기록만 보일 수 있어, 1.5초 뒤에도 같은 후보가
  // 유일할 때만 확정한다. 5초 안에 확인하지 못하면 null 로 둔다.
  const threadDeadline = Date.now() + 5000;
  let candidate = null;
  while (trackResumeLast && ready && !threadId) {
    const timeoutMs = threadDeadline - Date.now();
    if (timeoutMs <= 0) break;
    const found = await resumedCodexThread({
      cwd: cwd ?? process.cwd(),
      launchedAtMs,
      timeoutMs,
    });
    if (found && found === candidate) threadId = found;
    candidate = found;
    if (!threadId)
      await sleep(Math.min(found ? 1500 : 500, threadDeadline - Date.now()));
  }
  if (name && adapter.cli === "codex" && ready) {
    // paneCliProcess는 로컬 전용이므로 원격 입력 동작은 유지한다.
    const target = !remote && (await paneCliProcess(session, adapter.cli));
    if (!remote && !target?.running) {
      ready = false;
      warning = target
        ? "codex is not attached to the pane before input"
        : "codex exited before input";
    } else {
      try {
        const command = `/rename ${name}`;
        await runTmux(remote, [
          "send-keys",
          "-t",
          exactTmuxTarget(session),
          "-l",
          "--",
          command,
        ]);
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
  }
  if (name && adapter.cli === "agy" && ready) {
    try {
      nameApplied = await renameAgyConversation(
        session,
        name,
        Math.min(readyTimeoutMs, 5000),
        pollIntervalMs,
      );
    } catch {
      nameApplied = false;
    }
  }
  // SendMessage 주소는 pane 에 등록된 이름이라 등록까지 확인한다. 이름이 겹치면 SendMessage 가
  // 보내지 않고 [ref] 를 고르라고 거부한다(Claude Code 2026-10-14 실측).
  let registeredName = null;
  if (adapter.cli === "claude" && !remote && nameApplied) {
    const deadline = Date.now() + Math.min(readyTimeoutMs, 5000);
    while (!registeredName && Date.now() < deadline) {
      registeredName = (await claudeTmuxTarget(session))?.name ?? null;
      if (!registeredName) await sleep(Math.min(pollIntervalMs, 200));
    }
    nameApplied = registeredName === name;
  }
  const namePending = adapter.cli === "agy" && Boolean(name) && !nameApplied;
  if (namePending)
    await runTmux(null, [
      "set-option",
      "-t",
      exactTmuxTarget(session),
      "@tfx_agy_name",
      name,
    ]);
  const conversation =
    adapter.cli === "agy" && ready
      ? await agyConversation((await paneCliProcess(session, "agy"))?.pid)
      : null;
  // native 피어가 정확한 thread 출처를 확인하도록 세션에 남긴다.
  if (threadId && !remote)
    await runTmux(null, [
      "set-option",
      "-t",
      exactTmuxTarget(session),
      "@tfx_codex_thread",
      threadId,
    ]).catch(() => {});
  let iterm;
  let itermWarning;
  if (ready && shouldUseIterm(remote)) {
    try {
      const project = await itermProject(cwd ?? process.cwd());
      iterm = await openItermSession(
        session,
        opts.group || project.key,
        project,
      );
      if (iterm) {
        await runTmux(null, [
          "set-option",
          "-t",
          exactTmuxTarget(session),
          "@tfx_iterm_session",
          iterm.sessionId,
        ]);
        const scriptsDir = pathJoin(
          homedir(),
          "Library",
          "Application Support",
          "iTerm2",
          "Scripts",
        );
        const scriptPath = pathJoin(scriptsDir, ITERM_TITLE_SCRIPT_NAME);
        await mkdir(scriptsDir, { recursive: true });
        const installed = await readFile(scriptPath, "utf8").catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (installed !== ITERM_TITLE_SCRIPT)
          await writeFile(scriptPath, ITERM_TITLE_SCRIPT, { mode: 0o700 });
        await chmod(scriptPath, 0o700);
        const titleArgs = [
          iterm.sessionId,
          opts.group || project.name,
          name ?? session,
        ]
          .map(appleScriptString)
          .join(", ");
        // 절대 경로는 최초 설치 직후의 메뉴 캐시 지연을 피하고, 적용 표식은 비동기 실패를 잡는다.
        const titleScript = `tell application "iTerm2"
  set titleSession to missing value
  repeat with candidateWindow in windows
    repeat with candidateTab in tabs of candidateWindow
      repeat with candidateSession in sessions of candidateTab
        if id of candidateSession is ${appleScriptString(iterm.sessionId)} then set titleSession to candidateSession
      end repeat
    end repeat
  end repeat
  if titleSession is missing value then error "iTerm title session not found"
  launch API script named ${appleScriptString(scriptPath)} arguments {${titleArgs}}
  repeat 30 times
    try
      tell titleSession to set titleApplied to variable named "user.tfxLiveTitleApplied"
      if titleApplied is "1" then return
    end try
    delay 0.1
  end repeat
  error "iTerm title update was not confirmed; check the iTerm2 Python runtime and Script Console"
end tell`;
        await execFileAsync("/usr/bin/osascript", ["-e", titleScript], {
          timeout: 5000,
          maxBuffer: 64 * 1024,
        });
      }
    } catch (error) {
      itermWarning = error.message;
    }
  }
  return addLoginGuard(adapter, raw, {
    cli: adapter.cli,
    session,
    remote: remote ?? null,
    resumed,
    resumeTarget,
    ready,
    ...(blockedBy ? { blockedBy } : {}),
    ...(warning ? { warning } : {}),
    ...(restartedAfterUpdate ? { restartedAfterUpdate } : {}),
    name,
    nameGenerated: !resumed && opts.name === undefined,
    nameApplied,
    ...(adapter.cli === "codex" ? { threadId } : {}),
    ...(registeredName ? { sendMessageTo: registeredName } : {}),
    ...(adapter.cli === "agy"
      ? { conversationId: conversation?.conversationId ?? null, namePending }
      : {}),
    unsetEnv: opts.unsetEnv ?? [],
    unsetEnvVerified,
    ...(iterm ? { iterm } : {}),
    ...(itermWarning ? { itermWarning } : {}),
    ...(unsetEnvWarning ? { unsetEnvWarning } : {}),
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
async function submitComposerLine(remote, session, line, cli) {
  await sleep(300);
  for (let attempt = 1; attempt <= PROMPT_SUBMIT_MAX_ATTEMPTS; attempt += 1) {
    await runTmux(remote, [
      "send-keys",
      "-t",
      exactTmuxTarget(session),
      "Enter",
    ]);
    await sleep(300);
    if (!composerShowsPrompt(await captureVisible(remote, session), line, cli))
      return true;
  }
  return false;
}

async function renameAgyConversation(session, name, timeoutMs, pollIntervalMs) {
  const command = `/rename ${name}`;
  await runTmux(null, [
    "send-keys",
    "-t",
    exactTmuxTarget(session),
    "-l",
    "--",
    command,
  ]);
  if (!(await submitComposerLine(null, session, command, "agy"))) return false;
  const deadline = Date.now() + timeoutMs;
  do {
    const visible = stripAnsi(await captureVisible(null, session));
    if (visible.includes(`Conversation renamed to: ${name}`)) return true;
    await sleep(Math.min(pollIntervalMs, 200));
  } while (Date.now() < deadline);
  return false;
}

async function waitForTmuxIdle(adapter, opts, deps = {}) {
  const capture = deps.captureVisible ?? captureVisible;
  const tmux = deps.runTmux ?? runTmux;
  const pause = deps.sleep ?? sleep;
  const { session, remote, pollIntervalMs, busyTimeoutMs, ifBusy } = opts;
  if (
    ![
      "wait",
      "fail",
      "interrupt",
      ...(adapter.cli === "agy" ? ["queue"] : []),
    ].includes(ifBusy)
  ) {
    throw new Error(
      "--if-busy must be wait, fail, or interrupt for tmux (agy also supports queue)",
    );
  }
  const startedAt = Date.now();
  let interrupted = false;
  while (true) {
    const visible = await capture(remote, session);
    const elapsedMs = Date.now() - startedAt;
    const busy =
      adapter.isBusy(visible) ||
      (adapter.cli === "codex" && isCodexLoadingCapture(visible));
    if (!busy || ifBusy === "queue") return elapsedMs;
    if (ifBusy === "fail") throw new Error("target busy (--if-busy fail)");
    if (elapsedMs >= busyTimeoutMs) {
      throw new Error(
        `target busy after ${Math.ceil(busyTimeoutMs / 1000)}s (--if-busy ${ifBusy})`,
      );
    }
    if (ifBusy === "interrupt" && !interrupted) {
      await tmux(remote, [
        "send-keys",
        "-t",
        exactTmuxTarget(session),
        "Escape",
      ]);
      interrupted = true;
    }
    await pause(
      Math.min(pollIntervalMs, Math.max(1, busyTimeoutMs - elapsedMs)),
    );
  }
}

async function doAskViaTmux(adapter, opts, deps = {}) {
  const tmux = deps.runTmux ?? runTmux;
  const capture = deps.captureVisible ?? captureVisible;
  const captureHistory = deps.capturePane ?? capturePane;
  const pause = deps.sleep ?? sleep;
  const {
    session,
    prompt,
    remote,
    timeoutMs,
    settleMs,
    pollIntervalMs,
    doneMarker,
    ifBusy = adapter.cli === "agy" ? "queue" : "wait",
    busyTimeoutMs = timeoutMs,
  } = opts;
  const slashCommand =
    (adapter.cli === "agy" && isSlashCommand(prompt)) ||
    (adapter.cli === "codex" && /^\/(?:rename|status)(?:\s|$)/.test(prompt));
  const busyWaitedMs =
    opts.skipBusyCheck ||
    (adapter.cli === "codex" &&
      slashCommand &&
      ["wait", "queue"].includes(ifBusy))
      ? 0
      : await waitForTmuxIdle(
          adapter,
          {
            session,
            remote,
            pollIntervalMs,
            busyTimeoutMs,
            ifBusy: adapter.cli === "agy" && slashCommand ? "queue" : ifBusy,
          },
          deps,
        );
  const queued =
    adapter.cli === "agy" && adapter.isBusy(await capture(remote, session));
  const beforeRaw = await captureHistory(remote, session);
  const contextPctBefore = adapter.contextPct(beforeRaw);
  const context =
    adapter.cli === "agy"
      ? modelContext("agy", null)
      : opts.skipContextGuard
        ? {}
        : await tmuxContext(adapter, opts);
  const guard =
    opts.skipContextGuard || adapter.cli === "agy"
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

  // paneCliProcess는 로컬 전용이므로 원격 입력 동작은 유지한다.
  const target =
    !remote &&
    (await (deps.paneCliProcess ?? paneCliProcess)(session, adapter.cli));
  if (!remote && !target?.running) {
    throw new Error(
      target
        ? `${adapter.cli} is not attached to the pane before input`
        : `${adapter.cli} exited before input`,
    );
  }
  const bufferName = tmuxBufferName(session);
  // tmux 는 명령 하나를 16KiB 안팎에서 "command too long" 으로 거부한다. 긴 프롬프트는 파일로 넣는다.
  if (!remote && Buffer.byteLength(prompt) > TMUX_SET_BUFFER_MAX_BYTES) {
    const promptFile = pathJoin(
      privateTmpDir("tfx-live"),
      `${bufferName}-${process.pid}-${randomBytes(6).toString("hex")}.prompt`,
    );
    try {
      await writeFile(promptFile, prompt, { mode: 0o600 });
      await tmux(remote, ["load-buffer", "-b", bufferName, promptFile]);
    } finally {
      await rm(promptFile, { force: true });
    }
  } else {
    await tmux(remote, ["set-buffer", "-b", bufferName, "--", prompt]);
  }
  await tmux(remote, [
    "paste-buffer",
    "-b",
    bufferName,
    "-d",
    "-p",
    "-t",
    exactTmuxTarget(session),
  ]);
  await pause(settleMs);

  let promptSubmitted =
    adapter.cli === "agy" || opts.confirmSubmission ? false : !doneMarker;
  if (doneMarker || opts.noWait || adapter.cli === "agy") {
    for (
      let attempt = 1;
      attempt <= (opts.submitAttempts ?? PROMPT_SUBMIT_MAX_ATTEMPTS);
      attempt += 1
    ) {
      await tmux(remote, [
        "send-keys",
        "-t",
        exactTmuxTarget(session),
        "Enter",
      ]);
      await pause(PROMPT_SUBMIT_RETRY_DELAY_MS);
      const submissionVisible = await capture(remote, session);
      if (
        opts.confirmSubmission
          ? await opts.confirmSubmission(submissionVisible)
          : !composerShowsPrompt(submissionVisible, prompt, adapter.cli)
      ) {
        promptSubmitted = true;
        break;
      }
    }
    if (!promptSubmitted) {
      throw new Error(
        opts.confirmSubmission
          ? "compact submission could not be confirmed (it may still have started, or /compact may remain in the composer); --then was not sent"
          : `Prompt did not submit after ${PROMPT_SUBMIT_MAX_ATTEMPTS} attempts`,
      );
    }
  } else {
    await tmux(remote, ["send-keys", "-t", exactTmuxTarget(session), "Enter"]);
  }

  let nameApplied;
  if (adapter.cli === "agy" && !slashCommand) {
    const { stdout } = await tmux(null, [
      "show-options",
      "-qv",
      "-t",
      exactTmuxTarget(splitTmuxTarget(session).session),
      "@tfx_agy_name",
    ]);
    const pendingName = stdout.trim();
    if (pendingName) {
      nameApplied = false;
      let db;
      try {
        const { DatabaseSync } = await import("node:sqlite");
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (!db) {
            const agyProcess = await paneCliProcess(session, "agy");
            const conversation = await agyConversation(agyProcess?.pid);
            if (conversation)
              db = new DatabaseSync(conversation.dbPath, { readOnly: true });
          }
          if (
            db
              ?.prepare("SELECT 1 FROM steps WHERE step_type = 14 LIMIT 1")
              .get()
          ) {
            nameApplied = await renameAgyConversation(
              session,
              pendingName,
              5000,
              pollIntervalMs,
            );
            if (nameApplied)
              await tmux(null, [
                "set-option",
                "-u",
                "-t",
                exactTmuxTarget(splitTmuxTarget(session).session),
                "@tfx_agy_name",
              ]);
            break;
          }
          await pause(Math.min(pollIntervalMs, 200));
        }
      } catch {
        nameApplied = false;
      } finally {
        db?.close();
      }
    }
  }

  if (opts.noWait || slashCommand) {
    return {
      ...context,
      ...guard,
      ok: true,
      cli: adapter.cli,
      transport: "tmux",
      session,
      remote: remote ?? null,
      status: queued && !slashCommand ? "queued" : "submitted",
      ...(slashCommand ? { slashCommand: true } : {}),
      ...(nameApplied !== undefined ? { nameApplied } : {}),
      inputSent: true,
      done: false,
      submittedAt: new Date().toISOString(),
      target: session,
      ifBusy,
      busyWaitedMs,
    };
  }

  if (adapter.cli === "agy") {
    return {
      ...context,
      ...(await waitAgy({
        session,
        requestId: opts.noRelayTag ? null : opts.requestId,
        timeoutMs,
        pollIntervalMs,
      })),
      transport: "tmux",
      inputSent: true,
      ...(nameApplied !== undefined ? { nameApplied } : {}),
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
      ? await captureHistory(remote, session)
      : await capture(remote, session);
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
        await captureHistory(remote, session),
        prompt,
        beforeRaw,
      );
    if (markerDone || fallbackDone) {
      done = true;
      break;
    }

    await pause(pollIntervalMs);
  }

  raw = await captureHistory(remote, session);
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
  // 슬래시 명령은 CLI 와 상관없이 첫 글자가 / 여야 실행되므로 표식을 붙이지 않는다.
  const bare = opts.noRelayTag || isSlashCommand(opts.prompt);
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
      ...(await dispatchAsk(adapter, {
        ...opts,
        prompt,
        requestId,
        noRelayTag: bare,
        noWait:
          opts.noWait ||
          (adapter.cli === "claude" && CLAUDE_SILENT_SLASH.test(opts.prompt)),
      })),
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
    return (
      (await paneCliProcess(null, "codex", Number(panePid)))?.command ?? null
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
      exactTmuxTarget(session),
      "#{@tfx_codex_thread}\t#{pane_id}\t#{pane_current_path}\t#{session_created}\t#{pane_pid}",
    ]);
    fields = String(stdout).trimEnd().split("\t");
  } catch (error) {
    return { threadId: null, reason: `tmux-unavailable: ${error.message}` };
  }
  const [stored, paneId, cwd, created, panePid] = fields;
  const records = (deps.readCodexSessionRecords ?? readCodexSessionRecords)({
    dir: registryDir(),
  })
    .filter((entry) => entry.tmuxPane === paneId)
    .sort(
      (a, b) =>
        (Number(b.updatedAt ?? b.startedAt) || 0) -
        (Number(a.updatedAt ?? a.startedAt) || 0),
    );
  if (
    (deps.requireRegistryAgreement || !isCodexThreadId(stored)) &&
    records.length > 1 &&
    records[0].sessionId !== records[1].sessionId &&
    (Number(records[0].updatedAt ?? records[0].startedAt) || 0) ===
      (Number(records[1].updatedAt ?? records[1].startedAt) || 0)
  )
    return { threadId: null, reason: "registry-ambiguous" };
  const record = records[0];
  if (isCodexThreadId(stored)) {
    if (deps.requireRegistryAgreement && record && record.sessionId !== stored)
      return { threadId: null, reason: "pane-thread-conflict" };
    return { threadId: stored, threadSource: "tmux-option" };
  }
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

// Codex 입력창은 들여쓰기 없는 › 줄부터 화면 맨 아래 상태 줄 묶음 위의 빈 줄 앞까지다.
// 입력 내용의 빈 줄과 › 는 들여쓴 이어지는 줄로 그려지므로 경계가 아니다. 빈 입력창의
// 플레이스홀더는 흐린 글씨(SGR 2)라 빼고, 공백을 뺀 입력 내용을 돌려준다. 경계를 못 찾으면 null 이다.
function codexComposerText(escaped) {
  const lines = String(escaped).split("\n");
  const plain = lines.map((line) => stripAnsi(line));
  let end = plain.length;
  while (end > 0 && !plain[end - 1].trim()) end -= 1;
  let separator = end - 1;
  while (separator >= 0 && plain[separator].trim()) separator -= 1;
  const start = plain.findLastIndex(
    (line, index) => index < separator && /^›/.test(line),
  );
  if (start < 0) return null;
  return lines
    .slice(start, separator)
    .map((line) =>
      stripAnsi(line.replace(/\x1b\[2m.*?(?:\x1b\[(?:0|22)?m|$)/g, "")),
    )
    .join("")
    .replace(/^›/, "")
    .replace(/\s+/g, "");
}

// 확인 메시지 그대로가 그 thread 의 사용자 입력으로 들어왔는지 본다. 다른 Codex 가 pane 을 읽어
// 도구 출력으로 받은 nonce 나, 다른 내용과 함께 제출된 입력은 증거가 아니다.
async function rolloutHasUserInput(threadId, prefix, message) {
  const rollout = await findCodexRollout(threadId);
  const info = rollout && (await stat(rollout).catch(() => null));
  if (!info) return false;
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
  for (const line of text.split("\n")) {
    if (!line.includes(prefix)) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = entry.payload;
    if (
      entry.type === "response_item" &&
      payload?.type === "message" &&
      payload.role === "user" &&
      payload.content?.some(
        (part) => part?.type === "input_text" && part.text === message,
      )
    )
      return true;
  }
  return false;
}

// 손으로 띄운 Codex 도 기본으로 공유 daemon 에 붙지만 pane 과 thread 를 잇는 기록이 없다.
// daemon 안에서 도는 셸의 TMUX_PANE 은 daemon 값이라 Codex 의 자기 보고로는 pane 을 알 수 없다.
// 리드가 그 pane 에 nonce 를 tmux 로 한 번 입력하고, 그 nonce 를 사용자 입력으로 받은 daemon thread 를
// pane 에 기록한다. daemon 에 로드됐다는 사실은 pane 소속의 증거가 아니라 매번 다시 확인한다.
async function doAdopt(opts, deps = {}) {
  const tmux = deps.runTmux ?? runTmux;
  const pause = deps.sleep ?? sleep;
  const captureComposer =
    deps.captureEscaped ??
    (async (target) =>
      (await tmux(null, ["capture-pane", "-p", "-e", "-t", target])).stdout);
  const hasInput = deps.rolloutHasUserInput ?? rolloutHasUserInput;
  const { session, timeoutMs, pollIntervalMs } = opts;
  const deadline = Date.now() + timeoutMs;
  const listThreads =
    deps.listThreads ??
    (async () =>
      (
        await import("../hub/team/uds-orchestrator.mjs")
      ).listCodexAppServerThreads({
        socketPath: resolveCodexDaemonSocket("default"),
        timeoutMs,
      }));
  // 활성 pane 이 바뀌어도 같은 pane 에 입력하고 기록하도록 pane ID 를 먼저 고정한다.
  const { stdout } = await tmux(null, [
    "display-message",
    "-p",
    "-t",
    exactTmuxTarget(session),
    "#{pane_id}",
  ]);
  const paneId = String(stdout).trim();
  if (!/^%\d+$/.test(paneId))
    throw new Error(`tmux pane not found: ${session}`);
  await waitForTmuxIdle(
    ADAPTERS.codex,
    {
      session: paneId,
      remote: null,
      pollIntervalMs,
      busyTimeoutMs: timeoutMs,
      ifBusy: "wait",
    },
    deps,
  );
  // 기다리는 동안 Codex 가 끝났거나 메뉴 화면이면 입력이 셸이나 메뉴 선택으로 간다.
  const target = await (deps.paneCliProcess ?? paneCliProcess)(paneId, "codex");
  if (!target?.running)
    throw new Error(
      target
        ? "codex is not attached to the pane"
        : "no codex process in the pane",
    );
  // 플레이스홀더만 있는 빈 입력창이어야 입력한다. 초안이나 메뉴 선택 줄이 있으면 아무 키도 보내지 않는다.
  const before = await captureComposer(paneId);
  const visible = stripAnsi(before);
  if (
    !isCodexReadyCapture(visible) ||
    isStartupScreen(ADAPTERS.codex, visible) ||
    codexComposerText(before) !== ""
  )
    throw new Error(
      "codex is not at an empty input prompt; attach to the pane, clear the draft or close the open screen first",
    );
  const prefix = `[tfx-live adopt tfx-adopt-${randomBytes(6).toString("hex")}]`;
  const message = `${prefix} 리드가 이 Codex 세션을 피어 대화에 연결하려고 보낸 확인 메시지다. "확인"이라고만 답하고 새 작업은 시작하지 마라. 이후 리드의 메시지는 tfx-peer 로 온다.`;
  await tmux(null, ["send-keys", "-t", paneId, "-l", "--", message]);
  // 확인과 입력 사이에 누가 입력했으면 입력창이 메시지와 달라진다. 입력한 만큼만 지우고 멈춘다.
  await pause(300);
  if (
    codexComposerText(await captureComposer(paneId)) !==
    message.replace(/\s+/g, "")
  ) {
    await tmux(null, [
      "send-keys",
      "-t",
      paneId,
      "-N",
      String([...message].length),
      "BSpace",
    ]);
    throw new Error(
      "codex composer changed while typing; adopt removed its own text",
    );
  }
  await (deps.submitComposerLine ?? submitComposerLine)(
    null,
    paneId,
    message,
    "codex",
  );
  // 갓 띄운 Codex 는 첫 입력을 받아야 thread 가 생기므로 목록을 매번 다시 읽는다.
  // 하위 에이전트 thread 의 source 는 객체다. 피어는 최상위 사용자 thread 만 받는다.
  while (true) {
    const matches = [];
    for (const thread of await listThreads())
      if (
        typeof thread.source === "string" &&
        (await hasInput(thread.threadId, prefix, message))
      )
        matches.push(thread);
    if (matches.length > 1)
      throw new Error(
        `adopt nonce appeared in several threads: ${matches.map((thread) => thread.threadId).join(", ")}`,
      );
    if (matches.length === 1) {
      await tmux(null, [
        "set-option",
        "-p",
        "-t",
        paneId,
        "@tfx_codex_thread",
        matches[0].threadId,
      ]);
      return {
        ok: true,
        cli: "codex",
        session,
        paneId,
        threadId: matches[0].threadId,
        name: matches[0].name ?? null,
      };
    }
    const left = deadline - Date.now();
    if (left <= 0)
      throw new Error(
        "adopt nonce did not reach any shared-daemon thread; a Codex launched with -c overrides, --no-daemon, or another CODEX_HOME runs outside the shared daemon. Restart it with tfx-live start --cli codex --resume <thread>",
      );
    await pause(Math.min(pollIntervalMs, left));
  }
}

async function doAskViaQueue(adapter, opts, deps = {}) {
  // queue 를 못 쓰면 tmux 붙여넣기로 보내고 그 이유를 결과에 남긴다.
  const fallback = async (reason) => {
    if (opts.queueOnly)
      throw new Error(`compact --then requires Codex queue: ${reason}`);
    return {
      ...(await doAskViaTmux(adapter, { ...opts, transport: "tmux" })),
      transportRequested: "queue",
      fallbackReason: reason,
    };
  };
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
    queueVia: queued.via,
    ...(queued.fallbackReason
      ? { queueFallbackReason: queued.fallbackReason }
      : {}),
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
      exactTmuxTarget(splitTmuxTarget(opts.session).session),
    ]);
    return false;
  } catch {
    await doStart(adapter, {
      session: opts.session,
      remote: opts.remote,
      cwd: opts.cwd,
      group: opts.group,
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

async function doStop(adapter, opts, deps = {}) {
  const tmux = deps.runTmux ?? runTmux;
  const useIterm =
    !opts.remote && (deps.platform ?? process.platform) === "darwin";
  const closeIterm = deps.closeItermSession ?? closeItermSession;
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
  let itermSessionId;
  let itermWarning;
  let killedTtys = [];
  if (useIterm) {
    try {
      const { stdout } = await tmux(null, [
        "show-options",
        "-qv",
        "-t",
        exactTmuxTarget(session),
        "@tfx_iterm_session",
      ]);
      itermSessionId = stdout.trim();
    } catch (error) {
      itermWarning = error.message;
    }
    // kill 뒤에는 이 세션의 클라이언트가 목록에서 사라지므로 먼저 받아 둔다.
    const clients = await tmux(null, [
      "list-clients",
      "-t",
      exactTmuxTarget(session),
      "-F",
      "#{client_tty}",
    ]).catch(() => ({ stdout: "" }));
    killedTtys = clients.stdout.trim().split("\n").filter(Boolean);
  }
  await tmux(remote, ["kill-session", "-t", exactTmuxTarget(session)]);
  // tfx-live 가 연 패인 기록이나 붙어 있던 클라이언트가 있으면 어디서 stop 하든 닫고, 기록이 없을 때의 이름 검색은 iTerm 안에서만 한다.
  if (
    useIterm &&
    (itermSessionId ||
      killedTtys.length ||
      shouldUseIterm(remote, deps.platform ?? process.platform, deps.env))
  ) {
    try {
      await closeIterm(
        itermSessionId ?? "",
        session,
        shouldUseIterm(remote, deps.platform ?? process.platform, deps.env),
        killedTtys,
      );
    } catch (error) {
      itermWarning = error.message;
    }
  }
  return {
    cli: adapter.cli,
    session,
    remote: remote ?? null,
    stopped: true,
    ...(itermWarning ? { itermWarning } : {}),
  };
}

async function doInterruptViaTmux(adapter, opts) {
  await runTmux(opts.remote, [
    "send-keys",
    "-t",
    exactTmuxTarget(opts.session),
    "Escape",
  ]);
  if (adapter.cli === "agy")
    await waitForTmuxIdle(adapter, {
      ...opts,
      ifBusy: "wait",
      busyTimeoutMs: opts.timeoutMs,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    });
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
  const unsetEnv =
    flags["unset-env"] === undefined ? [] : flags["unset-env"].split(",");
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
    group: flags.group,
    sandbox: Object.hasOwn(flags, "sandbox"),
    noAutoTrust: Object.hasOwn(flags, "no-auto-trust"),
    unsetEnv,
    leadSession: flags["lead-session"],
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
  const word = String(prompt ?? "").match(/^\/[a-z][\w-]*(?=\s|$)/i)?.[0];
  // `/tmp 를 확인해` 처럼 이 기기에 실제로 있는 경로로 시작하는 문장은 명령이 아니다.
  return Boolean(word) && !existsSync(word);
}

// 응답 턴을 만들지 않는 Claude 내장 명령. 스킬 명령은 응답을 만드므로 기다린다.
const CLAUDE_SILENT_SLASH =
  /^\/(?:rename|clear|compact|model|effort|color)(?:\s|$)/i;

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
  if (adapter.cli === "agy" && transport !== "tmux")
    throw new Error("agy ask supports local --transport tmux only");
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
    ifBusy: flags["if-busy"] ?? (adapter.cli === "agy" ? "queue" : "wait"),
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
  if (adapter.cli === "agy" && transport !== "tmux")
    throw new Error("agy interrupt supports local --transport tmux only");
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
  printJson(await doStart(adapter, { ...startOpts(flags), nativePeer: true }));
}

async function ask(flags, deps = {}) {
  const adapter = selectAdapter(flags);
  const opts = askOpts(flags, adapter);
  const redirect = await sameMachineClaudeRedirect(adapter, opts, flags, deps);
  if (redirect) {
    printJson(redirect);
    process.exitCode = 1;
    return;
  }
  printJson(await doAsk(adapter, opts));
}

// 같은 기기의 Claude 가 다른 Claude 세션에 tmux 로 입력하면 사람 입력처럼 보이고 보낸 쪽도 남지 않는다.
// 그래서 대상 이름을 알려 주고 SendMessage 를 쓰게 한다. 슬래시 명령은 SendMessage 로 실행되지 않아 그대로 보낸다.
async function sameMachineClaudeRedirect(adapter, opts, flags, deps = {}) {
  const env = deps.env ?? process.env;
  if (
    adapter.cli !== "claude" ||
    env.CLAUDECODE !== "1" ||
    flags.remote ||
    Object.hasOwn(flags, "via-tmux") ||
    opts.short ||
    opts.sessionId ||
    !opts.session ||
    isSlashCommand(opts.prompt)
  )
    return null;
  const target = await (deps.claudeTmuxTarget ?? claudeTmuxTarget)(
    splitTmuxTarget(opts.session).target,
  ).catch(() => null);
  if (!target?.name) return null;
  return {
    ok: false,
    cli: "claude",
    status: "failed",
    done: false,
    inputSent: false,
    reason: "use-send-message",
    sendMessageTo: target.name,
    error: `같은 기기의 Claude 세션에는 SendMessage(to: "${target.name}")로 보낸다.`,
  };
}

const PEER_SEND_CLIS = ["claude", "codex", "agy"];

// --to 인자에서 선택적 CLI 접두사(claude:, codex:, agy:)와 검색어를 분리한다.
function parsePeerToSpec(raw) {
  const text = String(raw || "").trim();
  if (!text) return { cli: null, query: "" };
  const match = text.match(/^(claude|codex|agy|antigravity):(.*)$/i);
  if (!match) return { cli: null, query: text };
  const rawCli = match[1].toLowerCase();
  const cli = rawCli === "antigravity" ? "agy" : rawCli;
  return { cli, query: match[2].trim() };
}

function summarizePeerCandidate(candidate) {
  return {
    cli: candidate.cli,
    name: candidate.name,
    target: candidate.target,
    ...(candidate.session ? { session: candidate.session } : {}),
    ...(candidate.paneId ? { paneId: candidate.paneId } : {}),
    ...(candidate.sessionId ? { sessionId: candidate.sessionId } : {}),
    ...(candidate.threadId ? { threadId: candidate.threadId } : {}),
    ...(candidate.conversationId
      ? { conversationId: candidate.conversationId }
      : {}),
  };
}

// claude, codex, agy 세션을 탐색해 --to 매칭 후보 목록을 만든다.
async function discoverPeerTargets({
  cliFilter = null,
  cwd = null,
  deps = {},
} = {}) {
  const clis = cliFilter ? [cliFilter] : PEER_SEND_CLIS;
  const discoverClaude =
    deps.discoverClaudeTmuxSessions || discoverClaudeTmuxSessions;
  const discoverCodex =
    deps.discoverCodexTmuxSessions || discoverCodexTmuxSessions;
  const discoverAgy = deps.discoverAgyTmuxSessions || discoverAgyTmuxSessions;
  const resolveCodexThread =
    deps.resolveCodexTmuxThread ||
    (deps.discoverCodexTmuxSessions ? null : resolveCodexTmuxThread);
  const loadCodexThreadNames =
    deps.codexThreadNames ||
    (deps.discoverCodexTmuxSessions ? null : codexThreadNames);

  const candidates = [];

  if (clis.includes("claude")) {
    const claudeResult = await discoverClaude({ cwd });
    for (const s of claudeResult?.sessions || []) {
      const name = s.name || s.session || s.target;
      const aliases = [
        s.name,
        s.session,
        s.target,
        s.paneId,
        s.sessionId,
      ].filter(Boolean);
      candidates.push({
        cli: "claude",
        name,
        target: s.target || s.session,
        session: s.session || null,
        paneId: s.paneId || null,
        sessionId: s.sessionId || null,
        aliases,
        raw: s,
      });
    }
  }

  if (clis.includes("codex")) {
    const codexResult = await discoverCodex({ cwd });
    const rawSessions = Array.isArray(codexResult?.sessions)
      ? codexResult.sessions.map((s) => ({ ...s }))
      : [];
    if (resolveCodexThread) {
      const missingThreadIds = [];
      for (const s of rawSessions) {
        if (!s.threadId && (s.target || s.paneId)) {
          const resolved = await resolveCodexThread(s.target || s.paneId);
          if (resolved?.threadId) {
            s.threadId = resolved.threadId;
            s.threadSource = resolved.threadSource;
            if (!s.name) missingThreadIds.push(resolved.threadId);
          }
        } else if (s.threadId && !s.name) {
          missingThreadIds.push(s.threadId);
        }
      }
      if (missingThreadIds.length && loadCodexThreadNames) {
        const names = await loadCodexThreadNames(missingThreadIds);
        for (const s of rawSessions) {
          if (!s.name && s.threadId && names.get(s.threadId)) {
            s.name = names.get(s.threadId);
          }
        }
      }
    }
    for (const s of rawSessions) {
      const name = s.name || s.session || s.threadId || s.target;
      const aliases = [
        s.name,
        s.session,
        s.threadId,
        s.target,
        s.paneId,
      ].filter(Boolean);
      candidates.push({
        cli: "codex",
        name,
        target: s.target || s.session,
        session: s.session || null,
        paneId: s.paneId || null,
        threadId: s.threadId || null,
        aliases,
        raw: s,
      });
    }
  }

  if (clis.includes("agy")) {
    const agyResult = await discoverAgy({ cwd });
    for (const s of agyResult?.sessions || []) {
      const name = s.name || s.session || s.conversationId || s.target;
      const aliases = [
        s.name,
        s.session,
        s.conversationId,
        s.target,
        s.paneId,
      ].filter(Boolean);
      candidates.push({
        cli: "agy",
        name,
        target: s.target || s.session,
        session: s.session || null,
        paneId: s.paneId || null,
        conversationId: s.conversationId || null,
        aliases,
        raw: s,
      });
    }
  }

  return candidates;
}

// 후보 목록에서 query에 해당하는 단일 수신 세션을 찾는다.
function matchPeerCandidates(candidates, query) {
  const needle = String(query || "")
    .trim()
    .toLowerCase();
  if (!needle) return [];

  // 1순위: 표시 이름(name) 정확 일치
  const exactName = candidates.filter(
    (c) =>
      String(c.name || "")
        .trim()
        .toLowerCase() === needle,
  );
  if (exactName.length > 0) return exactName;

  // 2순위: 별칭(session, threadId, conversationId, target, paneId) 정확 일치
  return candidates.filter((c) =>
    (c.aliases || []).some(
      (alias) =>
        String(alias || "")
          .trim()
          .toLowerCase() === needle,
    ),
  );
}

// 발신 세션을 판별한다: --from -> TFX_LIVE_FROM -> 환경변수/tmux 자동 탐지.
async function resolvePeerSender({
  from = null,
  env = process.env,
  allCandidates = null,
  deps = {},
} = {}) {
  const detectCliFromEnv = () => {
    if (env.CLAUDECODE === "1") {
      return "claude";
    }
    if (env.ANTIGRAVITY_CONVERSATION_ID) {
      return "agy";
    }
    if (env.CODEX_THREAD_ID) {
      return "codex";
    }
    if (deps.isLocalClaudeCaller?.(env)) {
      return "claude";
    }
    return null;
  };

  const explicit = String(from || env.TFX_LIVE_FROM || "").trim();
  if (explicit) {
    const parsed = parsePeerToSpec(explicit);
    if (parsed.cli && parsed.query) {
      return { cli: parsed.cli, name: parsed.query };
    }
    let inferredCli = detectCliFromEnv();
    if (!inferredCli && env.TMUX_PANE) {
      const candidates = allCandidates || (await discoverPeerTargets({ deps }));
      inferredCli =
        candidates.find((c) => c.paneId === env.TMUX_PANE)?.cli || null;
    }
    return { cli: inferredCli || "unknown", name: explicit };
  }

  const candidates = allCandidates || (await discoverPeerTargets({ deps }));
  const envCli = detectCliFromEnv();

  if (envCli === "codex") {
    const byThread = candidates.find(
      (c) => c.cli === "codex" && c.threadId === env.CODEX_THREAD_ID,
    );
    if (byThread) return { cli: "codex", name: byThread.name };
  }

  if (env.TMUX_PANE && envCli !== "codex") {
    const byPane = candidates.find(
      (c) =>
        c.paneId === env.TMUX_PANE &&
        c.cli !== "codex" &&
        (!envCli || c.cli === envCli),
    );
    if (byPane) {
      return {
        cli: byPane.cli,
        name:
          byPane.cli === "claude" && byPane.raw
            ? byPane.raw.name || null
            : byPane.name,
        ...(byPane.sessionId ? { sessionId: byPane.sessionId } : {}),
      };
    }
  }

  if (envCli === "agy") {
    const byConv = candidates.find(
      (c) =>
        c.cli === "agy" && c.conversationId === env.ANTIGRAVITY_CONVERSATION_ID,
    );
    return {
      cli: "agy",
      name: byConv?.name || env.ANTIGRAVITY_CONVERSATION_ID,
    };
  }

  const resolveSender = deps.resolveSenderName || resolveSenderName;
  const senderName = await resolveSender({ env });
  if (senderName) {
    return { cli: envCli || "unknown", name: senderName };
  }
  if (envCli) {
    return { cli: envCli, name: envCli === "claude" ? null : envCli };
  }
  return { cli: "unknown", name: "unknown" };
}

function formatPeerReply(
  { cli, name, sessionId },
  targetCli,
  { platform = process.platform } = {},
) {
  if (cli === "unknown" || (cli === "claude" && !name && !sessionId))
    return "회신: 경로 불명(보낸 세션을 판별하지 못함)";
  const oneLineName = String(name || sessionId).replace(
    /[\r\n\u2028\u2029]+/g,
    " ",
  );
  if (cli === "claude" && targetCli === "claude") {
    return `회신: SendMessage(to: ${JSON.stringify(oneLineName)})`;
  }
  if (platform === "win32" && cli === "codex")
    return "회신: Windows 에서는 Codex 대상을 아직 지원하지 않는다";
  const command =
    platform === "win32" && cli === "claude"
      ? String.raw`node "$env:APPDATA\npm\node_modules\triflux\bin\tfx-peer.mjs"`
      : cli === "claude" || cli === "codex"
        ? shellQuote([pathJoin(homedir(), ".claude", "scripts", "tfx-peer")])
        : "tfx-live";
  const to = `${cli}:${cli === "claude" && sessionId ? sessionId : oneLineName}`
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/'/g, platform === "win32" ? "''" : `'"'"'`);
  return `회신: ${command} send --to '${to}' --message '...'`;
}

function formatPeerSendMessage({
  senderCli,
  senderName,
  senderSessionId,
  targetCli,
  msgId,
  requestId,
  message,
}) {
  const fromSpec =
    `${senderCli || "unknown"}:${senderName || "unknown"}`.replace(
      /[\r\n\u2028\u2029]+/g,
      " ",
    );
  const body = String(message ?? "").trim();
  return [
    `[tfx-peer from=${fromSpec} msg=${msgId}] [tfx-live req=${requestId}]`,
    body,
    formatPeerReply(
      {
        cli: senderCli || "unknown",
        name: senderName,
        sessionId: senderSessionId,
      },
      targetCli,
    ),
  ].join("\n");
}

async function doSend(opts = {}, deps = {}) {
  const rawTo = String(opts.to || "").trim();
  const rawMessage = String(opts.message ?? "").trim();
  if (!rawTo) {
    throw new Error("send requires --to NAME|CLI:NAME");
  }
  if (!rawMessage) {
    throw new Error("send requires --message TEXT");
  }

  const parsedTo = parsePeerToSpec(rawTo);
  if (!parsedTo.query) {
    throw new Error("send requires a non-empty target name in --to");
  }

  const env = opts.env || process.env;
  const msgId = opts.msgId || randomBytes(6).toString("hex");
  const requestId = opts.requestId || randomBytes(6).toString("hex");
  const noWait = Boolean(opts.noWait);
  const timeoutSec = Number(opts.timeoutSec || 600);

  const allCandidates = await discoverPeerTargets({
    cliFilter: null,
    cwd: opts.cwd || null,
    deps,
  });
  const scopedCandidates = parsedTo.cli
    ? allCandidates.filter((c) => c.cli === parsedTo.cli)
    : allCandidates;
  const matched = matchPeerCandidates(scopedCandidates, parsedTo.query);

  if (matched.length === 0) {
    return {
      ok: false,
      to: { cli: parsedTo.cli, name: parsedTo.query, target: null },
      transport: null,
      msgId,
      requestId,
      status: "failed",
      reason: "target-not-found",
      candidates: scopedCandidates.map(summarizePeerCandidate),
      error: `일치하는 세션을 찾지 못했다: ${rawTo}`,
    };
  }

  if (matched.length > 1) {
    return {
      ok: false,
      to: { cli: parsedTo.cli, name: parsedTo.query, target: null },
      transport: null,
      msgId,
      requestId,
      status: "failed",
      reason: "ambiguous-target",
      candidates: matched.map(summarizePeerCandidate),
      error: `일치하는 세션이 ${matched.length}개다. cli:이름 또는 정확한 이름으로 지정하라: ${rawTo}`,
    };
  }

  const target = matched[0];
  const sender = await resolvePeerSender({
    from: opts.from,
    env,
    allCandidates,
    deps,
  });

  const callerIsClaude =
    sender.cli === "claude" ||
    env.CLAUDECODE === "1" ||
    Boolean(deps.isLocalClaudeCaller?.(env));

  if (target.cli === "claude" && callerIsClaude && !opts.viaTmux) {
    return {
      ok: false,
      to: summarizePeerCandidate(target),
      from: sender,
      transport: "send-message",
      msgId,
      requestId,
      status: "failed",
      done: false,
      inputSent: false,
      reason: "use-send-message",
      sendMessageTo: target.name,
      error: `같은 기기의 Claude 세션에는 SendMessage(to: "${target.name}")로 보낸다.`,
    };
  }

  if (["claude", "codex"].includes(target.cli) && !opts.viaTmux) {
    return {
      ok: false,
      to: summarizePeerCandidate(target),
      from: sender,
      transport: "native-peer",
      msgId,
      requestId,
      status: "failed",
      done: false,
      inputSent: false,
      reason: "use-tfx-peer",
      error: `로컬 Claude·Codex 대상에는 ${shellQuote([pathJoin(homedir(), ".claude", "scripts", "tfx-peer"), "send", "--to", `${target.cli}:${target.cli === "claude" ? target.sessionId || target.name : target.name}`, "--message", "..."])} 로 보내라.`,
    };
  }

  const formattedPrompt = formatPeerSendMessage({
    senderCli: sender.cli,
    senderName: sender.name,
    senderSessionId: sender.sessionId,
    targetCli: target.cli,
    msgId,
    requestId,
    message: rawMessage,
  });

  const runAsk = deps.doAsk || doAsk;
  const adapter = ADAPTERS[target.cli];
  const sessionTarget =
    target.cli === "codex"
      ? target.session || target.target
      : target.target || target.session;
  const syntheticFlags = {
    cli: target.cli,
    session: sessionTarget,
    ...(target.cli === "codex" &&
    target.threadId &&
    isCodexThreadId(target.threadId)
      ? { thread: target.threadId }
      : {}),
    prompt: formattedPrompt,
    "request-id": requestId,
    ...(noWait ? { "no-wait": true } : {}),
    ...(opts.viaTmux ? { "via-tmux": true, transport: "tmux" } : {}),
    timeout: String(timeoutSec),
    ...(opts.warnContextPct !== undefined
      ? { "warn-context-pct": String(opts.warnContextPct) }
      : {}),
    ...(opts.maxContextPct !== undefined
      ? { "max-context-pct": String(opts.maxContextPct) }
      : {}),
  };
  const resolvedAskOpts = {
    ...askOpts(syntheticFlags, adapter),
    target: target.target,
    threadId: target.threadId || null,
    conversationId: target.conversationId || null,
  };

  const askResult = await runAsk(adapter, resolvedAskOpts);
  const defaultTransport =
    target.cli === "codex"
      ? "codex-queue"
      : target.cli === "agy"
        ? "agy-tmux"
        : "claude-tmux";
  const transport = askResult?.transport || defaultTransport;
  const status =
    askResult?.status ||
    (askResult?.ok ? (noWait ? "sent" : "completed") : "failed");

  return {
    ok: Boolean(askResult?.ok),
    to: summarizePeerCandidate(target),
    from: sender,
    transport,
    msgId,
    requestId,
    status,
    ...(noWait ? {} : { response: askResult?.response ?? "" }),
    ...(askResult?.reason ? { reason: askResult.reason } : {}),
    ...(askResult?.error ? { error: askResult.error } : {}),
    ...(askResult?.sendMessageTo
      ? { sendMessageTo: askResult.sendMessageTo }
      : {}),
    ...(typeof askResult?.inputSent === "boolean"
      ? { inputSent: askResult.inputSent }
      : {}),
  };
}

async function send(flags) {
  const to = flags.to || "";
  const message = flags.message || "";
  const result = await doSend({
    to,
    message,
    from: flags.from || null,
    noWait: Boolean(flags["no-wait"]),
    timeoutSec: Number(flags.timeout || 600),
    viaTmux: Boolean(flags["via-tmux"]),
    cwd: flags.cwd ? normalizeCwd(flags.cwd) : null,
    warnContextPct: flags["warn-context-pct"],
    maxContextPct: flags["max-context-pct"],
  });
  printJson(result);
  if (result.ok === false) process.exitCode = 1;
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
  if (flags.cli === "agy") {
    selectAdapter(flags);
    if (flags.transport && flags.transport !== "tmux")
      throw new Error("agy wait supports local --transport tmux only");
    return printJson(
      await waitAgy({
        session: splitTmuxTarget(requireFlag(flags, "session")).target,
        requestId: flags["request-id"] ?? null,
        timeoutMs:
          flags.timeout === "0"
            ? 0
            : secondsFlag(flags, "timeout", DEFAULT_ANSWER_TIMEOUT_MS),
        pollIntervalMs: msFlag(
          flags,
          "poll-interval",
          DEFAULT_POLL_INTERVAL_MS,
        ),
      }),
    );
  }
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

async function adopt(flags) {
  if (selectAdapter(flags).cli !== "codex")
    throw new Error("adopt supports --cli codex only");
  if (flags.remote) throw new Error("adopt supports local tmux only");
  printJson(
    await doAdopt({
      session: requireFlag(flags, "session"),
      timeoutMs: secondsFlag(flags, "timeout", 120_000),
      pollIntervalMs: msFlag(flags, "poll-interval", DEFAULT_POLL_INTERVAL_MS),
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
    exactTmuxTarget(session),
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

async function doCompact(flags, deps = {}) {
  const cli = flags.cli ?? "claude";
  if (cli === "agy")
    throw new Error("agy has no compact; use /clear or a handoff");
  if (
    !["claude", "codex"].includes(cli) ||
    flags.remote ||
    flags.short ||
    flags["session-id"] ||
    (flags.transport && flags.transport !== "tmux")
  )
    throw new Error(
      "compact supports local --cli claude|codex --session NAME only",
    );
  if (cli === "codex" && flags.instructions)
    throw new Error(
      "Codex /compact does not accept --instructions; use --then for follow-up instructions",
    );
  const thenPrompt = flags.then?.trim();
  if (flags.then !== undefined && !thenPrompt)
    throw new Error("--then must not be blank");
  if (isSlashCommand(thenPrompt))
    throw new Error("--then accepts text instructions, not slash commands");
  const ifBusy = flags["if-busy"] ?? "fail";
  if (!["fail", "wait"].includes(ifBusy))
    throw new Error("compact --if-busy must be fail or wait");
  const adapter = ADAPTERS[cli];
  const opts = askOpts(
    {
      ...flags,
      cli,
      transport: "tmux",
      "if-busy": ifBusy,
      "no-wait": true,
      prompt: `/compact${flags.instructions ? ` ${flags.instructions}` : ""}`,
    },
    adapter,
  );
  const pause = deps.sleep ?? sleep;
  const capture = deps.captureVisible ?? captureVisible;
  await waitForTmuxIdle(adapter, opts, deps);
  let transcriptPath;
  let threadId;
  if (cli === "claude") {
    transcriptPath = await (deps.claudeTmuxTranscript ?? claudeTmuxTranscript)(
      opts.session,
      opts.configDir,
    );
  } else {
    const thread = await (
      deps.resolveCodexTmuxThread ?? resolveCodexTmuxThread
    )(opts.session, deps);
    threadId = thread.threadId;
    transcriptPath = await (deps.findCodexRollout ?? findCodexRollout)(
      threadId,
    );
  }
  const readSnapshot = () =>
    cli === "claude"
      ? readClaudeTranscript(transcriptPath)
      : readCodexContext(transcriptPath, threadId);
  const before = transcriptPath && (await readSnapshot());
  if (!before || !Number.isInteger(before.compactCount))
    throw new Error(
      `compact requires a discoverable ${cli === "claude" ? "Claude transcript" : "Codex rollout"} for this tmux pane`,
    );
  let snapshot = before;
  const done = () => snapshot?.compactCount > before.compactCount;
  const deadline = Date.now() + opts.timeoutMs;
  const confirmSubmission = async (visible) => {
    const submissionDeadline = Math.min(
      deadline,
      Date.now() + (cli === "codex" ? 1000 : 5000),
    );
    do {
      snapshot = await readSnapshot();
      if (
        done() ||
        (cli === "claude"
          ? /Compacting conversation/i.test(stripAnsi(visible))
          : /Compacting context/i.test(stripAnsi(visible)))
      )
        return true;
      await pause(
        Math.min(
          opts.pollIntervalMs,
          Math.max(0, submissionDeadline - Date.now()),
        ),
      );
      visible = await capture(null, opts.session);
    } while (Date.now() < submissionDeadline);
    return false;
  };
  await doAskViaTmux(
    adapter,
    {
      ...opts,
      skipBusyCheck: true,
      skipContextGuard: true,
      submitAttempts: cli === "codex" ? 2 : 1,
      confirmSubmission,
    },
    deps,
  );
  const result = {
    cli,
    session: opts.session,
    compact: { submitted: true, done: done() },
    compacted: done(),
  };
  if (thenPrompt) {
    const requestId = randomBytes(6).toString("hex");
    const thenOpts = {
      ...opts,
      prompt: `[tfx-live req=${requestId}]\n${thenPrompt}`,
      requestId,
      threadId,
      noWait: true,
      settleMs: 0,
      transport: cli === "codex" ? "queue" : "tmux",
      skipBusyCheck: true,
      skipContextGuard: true,
      queueOnly: true,
    };
    try {
      if (cli === "codex") {
        const queued = await doAskViaQueue(adapter, thenOpts, deps);
        // biome-ignore lint/suspicious/noThenProperty: CLI 계약의 then은 함수가 아닌 큐 결과다.
        result.then = {
          ...queued,
          requestId,
          queued: queued.inputSent === true,
        };
        if (!result.then.queued) {
          result.ok = false;
          result.error =
            queued.status === "unknown"
              ? `${queued.error}; --then may already be queued, use wait --request-id and do not resend`
              : queued.error;
        }
      } else {
        await doAskViaTmux(adapter, thenOpts, deps);
        const queueDeadline = Date.now() + Math.min(opts.timeoutMs, 5000);
        let confirmedBy;
        do {
          const transcript = await readClaudeTranscript(transcriptPath, {
            requestId,
          });
          if (transcript?.enqueued) confirmedBy = "enqueue";
          else if (transcript?.userSeen) confirmedBy = "user";
          else if (
            /queued messages/i.test(
              stripAnsi(await capture(null, opts.session)),
            )
          )
            confirmedBy = "tui";
          if (confirmedBy) break;
          await pause(
            Math.min(
              opts.pollIntervalMs,
              Math.max(0, queueDeadline - Date.now()),
            ),
          );
        } while (Date.now() < queueDeadline);
        // biome-ignore lint/suspicious/noThenProperty: CLI 계약의 then은 함수가 아닌 큐 결과다.
        result.then = {
          requestId,
          queued: Boolean(confirmedBy) && confirmedBy !== "user",
          transport: "tmux",
          ...(confirmedBy === "user" ? { delivered: true } : {}),
          ...(confirmedBy ? { confirmedBy } : {}),
        };
        if (!confirmedBy) {
          result.ok = false;
          result.error =
            "Claude --then was sent but enqueue could not be confirmed; use wait --request-id, do not resend";
        }
      }
    } catch (error) {
      // compact 는 이미 제출됐으므로 그 정보를 지우지 않고 then 실패만 결과에 담는다.
      // biome-ignore lint/suspicious/noThenProperty: CLI 계약의 then은 함수가 아닌 큐 결과다.
      result.then = { requestId, queued: false, error: error.message };
      result.ok = false;
      result.error = `compact was submitted but --then failed: ${error.message}`;
    }
  }
  if (!Object.hasOwn(flags, "no-wait")) {
    do {
      snapshot = await readSnapshot();
      if (done()) break;
      await pause(
        Math.min(opts.pollIntervalMs, Math.max(0, deadline - Date.now())),
      );
    } while (Date.now() < deadline);
    if (!done()) result.timedOut = true;
  }
  result.compacted = result.compact.done = done();
  if (done()) {
    Object.assign(result, snapshot.compact);
    Object.assign(result.compact, snapshot.compact);
  }
  return result;
}

function codexGoalStatus(goal) {
  return {
    state: goal
      ? ({ usageLimited: "usage_limited", budgetLimited: "budget_limited" }[
          goal.status
        ] ?? goal.status)
      : "none",
    objective: goal?.objective ?? null,
    judgedBy: "model",
    ...(goal
      ? {
          tokensUsed: goal.tokensUsed,
          tokenBudget: goal.tokenBudget ?? null,
          updatedAt: new Date(goal.updatedAt * 1000).toISOString(),
        }
      : {}),
  };
}

async function readCodexGoal(threadId) {
  let db;
  try {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (
      major < 22 ||
      (major === 22 && minor < 13) ||
      (major === 23 && minor < 4)
    )
      throw new Error("Node 22.13+ with read-only node:sqlite is required");
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(
      pathJoin(
        process.env.CODEX_HOME ?? pathJoin(homedir(), ".codex"),
        "goals_1.sqlite",
      ),
      { readOnly: true },
    );
    const row = db
      .prepare(
        "SELECT objective, status, token_budget AS tokenBudget, tokens_used AS tokensUsed, updated_at_ms / 1000.0 AS updatedAt FROM thread_goals WHERE thread_id = ?",
      )
      .get(threadId);
    return codexGoalStatus(row);
  } catch (error) {
    // Node >=22 전체에서 sqlite 를 지원하지는 않으므로 미확인을 none 으로 보고하지 않는다.
    return {
      state: null,
      objective: null,
      judgedBy: "model",
      warning: `Goal status unavailable (read-only node:sqlite): ${error.message}`,
    };
  } finally {
    db?.close();
  }
}

async function codexGoal(action, opts, deps = {}) {
  const { threadId, objective, tokenBudget } = opts;
  let fallbackReason;
  let client;
  try {
    const socketPath = (deps.resolveSocket ?? resolveCodexDaemonSocket)(
      opts.codexSocket,
    );
    client = (
      deps.clientFactory ?? ((options) => new JsonRpcWsUdsClient(options))
    )({ socketPath, connectTimeoutMs: 5000 });
    await client.connect();
    await client.request(
      "initialize",
      {
        clientInfo: { name: "triflux-tfx-live", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      },
      5000,
    );
    client.notify("initialized", {});
    let cursor;
    let loaded = false;
    do {
      const page = await client.request(
        "thread/loaded/list",
        cursor ? { cursor } : {},
        5000,
      );
      loaded = page.data.includes(threadId);
      cursor = page.nextCursor;
    } while (!loaded && cursor);
    if (!loaded) fallbackReason = "thread-not-loaded";
  } catch (error) {
    fallbackReason = `daemon-unavailable: ${error.message}`;
  }
  try {
    if (fallbackReason) {
      if (tokenBudget !== undefined)
        throw new Error(
          `--budget requires a loaded Codex daemon thread; tmux fallback cannot set a budget (${fallbackReason})`,
        );
      return {
        ...(action === "status"
          ? await (deps.readGoal ?? readCodexGoal)(threadId)
          : {}),
        transport: action === "status" ? "sqlite" : "tmux",
        fallbackReason,
      };
    }
    const params = { threadId, origin: "user" };
    // 쓰기를 시도한 뒤의 오류는 폴백하지 않는다. 성공 여부가 불명확한 명령을 중복 전송할 수 있다.
    if (action !== "status") {
      const cleared = await client.request("thread/goal/clear", params, 10000);
      if (action === "clear")
        return {
          ...codexGoalStatus(null),
          ...cleared,
          confirmed: true,
          transport: "daemon",
        };
    }
    const result =
      action === "set"
        ? await client
            .request(
              "thread/goal/set",
              {
                ...params,
                objective,
                status: "active",
                ...(tokenBudget !== undefined ? { tokenBudget } : {}),
              },
              10000,
            )
            .catch((error) => {
              throw new Error(
                `${error.message}; clear was applied and there is currently no goal`,
              );
            })
        : await client.request("thread/goal/get", { threadId }, 10000);
    return {
      ...codexGoalStatus(result.goal),
      ...(action === "set" ? { confirmed: true } : {}),
      transport: "daemon",
    };
  } finally {
    client?.close();
  }
}

async function goal(action, flags) {
  if (!["set", "status", "clear"].includes(action))
    throw new Error("goal requires set, status, or clear");
  if (flags.remote !== undefined)
    throw new Error("goal does not support --remote");
  const session = splitTmuxTarget(requireFlag(flags, "session")).target;
  let cli = flags.cli;
  if (!cli) {
    for (const candidate of ["claude", "codex", "agy"]) {
      if (await paneCliProcess(session, candidate)) {
        cli = candidate;
        break;
      }
    }
    if (!cli)
      throw new Error("Cannot infer session CLI; specify --cli claude|codex");
  }
  if (cli === "agy") throw new Error("agy has no native goal");
  const adapter = selectAdapter({ ...flags, cli });
  if (flags.budget !== undefined && (cli !== "codex" || action !== "set"))
    throw new Error("--budget is supported only by goal set --cli codex");
  const tokenBudget = integerFlag(flags, "budget", undefined);
  if (tokenBudget !== undefined && !Number.isSafeInteger(tokenBudget))
    throw new Error("--budget must be a safe positive integer");
  const objective =
    action === "set"
      ? requireFlag(flags, "condition").replace(/\s+/gu, " ").trim()
      : null;
  if (
    action === "set" &&
    (!objective || /^(clear|pause|resume|edit)(?: |$)/i.test(objective))
  )
    throw new Error(
      "--condition must not be blank or start with a reserved command (clear, pause, resume, edit)",
    );
  const base = { cli, session };
  let codexResult;
  let threadId;
  if (cli === "codex") {
    ({ threadId } = await codexThreadFromFlags(flags));
    codexResult = await codexGoal(action, {
      threadId,
      objective,
      tokenBudget,
      codexSocket: flags["codex-socket"],
    });
    if (codexResult.transport !== "tmux") return { ...base, ...codexResult };
  }
  const transcriptPath =
    cli === "claude"
      ? await claudeTmuxTranscript(session, flags["config-dir"])
      : null;
  let snapshot =
    cli === "claude" ? await readClaudeTranscript(transcriptPath) : null;
  const unavailable = {
    state: null,
    objective: null,
    judgedBy: "evaluator",
    warning: "Claude transcript unavailable for this tmux pane",
  };
  if (action === "status")
    return {
      ...base,
      ...(snapshot?.goal ?? unavailable),
      transport: "tmux",
    };
  // 달성 뒤 자동 해제됐거나 없던 goal 은 /goal clear 가 기록을 남기지 않아 확인할 수 없다.
  if (action === "clear" && snapshot?.goal && snapshot.goal.state !== "active")
    return {
      ...base,
      ...snapshot.goal,
      transport: "tmux",
      confirmed: true,
      alreadyCleared: true,
    };
  const opts = askOpts(
    {
      ...flags,
      cli,
      "if-busy":
        flags["if-busy"] ?? (action === "clear" ? "interrupt" : "wait"),
      transport: "tmux",
      "no-wait": true,
      "no-relay-tag": true,
      prompt: `/goal ${action === "set" ? objective : "clear"}`,
    },
    adapter,
  );
  let interrupted = false;
  if (action === "clear" && opts.ifBusy === "interrupt") {
    const visible = await captureVisible(null, session);
    // Claude 반복 턴은 화면에 esc 안내가 없어도 active goal 을 계속 실행할 수 있다.
    if (
      snapshot?.goal?.state === "active" ||
      adapter.isBusy(visible) ||
      (cli === "codex" && isCodexLoadingCapture(visible))
    ) {
      await doInterruptViaTmux(adapter, opts);
      await sleep(opts.pollIntervalMs);
      interrupted = true;
    }
  }
  await waitForTmuxIdle(adapter, opts);
  // Esc 가 직전 입력을 복원해도 clear 명령 앞에 붙지 않게 비운다.
  if (interrupted)
    await runTmux(null, ["send-keys", "-t", exactTmuxTarget(session), "C-u"]);
  snapshot =
    cli === "claude" ? await readClaudeTranscript(transcriptPath) : null;
  const beforeCount = snapshot?.goalSentinel?.count ?? 0;
  const inputStartedAt = Date.now();
  await doAskViaTmux(adapter, {
    ...opts,
    ifBusy: "fail",
    skipContextGuard: true,
  });
  const deadline = Date.now() + Math.min(opts.timeoutMs, 15_000);
  let confirmed = false;
  if (cli === "codex") {
    do {
      snapshot = await readCodexGoal(threadId);
      confirmed =
        action === "set"
          ? snapshot.state === "active" &&
            snapshot.objective === objective &&
            Date.parse(snapshot.updatedAt) >= inputStartedAt
          : snapshot.state === "none";
      if (confirmed || snapshot.state === null || Date.now() >= deadline) break;
      await sleep(Math.min(opts.pollIntervalMs, deadline - Date.now()));
    } while (Date.now() < deadline);
    // 입력은 이미 들어갔으므로 오류로 끝내면 재전송을 부른다. 미확인으로만 알린다.
    return {
      ...base,
      ...codexResult,
      ...snapshot,
      inputSent: true,
      confirmed,
      ...(!confirmed && snapshot.state !== null
        ? { warning: "No matching Codex goal observed after input" }
        : {}),
    };
  }
  // 갓 띄운 세션은 첫 입력 뒤에야 자기 transcript 가 생기므로 매번 경로를 다시 찾는다.
  do {
    snapshot = await readClaudeTranscript(
      await claudeTmuxTranscript(session, flags["config-dir"]),
    );
    const sentinel = snapshot?.goalSentinel;
    confirmed =
      sentinel?.count > beforeCount &&
      Date.parse(sentinel.updatedAt) >= inputStartedAt &&
      (action === "set"
        ? sentinel.met === false && sentinel.condition === objective
        : sentinel.met === true);
    if (confirmed || Date.now() >= deadline) break;
    await sleep(Math.min(opts.pollIntervalMs, deadline - Date.now()));
  } while (Date.now() < deadline);
  return {
    ...base,
    ...(snapshot?.goal ?? unavailable),
    transport: "tmux",
    confirmed,
    ...(!confirmed
      ? { warning: "No new matching goal_status sentinel observed after input" }
      : {}),
  };
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
  if (adapter.cli === "agy") {
    if (flags.transport && flags.transport !== "tmux")
      throw new Error("agy list-sessions supports local --transport tmux only");
    return printJson(await discoverAgyTmuxSessions({ cwd: flags.cwd }));
  }
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
    group: flags.group,
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
  if (adapter.cli === "agy") throw new Error("agy is unavailable for converse");
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
  if (adapter.cli === "agy")
    throw new Error("agy is unavailable for goal-driven");
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
  if (!["counting", "freeform", "debate"].includes(mode)) {
    throw new Error("--mode must be one of: counting, freeform, debate");
  }
  return mode;
}

function peerPrompt(
  mode,
  hopIndex,
  previous,
  otherResponses = null,
  { self, seed, firstTurn } = {},
) {
  let prompt;
  if (mode === "debate") {
    // 안건은 첫 차례 참여자에게만 가므로 각자의 첫 차례에 원문을 다시 넣는다.
    prompt = [
      `너는 Participant ${String(self).toUpperCase()}다.`,
      ...(firstTurn ? [`원래 과제:\n${seed}`] : []),
      ...(otherResponses
        ? [
            otherResponses,
            "다른 참여자의 답을 검토하라. 동의하는 점, 동의하지 않는 점과 그 이유를 밝히고, 원래 과제가 요구한 형식으로 수정한 입장을 다시 내라.",
          ]
        : []),
    ].join("\n");
  } else if (mode === "counting") {
    if (hopIndex === 0) {
      prompt = "Reply with only the integer 1.";
    } else {
      prompt = `The current integer is ${previous}. Add 1 to it and reply with ONLY the resulting integer, nothing else.`;
      if (otherResponses) prompt = `${otherResponses}\n${prompt}`;
    }
  } else if (hopIndex === 0) {
    prompt = previous;
  } else {
    prompt = `${otherResponses ?? `The other party said: ${previous}`}\nReply briefly in 1-2 sentences and ask one short follow-up question.`;
  }

  return [
    prompt,
    `After you have completely finished your response, print a new line containing only this token: \`${PEER_HOP_DONE_MARKER}\`. Do not put any other characters on that line.`,
  ].join("\n");
}

function buildPeerClosurePrompt(previous, otherResponses = null) {
  return [
    "This is the final closure turn. Based on the discussion so far, declare whether a final agreement was reached.",
    "First reply with exactly one JSON object and no markdown fences:",
    '{"agreement_status":"complete|partial","unresolved_questions":[],"needs_more_rounds":false,"summary":"short final agreement"}',
    "Use agreement_status=complete only when no unresolved question remains and no more rounds are needed.",
    otherResponses ??
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

function peerArtifactPaths(sessionA, sessionB, sessionC = null) {
  const preferredDir =
    process.env.TFX_LIVE_ARTIFACT_DIR ??
    pathJoin(homedir(), ".claude", "cache", "triflux", "tfx-live", "peer-runs");
  let artifactDir = preferredDir;
  try {
    mkdirSync(artifactDir, { recursive: true });
  } catch {
    artifactDir = privateTmpDir("tfx-live");
  }
  const safe = (value) =>
    String(value)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .slice(0, 48);
  const runId = `peer-${safe(sessionA)}-${safe(sessionB)}${sessionC === null ? "" : `-${safe(sessionC)}`}-${Date.now()}-${process.pid}`;
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
        ...(output.cliC === undefined ? {} : { cliC: output.cliC }),
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
  // Codex 는 ask 와 같이 queue 가 기본이다. 원격, 바쁠 때 거부·중단, 표식 없는 응답 대기는 tmux 만 할 수 있다.
  const codexDefault =
    flags.remote ||
    Object.hasOwn(flags, "no-relay-tag") ||
    ["fail", "interrupt"].includes(sideFlag(flags, side, "if-busy"))
      ? "tmux"
      : "queue";
  const transport =
    explicit ??
    (adapter.cli === "claude"
      ? (globalTransport ?? defaultTransportFor(adapter, short, sessionId))
      : adapter.cli === "codex"
        ? codexDefault
        : undefined) ??
    "tmux";
  if (!VALID_TRANSPORTS.includes(transport)) {
    throw new Error(
      `--transport-${side} must be one of: ${VALID_TRANSPORTS.join(", ")}`,
    );
  }
  const supported =
    transport === "tmux" ||
    (adapter.cli === "claude" && transport !== "queue") ||
    (adapter.cli === "codex" && (transport === "uds" || transport === "queue"));
  if (!supported) {
    throw new Error(
      `--transport-${side} ${transport} is not supported for --cli-${side} ${adapter.cli}`,
    );
  }
  if (transport === "queue" && Object.hasOwn(flags, "no-relay-tag"))
    throw new Error(
      `--transport-${side} queue cannot wait with --no-relay-tag`,
    );
  return transport;
}

function peerSideBusyPolicy(flags, side, adapter, transport) {
  const allowed =
    adapter.cli === "codex" && transport === "uds"
      ? ["wait", "fail", "steer"]
      : transport === "queue"
        ? ["wait"]
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
  if (transport === "queue" && threadId && !isCodexThreadId(threadId))
    throw new Error(`--thread-${side} for queue must be a Codex session UUID`);
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
    group: flags.group,
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

// Codex queue 도 tmux pane 의 TUI 에 쌓이므로 tmux 와 같이 띄우고 확인한다.
function peerSideUsesTmuxPane(base) {
  return base.transport === "tmux" || base.transport === "queue";
}

async function verifyAttachedPeerSide(adapter, base, deps = {}) {
  if (!peerSideUsesTmuxPane(base)) return;
  const tmux = deps.runTmux ?? runTmux;
  const { session, target } = splitTmuxTarget(base.session);
  try {
    await tmux(base.remote, ["has-session", "-t", exactTmuxTarget(session)]);
  } catch {
    throw new Error(`attached ${adapter.cli} session not found: ${session}`);
  }
  if (adapter.cli === "codex") {
    const { stdout } = await tmux(base.remote, [
      "display-message",
      "-p",
      "-t",
      exactTmuxTarget(target),
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

// Claude 끼리는 SendMessage 로 직접 주고받게 한다. tfx-live 는 양쪽에 상대 이름과
// 끝낼 조건을 한 번 넣고 빠지므로 왕복 횟수와 기록은 두 세션이 맡는다.
async function peerViaMessage(flags, adapterA, adapterB) {
  if (adapterA.cli !== "claude" || adapterB.cli !== "claude")
    throw new Error("--via message requires --cli-a claude --cli-b claude");
  if (flags.remote)
    throw new Error("--via message supports local sessions only");
  const rounds = integerFlag(flags, "rounds", 4);
  const sides = [
    ["a", adapterA, "peerA"],
    ["b", adapterB, "peerB"],
  ].map(([side, adapter, fallback]) => {
    const session = flags[`session-${side}`] ?? fallback;
    const base = peerSideBaseOpts(flags, side, adapter, session);
    if (base.transport !== "tmux")
      throw new Error(
        `--via message needs a tmux Claude session (side ${side})`,
      );
    return {
      side,
      adapter,
      base,
      session,
      attached: Object.hasOwn(flags, `attach-${side}`),
    };
  });
  const [a, b] = sides;
  // 보고 받을 쪽은 SendMessage 가 닿는 Claude 세션이어야 한다.
  const reportTo =
    flags["report-to"] ??
    (process.env.CLAUDE_PID ? await resolveSenderName() : null);
  const finish = reportTo
    ? `send the final agreement to "${reportTo}" with SendMessage as`
    : "reply in this session with";
  const stopSpecs = [];
  const sent = [];
  try {
    for (const entry of sides) {
      if (entry.attached) {
        await verifyAttachedPeerSide(entry.adapter, entry.base);
      } else {
        await doStart(
          entry.adapter,
          startOptsForSession(flags, entry.session, entry.side),
        );
        addStopSpecOnce(stopSpecs, entry.adapter, entry.base);
      }
      // 같은 이름이 이미 있으면 Claude 가 이름 뒤에 번호를 붙이므로 pane 에 등록된 실제 이름을
      // 읽는다. 그 사이 활성 pane 이 바뀌어도 안내가 같은 pane 에 가도록 pane ID 로 보낸다.
      const target = await claudeTmuxTarget(entry.session);
      entry.name = target?.name ?? null;
      entry.paneId = target?.paneId;
      if (!entry.name)
        throw new Error(
          `Claude session name unknown (side ${entry.side}): ${entry.session}`,
        );
    }
    const kickoff = [
      [
        b,
        `You are in a direct conversation with the Claude session "${a.name}". It will message you with the SendMessage tool. Answer each of its messages with SendMessage to "${a.name}". No reply to this note is needed.`,
      ],
      [
        a,
        [
          flags.seed ?? PEER_DEFAULT_SEED,
          `Discuss this directly with the Claude session "${b.name}" using the SendMessage tool. Its replies arrive here as messages. Keep it to at most ${rounds} exchanges.`,
          `When you are done, ${finish} one JSON object: {"agreement_status":"complete|partial","unresolved_questions":[],"summary":"short final agreement"}`,
        ].join("\n"),
      ],
    ];
    for (const [entry, prompt] of kickoff) {
      const result = await doAsk(entry.adapter, {
        ...entry.base,
        session: entry.paneId,
        prompt,
        noWait: true,
      });
      if (result.inputSent !== true)
        throw new Error(
          result.error ??
            `kickoff not sent (side ${entry.side}): ${result.status}`,
        );
      sent.push({
        side: entry.side,
        requestId: result.requestId,
        status: result.status,
      });
    }
  } catch (error) {
    await stopAfterLifecycle(stopSpecs, error);
  }
  printJson({
    via: "message",
    status: "started",
    sessionA: a.session,
    sessionB: b.session,
    nameA: a.name,
    nameB: b.name,
    reportTo,
    kickoff: sent,
  });
}

async function peer(flags, deps = {}) {
  const startSession = deps.doStart ?? doStart;
  const askSession = deps.doAsk ?? doAsk;
  const verifyAttached = deps.verifyAttachedPeerSide ?? verifyAttachedPeerSide;
  const stopSessions = deps.stopAfterLifecycle ?? stopAfterLifecycle;
  const adapterA = selectAdapterName(flags["cli-a"] ?? "codex", "cli-a");
  const adapterB = selectAdapterName(flags["cli-b"] ?? "claude", "cli-b");
  const adapterC =
    flags["cli-c"] === undefined
      ? null
      : selectAdapterName(flags["cli-c"], "cli-c");
  if (
    flags.remote &&
    [adapterA, adapterB, adapterC].some((adapter) => adapter?.cli === "agy")
  )
    throw new Error("agy peer relay is local only; --remote is not supported");
  if (adapterC && flags.via === "message")
    throw new Error("--cli-c is only supported with --via relay");
  flags = {
    ...flags,
    group:
      flags.group ??
      `peer:${[
        flags["session-a"] ?? "peerA",
        flags["session-b"] ?? "peerB",
        ...(adapterC ? [flags["session-c"] ?? "peerC"] : []),
      ].join(":")}:${randomBytes(6).toString("hex")}`,
  };
  if (flags.via === "message") return peerViaMessage(flags, adapterA, adapterB);
  if (flags.via !== undefined && flags.via !== "relay")
    throw new Error("--via must be one of: relay, message");
  for (const [side, adapter] of [
    ["a", adapterA],
    ["b", adapterB],
    ...(adapterC ? [["c", adapterC]] : []),
  ]) {
    peerSideBusyPolicy(
      flags,
      side,
      adapter,
      peerSideTransport(flags, side, adapter),
    );
  }
  const sessionA = flags["session-a"] ?? "peerA";
  const sessionB = flags["session-b"] ?? "peerB";
  const baseA = peerSideBaseOpts(flags, "a", adapterA, sessionA);
  const baseB = peerSideBaseOpts(flags, "b", adapterB, sessionB);
  const sessionC = adapterC ? (flags["session-c"] ?? "peerC") : null;
  const baseC = adapterC
    ? peerSideBaseOpts(flags, "c", adapterC, sessionC)
    : null;
  const attachedA =
    Object.hasOwn(flags, "attach-a") || baseA.transport === "uds";
  const attachedB =
    Object.hasOwn(flags, "attach-b") || baseB.transport === "uds";
  const attachedC =
    adapterC && (Object.hasOwn(flags, "attach-c") || baseC.transport === "uds");
  const participants = [
    ["a", adapterA, baseA, attachedA],
    ["b", adapterB, baseB, attachedB],
    ...(adapterC ? [["c", adapterC, baseC, attachedC]] : []),
  ];
  const rounds = integerFlag(flags, "rounds", 4);
  const mode = peerMode(flags);
  const hops = [];
  const numbers = [];
  const stopSpecs = [];
  const artifactPaths = (deps.peerArtifactPaths ?? peerArtifactPaths)(
    sessionA,
    sessionB,
    sessionC,
  );
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
    ...(adapterC
      ? {
          cliC: adapterC.cli,
          transportC: baseC.transport,
          attachedC,
          stoppedC: false,
        }
      : {}),
    hops,
    transcript_path: artifactPaths.transcriptPath,
    status_path: artifactPaths.statusPath,
  };
  if (mode === "counting") {
    output.numbers = numbers;
  }
  let previous = mode !== "counting" ? (flags.seed ?? PEER_DEFAULT_SEED) : null;
  const latestResponses = new Map();
  let primaryError = null;
  let stopError = null;
  let closure = null;
  const stopPeerSessions = async () => {
    try {
      await stopSessions(stopSpecs);
    } finally {
      for (const [side, , base, attached] of participants) {
        output[`stopped${side.toUpperCase()}`] =
          !attached &&
          stopSpecs.some(
            (spec) => spec.opts.session === base.session && spec.stopped,
          );
      }
    }
  };
  const signalController = createPeerSignalController({
    output,
    persistTranscript: (value) => persistPeerTranscript(artifactPaths, value),
    persistStatus: (value) => persistPeerStatus(artifactPaths, value),
    stopSessions: stopPeerSessions,
    printOutput: deps.printJson ?? printJson,
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
    for (const [side, adapter, base, attached] of participants) {
      if (!attached) continue;
      const result = await verifyAttached(adapter, base);
      if (result?.preflightWarning) {
        output.preflightWarning ??= [];
        output.preflightWarning.push({
          side,
          message: result.preflightWarning,
        });
      }
    }
    for (const [side, adapter, base, attached] of participants) {
      if (attached || !peerSideUsesTmuxPane(base)) continue;
      await startSession(
        adapter,
        startOptsForSession(flags, base.session, side),
      );
      addStopSpecOnce(stopSpecs, adapter, base);
    }

    for (
      let hopIndex = 0;
      hopIndex < rounds * participants.length;
      hopIndex += 1
    ) {
      const [side, adapter, base, attached] =
        participants[hopIndex % participants.length];
      const otherResponses =
        adapterC || mode === "debate"
          ? participants
              .filter(([other]) => other !== side && latestResponses.has(other))
              .map(
                ([other]) =>
                  `Participant ${other.toUpperCase()}: ${latestResponses.get(other)}`,
              )
              .join("\n")
          : null;
      const isClosure = hopIndex === rounds * participants.length - 1;
      const debateTurn = {
        self: side,
        seed: flags.seed ?? PEER_DEFAULT_SEED,
        firstTurn: hopIndex < participants.length,
      };
      // rounds 1 이면 마지막 참여자의 첫 차례가 closure 이므로 여기서도 안건과 라벨을 넣는다.
      const debateHeader =
        mode === "debate"
          ? [
              `너는 Participant ${side.toUpperCase()}다.`,
              ...(debateTurn.firstTurn
                ? [`원래 과제:\n${debateTurn.seed}`]
                : []),
            ].join("\n")
          : null;
      const sent = isClosure
        ? [debateHeader, buildPeerClosurePrompt(previous, otherResponses)]
            .filter(Boolean)
            .join("\n")
        : peerPrompt(mode, hopIndex, previous, otherResponses, debateTurn);
      const result = await askSession(adapter, askOptsFromPeerBase(base, sent));
      // agy 는 tmux 전송이어도 DB 에서 답을 읽으므로 표식 줄을 뺀다.
      if (
        adapter.cli === "agy" ||
        (result.transportSelected ?? result.transport ?? base.transport) !==
          "tmux"
      ) {
        result.response = String(result.response ?? "")
          .split(/\r?\n/)
          .filter((line) => line.trim() !== PEER_HOP_DONE_MARKER)
          .join("\n")
          .trim();
      }
      if (result.tmuxStartedOnDemand && !attached) {
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
        from: side,
        cli: adapter.cli,
        transport: result.transport ?? base.transport,
        transportSelected: result.transportSelected,
        transportProbe: result.transportProbe,
        fallbackReason: result.fallbackReason,
        sent,
        response: result.response,
        done: result.done,
        aborted: result.aborted === true ? true : undefined,
        reason: result.reason,
      });
      latestResponses.set(side, result.response);
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
  (deps.printJson ?? printJson)(output);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const { command, flags, action } = parseCli(process.argv.slice(2));

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
    const result = await doCompact(flags);
    printJson(result);
    if (result.ok === false) process.exitCode = 1;
  } else if (command === "goal") {
    printJson(await goal(action, flags));
  } else if (command === "rename") {
    await rename(flags);
  } else if (command === "adopt") {
    await adopt(flags);
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
  } else if (command === "send") {
    await send(flags);
  } else {
    throw new Error(`Unknown subcommand: ${command}\n${usage()}`);
  }
}

export {
  ADAPTERS,
  agyStepText,
  agyWaitVerdict,
  appleScriptString,
  buildLaunchKeys,
  buildPeerClosurePrompt,
  buildRemoteLiveCommand,
  buildTmuxCommand,
  callRemoteLive,
  classifyPeerExitReason,
  closeItermSession,
  codexGoal,
  composerShowsPrompt,
  createPeerSignalController,
  derivePeerStatus,
  discoverAgyTmuxSessions,
  discoverClaudeTmuxSessions,
  discoverCodexTmuxSessions,
  discoverPeerTargets,
  doAdopt,
  doAskViaTmux,
  doCompact,
  doSend,
  doStop,
  extractAssistantResponse,
  extractClaudeCompletedTaskListResponse,
  extractResponseSinceMarker,
  formatPeerReply,
  formatPeerSendMessage,
  hasClaudeCompletedTaskListResponse,
  inspectCodexTmuxPane,
  inspectUnsetEnv,
  isCodexLoadingCapture,
  isSlashCommand,
  itermProject,
  matchPeerCandidates,
  openItermSession,
  paneCliProcess,
  parseCodexTmuxSessions,
  parsePeerClosure,
  parsePeerToSpec,
  parseRemoteLiveJson,
  peer,
  peerSideBaseOpts,
  resolveAskTransport,
  resolveCodexDaemonSocket,
  resolveCodexTmuxThread,
  resolvePeerSender,
  resumedCodexThread,
  sameMachineClaudeRedirect,
  send,
  shouldUseIterm,
  splitTmuxTarget,
  stopOpts,
  tmuxBufferName,
  verifyAttachedPeerSide,
  withLeadSession,
  withUnsetEnv,
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
