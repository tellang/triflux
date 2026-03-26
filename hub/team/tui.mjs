// hub/team/tui.mjs — Append-only 로그 대시보드 (v8)
// ANSI 색상은 유지하되 커서 이동/화면 덮어쓰기는 사용하지 않는다.

import { RESET, FG, color, dim, STATUS_ICON } from "./ansi.mjs";

// package.json에서 동적 로드 (실패 시 fallback)
let VERSION = "7.x";
try {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  VERSION = require("../../package.json").version;
} catch { /* fallback */ }

/**
 * 로그 스트림 대시보드 생성 (append-only)
 * @param {object} [opts]
 * @param {NodeJS.WriteStream} [opts.stream=process.stdout]
 * @param {number} [opts.refreshMs=1000] — 자동 렌더 주기 (0=수동만)
 * @returns {LogDashboardHandle}
 */
export function createLogDashboard(opts = {}) {
  const {
    stream = process.stdout,
    refreshMs = 1000,
  } = opts;

  const workers = new Map();
  let pipeline = { phase: "exec", fix_attempt: 0 };
  let startedAt = Date.now();
  let timer = null;
  let closed = false;
  let frameCount = 0;
  const lastLineByWorker = new Map();

  function out(text) { if (!closed) stream.write(`${text}\n`); }

  function nowElapsedSec() {
    return Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  }

  function elapsedLabel(sec) {
    return dim(`[${sec}s]`);
  }

  function oneLine(text, fallback = "n/a") {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (!normalized) return fallback;
    return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
  }

  function cliColor(cli) {
    if (cli === "gemini") return FG.gemini;
    if (cli === "claude") return FG.claude;
    if (cli === "codex") return FG.codex;
    return FG.white;
  }

  function statusLabel(status) {
    if (status === "completed") return color("completed", FG.green);
    if (status === "failed") return color("failed", FG.red);
    if (status === "running") return color("running", FG.blue);
    return dim(status || "pending");
  }

  function messageLabel(st) {
    if (st.handoff?.verdict) return oneLine(st.handoff.verdict, "completed");
    if (st.snapshot) return oneLine(st.snapshot, st.status || "running");
    if (st.status === "failed" && st.handoff?.lead_action) {
      return oneLine(`action=${st.handoff.lead_action}`, "failed");
    }
    return st.status || "pending";
  }

  function workerLine(name, st) {
    const status = st.status || "pending";
    const icon = STATUS_ICON[status] || STATUS_ICON.pending;
    const cli = st.cli || "codex";
    const cliLabel = `${cliColor(cli)}${cli}${RESET}`;
    const workerLabel = color(name, FG.triflux);
    const statusText = statusLabel(status);
    const message = messageLabel(st);
    const sec = Number.isFinite(st._logSec) ? st._logSec : nowElapsedSec();
    return `${elapsedLabel(sec)} ${icon} ${workerLabel} (${cliLabel}) ${statusText} ${dim("—")} ${message}`;
  }

  // 현재 상태와 마지막으로 출력한 라인을 비교해 변경분만 append
  function render() {
    if (closed) return;
    frameCount++;

    const names = [...workers.keys()].sort();
    for (const name of names) {
      const st = workers.get(name);
      const line = workerLine(name, st);
      if (line !== lastLineByWorker.get(name)) {
        lastLineByWorker.set(name, line);
        out(line);
      }
    }
  }

  if (refreshMs > 0) {
    timer = setInterval(render, refreshMs);
    if (timer.unref) timer.unref();
  }

  return {
    updateWorker(paneName, state) {
      const existing = workers.get(paneName) || { cli: "codex", status: "pending" };
      const merged = { ...existing, ...state };
      const nextSig = [
        merged.cli || "",
        merged.status || "",
        merged.snapshot || "",
        merged.handoff?.verdict || "",
      ].join("|");
      const sigChanged = nextSig !== existing._sig;
      const explicitElapsed = Number.isFinite(state.elapsed) ? Math.max(0, Math.round(state.elapsed)) : null;
      merged._sig = nextSig;
      merged._logSec = sigChanged
        ? (explicitElapsed ?? nowElapsedSec())
        : (Number.isFinite(existing._logSec) ? existing._logSec : (explicitElapsed ?? nowElapsedSec()));
      workers.set(paneName, merged);
    },
    updatePipeline(state) {
      pipeline = { ...pipeline, ...state };
    },
    setStartTime(ms) {
      startedAt = ms;
    },
    render,
    getWorkers() { return new Map(workers); },
    getFrameCount() { return frameCount; },
    getPipelineState() { return { ...pipeline }; },
    close() {
      if (closed) return;
      if (timer) clearInterval(timer);
      closed = true;
    },
  };
}

// 하위 호환
export { createLogDashboard as createTui };
