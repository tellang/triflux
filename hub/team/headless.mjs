// hub/team/headless.mjs — 헤드리스 CLI 오케스트레이션
// psmux pane에서 CLI를 헤드리스 모드로 실행하고 결과를 수집한다.
// 의존성: psmux.mjs (Node.js 내장 모듈만 사용)
import { join } from "node:path";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  createPsmuxSession,
  killPsmuxSession,
  psmuxSessionExists,
  dispatchCommand,
  waitForCompletion,
  capturePsmuxPane,
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
      return `gemini -p '${escaped}' -o text > '${resultFile}' 2>&1`;
    case "claude":
      return `claude -p '${escaped}' --output-format text > '${resultFile}' 2>&1`;
    default:
      throw new Error(`지원하지 않는 CLI: ${cli}`);
  }
}

/**
 * 결과 파일 읽기 (없으면 capture-pane fallback)
 * @param {string} resultFile
 * @param {string} sessionName
 * @param {string} paneName
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
 * @returns {{ sessionName: string, results: Array<{cli: string, paneName: string, matched: boolean, exitCode: number|null, output: string, sessionDead?: boolean}> }}
 */
export async function runHeadless(sessionName, assignments, opts = {}) {
  const {
    timeoutSec = 300,
    layout = "2x2",
    onProgress,
  } = opts;

  mkdirSync(RESULT_DIR, { recursive: true });
  const paneCount = assignments.length + 1; // +1 for lead pane (unused but reserved)
  const session = createPsmuxSession(sessionName, { layout, paneCount });

  if (onProgress) onProgress({ type: "session_created", sessionName, panes: session.panes });

  // 각 워커 pane에 헤드리스 명령 dispatch
  const dispatches = assignments.map((assignment, i) => {
    const paneName = `worker-${i + 1}`;
    const resultFile = join(RESULT_DIR, `${sessionName}-${paneName}.txt`).replace(/\\/g, "/");
    const cmd = buildHeadlessCommand(assignment.cli, assignment.prompt, resultFile);
    const dispatch = dispatchCommand(sessionName, paneName, cmd);

    if (onProgress) onProgress({ type: "dispatched", paneName, cli: assignment.cli });

    return { ...dispatch, paneName, resultFile, cli: assignment.cli, role: assignment.role };
  });

  // 병렬 대기 (Promise.all — 모든 pane 동시 폴링, 총 시간 = max(개별 시간))
  const results = await Promise.all(dispatches.map(async (d) => {
    const completion = await waitForCompletion(sessionName, d.paneName, d.token, timeoutSec);

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
