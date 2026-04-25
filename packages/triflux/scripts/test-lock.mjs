#!/usr/bin/env node

// scripts/test-lock.mjs — 테스트 러너 싱글톤 lockfile 가드
//
// npm test 동시 실행 방지. conductor 같은 child-spawn 테스트가
// 3중 실행되면 WT ConPTY 수백 개 → 16GB RAM 사고 발생.
//
// 사용: node scripts/test-lock.mjs [-- ...node --test args]

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCK_DIR = join(import.meta.dirname, "..", ".test-lock");
const LOCK_FILE = join(LOCK_DIR, "pid.lock");
const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10분 넘으면 stale

function readLock() {
  try {
    const content = readFileSync(LOCK_FILE, "utf8").trim();
    const [pidStr, tsStr] = content.split("\n");
    return { pid: Number(pidStr), ts: Number(tsStr) };
  } catch {
    return null;
  }
}

function acquireLock() {
  const existing = readLock();
  if (existing) {
    const age = Date.now() - existing.ts;
    // Windows에서 process.kill(pid,0)이 git-bash PID를 못 잡음.
    // 단순하게: lockfile이 있고 STALE_THRESHOLD 이내면 거부.
    if (age >= 0 && age < STALE_THRESHOLD_MS) {
      console.error(
        `\x1b[31m✗ 테스트 이미 실행 중 (PID ${existing.pid}, ${Math.round(age / 1000)}초 전 시작)\x1b[0m`,
      );
      console.error(
        `  동시 실행은 WT 메모리 폭발을 유발합니다. 기다리거나 PID를 kill하세요.`,
      );
      console.error(`  강제 해제: rm ${LOCK_FILE}`);
      process.exit(1);
    }
    // stale (>10분) — 덮어쓰기
  }
  mkdirSync(LOCK_DIR, { recursive: true });
  writeFileSync(LOCK_FILE, `${process.pid}\n${Date.now()}`, "utf8");
}

function releaseLock() {
  try {
    const lock = readLock();
    if (lock && lock.pid === process.pid) unlinkSync(LOCK_FILE);
  } catch {
    /* ignore */
  }
}

// ── main ──

acquireLock();

// cleanup on exit
process.on("exit", releaseLock);
process.on("SIGINT", () => {
  releaseLock();
  process.exit(130);
});
process.on("SIGTERM", () => {
  releaseLock();
  process.exit(143);
});

// forward args after -- to node --test
const args = process.argv.slice(2);
// stdio split (issue #192 F1): when prepare.mjs spawns this lock with
// ["ignore","pipe","pipe"], full inherit cascades the parent stdin=ignore
// to grand-child node --test, breaking ConPTY assumptions on Windows and
// surfacing as EXIT=1 (false-failed). Pipe stdin only — stdout/stderr stay
// inherited so the grand-child still streams to whoever attached to us.
const child = spawn(process.execPath, args, {
  stdio: ["pipe", "inherit", "inherit"],
  env: { ...process.env, TEST_LOCK_PID: String(process.pid) },
});
// Close stdin immediately so node --test never blocks waiting for input.
child.stdin?.end();

child.on("exit", (code) => {
  releaseLock();
  process.exit(code ?? 1);
});
