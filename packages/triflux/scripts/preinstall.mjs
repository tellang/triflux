#!/usr/bin/env node

// npm install 전 Hub를 안전하게 중지하여 EBUSY 방지
// better-sqlite3.node 파일이 Hub 프로세스에 의해 잠기면 npm이 덮어쓸 수 없음
//
// v6.0.0: taskkill /T /F + Atomics.wait sleep + 파일 잠금 확인
// (bin/triflux.mjs stopHubForUpdate 패턴과 동일)

import { execFileSync } from "child_process";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..");
const HUB_PID_FILE = join(homedir(), ".claude", "cache", "tfx-hub", "hub.pid");

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function stopHub() {
  if (!existsSync(HUB_PID_FILE)) return;

  let info;
  try {
    info = JSON.parse(readFileSync(HUB_PID_FILE, "utf8"));
    const pid = Number(info?.pid);
    if (!Number.isFinite(pid) || pid <= 0) return;
    process.kill(pid, 0); // 프로세스 존재 확인
  } catch {
    // 프로세스 없음 또는 PID 파일 손상 — PID 파일만 정리
    try {
      unlinkSync(HUB_PID_FILE);
    } catch {}
    return;
  }

  const pid = Number(info.pid);

  // D4 fix: PID 소유자 검증 — node 프로세스인지 확인 (PID 재사용 보호)
  if (process.platform === "win32") {
    try {
      const taskInfo = execFileSync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "ignore"],
          timeout: 5000,
          windowsHide: true,
        },
      ).trim();
      if (!taskInfo.toLowerCase().includes("node")) {
        console.log(
          `[triflux preinstall] PID ${pid}은 node 프로세스가 아님 — kill 건너뜀`,
        );
        try {
          unlinkSync(HUB_PID_FILE);
        } catch {}
        return;
      }
    } catch {
      // tasklist 실패 — 안전하게 진행 (프로세스가 이미 죽었을 수 있음)
    }
  }

  // 1단계: 프로세스 종료 — Windows는 taskkill, Unix는 SIGTERM
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: ["pipe", "pipe", "ignore"],
        timeout: 10000,
        windowsHide: true,
      });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // taskkill 실패 시 SIGKILL fallback
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }

  // 2단계: 프로세스 종료 대기 (최대 5초, 500ms 간격)
  for (let i = 0; i < 10; i++) {
    sleepMs(500);
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
  }

  // 3단계: better-sqlite3.node 파일 잠금 해제 확인 (최대 3초)
  const sqliteNode = join(
    PKG_ROOT,
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  );
  if (existsSync(sqliteNode)) {
    for (let i = 0; i < 6; i++) {
      try {
        const fd = openSync(sqliteNode, "r");
        closeSync(fd);
        break; // 열림 = 잠금 해제됨
      } catch {
        sleepMs(500);
      }
    }
  }

  // 4단계: PID 파일 정리 (종료 확인 후)
  try {
    unlinkSync(HUB_PID_FILE);
  } catch {}
  console.log(`[triflux preinstall] Hub 중지 완료 (PID ${pid})`);
}

// LOCAL: stopHub() 호출 비활성 — 사용자 요청 "끄는 로직 빼버리고 계속 켜놓자"
// npm install 시 better-sqlite3.node EBUSY 재발 가능하나, Hub 영구 유지가 우선.
// 충돌 재발 시 watchdog (scripts/hub-watchdog.mjs) 가 재기동.
// stopHub();
