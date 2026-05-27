import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 5 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 150;
const MAX_CONSECUTIVE_POLL_ERRORS = 3;
const STARTUP_PROMPT_MAX_ATTEMPTS = 30;
const STARTUP_PROMPT_POLL_INTERVAL_MS = 300;

const CONTROL_SEQUENCES = [
  ["\x1b[A", "Up"],
  ["\x1b[B", "Down"],
  ["\x1b[C", "Right"],
  ["\x1b[D", "Left"],
  ["\x1b[3~", "DC"],
  ["\x1b[H", "Home"],
  ["\x1b[F", "End"],
];

const CONTROL_CHARS = new Map([
  ["\r", "Enter"],
  ["\n", "Enter"],
  ["\t", "Tab"],
  ["\x7f", "BSpace"],
  ["\b", "BSpace"],
  ["\x1b", "Escape"],
]);

export async function defaultRunTmux(args, options = {}) {
  return execFileAsync("tmux", args, {
    timeout: options.timeout ?? 15_000,
    maxBuffer: MAX_BUFFER,
  });
}

export function createInteractiveTuiTransport({
  runTmux = defaultRunTmux,
  sessionName,
  cwd = null,
  launchCmd = "codex",
  env = {},
  onData = () => {},
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  if (!sessionName || typeof sessionName !== "string") {
    throw new Error("sessionName is required");
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("pollIntervalMs must be a positive integer");
  }

  let started = false;
  let stopped = false;
  let pollTimer = null;
  let pollInFlight = false;
  let previousCapture = "";
  let consecutivePollErrors = 0;

  async function tmux(args, options) {
    return runTmux(args, options);
  }

  async function captureVisible() {
    const { stdout = "" } = await tmux([
      "capture-pane",
      "-t",
      sessionName,
      "-p",
    ]);
    return stdout;
  }

  async function capturePane() {
    const { stdout = "" } = await tmux([
      "capture-pane",
      "-e",
      "-t",
      sessionName,
      "-p",
    ]);
    return stdout;
  }

  async function start() {
    if (started) {
      return;
    }
    if (stopped) {
      throw new Error("transport has been stopped");
    }

    await tmux([
      "new-session",
      "-d",
      "-s",
      sessionName,
      ...(cwd ? ["-c", cwd] : []),
      ...buildTmuxEnvArgs(env),
    ]);
    await tmux(["send-keys", "-t", sessionName, String(launchCmd), "Enter"]);
    await dismissStartupPrompts({ tmux, captureVisible, sessionName });
    started = true;
    startPolling();
  }

  async function writeInput(bytesOrText) {
    const events = inputToTmuxEvents(bytesOrText);
    for (const event of events) {
      if (event.type === "text") {
        await tmux(["send-keys", "-t", sessionName, "-l", "--", event.text]);
      } else {
        await tmux(["send-keys", "-t", sessionName, event.key]);
      }
    }
  }

  async function resize({ cols, rows } = {}) {
    assertPositiveInteger("cols", cols);
    assertPositiveInteger("rows", rows);
    await tmux([
      "resize-window",
      "-t",
      sessionName,
      "-x",
      String(cols),
      "-y",
      String(rows),
    ]);
  }

  async function stop() {
    if (stopped) {
      return;
    }
    stopped = true;
    stopPolling();
    await tmux(["kill-session", "-t", sessionName]);
  }

  function startPolling() {
    // TODO: upgrade this transport to tmux pipe-pane once attach wiring needs
    // byte-level output fidelity. The first native-bridge shard intentionally
    // starts with capture-pane -e polling per the PRD.
    pollTimer = setInterval(() => {
      void pollOutput();
    }, pollIntervalMs);
    void pollOutput();
  }

  async function pollOutput() {
    if (stopped || pollInFlight) {
      return;
    }
    pollInFlight = true;
    try {
      const raw = await capturePane();
      consecutivePollErrors = 0;
      if (raw && raw !== previousCapture) {
        previousCapture = raw;
        onData(raw);
      } else if (!raw) {
        previousCapture = raw;
      }
    } catch {
      consecutivePollErrors += 1;
      if (consecutivePollErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
        stopPolling();
      }
    } finally {
      pollInFlight = false;
    }
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  return {
    start,
    writeInput,
    resize,
    stop,
  };
}

function buildTmuxEnvArgs(env) {
  return Object.entries(env)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`invalid tmux env key: ${key}`);
      }
      return ["-e", `${key}=${String(value)}`];
    });
}

