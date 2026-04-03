// hub/team/psmux.mjs — Windows psmux 세션/키바인딩/캡처/steering 관리
// 의존성: child_process, fs, os, path (Node.js 내장)만 사용
import childProcess from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const PSMUX_BIN = (() => {
  if (process.env.PSMUX_BIN) return process.env.PSMUX_BIN;
  // PATH에서 찾기
  try {
    childProcess.execFileSync("psmux", ["-V"], { stdio: "ignore", timeout: 2000, windowsHide: true });
    return "psmux";
  } catch { /* not in PATH */ }
  // Windows 기본 설치 경로 탐색
  if (process.platform === "win32") {
    const candidates = [
      join(process.env.LOCALAPPDATA || "", "psmux", "psmux.exe"),
      join(process.env.APPDATA || "", "npm", "psmux.cmd"),
      join(homedir(), "AppData", "Local", "psmux", "psmux.exe"),
      join(homedir(), "scoop", "shims", "psmux.exe"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
  }
  return "psmux"; // 최종 fallback — 원래대로
})();
const GIT_BASH = process.env.GIT_BASH_PATH || "C:\\Program Files\\Git\\bin\\bash.exe";
const IS_WINDOWS = process.platform === "win32";

/** Windows psmux 세션의 기본 셸을 PowerShell로 강제한다 (pwsh7 우선, ps5 fallback). */
const PWSH_BIN = (() => {
  if (!IS_WINDOWS) return "";
  if (process.env.PSMUX_SHELL) return process.env.PSMUX_SHELL;
  // pwsh 7 우선
  try {
    childProcess.execFileSync("pwsh", ["-NoLogo", "-NoProfile", "-Command", "exit 0"], { stdio: "ignore", timeout: 3000, windowsHide: true });
    return "pwsh";
  } catch { /* not found */ }
  // powershell 5 fallback
  try {
    childProcess.execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", "exit 0"], { stdio: "ignore", timeout: 3000, windowsHide: true });
    return "powershell.exe";
  } catch { /* not found */ }
  return ""; // 둘 다 없으면 psmux 기본 셸 사용
})();
const PSMUX_TIMEOUT_MS = 10000;
const COMPLETION_PREFIX = "__TRIFLUX_DONE__:";
const CAPTURE_ROOT = process.env.PSMUX_CAPTURE_ROOT || join(tmpdir(), "psmux-steering");
const CAPTURE_HELPER_PATH = join(CAPTURE_ROOT, "pipe-pane-capture.ps1");
const POLL_INTERVAL_MS = (() => {
  const ms = Number.parseInt(process.env.PSMUX_POLL_INTERVAL_MS || "", 10);
  if (Number.isFinite(ms) && ms > 0) return ms;
  const sec = Number.parseFloat(process.env.PSMUX_POLL_INTERVAL_SEC || "1");
  return Number.isFinite(sec) && sec > 0 ? Math.max(100, Math.trunc(sec * 1000)) : 1000;
})();

function quoteArg(value) {
  const str = String(value);
  if (!/[\s"]/u.test(str)) return str;
  return `"${str.replace(/"/g, '\\"')}"`;
}

function sanitizePathPart(value) {
  return String(value).replace(/[<>:"/\\|?*\u0000-\u001f']/gu, "_");
}

function toPaneTitle(index) {
  return index === 0 ? "lead" : `worker-${index}`;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

function sleepMsAsync(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function tokenizeCommand(command) {
  const source = String(command || "").trim();
  if (!source) return [];

  const tokens = [];
  let current = "";
  let quote = null;

  const pushCurrent = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (quote === '"') {
      if (char === '"') {
        quote = null;
        continue;
      }
      if (char === "\\" && (next === '"' || next === "\\")) {
        current += next;
        index += 1;
        continue;
      }
      current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "\\" && next && (/[\s"'\\;]/u.test(next))) {
      current += next;
      index += 1;
      continue;
    }

    if (/\s/u.test(char)) {
      pushCurrent();
      continue;
    }

    current += char;
  }

  if (quote) {
    throw new Error(`psmux 인자 파싱 실패: 닫히지 않은 인용부호 (${command})`);
  }

  pushCurrent();
  return tokens;
}

function normalizePsmuxArgs(args) {
  if (Array.isArray(args)) {
    return args.map((arg) => String(arg));
  }
  return tokenizeCommand(args);
}

function randomToken(prefix) {
  const base = sanitizePathPart(prefix).replace(/_+/g, "-") || "pane";
  const entropy = Math.random().toString(36).slice(2, 10);
  return `${base}-${Date.now()}-${entropy}`;
}

function ensurePsmuxInstalled() {
  if (!hasPsmux()) {
    throw new Error(
      "psmux가 설치되어 있지 않습니다.\n\n" +
      "psmux는 Codex/Gemini CLI를 병렬 세션으로 실행하는 터미널 멀티플렉서입니다.\n" +
      "설치 방법 (택 1):\n" +
      "  winget install marlocarlo.psmux\n" +
      "  scoop install psmux\n" +
      "  npm install -g psmux\n\n" +
      "설치 후 터미널을 재시작하세요."
    );
  }
}

function getCaptureSessionDir(sessionName) {
  return join(CAPTURE_ROOT, sanitizePathPart(sessionName));
}

function getCaptureLogPath(sessionName, paneName) {
  return join(getCaptureSessionDir(sessionName), `${sanitizePathPart(paneName)}.log`);
}

function ensureCaptureHelper() {
  mkdirSync(CAPTURE_ROOT, { recursive: true });
  writeFileSync(
    CAPTURE_HELPER_PATH,
    [
      "param(",
      "  [Parameter(Mandatory = $true)][string]$Path",
      ")",
      "",
      "$parent = Split-Path -Parent $Path",
      "if ($parent) {",
      "  New-Item -ItemType Directory -Force -Path $parent | Out-Null",
      "}",
      "",
      "$reader = [Console]::In",
      "while (($line = $reader.ReadLine()) -ne $null) {",
      "  Add-Content -LiteralPath $Path -Value $line -Encoding utf8",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  return CAPTURE_HELPER_PATH;
}

function readCaptureLog(logPath) {
  return existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
}

function parsePaneList(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [indexText, target] = line.split("\t");
      return {
        index: parseInt(indexText, 10),
        target: target?.trim() || "",
      };
    })
    .filter((entry) => Number.isFinite(entry.index) && entry.target)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.target);
}

function parseSessionSummaries(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const colonIndex = line.indexOf(":");
      if (colonIndex === -1) {
        return null;
      }

      const sessionName = line.slice(0, colonIndex).trim();
      const flags = [...line.matchAll(/\(([^)]*)\)/g)].map((match) => match[1]).join(", ");
      const attachedMatch = flags.match(/(\d+)\s+attached/);
      const attachedCount = attachedMatch
        ? parseInt(attachedMatch[1], 10)
        : /\battached\b/.test(flags)
          ? 1
          : 0;

      return sessionName
        ? { sessionName, attachedCount }
        : null;
    })
    .filter(Boolean);
}

function parsePaneDetails(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const hasPaneIndex = parts.length >= 5;
      const [paneIndexText = "", title = "", paneId = "", dead = "0", deadStatus = ""] = hasPaneIndex
        ? parts
        : ["", ...parts];
      const exitCode = dead === "1"
        ? Number.parseInt(deadStatus, 10)
        : null;
      const paneIndex = Number.parseInt(paneIndexText, 10);
      return {
        title,
        paneId,
        paneIndex: Number.isFinite(paneIndex) ? paneIndex : null,
        isDead: dead === "1",
        exitCode: Number.isFinite(exitCode) ? exitCode : dead === "1" ? 0 : null,
      };
    })
    .filter((entry) => entry.paneId);
}

function collectSessionPanes(sessionName) {
  const output = psmuxExec([
    "list-panes",
    "-t",
    `${sessionName}:0`,
    "-F",
    "#{pane_index}\t#{session_name}:#{window_index}.#{pane_index}",
  ]);
  return parsePaneList(output);
}

function listPaneDetails(sessionName) {
  const output = psmuxExec([
    "list-panes",
    "-t",
    sessionName,
    "-F",
    "#{pane_index}\t#{pane_title}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_dead}\t#{pane_dead_status}",
  ]);
  return parsePaneDetails(output);
}

function paneTitleToIndex(name) {
  const lower = String(name).toLowerCase();
  if (lower === "lead") return 0;
  const m = /^worker-(\d+)$/.exec(lower);
  if (!m) return -1;
  const idx = parseInt(m[1], 10);
  // worker-0은 유효하지 않음 (lead와 충돌, toPaneTitle은 worker-0을 생성하지 않음)
  return idx >= 1 ? idx : -1;
}

function resolvePane(sessionName, paneNameOrTarget) {
  const wanted = String(paneNameOrTarget);
  const panes = listPaneDetails(sessionName);

  // 1차: title 또는 paneId 직접 매칭
  const direct = panes.find((entry) => entry.title === wanted || entry.paneId === wanted);
  if (direct) return direct;

  // 2차: psmux title 미설정 fallback — "lead"→0, "worker-N"→N 인덱스 매칭
  const idx = paneTitleToIndex(wanted);
  if (idx >= 0 && idx < panes.length) return panes[idx];

  throw new Error(`Pane을 찾을 수 없습니다: ${paneNameOrTarget}`);
}

function refreshCaptureSnapshot(sessionName, paneNameOrTarget) {
  const pane = resolvePane(sessionName, paneNameOrTarget);
  const paneName = pane.title || paneNameOrTarget;
  const logPath = getCaptureLogPath(sessionName, paneName);
  mkdirSync(getCaptureSessionDir(sessionName), { recursive: true });
  const snapshot = psmuxExec(["capture-pane", "-t", pane.paneId, "-p", "-S", "-"]);
  writeFileSync(logPath, snapshot, "utf8");
  return { paneId: pane.paneId, paneName, logPath, snapshot };
}

function disablePipeCapture(paneId) {
  try {
    psmuxExec(["pipe-pane", "-t", paneId]);
  } catch {
    // 기존 pipe가 없으면 무시
  }
}

function sendLiteralToPane(paneId, text, submit = true) {
  psmuxExec(["send-keys", "-t", paneId, "-l", text]);
  if (submit) {
    psmuxExec(["send-keys", "-t", paneId, "Enter"]);
  }
}

export function sendKeysToPane(paneId, text, submit = true) {
  psmuxExec(["send-keys", "-t", paneId, "-l", text]);
  if (submit) {
    psmuxExec(["send-keys", "-t", paneId, "Enter"]);
  }
}

function toPatternRegExp(pattern) {
  if (pattern instanceof RegExp) {
    const flags = pattern.flags.includes("m") ? pattern.flags : `${pattern.flags}m`;
    return new RegExp(pattern.source, flags);
  }
  return new RegExp(String(pattern), "m");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function psmux(args, opts = {}) {
  const normalizedArgs = normalizePsmuxArgs(args);
  // PSMUX_SESSION 제거 — 기존 psmux 세션 내에서 호출 시 중첩 세션 차단 방지
  const { PSMUX_SESSION: _, ...cleanEnv } = process.env;
  try {
    const result = childProcess.execFileSync(PSMUX_BIN, normalizedArgs, {
      encoding: "utf8",
      timeout: PSMUX_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: cleanEnv,
      ...opts,
    });
    return result != null ? String(result).trim() : "";
  } catch (error) {
    const stderr = typeof error?.stderr === "string"
      ? error.stderr
      : error?.stderr?.toString?.("utf8") || "";
    const stdout = typeof error?.stdout === "string"
      ? error.stdout
      : error?.stdout?.toString?.("utf8") || "";
    const wrapped = new Error((stderr || stdout || error.message || "psmux command failed").trim());
    wrapped.status = error.status;
    throw wrapped;
  }
}

/** psmux 실행 가능 여부 확인 */
export function hasPsmux() {
  try {
    childProcess.execFileSync(PSMUX_BIN, ["-V"], {
      stdio: "ignore",
      timeout: 3000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * psmux 커맨드 실행 래퍼
 * @param {string|string[]} args
 * @param {object} opts
 * @returns {string}
 */
export function psmuxExec(args, opts = {}) {
  return psmux(args, opts);
}

/**
 * psmux 세션 생성 + 레이아웃 분할
 * @param {string} sessionName
 * @param {object} opts
 * @param {'2x2'|'1xN'|'Nx1'} opts.layout
 * @param {number} opts.paneCount
 * @returns {{ sessionName: string, panes: string[] }}
 */
export function createPsmuxSession(sessionName, opts = {}) {
  const layout = opts.layout === "1xN" || opts.layout === "Nx1" ? opts.layout : "2x2";
  const paneCount = Math.max(
    1,
    Number.isFinite(opts.paneCount) ? Math.trunc(opts.paneCount) : 4,
  );
  const limitedPaneCount = layout === "2x2" ? Math.min(paneCount, 4) : paneCount;
  const sessionTarget = `${sessionName}:0`;

  const newSessionArgs = [
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{session_name}:#{window_index}.#{pane_index}",
    "-s",
    sessionName,
    "-x",
    "220",
    "-y",
    "55",
  ];
  // Windows: psmux 기본 셸이 cmd.exe일 수 있으므로 PowerShell 강제
  if (PWSH_BIN) newSessionArgs.push(PWSH_BIN, "-NoLogo", "-NoProfile");
  const leadPane = psmuxExec(newSessionArgs);

  // split-window로 생성되는 pane도 동일 셸 사용
  if (PWSH_BIN) {
    try { psmuxExec(["set-option", "-t", sessionName, "default-command", `${PWSH_BIN} -NoLogo -NoProfile`]); } catch { /* 미지원 시 무시 */ }
  }

  if (layout === "2x2" && limitedPaneCount >= 3) {
    const rightPane = psmuxExec([
      "split-window",
      "-h",
      "-P",
      "-F",
      "#{session_name}:#{window_index}.#{pane_index}",
      "-t",
      leadPane,
    ]);
    psmuxExec([
      "split-window",
      "-v",
      "-P",
      "-F",
      "#{session_name}:#{window_index}.#{pane_index}",
      "-t",
      rightPane,
    ]);
    if (limitedPaneCount >= 4) {
      psmuxExec([
        "split-window",
        "-v",
        "-P",
        "-F",
        "#{session_name}:#{window_index}.#{pane_index}",
        "-t",
        leadPane,
      ]);
    }
    psmuxExec(["select-layout", "-t", sessionTarget, "tiled"]);
  } else if (layout === "1xN") {
    for (let index = 1; index < limitedPaneCount; index += 1) {
      psmuxExec(["split-window", "-h", "-t", sessionTarget]);
    }
    psmuxExec(["select-layout", "-t", sessionTarget, "even-horizontal"]);
  } else {
    for (let index = 1; index < limitedPaneCount; index += 1) {
      psmuxExec(["split-window", "-v", "-t", sessionTarget]);
    }
    psmuxExec(["select-layout", "-t", sessionTarget, "even-vertical"]);
  }

  psmuxExec(["select-pane", "-t", leadPane]);

  const panes = collectSessionPanes(sessionName).slice(0, limitedPaneCount);
  panes.forEach((pane, index) => {
    psmuxExec(["select-pane", "-t", pane, "-T", toPaneTitle(index)]);
  });

  return { sessionName, panes };
}

/**
 * psmux 세션의 모든 pane PID를 수집
 * @param {string} sessionName
 * @returns {number[]}
 */
function collectPanePids(sessionName) {
  try {
    const output = psmuxExec([
      "list-panes", "-t", sessionName, "-F", "#{pane_pid}",
    ]);
    return output
      .split(/\r?\n/)
      .map((l) => Number.parseInt(l.trim(), 10))
      .filter((pid) => Number.isFinite(pid) && pid > 0);
  } catch {
    return [];
  }
}

/**
 * Windows 프로세스 트리 강제 종료 (taskkill /T /F)
 * @param {number} pid
 */
function killProcessTree(pid) {
  if (!IS_WINDOWS || !pid) return;
  try {
    childProcess.execSync(`taskkill /T /F /PID ${pid}`, {
      stdio: "ignore",
      timeout: 5000,
    });
  } catch {
    // 이미 종료된 프로세스 — 무시
  }
}

/**
 * 세션의 모든 pane에서 pipe-pane 캡처를 해제한다.
 * pipe-pane을 인자 없이 호출하면 psmux가 reader 프로세스에 EOF를 보내 정상 종료시킨다.
 * @param {string} sessionName
 * @param {string[]} paneIds — collectSessionPanes() 결과
 */
function disableAllPipeCaptures(sessionName, paneIds) {
  for (const paneId of paneIds) {
    try {
      psmuxExec(["pipe-pane", "-t", paneId]);
    } catch {
      // pane이 이미 죽었거나 pipe가 없으면 무시
    }
  }
}

/**
 * 세션과 관련된 고아 pipe-pane 헬퍼 프로세스를 찾아 종료한다.
 * pipe-pane disable 후에도 reader가 종료되지 않는 경우의 안전망.
 * @param {string} sessionName
 */
function killOrphanPipeHelpers(sessionName) {
  if (!IS_WINDOWS) return;
  const safeSession = sanitizePathPart(sessionName);
  try {
    const output = childProcess.execSync(
      `powershell -NoProfile -WindowStyle Hidden -Command "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'pipe-pane-capture' -and $_.CommandLine -match 'tfx-headless[/\\\\]${safeSession}' } | Select-Object -ExpandProperty ProcessId"`,
      { encoding: "utf8", timeout: 8000, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    const pids = output.split(/\r?\n/).map((l) => Number.parseInt(l.trim(), 10)).filter((p) => Number.isFinite(p) && p > 0);
    for (const pid of pids) {
      killProcessTree(pid);
    }
  } catch {
    // WMI 조회 실패 — 무시
  }
}

/**
 * 세션이 spawn한 CLI(codex/gemini)의 고아 MCP 서버 프로세스를 찾아 종료한다.
 * headless 워커가 codex/gemini를 실행하면 MCP 서버(node.exe)가 자식으로 생성되는데,
 * 부모가 죽어도 Windows에서는 자식이 자동 종료되지 않아 고아가 된다.
 * @param {string} sessionName
 */
function killOrphanMcpProcesses(sessionName) {
  if (!IS_WINDOWS) return;
  const safeSession = sanitizePathPart(sessionName);

  // Hub PID 보호 — Hub 프로세스를 고아로 잘못 식별하지 않도록
  let hubPid = null;
  try {
    const hubPidPath = join(homedir(), ".claude", "cache", "tfx-hub", "hub.pid");
    if (existsSync(hubPidPath)) {
      const hubInfo = JSON.parse(readFileSync(hubPidPath, "utf8"));
      hubPid = Number(hubInfo?.pid);
    }
  } catch {}

  try {
    // 세션 결과 디렉토리 패턴으로 MCP 서버 프로세스 식별
    const output = childProcess.execSync(
      `powershell -NoProfile -WindowStyle Hidden -Command "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'tfx-headless[/\\\\]${safeSession}' } | Select-Object -ExpandProperty ProcessId"`,
      { encoding: "utf8", timeout: 8000, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    const pids = output.split(/\r?\n/).map((l) => Number.parseInt(l.trim(), 10)).filter((p) => Number.isFinite(p) && p > 0 && p !== hubPid);
    for (const pid of pids) {
      killProcessTree(pid);
    }
  } catch {
    // WMI 조회 실패 — 무시
  }
}

function detachAttachedClients(sessionName, waitMs = 750) {
  const attachedCount = getPsmuxSessionAttachedCount(sessionName);
  if (!Number.isFinite(attachedCount) || attachedCount <= 0) return false;
  try {
    psmuxExec(["detach-client", "-t", sessionName], { stdio: "ignore" });
    sleepMs(waitMs);
    return true;
  } catch {
    return false;
  }
}

function findFallbackPane(sessionName, excludedPaneId) {
  try {
    const panes = listPaneDetails(sessionName)
      .filter((pane) => pane.paneId !== excludedPaneId && !pane.isDead);
    if (panes.length === 0) return null;
    return panes.find((pane) => pane.title === "lead")
      || panes.find((pane) => pane.paneIndex === 0)
      || panes[0];
  } catch {
    return null;
  }
}

/**
 * psmux 세션 종료
 * 순서: pipe-pane 해제 → pane 프로세스 트리 정리 → 세션 종료 → 고아 정리
 * @param {string} sessionName
 */
export function killPsmuxSession(sessionName) {
  // attach된 WT/ConPTY 클라이언트가 있으면 먼저 안전하게 분리한다.
  detachAttachedClients(sessionName);

  // 1. pipe-pane 캡처 해제 — reader 프로세스에 EOF 전송하여 정상 종료 유도
  let paneIds = [];
  try {
    paneIds = collectSessionPanes(sessionName);
  } catch {
    // 세션이 이미 죽었으면 pane 목록 수집 불가 — 계속 진행
  }
  disableAllPipeCaptures(sessionName, paneIds);

  // pipe-pane reader가 EOF를 처리하고 정상 종료할 시간 확보
  sleepMs(500);

  // 2. pane 프로세스 트리 강제 종료 (MCP 서버 포함)
  const pids = collectPanePids(sessionName);
  for (const pid of pids) {
    killProcessTree(pid);
  }

  // 3. psmux 세션 자체 종료
  try {
    psmuxExec(["kill-session", "-t", sessionName], { stdio: "ignore" });
  } catch {
    // 이미 종료된 세션 — 무시
  }

  // 4. 고아 프로세스 정리 (pipe-pane 헬퍼 + MCP 서버)
  killOrphanPipeHelpers(sessionName);
  killOrphanMcpProcesses(sessionName);
}

/**
 * psmux 세션 존재 확인
 * @param {string} sessionName
 * @returns {boolean}
 */
export function psmuxSessionExists(sessionName) {
  try {
    psmuxExec(["has-session", "-t", sessionName], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * tfx-multi- 접두사 psmux 세션 목록
 * @returns {string[]}
 */
export function listPsmuxSessions() {
  try {
    return parseSessionSummaries(psmuxExec(["list-sessions"]))
      .map((session) => session.sessionName)
      .filter((sessionName) => sessionName.startsWith("tfx-multi-"));
  } catch {
    return [];
  }
}

/**
 * pane 마지막 N줄 캡처
 * @param {string} target
 * @param {number} lines
 * @returns {string}
 */
export function capturePsmuxPane(target, lines = 5) {
  try {
    const full = psmuxExec(["capture-pane", "-t", target, "-p", "-S", "-"]);
    const nonEmpty = full.split("\n").filter((line) => line.trim() !== "");
    return nonEmpty.slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/**
 * psmux 세션 연결
 * @param {string} sessionName
 */
export function attachPsmuxSession(sessionName) {
  const result = childProcess.spawnSync(PSMUX_BIN, ["attach-session", "-t", sessionName], {
    stdio: "inherit",
    timeout: 0,
    windowsHide: false,
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`psmux attach 실패 (exit=${result.status})`);
  }
}

/**
 * 세션 attach client 수 조회
 * @param {string} sessionName
 * @returns {number|null}
 */
export function getPsmuxSessionAttachedCount(sessionName) {
  try {
    const session = parseSessionSummaries(psmuxExec(["list-sessions"]))
      .find((entry) => entry.sessionName === sessionName);
    return session ? session.attachedCount : null;
  } catch {
    return null;
  }
}

/**
 * 팀메이트 조작 키 바인딩 설정
 * @param {string} sessionName
 * @param {object} opts
 * @param {boolean} opts.inProcess
 * @param {string} opts.taskListCommand
 */
export function configurePsmuxKeybindings(sessionName, opts = {}) {
  const { inProcess = false, taskListCommand = "" } = opts;
  const cond = `#{==:#{session_name},${sessionName}}`;
  const target = `${sessionName}:0`;
  const bindNext = inProcess
    ? "select-pane -t :.+ \\; resize-pane -Z"
    : "select-pane -t :.+";
  const bindPrev = inProcess
    ? "select-pane -t :.- \\; resize-pane -Z"
    : "select-pane -t :.-";

  // psmux는 세션별 서버이므로 -t target으로 세션 컨텍스트를 전달해야 한다.
  const bindSafe = (args) => {
    try {
      psmuxExec(["-t", target, ...args]);
    } catch {
      // 미지원 시 무시
    }
  };

  bindSafe(["bind-key", "-T", "root", "-n", "S-Down", "if-shell", "-F", cond, bindNext, "send-keys S-Down"]);
  bindSafe(["bind-key", "-T", "root", "-n", "S-Up", "if-shell", "-F", cond, bindPrev, "send-keys S-Up"]);
  bindSafe(["bind-key", "-T", "root", "-n", "S-Right", "if-shell", "-F", cond, bindNext, "send-keys S-Right"]);
  bindSafe(["bind-key", "-T", "root", "-n", "S-Left", "if-shell", "-F", cond, bindPrev, "send-keys S-Left"]);
  bindSafe(["bind-key", "-T", "root", "-n", "BTab", "if-shell", "-F", cond, bindPrev, "send-keys BTab"]);
  bindSafe(["bind-key", "-T", "root", "-n", "Escape", "if-shell", "-F", cond, "send-keys C-c", "send-keys Escape"]);

  if (taskListCommand) {
    bindSafe([
      "bind-key",
      "-T",
      "root",
      "-n",
      "C-t",
      "if-shell",
      "-F",
      cond,
      `display-popup -E ${quoteArg(taskListCommand)}`,
      "send-keys C-t",
    ]);
  }
}

// ─── steering 기능 ───

/**
 * pane 출력 pipe-pane 캡처를 시작하고 즉시 snapshot을 기록한다.
 * @param {string} sessionName
 * @param {string} paneNameOrTarget
 * @returns {{ paneId: string, paneName: string, logPath: string }}
 */
export function startCapture(sessionName, paneNameOrTarget) {
  ensurePsmuxInstalled();
  const pane = resolvePane(sessionName, paneNameOrTarget);
  const paneName = pane.title || paneNameOrTarget;
  const logPath = getCaptureLogPath(sessionName, paneName);
  const helperPath = ensureCaptureHelper();
  mkdirSync(getCaptureSessionDir(sessionName), { recursive: true });
  writeFileSync(logPath, "", "utf8");

  disablePipeCapture(pane.paneId);
  psmuxExec([
    "pipe-pane",
    "-t",
    pane.paneId,
    `powershell.exe -NoLogo -NoProfile -File ${quoteArg(helperPath)} ${quoteArg(logPath)}`,
  ]);

  refreshCaptureSnapshot(sessionName, pane.paneId);
  return { paneId: pane.paneId, paneName, logPath };
}

/**
 * PowerShell 명령을 pane에 비동기 전송하고 완료 토큰을 반환한다.
 * @param {string} sessionName
 * @param {string} paneNameOrTarget
 * @param {string} commandText
 * @returns {{ paneId: string, paneName: string, token: string, logPath: string }}
 */
/**
 * CLI 명령(codex/gemini)이 psmux pane의 PowerShell 환경에서 단축 플래그 충돌을
 * 일으키는 문제를 방지하기 위해 bash -c '...' 로 감싼다.
 * - codex -o flag → PS -OutVariable/OutBuffer 충돌
 * - gemini --prompt flag (v8.6.0: -p → --prompt, PS 충돌 해소)
 * @param {string} cmd
 * @returns {string}
 */
function wrapCliForBash(cmd) {
  const trimmed = cmd.trimStart();
  // PowerShell 구문(Clear-Host, Get-Content 등) 또는 completion token이 포함되면 PowerShell 직통
  if (/Clear-Host|Get-Content|__TRIFLUX_DONE__/i.test(trimmed)) return cmd;
  const isCli = /\b(codex|gemini)\b/u.test(trimmed);
  if (!isCli) return cmd;
  // 단일 따옴표 이스케이프: ' → '\''
  const escaped = trimmed.replace(/'/g, "'\\''");
  return `bash -c '${escaped}'`;
}

export function dispatchCommand(sessionName, paneNameOrTarget, commandText) {
  ensurePsmuxInstalled();
  const pane = resolvePane(sessionName, paneNameOrTarget);
  const paneName = pane.title || paneNameOrTarget;
  const logPath = getCaptureLogPath(sessionName, paneName);

  if (!existsSync(logPath)) {
    startCapture(sessionName, paneName);
  }

  const token = randomToken(paneName);
  const safeCommand = wrapCliForBash(commandText);
  const wrapped = `try { ${safeCommand} } finally { $trifluxExit = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }; Write-Output "${COMPLETION_PREFIX}${token}:$trifluxExit" }`;

  sendLiteralToPane(pane.paneId, wrapped, true);

  return { paneId: pane.paneId, paneName, token, logPath };
}

/**
 * pane 캡처 로그에서 정규식 패턴을 polling으로 대기한다.
 * @param {string} sessionName
 * @param {string} paneNameOrTarget
 * @param {string|RegExp} pattern
 * @param {number} timeoutSec
 * @param {object} [opts]
 * @param {(snapshot: {content: string, paneId: string, paneName: string, elapsed: number}) => void} [opts.onPoll] — 각 폴링 주기마다 호출
 * @param {AbortSignal} [opts.signal] — 외부에서 폴링 중단 요청 시 사용
 * @returns {{ matched: boolean, paneId: string, paneName: string, logPath: string, match: string|null, aborted?: boolean }}
 */
export async function waitForPattern(sessionName, paneNameOrTarget, pattern, timeoutSec = 300, opts = {}) {
  ensurePsmuxInstalled();

  // E4 크래시 복구: 초기 resolvePane도 세션 사망을 감지
  let pane;
  try {
    pane = resolvePane(sessionName, paneNameOrTarget);
  } catch (resolveError) {
    if (!psmuxSessionExists(sessionName)) {
      return {
        matched: false,
        paneId: "",
        paneName: String(paneNameOrTarget),
        logPath: "",
        match: null,
        sessionDead: true,
      };
    }
    throw resolveError; // 세션은 살아있지만 pane을 못 찾음 → 원래 에러 전파
  }

  const paneName = pane.title || paneNameOrTarget;
  // opts.logPath: dispatch 시 확정된 캡처 로그 경로 직접 지정 (타이틀 변경 내성)
  const logPath = (opts.logPath && existsSync(opts.logPath))
    ? opts.logPath
    : getCaptureLogPath(sessionName, paneName);
  if (!existsSync(logPath)) {
    throw new Error(`캡처 로그가 없습니다. 먼저 startCapture(${sessionName}, ${paneName})를 호출하세요.`);
  }

  const startTime = Date.now();
  const deadline = startTime + Math.max(0, Math.trunc(timeoutSec * 1000));
  const regex = toPatternRegExp(pattern);

  if (opts?.signal?.aborted) {
    return { matched: false, paneId: pane.paneId, paneName, logPath, match: null, aborted: true };
  }

  while (Date.now() <= deadline) {
    if (opts?.signal?.aborted) {
      return { matched: false, paneId: pane.paneId, paneName, logPath, match: null, aborted: true };
    }
    // E4 크래시 복구: capture 실패 시 세션 생존 체크
    try {
      if (opts.logPath) {
        // logPath 직접 지정 시 — 셸 타이틀 변경과 무관하게 올바른 파일에 기록
        const snapshot = psmuxExec(["capture-pane", "-t", pane.paneId, "-p", "-S", "-"]);
        writeFileSync(logPath, snapshot, "utf8");
      } else {
        refreshCaptureSnapshot(sessionName, pane.paneId);
      }
    } catch {
      if (!psmuxSessionExists(sessionName)) {
        return {
          matched: false,
          paneId: pane.paneId,
          paneName,
          logPath,
          match: null,
          sessionDead: true,
        };
      }
      // 일시적 오류 — 다음 폴링에서 재시도
    }

    const content = readCaptureLog(logPath);

    // onPoll 콜백 — 각 폴링 주기마다 중간 상태 전달
    if (opts.onPoll) {
      try {
        opts.onPoll({ content, paneId: pane.paneId, paneName, elapsed: Date.now() - startTime });
      } catch { /* 콜백 예외는 삼킴 — 폴링 루프 보호 */ }
    }

    const match = regex.exec(content);
    if (match) {
      return {
        matched: true,
        paneId: pane.paneId,
        paneName,
        logPath,
        match: match[0],
      };
    }

    if (Date.now() > deadline) {
      break;
    }
    await sleepMsAsync(POLL_INTERVAL_MS);
    if (opts?.signal?.aborted) {
      return { matched: false, paneId: pane.paneId, paneName, logPath, match: null, aborted: true };
    }
  }

  return {
    matched: false,
    paneId: pane.paneId,
    paneName,
    logPath,
    match: null,
  };
}

/**
 * 완료 토큰이 찍힐 때까지 대기하고 exit code를 파싱한다.
 * @param {string} sessionName
 * @param {string} paneNameOrTarget
 * @param {string} token
 * @param {number} timeoutSec
 * @param {object} [opts] — waitForPattern에 전달할 옵션 (onPoll 등)
 * @returns {{ matched: boolean, paneId: string, paneName: string, logPath: string, match: string|null, token: string, exitCode: number|null }}
 */
export async function waitForCompletion(sessionName, paneNameOrTarget, token, timeoutSec = 300, opts = {}) {
  const completionRegex = new RegExp(
    `${escapeRegExp(COMPLETION_PREFIX)}${escapeRegExp(token)}:(\\d+)`,
    "m",
  );
  const result = await waitForPattern(sessionName, paneNameOrTarget, completionRegex, timeoutSec, opts);

  // 타이밍 이슈 대응: matched=false인 경우 500ms 대기 후 최종 1회 캡처 재시도
  if (!result.matched && !result.sessionDead && result.logPath) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const pane = resolvePane(sessionName, paneNameOrTarget);
      const snapshot = psmuxExec(["capture-pane", "-t", pane.paneId, "-p", "-S", "-"]);
      writeFileSync(result.logPath, snapshot, "utf8");
      const content = readCaptureLog(result.logPath);
      const retryMatch = completionRegex.exec(content);
      if (retryMatch) {
        return {
          ...result,
          matched: true,
          match: retryMatch[0],
          token,
          exitCode: Number.parseInt(retryMatch[1], 10),
        };
      }
    } catch {
      // 세션 이미 종료 — 무시
    }
  }

  const exitMatch = result.match ? completionRegex.exec(result.match) : null;
  return {
    ...result,
    token,
    exitCode: exitMatch ? Number.parseInt(exitMatch[1], 10) : null,
  };
}

// ─── 하이브리드 모드 워커 관리 함수 ───

/**
 * psmux 세션의 새 pane에서 워커 실행
 * @param {string} sessionName - 대상 psmux 세션 이름
 * @param {string} workerName - 워커 식별용 pane 타이틀
 * @param {string} cmd - 실행할 커맨드
 * @returns {{ paneId: string, workerName: string }}
 */
export function spawnWorker(sessionName, workerName, cmd) {
  if (!hasPsmux()) {
    throw new Error(
      "psmux가 설치되어 있지 않습니다.\n" +
      "설치: winget install marlocarlo.psmux  (또는 scoop install psmux / npm i -g psmux)"
    );
  }

  // remain-on-exit: 종료된 pane이 즉시 사라지는 것 방지
  try {
    psmuxExec(["set-option", "-t", sessionName, "remain-on-exit", "on"]);
  } catch {
    // 미지원 시 무시
  }

  // Windows: pane 기본셸이 PowerShell → Git Bash로 래핑
  // psmux가 이스케이프 시퀀스를 처리하므로 포워드 슬래시 경로를 사용한다.
  const shellCmd = IS_WINDOWS
    ? `& '${GIT_BASH.replace(/\\/g, "/")}' -l -c '${cmd.replace(/'/g, "'\\''")}'`
    : cmd;

  try {
    const paneTarget = psmuxExec([
      "split-window",
      "-t",
      sessionName,
      "-P",
      "-F",
      "#{session_name}:#{window_index}.#{pane_index}",
      shellCmd,
    ]);
    psmuxExec(["select-pane", "-t", paneTarget, "-T", workerName]);
    return { paneId: paneTarget, workerName };
  } catch (err) {
    throw new Error(`워커 생성 실패 (session=${sessionName}, worker=${workerName}): ${err.message}`);
  }
}

/**
 * 워커 pane 실행 상태 확인
 * @param {string} sessionName - 대상 psmux 세션 이름
 * @param {string} workerName - 워커 pane 타이틀
 * @returns {{ status: "running"|"exited", exitCode: number|null, paneId: string }}
 */
export function getWorkerStatus(sessionName, workerName) {
  if (!hasPsmux()) {
    throw new Error("psmux 미설치. 설치: winget install marlocarlo.psmux (또는 npm i -g psmux)");
  }
  try {
    const pane = resolvePane(sessionName, workerName);
    return {
      status: pane.isDead ? "exited" : "running",
      exitCode: pane.isDead ? pane.exitCode : null,
      paneId: pane.paneId,
    };
  } catch (err) {
    if (err.message.includes("Pane을 찾을 수 없습니다")) {
      throw new Error(`워커를 찾을 수 없습니다: ${workerName}`);
    }
    throw new Error(`워커 상태 조회 실패 (session=${sessionName}, worker=${workerName}): ${err.message}`);
  }
}

/**
 * 워커 pane 프로세스 강제 종료
 * @param {string} sessionName - 대상 psmux 세션 이름
 * @param {string} workerName - 워커 pane 타이틀
 * @returns {{ killed: boolean }}
 */
export function killWorker(sessionName, workerName) {
  if (!hasPsmux()) {
    throw new Error("psmux 미설치. 설치: winget install marlocarlo.psmux (또는 npm i -g psmux)");
  }
  try {
    const { paneId, status } = getWorkerStatus(sessionName, workerName);
    const attachedCount = getPsmuxSessionAttachedCount(sessionName);
    const fallbackPane = attachedCount > 0
      ? findFallbackPane(sessionName, paneId)
      : null;

    if (fallbackPane?.paneId) {
      try {
        psmuxExec(["select-pane", "-t", fallbackPane.paneId]);
      } catch {
        // focus 회복 best-effort
      }
    }

    // pipe-pane 캡처 해제 — reader 프로세스 정상 종료 유도
    disablePipeCapture(paneId);

    // pane PID 수집 → 프로세스 트리 정리 (MCP 서버 좀비 방지)
    try {
      const pidOutput = psmuxExec(["list-panes", "-t", paneId, "-F", "#{pane_pid}"]);
      const pid = Number.parseInt(pidOutput.trim(), 10);
      if (Number.isFinite(pid) && pid > 0) killProcessTree(pid);
    } catch {
      // PID 조회 실패 — 아래에서 pane만 정리
    }

    // 이미 종료된 워커 → pane 정리만 수행
    if (status === "exited") {
      try {
        psmuxExec(["kill-pane", "-t", paneId]);
      } catch {
        // 무시
      }
      return { killed: true };
    }

    // running → C-c 우아한 종료 시도
    try {
      psmuxExec(["send-keys", "-t", paneId, "C-c"]);
    } catch {
      // send-keys 실패 무시
    }

    if (!fallbackPane) {
      try {
        psmuxExec(["send-keys", "-t", paneId, "exit", "Enter"]);
      } catch {
        // send-keys 실패 무시
      }
    }

    sleepMs(2000);

    try {
      psmuxExec(["kill-pane", "-t", paneId]);
    } catch {
      // 이미 종료된 pane — 무시
    }

    if (fallbackPane?.paneId) {
      try {
        psmuxExec(["select-pane", "-t", fallbackPane.paneId]);
      } catch {
        // pane 정리 후 focus 재선택 best-effort
      }
    }
    return { killed: true };
  } catch (err) {
    if (err.message.includes("워커를 찾을 수 없습니다")) {
      return { killed: true };
    }
    throw new Error(`워커 종료 실패 (session=${sessionName}, worker=${workerName}): ${err.message}`);
  }
}

/**
 * 워커 pane 출력 마지막 N줄 캡처
 * @param {string} sessionName - 대상 psmux 세션 이름
 * @param {string} workerName - 워커 pane 타이틀
 * @param {number} lines - 캡처할 줄 수 (기본 50)
 * @returns {string} 캡처된 출력
 */
export function captureWorkerOutput(sessionName, workerName, lines = 50) {
  if (!hasPsmux()) {
    throw new Error("psmux 미설치. 설치: winget install marlocarlo.psmux (또는 npm i -g psmux)");
  }
  try {
    const { paneId } = getWorkerStatus(sessionName, workerName);
    return psmuxExec(["capture-pane", "-t", paneId, "-p", "-S", `-${lines}`]);
  } catch (err) {
    if (err.message.includes("워커를 찾을 수 없습니다")) throw err;
    throw new Error(`출력 캡처 실패 (session=${sessionName}, worker=${workerName}): ${err.message}`);
  }
}

// ─── CLI 진입점 ───

if (process.argv[1] && process.argv[1].endsWith("psmux.mjs")) {
  (async () => {
  const [, , cmd, ...args] = process.argv;

  // CLI 인자 파싱 헬퍼
  function getArg(name) {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  }

  try {
    switch (cmd) {
      case "spawn": {
        const session = getArg("session");
        const name = getArg("name");
        const workerCmd = getArg("cmd");
        if (!session || !name || !workerCmd) {
          console.error("사용법: node psmux.mjs spawn --session <세션> --name <워커명> --cmd <커맨드>");
          process.exit(1);
        }
        console.log(JSON.stringify(spawnWorker(session, name, workerCmd), null, 2));
        break;
      }
      case "status": {
        const session = getArg("session");
        const name = getArg("name");
        if (!session || !name) {
          console.error("사용법: node psmux.mjs status --session <세션> --name <워커명>");
          process.exit(1);
        }
        console.log(JSON.stringify(getWorkerStatus(session, name), null, 2));
        break;
      }
      case "kill": {
        const session = getArg("session");
        const name = getArg("name");
        if (!session || !name) {
          console.error("사용법: node psmux.mjs kill --session <세션> --name <워커명>");
          process.exit(1);
        }
        console.log(JSON.stringify(killWorker(session, name), null, 2));
        break;
      }
      case "output": {
        const session = getArg("session");
        const name = getArg("name");
        const lines = parseInt(getArg("lines") || "50", 10);
        if (!session || !name) {
          console.error("사용법: node psmux.mjs output --session <세션> --name <워커명> [--lines <줄수>]");
          process.exit(1);
        }
        console.log(captureWorkerOutput(session, name, lines));
        break;
      }
      case "capture-start": {
        const session = getArg("session");
        const name = getArg("name");
        if (!session || !name) {
          console.error("사용법: node psmux.mjs capture-start --session <세션> --name <pane>");
          process.exit(1);
        }
        console.log(JSON.stringify(startCapture(session, name), null, 2));
        break;
      }
      case "dispatch": {
        const session = getArg("session");
        const name = getArg("name");
        const commandText = getArg("command");
        if (!session || !name || !commandText) {
          console.error("사용법: node psmux.mjs dispatch --session <세션> --name <pane> --command <PowerShell 명령>");
          process.exit(1);
        }
        console.log(JSON.stringify(dispatchCommand(session, name, commandText), null, 2));
        break;
      }
      case "wait-pattern": {
        const session = getArg("session");
        const name = getArg("name");
        const pattern = getArg("pattern");
        const timeoutSec = parseInt(getArg("timeout") || "300", 10);
        if (!session || !name || !pattern) {
          console.error("사용법: node psmux.mjs wait-pattern --session <세션> --name <pane> --pattern <정규식> [--timeout <초>]");
          process.exit(1);
        }
        const result = await waitForPattern(session, name, pattern, timeoutSec);
        console.log(JSON.stringify(result, null, 2));
        if (!result.matched) process.exit(2);
        break;
      }
      case "wait-completion": {
        const session = getArg("session");
        const name = getArg("name");
        const token = getArg("token");
        const timeoutSec = parseInt(getArg("timeout") || "300", 10);
        if (!session || !name || !token) {
          console.error("사용법: node psmux.mjs wait-completion --session <세션> --name <pane> --token <토큰> [--timeout <초>]");
          process.exit(1);
        }
        const result = await waitForCompletion(session, name, token, timeoutSec);
        console.log(JSON.stringify(result, null, 2));
        if (!result.matched) process.exit(2);
        break;
      }
      default:
        console.error("사용법: node psmux.mjs spawn|status|kill|output|capture-start|dispatch|wait-pattern|wait-completion [args]");
        console.error("");
        console.error("  spawn            --session <세션> --name <워커명> --cmd <커맨드>");
        console.error("  status           --session <세션> --name <워커명>");
        console.error("  kill             --session <세션> --name <워커명>");
        console.error("  output           --session <세션> --name <워커명> [--lines <줄수>]");
        console.error("  capture-start    --session <세션> --name <pane>");
        console.error("  dispatch         --session <세션> --name <pane> --command <PowerShell 명령>");
        console.error("  wait-pattern     --session <세션> --name <pane> --pattern <정규식> [--timeout <초>]");
        console.error("  wait-completion  --session <세션> --name <pane> --token <토큰> [--timeout <초>]");
        process.exit(1);
    }
  } catch (err) {
    console.error(`오류: ${err.message}`);
    process.exit(1);
  }
  })();
}
