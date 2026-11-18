import { execFileSync, spawnSync } from "node:child_process";
import { resolveGitBashExecutable } from "@triflux/core/hub/lib/bash-path.mjs";
import { getEnvironment } from "@triflux/core/hub/lib/env-detect.mjs";
import {
  attachPsmuxSession,
  capturePsmuxPane,
  configurePsmuxKeybindings,
  createPsmuxSession,
  getMultiplexerType,
  getPsmuxSessionAttachedCount,
  hasMultiplexer,
  killPsmuxSession,
  listPsmuxSessions,
  psmuxExec,
  psmuxSessionExists,
  tokenizeCommand,
} from "./psmux.mjs";

export function hasWindowsTerminal() {
  return !!getEnvironment().terminal.hasWt;
}

export function hasWindowsTerminalSession() {
  return process.platform === "win32" && !!process.env.WT_SESSION;
}

function hasTmux() {
  try {
    execFileSync("tmux", ["-V"], {
      stdio: "ignore",
      timeout: 3000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function hasGitBashTmux() {
  const bash = resolveGitBashExecutable();
  if (!bash) return false;
  try {
    const r = spawnSync(bash, ["-lc", "tmux -V"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return (r.status ?? 1) === 0;
  } catch {
    return false;
  }
}

function isPsmuxCommandName(command) {
  const name = String(command || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .toLowerCase();
  return name === "psmux" || name === "psmux.exe" || name === "psmux.cmd";
}

// 프로세스 수명 동안 불변이므로 결과를 캐싱한다.
let _cachedMux;
export function detectMultiplexer() {
  if (_cachedMux !== undefined) return _cachedMux;

  if (process.platform !== "win32") {
    const primaryMux = getMultiplexerType();
    if (primaryMux === "tmux" && hasMultiplexer()) {
      _cachedMux = "tmux";
      return _cachedMux;
    }
    if (hasTmux()) {
      _cachedMux = "tmux";
      return _cachedMux;
    }
    _cachedMux = null;
    return _cachedMux;
  }

  if (hasMultiplexer() && isPsmuxCommandName(getMultiplexerType())) {
    _cachedMux = "psmux";
    return _cachedMux;
  }
  if (hasTmux()) {
    _cachedMux = "tmux";
    return _cachedMux;
  }
  if (hasGitBashTmux()) {
    _cachedMux = "git-bash-tmux";
    return _cachedMux;
  }
  _cachedMux = null;
  return _cachedMux;
}

function bashArg(value) {
  return /^[\w@%+=:,./-]+$/u.test(value)
    ? value
    : `'${value.replace(/'/g, "'\\''")}'`;
}

function tmux(args, opts = {}) {
  const mux = detectMultiplexer();
  if (!mux) {
    throw new Error(
      "tmux/psmux 미발견.\n\n" +
        "tfx multi은 tmux 계열 멀티플렉서가 필요합니다:\n" +
        "  Windows: psmux 설치\n" +
        "  macOS:  brew install tmux\n" +
        "  Linux:  apt install tmux",
    );
  }
  if (mux === "psmux") {
    return psmuxExec(args, opts);
  }
  // 셸을 거치지 않게 인자 배열로 넘긴다. 세션 이름이나 pane 대상이 셸 문법으로 읽히지 않는다.
  const argv = Array.isArray(args) ? args.map(String) : tokenizeCommand(args);
  if (mux === "git-bash-tmux") {
    const bash = resolveGitBashExecutable();
    if (!bash) throw new Error("git-bash-tmux 감지 실패");
    const r = spawnSync(
      bash,
      ["-lc", ["tmux", ...argv.map(bashArg)].join(" ")],
      {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        ...opts,
      },
    );
    if ((r.status ?? 1) !== 0) {
      const e = new Error(r.stderr || "tmux command failed");
      e.status = r.status;
      throw e;
    }
    return (r.stdout || "").trim();
  }

  const result = execFileSync("tmux", argv, {
    encoding: "utf8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...opts,
  });
  return result != null ? result.trim() : "";
}

export function tmuxExec(args, opts = {}) {
  return tmux(args, opts);
}

export function resolveAttachCommand(sessionName, opts = {}) {
  const mux = opts.mux || detectMultiplexer();
  if (!mux) {
    throw new Error("tmux/psmux 미발견");
  }

  if (mux === "psmux") {
    return {
      command: process.env.PSMUX_BIN || "psmux",
      args: ["attach-session", "-t", sessionName],
    };
  }

  if (mux === "git-bash-tmux") {
    const bash = opts.bashCommand || resolveGitBashExecutable();
    if (!bash) throw new Error("git-bash-tmux 감지 실패");
    return {
      command: bash,
      args: ["-lc", `tmux attach-session -t ${bashArg(sessionName)}`],
    };
  }

  return {
    command: "tmux",
    args: ["attach-session", "-t", sessionName],
  };
}

export function createSession(sessionName, opts = {}) {
  const { layout = "2x2", paneCount = 4 } = opts;
  const mux = detectMultiplexer();

  if (sessionExists(sessionName)) {
    killSession(sessionName);
  }

  if (mux === "psmux") {
    return createPsmuxSession(sessionName, { layout, paneCount });
  }

  tmux(["new-session", "-d", "-s", sessionName, "-x", "220", "-y", "55"]);

  const panes = [`${sessionName}:0.0`];

  if (layout === "2x2" && paneCount >= 3) {
    tmux(["split-window", "-h", "-t", `${sessionName}:0.0`]);
    tmux(["split-window", "-v", "-t", `${sessionName}:0.1`]);
    if (paneCount >= 4) {
      tmux(["split-window", "-v", "-t", `${sessionName}:0.0`]);
    }
    panes.length = 0;
    for (let i = 0; i < Math.min(paneCount, 4); i++) {
      panes.push(`${sessionName}:0.${i}`);
    }
  } else if (layout === "1xN") {
    for (let i = 1; i < paneCount; i++) {
      tmux(["split-window", "-h", "-t", `${sessionName}:0`]);
    }
    tmux(["select-layout", "-t", `${sessionName}:0`, "even-horizontal"]);
    panes.length = 0;
    for (let i = 0; i < paneCount; i++) {
      panes.push(`${sessionName}:0.${i}`);
    }
  } else {
    for (let i = 1; i < paneCount; i++) {
      tmux(["split-window", "-v", "-t", `${sessionName}:0`]);
    }
    tmux(["select-layout", "-t", `${sessionName}:0`, "even-vertical"]);
    panes.length = 0;
    for (let i = 0; i < paneCount; i++) {
      panes.push(`${sessionName}:0.${i}`);
    }
  }

  return { sessionName, panes };
}

export function focusPane(target, opts = {}) {
  const { zoom = false } = opts;
  tmux(["select-pane", "-t", target]);
  if (zoom) {
    try {
      tmux(["resize-pane", "-t", target, "-Z"]);
    } catch {}
  }
}

export function configureTeammateKeybindings(sessionName, opts = {}) {
  if (detectMultiplexer() === "psmux") {
    configurePsmuxKeybindings(sessionName, opts);
    return;
  }

  const { inProcess = false, taskListCommand = "" } = opts;
  const cond = `#{==:#{session_name},${sessionName}}`;

  // Shift+Up이 터미널/호스트 조합에 따라 전달되지 않는 경우가 있어
  // 좌/우/Shift+Tab 대체 키를 함께 바인딩한다.
  const bindNext = inProcess
    ? "select-pane -t :.+ \\; resize-pane -Z"
    : "select-pane -t :.+";
  const bindPrev = inProcess
    ? "select-pane -t :.- \\; resize-pane -Z"
    : "select-pane -t :.-";
  const bindIf = (key, onMatch, otherwise) =>
    tmux([
      "bind-key",
      "-T",
      "root",
      "-n",
      key,
      "if-shell",
      "-F",
      cond,
      onMatch,
      otherwise,
    ]);

  bindIf("S-Down", bindNext, "send-keys S-Down");
  bindIf("S-Up", bindPrev, "send-keys S-Up");

  // 대체 키: 일부 환경에서 S-Up이 누락될 때 사용
  bindIf("S-Right", bindNext, "send-keys S-Right");
  bindIf("S-Left", bindPrev, "send-keys S-Left");
  bindIf("BTab", bindPrev, "send-keys BTab");

  // 현재 활성 pane 인터럽트
  bindIf("Escape", "send-keys C-c", "send-keys Escape");

  // 태스크 목록 토글 (tmux 3.2+ popup 우선, 실패 시 안내 메시지)
  if (taskListCommand) {
    const escaped = taskListCommand.replace(/'/g, "'\\''");
    try {
      bindIf("C-t", `display-popup -E '${escaped}'`, "send-keys C-t");
    } catch {
      bindIf(
        "C-t",
        'display-message "tfx multi tasks 명령으로 태스크 확인"',
        "send-keys C-t",
      );
    }
  }
}

export function attachSession(sessionName) {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error("현재 터미널은 tmux attach를 지원하지 않음 (non-TTY)");
  }

  if (detectMultiplexer() === "psmux") {
    attachPsmuxSession(sessionName);
    return;
  }

  const { command, args } = resolveAttachCommand(sessionName);
  const r = spawnSync(command, args, {
    stdio: "inherit",
    timeout: 0, // 타임아웃 없음 (사용자가 detach할 때까지)
  });
  if ((r.status ?? 1) !== 0) {
    throw new Error(`tmux attach 실패 (exit=${r.status})`);
  }
}

// 호출 프로세스가 non-TTY여도 tmux split-window로 새 pty를 붙여 attach할 수 있다.
// env -u TMUX는 중첩 attach 보호 해제용이다.
export function buildSplitAttachArgs(sessionName, targetPane, tmuxEnv) {
  const normalizedSessionName = String(sessionName || "");
  if (!normalizedSessionName.trim()) {
    throw new Error("session name is required");
  }
  if (!/^%\d+$/u.test(String(targetPane || ""))) {
    throw new Error("requesting lead TMUX_PANE is required");
  }
  const socketPath = String(tmuxEnv || "").split(",", 1)[0];
  if (!socketPath.trim()) {
    throw new Error("requesting lead TMUX socket is required");
  }
  const quotedSocket = `'${socketPath.replace(/'/gu, "'\\''")}'`;
  const quotedSessionName = `'${normalizedSessionName.replace(/'/gu, "'\\''")}'`;
  return [
    "split-window",
    "-t",
    targetPane,
    "-v",
    "-l",
    "50%",
    `env -u TMUX tmux -S ${quotedSocket} attach -t ${quotedSessionName}`,
  ];
}

export function splitAttachToClient(sessionName, opts = {}) {
  const deps = opts._deps || {};
  const detectMux = deps.detectMultiplexer || detectMultiplexer;
  if (detectMux() !== "tmux") return false;

  let args;
  try {
    args = buildSplitAttachArgs(sessionName, opts.targetPane, opts.tmuxEnv);
  } catch {
    return false;
  }

  // 상하 분할: 좌우 분할은 절반 폭이 워커 pane 가독 하한(100cols) 미만인 경우가 흔함
  const spawn = deps.spawnSync || spawnSync;
  const split = spawn("tmux", args);
  return (split.status ?? 1) === 0;
}

export function sessionExists(sessionName) {
  if (detectMultiplexer() === "psmux") {
    return psmuxSessionExists(sessionName);
  }

  try {
    // '=' 가 없으면 tmux 가 접두사로 다른 세션을 잡는다(#548).
    tmux(["has-session", "-t", `=${sessionName}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function killSession(sessionName) {
  if (detectMultiplexer() === "psmux") {
    killPsmuxSession(sessionName);
    return;
  }

  try {
    tmux(["kill-session", "-t", `=${sessionName}`], { stdio: "ignore" });
  } catch {}
}

export function listSessions() {
  if (detectMultiplexer() === "psmux") {
    return listPsmuxSessions();
  }

  try {
    const output = tmux(["list-sessions", "-F", "#{session_name}"]);
    return output.split("\n").filter((s) => s.startsWith("tfx-multi-"));
  } catch {
    return [];
  }
}

export function getSessionAttachedCount(sessionName) {
  if (detectMultiplexer() === "psmux") {
    return getPsmuxSessionAttachedCount(sessionName);
  }

  try {
    const output = tmux([
      "list-sessions",
      "-F",
      "#{session_name} #{session_attached}",
    ]);
    const line = output
      .split("\n")
      .find((l) => l.startsWith(`${sessionName} `));
    if (!line) return null;
    const n = parseInt(line.split(" ")[1], 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function capturePaneOutput(target, lines = 5) {
  if (detectMultiplexer() === "psmux") {
    return capturePsmuxPane(target, lines);
  }

  try {
    // -l 플래그는 일부 tmux 빌드(MSYS2)에서 미지원이라 전체 캡처 후 JS에서 자른다.
    const full = tmux(["capture-pane", "-t", target, "-p"]);
    const nonEmpty = full.split("\n").filter((l) => l.trim() !== "");
    return nonEmpty.slice(-lines).join("\n");
  } catch {
    return "";
  }
}
