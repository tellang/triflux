#!/usr/bin/env node
/**
 * session-stale-cleanup.mjs — SessionStart 훅
 *
 * 새 세션 시작 시 이전 세션의 stale 상태를 정리한다:
 * 1. tfx-multi-state.json — 세션 간 상태 누수 방지 (#62)
 * 2. tfx-route-*-pids — 고아 워커 프로세스 정리 (#62 후속)
 *
 * @see scripts/headless-guard.mjs — 상태 소비자
 * @see scripts/tfx-gate-activate.mjs — 상태 생산자 (ownerPid 기록)
 * @see scripts/tfx-route.sh — PID tracking 파일 생산자
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { isProcessAlive } from "./lib/process-utils.mjs";

const MULTI_STATE_FILE = join(tmpdir(), "tfx-multi-state.json");
const EXPIRE_MS = 30 * 60 * 1000; // 30분
const PID_FILE_RE = /^tfx-route-(\d+)-pids$/;
const PROTECTED_ANCESTOR_NAMES = new Set(["claude.exe", "codex.exe"]);
const PID_REUSE_GRACE_MS = 1000;

function normalizeName(name) {
  return String(name || "")
    .trim()
    .toLowerCase();
}

function parseCreationMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : null;
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
      process.kill(pid, "SIGTERM");
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

export function main() {
  cleanupMultiState();
  cleanupOrphanPidFiles();
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url.endsWith(
    process.argv[1].replace(/\\/g, "/").split("/").pop(),
  );

if (isDirectRun) main();
