#!/usr/bin/env node
// hub/team/tui-viewer.mjs — worker state aggregator v5
// psmux capture-pane 기반 워커 상태 집계 + TUI 렌더링
// data ingest: ~2Hz (500ms), render: 8-12FPS (별도 루프)

import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLogDashboard } from "./tui.mjs";
import { createLiteDashboard } from "./tui-lite.mjs";
import { openHeadlessDashboardTarget } from "./dashboard-open.mjs";
import { processHandoff } from "./handoff.mjs";
import { statusBadge } from "./ansi.mjs";


// ── CLI 인자 파싱 ──
const args = process.argv.slice(2);
function argVal(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : null;
}

const SESSION    = argVal("--session");
const RESULT_DIR = argVal("--result-dir") ?? join(tmpdir(), "tfx-headless");
const LAYOUT     = argVal("--layout") ?? "single";

if (!SESSION) {
  process.stderr.write(
    "Usage: node tui-viewer.mjs --session <name> [--result-dir <dir>] [--layout <name>]\n",
  );
  process.exit(1);
}

try {
  execFileSync("psmux", ["--version"], { encoding: "utf8", timeout: 2000 });
} catch {
  process.stderr.write(
    "ERROR: psmux 미설치. 설치: winget install marlocarlo.psmux (또는 npm i -g psmux)\n",
  );
  process.exit(1);
}

// ── 메모리 보호 상수 ──
const MAX_BODY_BYTES = 10240;

// ── TUI 초기화 ──
// WT pane에서 spawn 시 process.stdout.isTTY=false일 수 있음
// forceTTY 시 alternate screen이 WT pane에서 렌더링 안 되는 문제 → append-only 유지
const tuiFactory = LAYOUT === "lite" ? createLiteDashboard : createLogDashboard;
const tui = tuiFactory({
  refreshMs: 0,          // render 루프를 직접 제어
  stream: process.stdout,
  input: process.stdin,
  columns: process.stdout.columns || parseInt(process.env.COLUMNS, 10) || 120,
  layout: LAYOUT,
  onOpenSelectedWorker: (workerName) => openHeadlessDashboardTarget(SESSION, {
    worker: workerName,
    openAll: false,
    cwd: process.cwd(),
  }),
  onOpenAllWorkers: () => openHeadlessDashboardTarget(SESSION, {
    openAll: true,
    cwd: process.cwd(),
  }),
});
const startTime = Date.now();
tui.setStartTime(startTime);

// ── 내부 raw data 누출 방지 패턴 ──
const INTERNAL_PATTERNS = [
  /\$trifluxExit/,
  /\.err\b/,
  /completion[-_]token/i,
  /^---\s*HANDOFF\s*---$/i,
];

function isInternalLine(line) {
  return INTERNAL_PATTERNS.some((re) => re.test(line));
}

