#!/usr/bin/env node
// hub/team/tui-viewer.mjs — psmux pane용 append-only 로그 뷰어 v3
// 같은 psmux 세션의 워커 pane을 capture-pane으로 모니터링한다.

import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLogDashboard } from "./tui.mjs";
import { processHandoff } from "./handoff.mjs";

const args = process.argv.slice(2);
const sessionIdx = args.indexOf("--session");
const resultDirIdx = args.indexOf("--result-dir");
const SESSION = sessionIdx >= 0 ? args[sessionIdx + 1] : null;
const RESULT_DIR = resultDirIdx >= 0
  ? args[resultDirIdx + 1]
  : join(tmpdir(), "tfx-headless");

if (!SESSION) {
  process.stderr.write("Usage: node tui-viewer.mjs --session <name>\n");
  process.exit(1);
}

// ── psmux 존재 확인 ──
try {
  execFileSync("psmux", ["--version"], { encoding: "utf8", timeout: 2000 });
} catch {
  process.stderr.write("ERROR: psmux not found or not executable. Install psmux before running tui-viewer.\n");
  process.exit(1);
}

const tui = createLogDashboard({ refreshMs: 0 });
const startTime = Date.now();
tui.setStartTime(startTime);

// ── psmux pane 목록 조회 ──
function listPanes() {
  try {
    const out = execFileSync("psmux", [
      "list-panes", "-t", SESSION, "-F",
      "#{pane_index}:#{pane_title}:#{pane_pid}",
    ], { encoding: "utf8", timeout: 2000 });
    return out.trim().split("\n").filter(Boolean).map(line => {
      const [index, title, pid] = line.split(":");
      return { index: parseInt(index, 10), title: title || "", pid };
    });
  } catch {
    // psmux 미설치 또는 세션 없음 — 빈 목록 반환
    return [];
  }
}

// ── pane 캡처 ──
function capturePane(paneIdx, lines = 5) {
  try {
    return execFileSync("psmux", [
      "capture-pane", "-t", `${SESSION}:0.${paneIdx}`, "-p",
    ], { encoding: "utf8", timeout: 2000 }).trim().split("\n").slice(-lines).join("\n");
  } catch {
    // pane 캡처 실패 (pane 종료 또는 세션 소멸) — 빈 문자열 반환
    return "";
  }
}

// ── result 파일에서 handoff 파싱 ──
function checkResultFile(paneName) {
  const resultFile = join(RESULT_DIR, `${SESSION}-${paneName}.txt`);
  if (!existsSync(resultFile)) return null;
  try {
    const content = readFileSync(resultFile, "utf8");
    if (content.trim().length === 0) return null;
    return processHandoff(content, { exitCode: 0, resultFile });
  } catch {
    // result 파일 파싱 실패 — null 반환하여 진행 중으로 처리
    return null;
  }
}

// ── 메인 폴링 ──
const POLL_MS = 1000;
const workerState = new Map(); // paneName → { paneIdx, done }

function poll() {
  const panes = listPanes();
  // pane 0 = 대시보드 (자기 자신), pane 1+ = 워커
  for (const pane of panes) {
    if (pane.index === 0) continue; // 자기 자신 건너뜀
    const paneName = `worker-${pane.index}`;
    const existing = workerState.get(paneName);

    if (existing?.done) continue;

    // CLI 타입 추정 (pane title에서)
    let cli = "codex";
    if (pane.title.includes("gemini") || pane.title.includes("🔵")) cli = "gemini";
    else if (pane.title.includes("claude") || pane.title.includes("🟠")) cli = "claude";

    // result 파일 확인 (완료 여부)
    const handoffResult = checkResultFile(paneName);
    if (handoffResult && !handoffResult.fallback) {
      workerState.set(paneName, { paneIdx: pane.index, done: true });
      tui.updateWorker(paneName, {
        cli,
        role: pane.title,
        status: handoffResult.handoff.status === "failed" ? "failed" : "completed",
        handoff: handoffResult.handoff,
        elapsed: Math.round((Date.now() - startTime) / 1000),
      });
      continue;
    }

    // 진행 중 — pane 캡처로 스냅샷
    const snapshot = capturePane(pane.index, 5);
    const lines = snapshot.split("\n").filter(l => l.trim());
    const lastLine = lines.pop() || "";

    if (!existing) {
      workerState.set(paneName, { paneIdx: pane.index, done: false });
    }

    // 완료 감지: (1) result 파일 존재, (2) 셸 프롬프트 복귀, (3) "tokens used" 텍스트
    const resultFile = join(RESULT_DIR, `${SESSION}-${paneName}.txt`);
    let resultSize = 0;
    try { resultSize = statSync(resultFile).size; } catch { /* 파일 미존재 — size 0 유지 */ }

    const shellReturned = /^(PS\s|>|\$)\s*/.test(lastLine) && lines.length > 2;
    const tokensLine = lines.find(l => /tokens?\s+used/i.test(l));

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    if (resultSize > 10 || shellReturned) {
      workerState.set(paneName, { paneIdx: pane.index, done: true });
      const meaningful = lines.filter((l) => !(/^(PS\s|>|\$)/.test(l)) && !(/tokens?\s+used/i.test(l)));
      const verdict = meaningful.pop()?.slice(0, 80) || "completed";
      tui.updateWorker(paneName, {
        cli,
        role: pane.title,
        status: "completed",
        handoff: { verdict, confidence: tokensLine ? "high" : "low" },
        elapsed,
      });
    } else {
      const meaningful = lines.filter(l => !(/^(PS\s|>|\$)/.test(l)));
      const snap = meaningful.pop()?.slice(0, 60) || lastLine.slice(0, 60);
      tui.updateWorker(paneName, { cli, role: pane.title, status: "running", snapshot: snap, elapsed });
    }
  }

  tui.render();
}

// 초기 렌더
tui.render();

const timer = setInterval(poll, POLL_MS);

// 모든 워커 완료 → 15초 유지 후 종료
const doneCheck = setInterval(() => {
  if (workerState.size > 0 && [...workerState.values()].every(w => w.done)) {
    tui.render();
    clearInterval(doneCheck);
    setTimeout(() => { tui.close(); clearInterval(timer); process.exit(0); }, 15000);
  }
}, 2000);

process.on("SIGINT", () => { tui.close(); clearInterval(timer); clearInterval(doneCheck); process.exit(0); });
setTimeout(() => { tui.close(); clearInterval(timer); clearInterval(doneCheck); process.exit(0); }, 10 * 60 * 1000);
