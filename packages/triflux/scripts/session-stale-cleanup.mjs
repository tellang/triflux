#!/usr/bin/env node
/**
 * session-stale-cleanup.mjs — tfx doctor --fix 정리 작업
 *
 * 이전 세션의 stale 상태를 정리한다:
 * 1. tfx-multi-state.json — 세션 간 상태 누수 방지 (#62)
 * 2. tfx-route-*-pids — 고아 워커 프로세스 정리 (#62 후속)
 * 3. git fsmonitor--daemon 누적 감시 — threshold 초과 시 증거 기록 (#214)
 *
 * @see scripts/tfx-route.sh — PID tracking 파일 생산자
 */

import { execFileSync, execSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { privateTmpRoot } from "../hub/lib/private-tmp.mjs";
import { findFsmonitorDaemons } from "../hub/lib/process-utils.mjs";
import { isProcessAlive } from "./lib/process-utils.mjs";

const MULTI_STATE_FILE = join(tmpdir(), "tfx-multi-state.json");
const EXPIRE_MS = 30 * 60 * 1000; // 30분
const PID_FILE_RE = /^tfx-route-(\d+)-pids$/;
const PROTECTED_ANCESTOR_NAMES = new Set([
  "claude.exe",
  "codex.exe",
  "gemini.exe",
]);
const PID_REUSE_GRACE_MS = 1000;
// ps etime 은 초 단위로 잘려 시작 시각이 최대 1초 늦게 계산된다.
const POSIX_PID_REUSE_GRACE_MS = 2000;
const WORKER_CMD_RE =
  /codex|antigravity|claude|(^|[\s/])agy(\s|$)|--bg-pty-host|--bg-spare|--agent-id|tfx-route/;
const DEFAULT_FSMONITOR_ALERT_THRESHOLD = 50;
const FSMONITOR_STALE_MS = 24 * 60 * 60 * 1000;

function normalizeName(name) {
  return String(name || "")
    .trim()
    .toLowerCase();
}

function parseCreationMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : null;
}

