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
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { isProcessAlive } from "./lib/process-utils.mjs";

const MULTI_STATE_FILE = join(tmpdir(), "tfx-multi-state.json");
const EXPIRE_MS = 30 * 60 * 1000; // 30분
const PID_FILE_RE = /^tfx-route-(\d+)-pids$/;

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

  for (const f of files) {
    const m = PID_FILE_RE.exec(f);
    if (!m) continue;

    const ownerPid = Number(m[1]);
    if (isProcessAlive(ownerPid)) continue; // 세션 살아있음, 건드리지 않음

    const filePath = join(tmpdir(), f);
    try {
      const pids = readFileSync(filePath, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map(Number);

      for (const pid of pids) {
        if (pid > 0 && isProcessAlive(pid)) {
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