// ── 코드블록 필터링 → filtered_body 생성 ──
function filterCodeBlocks(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/```[\s\S]*?(?:```|$)/gm, "\n")
    .replace(/^\s*```.*$/gm, "")
    .trim();
}

function toFilteredBody(text) {
  return filterCodeBlocks(text)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !isInternalLine(l))
    .filter((l) => !/^(PS\s|>|\$)\s*/.test(l))
    .join("\n");
}

function toLines(text) {
  return toFilteredBody(text).split("\n").filter(Boolean);
}

// ── 토큰 라벨 추출 ──
function extractTokenLabel(text) {
  const m = String(text || "").match(
    /(\d+(?:[.,]\d+)?\s*[kKmM]?)(?=\s*tokens?\s+used|\s*tokens?\b)/i,
  );
  return m ? m[1].replace(/\s+/g, "").toLowerCase() : "";
}

// ── findings 추출 ──
function extractFindings(lines, verdict = "") {
  return lines
    .map((l) => l.replace(/^verdict\s*:\s*/i, "").trim())
    .filter(Boolean)
    .filter(
      (l) =>
        !/^(status|lead_action|confidence|files_changed|detail|risk|error_stage|retryable|partial_output)\s*:/i.test(
          l,
        ),
    )
    .filter((l) => l !== verdict)
    .slice(-2);
}

// ── Phase 가중치 진행률 (Plan=10%, Research=30%, Exec=50%, Verify=10%) ──
const PHASE_WEIGHTS = {
  plan:    0.10,
  research:0.40,   // plan + research
  exec:    0.90,   // plan + research + exec
  verify:  1.00,
};

function estimateProgress(lines, context = {}) {
  if (context.done) return 1;

  const text = lines.join("\n").toLowerCase();
  let phase = "plan";

  if (/verify|assert|test|check|confirm/.test(text))       phase = "verify";
  else if (/edit|patch|implement|write|update|fix|refactor/.test(text)) phase = "exec";
  else if (/search|read|inspect|analy|review|research/.test(text))     phase = "research";

  let ratio = PHASE_WEIGHTS[phase];

  // 라인 수 기반 보정
  if (lines.length < 2) ratio = Math.min(ratio, 0.12);

  // 토큰 발생 시 최소 88%
  if (context.tokens) ratio = Math.max(ratio, 0.88);

  // 결과 파일 존재 or 쉘 복귀 → 완료로 간주
  if (context.resultSize > 10 || context.shellReturned) return 1;

  return Math.min(0.97, ratio);
}

// ── psmux 래퍼 ──
function listPanes() {
  try {
    const out = execFileSync(
      "psmux",
      ["list-panes", "-t", SESSION, "-F", "#{pane_index}:#{pane_title}:#{pane_pid}"],
      { encoding: "utf8", timeout: 2000 },
    );
    return out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [index, title, pid] = line.split(":");
        return { index: parseInt(index, 10), title: title || "", pid };
      });
  } catch {
    return [];
  }
}

function capturePane(paneIdx, lines = 20) {
  try {
    return execFileSync(
      "psmux",
      ["capture-pane", "-t", `${SESSION}:0.${paneIdx}`, "-p"],
      { encoding: "utf8", timeout: 2000 },
    )
      .trim()
      .split("\n")
      .slice(-lines)
      .join("\n");
  } catch {
    return "";
  }
}

function checkResultFile(paneName) {
  const resultFile = join(RESULT_DIR, `${SESSION}-${paneName}.txt`);
  if (!existsSync(resultFile)) return null;
  try {
    const content = readFileSync(resultFile, "utf8");
    if (!content.trim()) return null;
    return {
      resultFile,
      content,
      processed: processHandoff(content, { exitCode: 0, resultFile }),
    };
  } catch {
    return null;
  }
}

// ── 워커 상태 모델 ──
// 각 워커는 다음 필드를 가짐:
//   raw_body      — capture-pane 원시 텍스트
//   filtered_body — 코드블록 + 내부 패턴 제거된 텍스트
//   verdict       — 한 줄 결론
//   findings[]    — 주목할 라인 (최대 2)
//   handoff{}     — { status, lead_action, verdict, ... }
//   progress      — 0~1
//   activityAt    — 마지막 변경 타임스탬프
//   done          — boolean
function makeWorkerState(paneIdx) {
  return {
    paneIdx,
    done: false,
    raw_body: "",
    filtered_body: "",
    verdict: "",
    findings: [],
    handoff: null,
    progress: 0,
    activityAt: Date.now(),
    title: "",
    cli: "codex",
  };
}

// HANDOFF status / lead_action 분리
function splitHandoff(handoff) {
  if (!handoff) return { status: "pending", lead_action: null };
  return {
    status: handoff.status || "pending",
    lead_action: handoff.lead_action || null,
  };
}

// ── 상태 집계 저장소 ──
const workerState = new Map();   // paneName → 내부 상태
let emptyPollCount = 0;

// ── data ingest (4Hz = 250ms) ──
function ingest() {
  const panes = listPanes();

  if (!panes.some((p) => p.index !== 0)) {
    emptyPollCount++;
    const threshold = workerState.size === 0 ? 15 : 10;
    if (emptyPollCount >= threshold) {
      // 세션 종료 후에도 최종 결과 유지 — 키 입력 시 종료
      clearInterval(ingestTimer);
      clearInterval(renderTimer);
      tui.render();
      process.stdout.write("\n\x1b[38;5;245m  세션 종료됨 — 아무 키나 누르면 닫힘\x1b[0m");
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.once("data", () => { cleanup(); process.exit(0); });
      } else {
        setTimeout(() => { cleanup(); process.exit(0); }, 30000);
      }
      return;
    }
    return;
  }
  emptyPollCount = 0;

  for (const pane of panes) {
    if (pane.index === 0) continue;

    const paneName = `worker-${pane.index}`;
    let ws = workerState.get(paneName);
    if (!ws) {
      ws = makeWorkerState(pane.index);
      workerState.set(paneName, ws);
    }
    if (ws.done) continue;

    // CLI 타입 감지
    let cli = "codex";
    if (pane.title.includes("gemini") || pane.title.includes("🔵")) cli = "gemini";
    else if (pane.title.includes("claude") || pane.title.includes("🟠")) cli = "claude";
    ws.title = pane.title;
    ws.cli = cli;

    const resultData = checkResultFile(paneName);
    if (resultData?.processed && !resultData.processed.fallback) {
      // 결과 파일 처리 완료
      const raw = resultData.content;
      const filtered = toFilteredBody(raw);
      const lines = filtered.split("\n").filter(Boolean);
      const handoff = resultData.processed.handoff;
      const verdict = handoff.verdict || "completed";

      ws.done = true;
      ws.raw_body = raw;
      ws.filtered_body = filtered;
      ws.verdict = verdict;
      ws.findings = extractFindings(lines, verdict);
      ws.handoff = handoff;
      ws.progress = 1;
      ws.activityAt = Date.now();

      const { status, lead_action } = splitHandoff(handoff);
      pushToTui(paneName, cli, pane.title, {
        status: status === "failed" ? "failed" : "completed",
        handoff,
        summary: verdict,
        detail: filtered,
        findings: ws.findings,
        tokens: extractTokenLabel(raw),
        progress: 1,
        elapsed: Math.round((Date.now() - startTime) / 1000),
        _leadAction: lead_action,
      });
      continue;
    }

    // 스냅샷 기반 진행 중 상태
    const snapshot = capturePane(pane.index, 20);
    const raw_body = snapshot;
    const filtered_body = toFilteredBody(snapshot);
    const lines = filtered_body.split("\n").filter(Boolean);
    const lastLine = lines.at(-1) || "";

    const resultFile = join(RESULT_DIR, `${SESSION}-${paneName}.txt`);
    let resultSize = 0;
    try { resultSize = statSync(resultFile).size; } catch { /* missing */ }

    const shellReturned = /^(PS\s|>|\$)\s*/.test(lastLine) && lines.length > 2;
    const tokens = extractTokenLabel(snapshot);
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    if (resultSize > 10 || shellReturned) {
      const resultContent = existsSync(resultFile)
        ? readFileSync(resultFile, "utf8")
        : snapshot;
      const rLines = toLines(resultContent);
      const verdict = extractFindings(rLines).at(-1) || lastLine || "completed";
      const handoffStatus = /fail|error|exception/i.test(rLines.join("\n")) ? "failed" : "ok";
      const handoff = {
        status: handoffStatus,
        lead_action: handoffStatus === "failed" ? "retry" : "accept",
        verdict,
        confidence: tokens ? "high" : "medium",
        files_changed: [],
      };

      ws.done = true;
      ws.raw_body = resultContent;
      ws.filtered_body = toFilteredBody(resultContent);
      ws.verdict = verdict;
      ws.findings = extractFindings(rLines, verdict);
      ws.handoff = handoff;
      ws.progress = 1;
      ws.activityAt = Date.now();

      pushToTui(paneName, cli, pane.title, {
        status: handoffStatus === "failed" ? "failed" : "completed",
        handoff,
        summary: verdict,
        detail: ws.filtered_body,
        findings: ws.findings,
        tokens,
        progress: 1,
        elapsed,
      });
      continue;
    }

    // 진행 중
    const progress = estimateProgress(lines, { tokens, resultSize, shellReturned, done: false });
    const verdict = lastLine;

    ws.raw_body = raw_body.length > MAX_BODY_BYTES ? raw_body.slice(-MAX_BODY_BYTES) : raw_body;
    ws.filtered_body = filtered_body.length > MAX_BODY_BYTES ? filtered_body.slice(-MAX_BODY_BYTES) : filtered_body;
    ws.verdict = verdict;
    ws.findings = extractFindings(lines, lastLine);
    ws.progress = progress;
    ws.activityAt = Date.now();

    pushToTui(paneName, cli, pane.title, {
      status: "running",
      snapshot: lastLine,
      summary: lastLine,
      detail: filtered_body,
      findings: ws.findings,
      confidence: tokens ? "medium" : "low",
      tokens,
      progress,
      elapsed,
    });
  }
}

// ── tui.updateWorker 래퍼 — raw internal data 누출 방지 ──
function pushToTui(paneName, cli, paneTitle, update) {
  // _leadAction은 tui에 노출하지 않음 (내부용)
  const { _leadAction: _ignored, ...safeUpdate } = update;
  // pane title에서 실제 역할만 추출: "⚪ codex (executor)" → "executor"
  const roleMatch = paneTitle.match(/\(([^)]+)\)$/);
  const role = roleMatch ? roleMatch[1] : "";
  tui.updateWorker(paneName, { cli, role, ...safeUpdate });
}

// ── render 루프 (8-12FPS ≈ 100ms) ──
let renderTimer = null;
function startRender() {
  renderTimer = setInterval(() => { tui.render(); }, 100);
  if (renderTimer.unref) renderTimer.unref();
}

// ── 완료 감지 ──
const doneCheck = setInterval(() => {
  if (workerState.size > 0 && [...workerState.values()].every((w) => w.done)) {
    tui.render();
    clearInterval(doneCheck);
    clearInterval(ingestTimer);
    clearInterval(renderTimer);
    process.stdout.write("\n\x1b[38;5;245m  전체 완료 — 아무 키나 누르면 닫힘\x1b[0m");
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.once("data", () => { cleanup(); process.exit(0); });
    } else {
      setTimeout(() => { cleanup(); process.exit(0); }, 30000);
    }
  }
}, 2000);

// ── resize 대응 ──
process.stdout.on("resize", () => {
  tui.render();
});

// ── 정리 ──
function cleanup() {
  clearInterval(ingestTimer);
  clearInterval(renderTimer);
  clearInterval(doneCheck);
  tui.close();
}

// ── 진입점 ──
tui.render();
const ingestTimer = setInterval(ingest, 500);   // 2Hz
startRender();

// 타임아웃 (10분)
setTimeout(() => { cleanup(); process.exit(0); }, 10 * 60 * 1000);

// Ctrl-C
process.on("SIGINT", () => { cleanup(); process.exit(0); });