function parsePositiveInteger(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function resolveHomeDir() {
  return (
    process.env.TRIFLUX_TEST_HOME ||
    process.env.USERPROFILE ||
    process.env.HOME ||
    homedir()
  );
}

function defaultFsmonitorAlertLogPath() {
  return join(resolveHomeDir(), ".omc", "state", "fsmonitor-alert.log");
}

function summarizeFsmonitorDaemon(proc) {
  return {
    pid: proc.pid,
    parentPid: proc.parentPid,
    ageMs: Number.isFinite(proc.ageMs) ? proc.ageMs : null,
    commandLine: String(proc.commandLine || "").slice(0, 200),
  };
}

function collectWindowsProcessTable() {
  if (platform() !== "win32") return new Map();
  try {
    const raw = execSync(
      [
        "powershell",
        "-NoProfile",
        "-Command",
        "$ErrorActionPreference='SilentlyContinue';",
        "Get-CimInstance Win32_Process |",
        "Select-Object ProcessId,ParentProcessId,Name,@{Name='CreationDateIso';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}},CommandLine |",
        "ConvertTo-Json -Compress",
      ].join(" "),
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!raw) return new Map();
    const rows = JSON.parse(raw);
    const list = Array.isArray(rows) ? rows : [rows];
    return new Map(
      list
        .filter((row) => Number.isFinite(Number(row?.ProcessId)))
        .map((row) => [
          Number(row.ProcessId),
          {
            pid: Number(row.ProcessId),
            ppid: Number(row.ParentProcessId),
            name: normalizeName(row.Name),
            creationMs: parseCreationMs(row.CreationDateIso),
            commandLine: String(row.CommandLine || ""),
          },
        ]),
    );
  } catch {
    return new Map();
  }
}

// ps etime: [[dd-]hh:]mm:ss
export function parseEtimeMs(value) {
  const m = String(value || "")
    .trim()
    .match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, d = 0, h = 0, min, sec] = m;
  return (
    (((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(sec)) *
    1000
  );
}

function readPosixProcess(pid) {
  try {
    const out = execFileSync(
      "ps",
      ["-o", "ppid=,pgid=,etime=,command=", "-p", String(pid)],
      { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const m = out.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) return null;
    const ageMs = parseEtimeMs(m[3]);
    return {
      pid: Number(pid),
      ppid: Number(m[1]),
      pgid: Number(m[2]),
      name: "",
      creationMs: ageMs === null ? null : Date.now() - ageMs,
      commandLine: m[4],
    };
  } catch {
    return null;
  }
}

function hasProtectedAncestor(pid, procMap) {
  let current = Number(pid);
  const seen = new Set();
  while (Number.isFinite(current) && current > 0 && !seen.has(current)) {
    seen.add(current);
    const proc = procMap.get(current);
    if (!proc) return false;
    if (PROTECTED_ANCESTOR_NAMES.has(proc.name)) return true;
    current = proc.ppid;
  }
  return false;
}

function hasProtectedDescendant(pid, procMap) {
  const children = new Map();
  for (const proc of procMap.values()) {
    if (!Number.isFinite(proc.ppid) || proc.ppid <= 0) continue;
    const list = children.get(proc.ppid) || [];
    list.push(proc);
    children.set(proc.ppid, list);
  }

  const seen = new Set();
  const stack = [...(children.get(Number(pid)) || [])];
  while (stack.length > 0) {
    const proc = stack.pop();
    if (!proc || seen.has(proc.pid)) continue;
    seen.add(proc.pid);
    if (PROTECTED_ANCESTOR_NAMES.has(proc.name)) return true;
    stack.push(...(children.get(proc.pid) || []));
  }
  return false;
}

export function shouldKillTrackedPid({
  pid,
  pidFileMtimeMs,
  procMap = new Map(),
  isWindows = platform() === "win32",
} = {}) {
  const proc = procMap.get(Number(pid));
  if (!proc) return false;

  // PID 파일을 마지막으로 쓴 뒤 시작한 프로세스는 재사용된 PID 다.
  const graceMs = isWindows ? PID_REUSE_GRACE_MS : POSIX_PID_REUSE_GRACE_MS;
  if (
    Number.isFinite(proc.creationMs) &&
    Number.isFinite(pidFileMtimeMs) &&
    proc.creationMs > pidFileMtimeMs + graceMs
  ) {
    return false;
  }

  if (hasProtectedAncestor(pid, procMap)) return false;
  if (hasProtectedDescendant(pid, procMap)) return false;

  return true;
}

function treeKill(pid, proc) {
  try {
    if (platform() === "win32") {
      execSync(`taskkill /T /F /PID ${pid}`, {
        stdio: "ignore",
        timeout: 5000,
        windowsHide: true,
      });
      return;
    }
    // POSIX: 손자까지 회수하려면 그룹 kill 이 필요하지만, 공유 그룹이면 무관한
    // 프로세스까지 죽는다. 리더이고 워커 서명일 때만 그룹, 아니면 단일 PID.
    const safeGroupKill =
      proc.pgid > 1 &&
      proc.pgid === pid &&
      WORKER_CMD_RE.test(proc.commandLine);
    process.kill(safeGroupKill ? -pid : pid, "SIGTERM");
  } catch {
    /* already dead */
  }
}

// ── 1. tfx-multi-state.json 정리 ──
function cleanupMultiState() {
  if (!existsSync(MULTI_STATE_FILE)) return;

  let state;
  try {
    state = JSON.parse(readFileSync(MULTI_STATE_FILE, "utf8"));
  } catch {
    try {
      unlinkSync(MULTI_STATE_FILE);
    } catch {
      /* ignore */
    }
    return;
  }

  if (state.ownerPid && isProcessAlive(state.ownerPid)) return;

  if (!state.ownerPid && state.activatedAt) {
    if (Date.now() - state.activatedAt < EXPIRE_MS) return;
  }

  if (state.active) {
    console.error(
      `[session-stale-cleanup] stale tfx-multi state 정리 (pid=${state.ownerPid || "unknown"}, dispatched=${state.dispatched}, calls=${state.nativeWorkCalls || 0})`,
    );
  }

  try {
    unlinkSync(MULTI_STATE_FILE);
  } catch {
    /* ignore */
  }
}

// ── 2. orphan PID tracking 파일 정리 ──
// tfx-route.sh 는 uid 0700 루트에 추적 파일을 쓴다. tmpdir() 는 예전 버전이 남긴 파일용이다.
function pidFileDirs() {
  const dirs = [tmpdir()];
  try {
    dirs.unshift(privateTmpRoot());
  } catch {
    /* 남의 루트면 건너뛴다 */
  }
  return [...new Set(dirs)];
}

// 공용 /tmp 에 남이 쓴 추적 파일의 PID 를 믿으면 내 프로세스를 죽이게 된다.
export function cleanupOrphanPidFiles({
  dirs = pidFileDirs(),
  uid = process.getuid?.(),
} = {}) {
  const isWindows = platform() === "win32";
  const winProcMap = collectWindowsProcessTable();

  for (const dir of dirs) {
    let files;
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      const m = PID_FILE_RE.exec(f);
      if (m)
        cleanupPidFile(join(dir, f), Number(m[1]), uid, isWindows, winProcMap);
    }
  }
}

function cleanupPidFile(filePath, ownerPid, uid, isWindows, winProcMap) {
  if (isProcessAlive(ownerPid)) return; // 세션 살아있음, 건드리지 않음

  let st;
  try {
    st = lstatSync(filePath);
  } catch {
    return;
  }
  if (!st.isFile() || (uid !== undefined && st.uid !== uid)) return;

  const f = basename(filePath);
  try {
    const pids = readFileSync(filePath, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map(Number);

    for (const pid of pids) {
      if (pid > 0 && isProcessAlive(pid)) {
        const procMap = isWindows
          ? winProcMap
          : new Map([[pid, readPosixProcess(pid)]]);
        if (
          !shouldKillTrackedPid({ pid, pidFileMtimeMs: st.mtimeMs, procMap })
        ) {
          console.error(
            `[session-stale-cleanup] skip pid=${pid} from ${f} (pid-reuse-or-live-cli-root)`,
          );
          continue;
        }
        console.error(
          `[session-stale-cleanup] orphan worker kill: pid=${pid} (from ${f})`,
        );
        treeKill(pid, procMap.get(pid));
      }
    }
  } catch {
    /* 읽기 실패 무시 */
  }

  try {
    unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

export function monitorFsmonitorDaemons({
  threshold = parsePositiveInteger(
    process.env.TFX_FSMONITOR_ALERT_THRESHOLD,
    DEFAULT_FSMONITOR_ALERT_THRESHOLD,
  ),
  logPath = process.env.TFX_FSMONITOR_ALERT_LOG ||
    defaultFsmonitorAlertLogPath(),
  findFn = findFsmonitorDaemons,
  now = new Date(),
  isWindows = platform() === "win32",
} = {}) {
  if (process.env.TFX_FSMONITOR_MONITOR === "0") {
    return { checked: false, reason: "disabled" };
  }
  if (!isWindows) return { checked: false, reason: "non-windows" };

  const effectiveThreshold = parsePositiveInteger(
    threshold,
    DEFAULT_FSMONITOR_ALERT_THRESHOLD,
  );

  try {
    const daemons = findFn({
      minAgeMs: 0,
      nowMs: now.getTime(),
      isWindows,
    });
    const total = daemons.length;
    if (total < effectiveThreshold) {
      return {
        checked: true,
        alert: false,
        total,
        threshold: effectiveThreshold,
      };
    }

    const record = {
      ts: now.toISOString(),
      source: "session-start",
      total,
      threshold: effectiveThreshold,
      stale24h: daemons.filter(
        (proc) =>
          Number.isFinite(proc.ageMs) && proc.ageMs >= FSMONITOR_STALE_MS,
      ).length,
      pids: daemons.slice(0, 20).map(summarizeFsmonitorDaemon),
    };

    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
    console.error(
      `[session-stale-cleanup] git fsmonitor daemon threshold exceeded: total=${total} threshold=${effectiveThreshold} log=${logPath}`,
    );

    return {
      checked: true,
      alert: true,
      total,
      threshold: effectiveThreshold,
      stale24h: record.stale24h,
      logPath,
    };
  } catch (error) {
    console.error(
      `[session-stale-cleanup] fsmonitor monitor failed: ${error?.message || error}`,
    );
    return {
      checked: false,
      reason: "error",
      error: error?.message || String(error),
    };
  }
}

export function main() {
  cleanupMultiState();
  cleanupOrphanPidFiles();
  monitorFsmonitorDaemons();
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url.endsWith(
    process.argv[1].replace(/\\/g, "/").split("/").pop(),
  );

if (isDirectRun) main();
