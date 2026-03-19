#!/usr/bin/env node
// npm install 전 Hub를 안전하게 중지하여 EBUSY 방지
// better-sqlite3.node 파일이 Hub 프로세스에 의해 잠기면 npm이 덮어쓸 수 없음

import { existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HUB_PID_FILE = join(homedir(), ".claude", "cache", "tfx-hub", "hub.pid");

function stopHub() {
  if (!existsSync(HUB_PID_FILE)) return;

  try {
    const info = JSON.parse(readFileSync(HUB_PID_FILE, "utf8"));
    const pid = Number(info?.pid);
    if (!Number.isFinite(pid) || pid <= 0) return;

    // 프로세스 존재 확인
    process.kill(pid, 0);

    // SIGTERM 전송
    process.kill(pid, "SIGTERM");
    console.log(`[triflux preinstall] Hub 중지됨 (PID ${pid}) — EBUSY 방지`);

    // Windows: 프로세스 종료 + 파일 핸들 해제 대기 (최대 3초)
    const start = Date.now();
    while (Date.now() - start < 3000) {
      try { process.kill(pid, 0); } catch { break; }
    }

    // PID 파일 정리
    try { unlinkSync(HUB_PID_FILE); } catch {}
  } catch (err) {
    if (err.code === "ESRCH") {
      // 프로세스 이미 종료됨 — PID 파일만 정리
      try { unlinkSync(HUB_PID_FILE); } catch {}
    }
    // EPERM 등 기타 에러는 무시 (설치를 막으면 안 됨)
  }
}

stopHub();
