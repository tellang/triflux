#!/usr/bin/env node
// scripts/hub-watchdog.mjs — Hub 상시 감시 + 자동 재시작
//
// 10초마다 27888/status 체크. 응답 없으면 `tfx hub start` 실행.
// 실행: node scripts/hub-watchdog.mjs &
// 중지: kill $(pgrep -f hub-watchdog.mjs)  (또는 별도 pid 파일)

import { spawn } from "node:child_process";
import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const HUB_URL = "http://127.0.0.1:27888/status";
const POLL_MS = 10_000;
const START_GRACE_MS = 5_000;
const LOG_PREFIX = "[hub-watchdog]";

const PID_FILE = join(process.cwd(), ".claude", "hub-watchdog.pid");
const LOG_FILE = join(process.cwd(), ".claude", "hub-watchdog.log");

function log(msg) {
  const ts = new Date().toISOString();
  const line = `${ts} ${LOG_PREFIX} ${msg}\n`;
  try {
    process.stdout.write(line);
  } catch {}
  try {
    const fs = require("node:fs");
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

async function isAlive() {
  try {
    const r = await fetch(HUB_URL, {
      signal: AbortSignal.timeout(3000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

function startHub() {
  log("Hub 기동: tfx hub start");
  const proc = spawn("tfx", ["hub", "start"], {
    cwd: process.cwd(),
    stdio: "ignore",
    detached: true,
    shell: true,
  });
  proc.unref();
}

let restarts = 0;
async function ensure() {
  if (await isAlive()) return;
  log(`Hub down 감지. restart #${++restarts}`);
  startHub();
  await new Promise((r) => setTimeout(r, START_GRACE_MS));
  if (await isAlive()) {
    log(`Hub 복구 성공 (restart #${restarts})`);
  } else {
    log(`WARN: Hub 재시작 후에도 응답 없음 (restart #${restarts})`);
  }
}

function cleanup() {
  if (existsSync(PID_FILE)) {
    try {
      unlinkSync(PID_FILE);
    } catch {}
  }
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// 시작 시 pid 기록
try {
  writeFileSync(PID_FILE, String(process.pid));
} catch {}

log(`watchdog 시작 (pid=${process.pid}, poll=${POLL_MS}ms)`);
ensure();
setInterval(ensure, POLL_MS);
