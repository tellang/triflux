// hub/team/headless.mjs — 헤드리스 CLI 오케스트레이션
// psmux pane에서 CLI를 헤드리스 모드로 실행하고 결과를 수집한다.
// v5.2.0: 기본 headless 엔진 (runHeadless, runHeadlessWithCleanup)
// v6.0.0: Lead-direct 모드 (runHeadlessInteractive, autoAttachTerminal)
// 의존성: psmux.mjs (Node.js 내장 모듈만 사용)
import { join } from "node:path";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
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
      return `gemini -p '${escaped}' -o text > '${resultFile}' 2>$null`;
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
 * @returns {{ sessionName: string, results: Array<{cli: string, paneName: string, matched: boolean, exitCode: number|null, output: string, sessionDead?: boolean}> }}
 */
export async function runHeadless(sessionName, assignments, opts = {}) {
  const {
    timeoutSec = 300,
    layout = "2x2",
    onProgress,
    progressIntervalSec = 0,
  } = opts;

  mkdirSync(RESULT_DIR, { recursive: true });
  const paneCount = assignments.length + 1; // +1 for lead pane (unused but reserved)
  const session = createPsmuxSession(sessionName, { layout, paneCount });

  if (onProgress) onProgress({ type: "session_created", sessionName, panes: session.panes });

  // 각 워커 pane에 헤드리스 명령 dispatch + pane 타이틀 설정
  const dispatches = assignments.map((assignment, i) => {
    const paneName = `worker-${i + 1}`;
    const resultFile = join(RESULT_DIR, `${sessionName}-${paneName}.txt`).replace(/\\/g, "/");
    const cmd = buildHeadlessCommand(assignment.cli, assignment.prompt, resultFile);
    const dispatch = dispatchCommand(sessionName, paneName, cmd);

    // pane 타이틀을 "codex (reviewer)" 형태로 설정 — 시각적 구분
    const paneTitle = assignment.role
      ? `${assignment.cli} (${assignment.role})`
      : `${assignment.cli}-${i + 1}`;
    try { psmuxExec(["select-pane", "-t", dispatch.paneId, "-T", paneTitle]); } catch { /* 무시 */ }

    if (onProgress) onProgress({ type: "dispatched", paneName, cli: assignment.cli });

    return { ...dispatch, paneName, resultFile, cli: assignment.cli, role: assignment.role };
  });

  // 병렬 대기 (Promise.all — 모든 pane 동시 폴링, 총 시간 = max(개별 시간))
  const results = await Promise.all(dispatches.map(async (d) => {
    // onPoll → onProgress 변환 (throttle by progressIntervalSec)
    const pollOpts = {};
    if (onProgress && progressIntervalSec > 0) {
      let lastProgressAt = 0;
      const intervalMs = progressIntervalSec * 1000;
      pollOpts.onPoll = ({ content }) => {
        const now = Date.now();
        if (now - lastProgressAt >= intervalMs) {
          lastProgressAt = now;
          onProgress({
            type: "progress",
            paneName: d.paneName,
            cli: d.cli,
            snapshot: content.split("\n").slice(-15).join("\n"), // 마지막 15줄
          });
        }
      };
    }

    const completion = await waitForCompletion(sessionName, d.paneName, d.token, timeoutSec, pollOpts);

    const output = completion.matched
      ? readResult(d.resultFile, d.paneId)
      : "";

    if (onProgress) {
      onProgress({
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

  try {
    // wt.exe new-tab: 새 탭에서 psmux attach 실행
    execSync(`wt.exe -w 0 nt psmux attach -t ${sessionName}`, { stdio: "ignore" });
    return true;
  } catch {
    // fallback: 새 창으로 시도
    try {
      execSync(`start wt.exe psmux attach -t ${sessionName}`, { stdio: "ignore", shell: true });
      return true;
    } catch {
      return false;
    }
  }
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
  const dispatches = assignments.map((a, i) => ({
    paneName: `worker-${i + 1}`,
    cli: a.cli,
    role: a.role,
  }));

  const handle = {
    sessionName,
    results,
    dispatches,
    _killed: false,

    /** 특정 pane에 후속 명령 dispatch (캡처 자동 재시작) */
    dispatch(paneName, command) {
      if (this._killed) throw new Error("세션이 이미 종료되었습니다.");
      // 후속 dispatch 시 캡처 로그가 없을 수 있음 (pane title 변경 등)
      try { startCapture(sessionName, paneName); } catch { /* 이미 활성 — 무시 */ }
      return dispatchCommand(sessionName, paneName, command);
    },

    /** 특정 pane의 현재 출력 캡처 */
    capture(paneName, lines = 30) {
      if (this._killed) return "";
      try {
        return capturePsmuxPane(
          // psmux는 세션:pane 형태로 resolve
          `${sessionName}:${paneName}`,
          lines,
        );
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
