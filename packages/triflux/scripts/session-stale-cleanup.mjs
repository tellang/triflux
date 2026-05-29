#!/usr/bin/env node
/**
 * session-stale-cleanup.mjs — SessionStart 훅
 *
 * 새 세션 시작 시 이전 세션의 stale 상태를 정리한다:
 * 1. tfx-multi-state.json — 세션 간 상태 누수 방지 (#62)
 * 2. tfx-route-*-pids — 고아 워커 프로세스 정리 (#62 후속)
 * 3. git fsmonitor--daemon 누적 감시 — threshold 초과 시 증거 기록 (#214)
 *
 * @see scripts/headless-guard.mjs — 상태 소비자
 * @see scripts/tfx-gate-activate.mjs — 상태 생산자 (ownerPid 기록)
 * @see scripts/tfx-route.sh — PID tracking 파일 생산자
 */

import { execSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  if (!isWindows) return true;

  const proc = procMap.get(Number(pid));
  if (!proc) return false;

  if (
    Number.isFinite(proc.creationMs) &&
    Number.isFinite(pidFileMtimeMs) &&
    proc.creationMs > pidFileMtimeMs + PID_REUSE_GRACE_MS
  ) {
    return false;
  }

  if (hasProtectedAncestor(pid, procMap)) return false;
  if (hasProtectedDescendant(pid, procMap)) return false;

  return true;
}

function treeKill(pid) {
  try {
    if (platform() === "win32") {
      execSync(`taskkill /T /F /PID ${pid}`, {
        stdio: "ignore",
        timeout: 5000,
        windowsHide: true,
      });
    } else {
      // POSIX: detached 워커의 손자까지 회수하려면 프로세스 '그룹' 을 종료해야 한다
      // (Windows `taskkill /T` 와 동일 의미). 단 PID 재사용/공유 그룹 때문에 그룹
      // kill 이 무관한 live 프로세스 그룹을 죽일 수 있다 (Codex review PR #365 P1).
      // 그래서 그룹 kill 은 다음을 모두 만족할 때만 한다:
      //   - 대상이 자기 그룹의 leader (pgid === pid → 그룹 = 그 워커의 subtree 뿐)
      //   - 여전히 triflux 가 띄운 워커처럼 보임 (command signature)
      //   - init 류 그룹 아님 (pgid > 1)
      // 그 외에는 기존과 동일하게 단일 PID SIGTERM 으로 폴백한다 (회귀 없음).
      let pgid = null;
      let cmd = "";
      try {
        const out = execSync(`ps -o pgid=,command= -p ${pid}`, { timeout: 2000 })
          .toString()
          .trim();
        const m = out.match(/^(\d+)\s+(.*)$/);
        if (m) {
          pgid = parseInt(m[1], 10);
          cmd = m[2];
        }
      } catch {
        /* 조회 실패 — bare pid 폴백 */
      }
      const isWorker =
        /codex|antigravity|claude|--bg-pty-host|--bg-spare|--agent-id|tfx-route/.test(
          cmd,
        );
      const safeGroupKill =
        Number.isInteger(pgid) && pgid > 1 && pgid === pid && isWorker;
      process.kill(safeGroupKill ? -pgid : pid, "SIGTERM");
    }
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
function cleanupOrphanPidFiles() {
  let files;
  try {
    files = readdirSync(tmpdir());
  } catch {
    return;
  }
  const procMap = collectWindowsProcessTable();

  for (const f of files) {
    const m = PID_FILE_RE.exec(f);
    if (!m) continue;

    const ownerPid = Number(m[1]);
    if (isProcessAlive(ownerPid)) continue; // 세션 살아있음, 건드리지 않음

    const filePath = join(tmpdir(), f);
    try {
      const pidFileMtimeMs = statSync(filePath).mtimeMs;
      const pids = readFileSync(filePath, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map(Number);

      for (const pid of pids) {
        if (pid > 0 && isProcessAlive(pid)) {
          if (!shouldKillTrackedPid({ pid, pidFileMtimeMs, procMap })) {
            console.error(
              `[session-stale-cleanup] skip pid=${pid} from ${f} (pid-reuse-or-live-cli-root)`,
            );
            continue;
          }
          console.error(
            `[session-stale-cleanup] orphan worker kill: pid=${pid} (from ${f})`,
          );
          treeKill(pid);
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