function inputToTmuxEvents(bytesOrText) {
  const text =
    bytesOrText instanceof Uint8Array
      ? Buffer.from(bytesOrText).toString("utf8")
      : String(bytesOrText ?? "");
  const events = [];
  let literal = "";

  function flushLiteral() {
    if (literal) {
      events.push({ type: "text", text: literal });
      literal = "";
    }
  }

  for (let index = 0; index < text.length; ) {
    const sequence = CONTROL_SEQUENCES.find(([candidate]) =>
      text.startsWith(candidate, index),
    );
    if (sequence) {
      flushLiteral();
      events.push({ type: "key", key: sequence[1] });
      index += sequence[0].length;
      continue;
    }

    const char = text[index];
    const mapped = mapControlChar(char);
    if (mapped) {
      flushLiteral();
      events.push({ type: "key", key: mapped });
      index += 1;
      continue;
    }

    literal += char;
    index += 1;
  }

  flushLiteral();
  return events;
}

function mapControlChar(char) {
  const direct = CONTROL_CHARS.get(char);
  if (direct) {
    return direct;
  }

  const code = char.charCodeAt(0);
  if (code >= 1 && code <= 26) {
    return `C-${String.fromCharCode(96 + code)}`;
  }
  return null;
}

function assertPositiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function isUpdatePrompt(text) {
  return (
    /Update available/.test(text) &&
    /Update now/.test(text) &&
    /\bSkip\b/.test(text)
  );
}

function isCodexTrustPrompt(text) {
  return String(text).includes("Do you trust the contents of this directory");
}

function isCodexMainPrompt(text) {
  const raw = String(text);
  return /\/model to change/.test(raw) || /^\s*›\s*$/m.test(raw);
}

function selectedLine(text) {
  return (
    String(text)
      .split("\n")
      .find((line) => /^\s*[›❯▶▸]\s*/.test(line)) ?? ""
  );
}

function isUpdateNowLine(line) {
  return /Update now/.test(line);
}

function isSafeSkipLine(line) {
  return /\bSkip\b/.test(line) && !isUpdateNowLine(line);
}

async function dismissStartupPrompts({ tmux, captureVisible, sessionName }) {
  for (let attempt = 0; attempt < STARTUP_PROMPT_MAX_ATTEMPTS; attempt += 1) {
    const raw = await captureVisible();

    if (isUpdatePrompt(raw)) {
      await dismissCodexUpdatePromptStep({ tmux, raw, sessionName });
      await sleep(STARTUP_PROMPT_POLL_INTERVAL_MS);
      continue;
    }

    if (isCodexTrustPrompt(raw)) {
      await dismissCodexTrustPromptStep({ tmux, raw, sessionName });
      await sleep(STARTUP_PROMPT_POLL_INTERVAL_MS);
      continue;
    }

    if (isCodexMainPrompt(raw)) {
      return;
    }

    await sleep(STARTUP_PROMPT_POLL_INTERVAL_MS);
  }
}

async function dismissCodexUpdatePromptStep({ tmux, raw, sessionName }) {
  const selected = selectedLine(raw);
  if (isSafeSkipLine(selected)) {
    await tmux(["send-keys", "-t", sessionName, "Enter"]);
    return;
  }

  await tmux(["send-keys", "-t", sessionName, "Down"]);
}

async function dismissCodexTrustPromptStep({ tmux, raw, sessionName }) {
  const selected = selectedLine(raw);
  if (/Yes, continue/.test(selected) && !/No, quit/.test(selected)) {
    await tmux(["send-keys", "-t", sessionName, "Enter"]);
    return;
  }

  await tmux(["send-keys", "-t", sessionName, "Down"]);
}
