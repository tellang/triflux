#!/usr/bin/env node
/**
 * session-stale-cleanup.mjs — SessionStart 훅
 *
 * 새 세션 시작 시 이전 세션의 tfx-multi 상태 파일을 정리한다.
 * 단, 다른 세션이 지금 사용 중인 상태는 건드리지 않는다.
 *
 * 판단 기준:
 * - ownerPid 있음 + 해당 PID 살아있음 → 동시 세션, 삭제 안 함
 * - ownerPid 있음 + 해당 PID 죽음 → stale, 삭제
 * - ownerPid 없음 (구버전 상태) → 30분 만료 기준으로 삭제
 * - 파싱 실패 → 손상, 삭제
 *
 * 해결하는 문제 (GitHub #62):
 * - 세션 간 상태 누수: 이전 세션의 nativeWorkCalls 카운터가 누적
 * - 미정리 종료: dispatch 안 하고 종료 시 30분간 좀비 상태
 *
 * @see scripts/headless-guard.mjs — 상태 소비자
 * @see scripts/tfx-gate-activate.mjs — 상태 생산자 (ownerPid 기록)
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MULTI_STATE_FILE = join(tmpdir(), "tfx-multi-state.json");
const EXPIRE_MS = 30 * 60 * 1000; // 30분

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 = 존재 여부만 확인
    return true;
  } catch {
    return false;
  }
}

function main() {
  if (!existsSync(MULTI_STATE_FILE)) return;

  let state;
  try {
    state = JSON.parse(readFileSync(MULTI_STATE_FILE, "utf8"));
  } catch {
    // 파싱 실패 = 손상된 파일 → 삭제
    try { unlinkSync(MULTI_STATE_FILE); } catch { /* ignore */ }
    return;
  }

  // ownerPid가 있고 해당 프로세스가 살아있으면 → 동시 세션, 건드리지 않음
  if (state.ownerPid && isProcessAlive(state.ownerPid)) {
    return;
  }

  // ownerPid 없음 (구버전 상태) → 30분 만료 기준
  if (!state.ownerPid && state.activatedAt) {
    if (Date.now() - state.activatedAt < EXPIRE_MS) {
      return; // 아직 만료 안 됨, 보수적으로 유지
    }
  }

  // stale 상태 삭제
  if (state.active) {
    console.error(
      `[session-stale-cleanup] stale tfx-multi state 정리 (pid=${state.ownerPid || "unknown"}, dispatched=${state.dispatched}, calls=${state.nativeWorkCalls || 0})`,
    );
  }

  try {
    unlinkSync(MULTI_STATE_FILE);
  } catch {
    // 이미 삭제됨 or 권한 문제 — 무시
  }
}

main();
