// hub/team/headless.mjs — 헤드리스 CLI 오케스트레이션
// psmux pane에서 CLI를 헤드리스 모드로 실행하고 결과를 수집한다.
// v5.2.0: 기본 headless 엔진 (runHeadless, runHeadlessWithCleanup)
// v6.0.0: Lead-direct 모드 (runHeadlessInteractive, autoAttachTerminal)
// 의존성: psmux.mjs (Node.js 내장 모듈만 사용)
import { join } from "node:path";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync, execFileSync } from "node:child_process";
import {
  createPsmuxSession,
  killPsmuxSession,
  psmuxSessionExists,
  dispatchCommand,
  waitForCompletion,
  capturePsmuxPane,
  startCapture,
  psmuxExec,
} from "./psmux.mjs";

const RESULT_DIR = join(tmpdir(), "tfx-headless");

/**
 * CLI별 헤드리스 명령 빌더
 * @param {'codex'|'gemini'|'claude'} cli
 * @param {string} prompt — 실행할 프롬프트
 * @param {string} resultFile — 결과 저장 파일 경로
 * @returns {string} PowerShell 명령
 */
export function buildHeadlessCommand(cli, prompt, resultFile) {
  // 프롬프트의 단일 인용부호를 이스케이프
  const escaped = prompt.replace(/'/g, "''");

  switch (cli) {
    case "codex":
      return `codex exec '${escaped}' -o '${resultFile}' --color never`;
    case "gemini":
      return `gemini -p '${escaped}' -o text > '${resultFile}' 2>'${resultFile}.err'`;
    case "claude":
      return `claude -p '${escaped}' --output-format text > '${resultFile}' 2>&1`;
    default:
      throw new Error(`지원하지 않는 CLI: ${cli}`);
  }
}

/**
 * 결과 파일 읽기 (없으면 capture-pane fallback)
 * @param {string} resultFile
 * @param {string} paneId
 * @returns {string}
 */
function readResult(resultFile, paneId) {
  if (existsSync(resultFile)) {
    return readFileSync(resultFile, "utf8").trim();
  }
  // fallback: capture-pane (paneId = "tfx:0.1" 형태)
  return capturePsmuxPane(paneId, 30);
}

/**
 * 헤드리스 CLI 오케스트레이션 실행
 *
 * @param {string} sessionName — psmux 세션 이름
 * @param {Array<{cli: string, prompt: string, role?: string}>} assignments
 * @param {object} [opts]
 * @param {number} [opts.timeoutSec=300] — 각 워커 타임아웃
 * @param {string} [opts.layout='2x2'] — pane 레이아웃
 * @param {(event: object) => void} [opts.onProgress] — 진행 콜백
 * @param {number} [opts.progressIntervalSec=0] — N초마다 progress 이벤트 발화 (0=비활성)
 * @param {boolean} [opts.progressive=true] — true면 pane을 하나씩 split-window로 추가 (실시간 스플릿)
 * @returns {{ sessionName: string, results: Array<{cli: string, paneName: string, matched: boolean, exitCode: number|null, output: string, sessionDead?: boolean}> }}
 */
export async function runHeadless(sessionName, assignments, opts = {}) {
  const {
    timeoutSec = 300,
    layout = "2x2",
    onProgress,
    progressIntervalSec = 0,
    progressive = true,
  } = opts;

  mkdirSync(RESULT_DIR, { recursive: true });

  // onProgress 예외를 삼켜 실행 흐름 보호 (onPoll과 동일 패턴)
  const safeProgress = onProgress
    ? (event) => { try { onProgress(event); } catch { /* 콜백 예외 삼킴 */ } }
    : null;

  let dispatches;

  if (progressive) {
    // ─── 실시간 스플릿 모드: lead pane만 생성 후, 워커를 하나씩 추가 ───
    const session = createPsmuxSession(sessionName, { layout, paneCount: 1 });
    applyTrifluxTheme(sessionName);
    if (safeProgress) safeProgress({ type: "session_created", sessionName, panes: session.panes });

    dispatches = assignments.map((assignment, i) => {
      const paneName = `worker-${i + 1}`;
      const paneTitle = assignment.role
        ? `${assignment.cli} (${assignment.role})`
        : `${assignment.cli}-${i + 1}`;

      // split-window로 새 pane 추가 — paneId 직접 획득
      const newPaneId = psmuxExec([
        "split-window", "-t", sessionName, "-P", "-F",
        "#{session_name}:#{window_index}.#{pane_index}",
      ]);

      // 타이틀 설정
      try { psmuxExec(["select-pane", "-t", newPaneId, "-T", paneTitle]); } catch { /* 무시 */ }

      if (safeProgress) safeProgress({ type: "worker_added", paneName, cli: assignment.cli, paneTitle });

      // 캡처 시작 + 명령 dispatch (paneId 직접 사용 — resolvePane race 회피)
      const resultFile = join(RESULT_DIR, `${sessionName}-${paneName}.txt`).replace(/\\/g, "/");
      const cmd = buildHeadlessCommand(assignment.cli, assignment.prompt, resultFile);
      startCapture(sessionName, newPaneId);
      const dispatch = dispatchCommand(sessionName, newPaneId, cmd);

      if (safeProgress) safeProgress({ type: "dispatched", paneName, cli: assignment.cli });

      return { ...dispatch, paneId: newPaneId, paneName, resultFile, cli: assignment.cli, role: assignment.role };
    });

    // 모든 split 완료 후 레이아웃 한 번만 정렬 (깜빡임 방지)
    try { psmuxExec(["select-layout", "-t", sessionName, "tiled"]); } catch { /* 무시 */ }

  } else {
    // ─── 기존 모드: 모든 pane을 한 번에 생성 ───
    const paneCount = assignments.length + 1;
    // A2b fix: 2x2 레이아웃은 최대 4 pane — 초과 시 tiled로 자동 전환
    const effectiveLayout = (layout === "2x2" && paneCount > 4) ? "tiled" : layout;
    const session = createPsmuxSession(sessionName, { layout: effectiveLayout, paneCount });
    applyTrifluxTheme(sessionName);
    if (safeProgress) safeProgress({ type: "session_created", sessionName, panes: session.panes });

    dispatches = assignments.map((assignment, i) => {
      const paneName = `worker-${i + 1}`;
      const resultFile = join(RESULT_DIR, `${sessionName}-${paneName}.txt`).replace(/\\/g, "/");
      const cmd = buildHeadlessCommand(assignment.cli, assignment.prompt, resultFile);
      const dispatch = dispatchCommand(sessionName, paneName, cmd);

      // P1 fix: 비-progressive에서는 pane 리네임 금지 — 캡처 로그 경로가 타이틀 기반이므로
      // 리네임하면 waitForCompletion이 "codex (role).log"를 찾지만 실제는 "worker-N.log"로 불일치
      // progressive 모드에서는 split-window 시 새 pane에 바로 타이틀이 설정되므로 문제없음

      if (safeProgress) safeProgress({ type: "dispatched", paneName, cli: assignment.cli });

      return { ...dispatch, paneName, resultFile, cli: assignment.cli, role: assignment.role };
    });
  }

  // 병렬 대기 (Promise.all — 모든 pane 동시 폴링, 총 시간 = max(개별 시간))
  const results = await Promise.all(dispatches.map(async (d) => {
    // onPoll → onProgress 변환 (throttle by progressIntervalSec)
    const pollOpts = {};
    if (safeProgress && progressIntervalSec > 0) {
      let lastProgressAt = 0;
      const intervalMs = progressIntervalSec * 1000;
      pollOpts.onPoll = ({ content }) => {
        const now = Date.now();
        if (now - lastProgressAt >= intervalMs) {
          lastProgressAt = now;
          safeProgress({
            type: "progress",
            paneName: d.paneName,
            cli: d.cli,
            snapshot: content.split("\n").slice(-15).join("\n"), // 마지막 15줄
          });
        }
      };
    }

    // dispatch 시 확정된 logPath를 전달 — 셸이 pane 타이틀 변경해도 캡처 로그 매칭 유지
    if (d.logPath) pollOpts.logPath = d.logPath;
    const completion = await waitForCompletion(sessionName, d.paneId || d.paneName, d.token, timeoutSec, pollOpts);

    const output = completion.matched
      ? readResult(d.resultFile, d.paneId)
      : "";

    if (safeProgress) {
      safeProgress({
        type: "completed",
        paneName: d.paneName,
        cli: d.cli,
        matched: completion.matched,
        exitCode: completion.exitCode,
        sessionDead: completion.sessionDead || false,
      });
    }

    return {
      cli: d.cli,
      paneName: d.paneName,
      paneId: d.paneId,
      role: d.role,
      matched: completion.matched,
      exitCode: completion.exitCode,
      output,
      sessionDead: completion.sessionDead || false,
    };
  }));

  return { sessionName, results };
}

/**
 * 헤드리스 실행 + 자동 정리
 * 성공/실패에 관계없이 세션을 정리한다.
 *
 * @param {Array<{cli: string, prompt: string, role?: string}>} assignments
 * @param {object} [opts] — runHeadless opts + sessionPrefix
 * @returns {{ results: Array, sessionName: string }}
 */
export async function runHeadlessWithCleanup(assignments, opts = {}) {
  const { sessionPrefix = "tfx-hl", ...runOpts } = opts;
  const sessionName = `${sessionPrefix}-${Date.now().toString(36).slice(-6)}`;

  try {
    return await runHeadless(sessionName, assignments, runOpts);
  } finally {
    try {
      killPsmuxSession(sessionName);
    } catch {
      // 이미 종료된 세션 — 무시
    }
  }
}

// ─── v6.0.0: Theme + Visual ───

/**
 * psmux 세션에 triflux 테마를 적용한다.
 * status bar + pane border 색상 + 브랜딩.
 *
 * @param {string} sessionName
 */
export function applyTrifluxTheme(sessionName) {
  const opts = [
    // Status bar — Catppuccin Mocha 기반
    ["status-style", "bg=#1e1e2e,fg=#cdd6f4"],
    ["status-left", " #[fg=#89b4fa,bold]▲ triflux#[default] "],
    ["status-left-length", "20"],
    ["status-right", " #[fg=#a6adc8]#{pane_title}#[default] │ #[fg=#f9e2af]%H:%M#[default] "],
    ["status-right-length", "40"],
    // Pane border — active/inactive 구분
    ["pane-active-border-style", "fg=#89b4fa"],
    ["pane-border-style", "fg=#45475a"],
    // Status bar 위치
    ["status-position", "bottom"],
    // 셸이 pane 타이틀을 변경하는 것 방지 (캡처 로그 경로 안정성)
    ["allow-rename", "off"],
  ];
  for (const [key, value] of opts) {
    try { psmuxExec(["set-option", "-t", sessionName, key, value]); } catch { /* 무시 */ }
  }
}

// ─── v6.0.0: Lead-Direct Interactive Mode ───

/**
 * Windows Terminal에서 psmux 세션을 자동 attach한다.
 * 별도 창이 열리며 사용자가 실시간으로 CLI 출력을 볼 수 있다.
 *
 * @param {string} sessionName — attach할 psmux 세션 이름
 * @param {object} [opts]
 * @param {string} [opts.position] — "right" | "left" | 없으면 기본 위치
 * @returns {boolean} 성공 여부
 */
export function autoAttachTerminal(sessionName, opts = {}) {
  try {
    // Windows Terminal이 설치되어 있는지 확인
    execSync("where wt.exe", { stdio: "ignore" });
  } catch {
    return false; // wt.exe 미설치 — 사용자에게 수동 attach 안내 필요
  }

  // PowerShell 래핑 — wt가 psmux를 파일로 인식하는 문제 방지
  // "--" 구분자 필수: -NoExit 등이 wt 옵션으로 해석되는 것 방지
  // pwsh.exe (PS7) 우선, 없으면 powershell.exe (PS5.1) fallback
  const shells = ["pwsh.exe", "powershell.exe"];
  for (const shell of shells) {
    try {
      execFileSync("wt.exe", [
        "nt", "--title", "triflux", "--",
        shell, "-NoExit", "-Command",
        `psmux attach -t ${sessionName}`,
      ], { stdio: "ignore" });
      return true;
    } catch { /* 다음 shell 시도 */ }
  }
  return false;
}

/**
 * 모든 워커 pane의 현재 스냅샷을 수집한다.
 *
 * @param {string} sessionName
 * @param {Array<{paneId: string, paneName: string, cli: string}>} dispatches
 * @param {number} [lines=15] — 각 pane에서 캡처할 줄 수
 * @returns {Array<{paneName: string, cli: string, snapshot: string}>}
 */
export function getProgressSnapshots(sessionName, dispatches, lines = 15) {
  if (!psmuxSessionExists(sessionName)) return [];
  return dispatches.map((d) => {
    try {
      const snapshot = capturePsmuxPane(d.paneId, lines);
      return { paneName: d.paneName, cli: d.cli, snapshot };
    } catch {
      return { paneName: d.paneName, cli: d.cli, snapshot: "(캡처 실패)" };
    }
  });
}

/**
 * Lead-Direct Interactive 헤드리스 실행.
 * 세션을 유지하면서 결과 수집 후에도 추가 명령을 dispatch할 수 있다.
 * 반환된 handle의 kill()을 반드시 호출하여 세션을 정리해야 한다.
 *
 * @param {string} sessionName — psmux 세션 이름
 * @param {Array<{cli: string, prompt: string, role?: string}>} assignments
 * @param {object} [opts]
 * @param {number} [opts.timeoutSec=300]
 * @param {string} [opts.layout='2x2']
 * @param {(event: object) => void} [opts.onProgress]
 * @param {number} [opts.progressIntervalSec=0]
 * @param {boolean} [opts.autoAttach=false] — Windows Terminal 자동 attach
 * @param {AbortSignal} [opts.signal] — abort 시 자동 세션 정리
 * @param {number} [opts.maxIdleSec=0] — 유휴 시 자동 정리 (0=비활성)
 * @returns {Promise<{
 *   sessionName: string,
 *   results: Array,
 *   dispatches: Array,
 *   dispatch: (paneName: string, command: string) => {paneId: string, paneName: string, token: string},
 *   capture: (paneName: string, lines?: number) => string,
 *   snapshots: (lines?: number) => Array,
 *   waitFor: (paneName: string, token: string, timeoutSec?: number, opts?: object) => Promise,
 *   alive: () => boolean,
 *   kill: () => void,
 * }>}
 */
export async function runHeadlessInteractive(sessionName, assignments, opts = {}) {
  const {
    autoAttach = false,
    signal,
    maxIdleSec = 0,
    ...runOpts
  } = opts;

  // autoAttach를 session_created 시점에 트리거 (CLI 실행 전에 터미널 열림)
  const userOnProgress = runOpts.onProgress;
  let terminalAttached = false;
  runOpts.onProgress = (event) => {
    if (autoAttach && event.type === "session_created" && !terminalAttached) {
      terminalAttached = true;
      autoAttachTerminal(sessionName);
    }
    if (userOnProgress) userOnProgress(event);
  };

  // Phase 1: 세션 생성 → 즉시 터미널 팝업 → dispatch → 대기 → 결과 수집
  const { results } = await runHeadless(sessionName, assignments, runOpts);

  // Phase 2: 세션을 유지하고 interactive handle 반환
  // Fix P2: paneId를 dispatches에 포함 (snapshots에서 필요)
  const dispatches = results.map((r, i) => ({
    paneName: r.paneName,
    paneId: r.paneId || "",
    cli: r.cli,
    role: r.role,
  }));

  // Fix P2: maxIdleSec 리셋을 위한 타이머 관리
  let idleTimer = null;
  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    if (maxIdleSec > 0) {
      idleTimer = setTimeout(() => handle.kill(), maxIdleSec * 1000);
      if (idleTimer.unref) idleTimer.unref();
    }
  }

  const handle = {
    sessionName,
    results,
    dispatches,
    _killed: false,

    /** 특정 pane에 후속 명령 dispatch (캡처 자동 재시작) */
    dispatch(paneName, command) {
      if (this._killed) throw new Error("세션이 이미 종료되었습니다.");
      try { startCapture(sessionName, paneName); } catch { /* 이미 활성 — 무시 */ }
      resetIdleTimer();
      return dispatchCommand(sessionName, paneName, command);
    },

    /** 특정 pane의 현재 출력 캡처 */
    capture(paneName, lines = 30) {
      if (this._killed) return "";
      try {
        // Fix P2: paneName으로 resolvePane을 경유하여 정확한 paneId 획득
        return capturePsmuxPane(paneName, lines);
      } catch {
        return "(캡처 실패)";
      }
    },

    /** 모든 pane 스냅샷 */
    snapshots(lines = 15) {
      if (this._killed) return [];
      return getProgressSnapshots(sessionName, dispatches, lines);
    },

    /** 특정 pane에서 완료 대기 */
    async waitFor(paneName, token, timeoutSec = 300, waitOpts = {}) {
      if (this._killed) return { matched: false, sessionDead: true };
      resetIdleTimer();
      return waitForCompletion(sessionName, paneName, token, timeoutSec, waitOpts);
    },

    /** 세션 생존 확인 */
    alive() {
      if (this._killed) return false;
      return psmuxSessionExists(sessionName);
    },

    /** 세션 종료 */
    kill() {
      if (this._killed) return;
      this._killed = true;
      try { killPsmuxSession(sessionName); } catch { /* 무시 */ }
    },
  };

  // AbortController signal로 자동 정리
  if (signal) {
    if (signal.aborted) {
      handle.kill();
    } else {
      signal.addEventListener("abort", () => handle.kill(), { once: true });
    }
  }

  // 유휴 타임아웃 자동 정리
  if (maxIdleSec > 0) {
    const timer = setTimeout(() => handle.kill(), maxIdleSec * 1000);
    if (timer.unref) timer.unref(); // Node.js exit를 방해하지 않음
  }

  // 프로세스 종료 시 safety net
  const exitHandler = () => handle.kill();
  process.on("exit", exitHandler);
  // kill() 후 리스너 제거를 위해 참조 보관
  const originalKill = handle.kill.bind(handle);
  handle.kill = function () {
    originalKill();
    process.removeListener("exit", exitHandler);
  };

  return handle;
}
