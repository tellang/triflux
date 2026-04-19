// hub/team/headless.mjs — 헤드리스 CLI 오케스트레이션
// psmux pane에서 CLI를 헤드리스 모드로 실행하고 결과를 수집한다.
// v5.2.0: 기본 headless 엔진 (runHeadless, runHeadlessWithCleanup)
// v6.0.0: Lead-direct 모드 (runHeadlessInteractive, autoAttachTerminal)
// 의존성: psmux.mjs (Node.js 내장 모듈만 사용)

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestJson } from "../bridge.mjs";
import { escapePwshSingleQuoted } from "../cli-adapter-base.mjs";
import { getMaxSpawnPerSec } from "../lib/spawn-trace.mjs";
import { IS_WINDOWS } from "../platform.mjs";
import { getBackend } from "./backend.mjs";
import { resolveDashboardLayout } from "./dashboard-layout.mjs";
import {
  formatHandoffForLead,
  HANDOFF_INSTRUCTION_SHORT,
  processHandoff,
} from "./handoff.mjs";
import {
  capturePsmuxPane,
  createPsmuxSession,
  dispatchCommand,
  killPsmuxSession,
  psmuxExec,
  psmuxSessionExists,
  startCapture,
  waitForCompletion,
} from "./psmux.mjs";
import {
  buildSynapseTaskSummary,
  registerSynapseSession,
  unregisterSynapseSession,
} from "./synapse-http.mjs";
import { createLogDashboard } from "./tui.mjs";
import { createWtManager } from "./wt-manager.mjs";

const RESULT_DIR = join(tmpdir(), "tfx-headless");

/** CLI별 브랜드 — 이모지 + 공식 색상 (HUD와 통일) */
const CLI_BRAND = {
  codex: { emoji: "\u{26AA}", label: "Codex", ansi: "\x1b[97m" }, // ⚪ bright white (codexWhite)
  gemini: { emoji: "\u{1F535}", label: "Gemini", ansi: "\x1b[38;5;39m" }, // 🔵 geminiBlue
  claude: {
    emoji: "\u{1F7E0}",
    label: "Claude",
    ansi: "\x1b[38;2;232;112;64m",
  }, // 🟠 claudeOrange
};
const _ANSI_RESET = "\x1b[0m";
const _ANSI_DIM = "\x1b[2m";

/** 에이전트 역할명 → CLI 타입 매핑 (단일 소스: agent-map.json) */
const _require = createRequire(import.meta.url);
const AGENT_TO_CLI = _require("./agent-map.json");

/**
 * 에이전트 역할명 또는 CLI 이름을 CLI 타입("codex"|"gemini"|"claude")으로 해석한다.
 * route_agent()가 적용되지 않는 headless 경로에서 사용.
 * @param {string} agentOrCli — "executor", "codex", "designer" 등
 * @returns {'codex'|'gemini'|'claude'} CLI 타입
 */
export function resolveCliType(agentOrCli) {
  return AGENT_TO_CLI[agentOrCli] || agentOrCli;
}

export function getHeadlessWorkerAgentId(sessionName, index) {
  return `headless-${sessionName}-${index}`;
}

export function getHeadlessLeadAgentId(sessionName) {
  return `headless-${sessionName}-lead`;
}

export async function registerHeadlessWorker(
  sessionName,
  index,
  cli,
  requestJsonFn = requestJson,
) {
  await requestJsonFn("/bridge/register", {
    body: {
      agentId: getHeadlessWorkerAgentId(sessionName, index),
      topics: ["headless.worker"],
      capabilities: [cli],
    },
  }).catch(() => {});
}

export async function publishHeadlessResult(
  sessionName,
  workerId,
  status,
  handoff,
  requestJsonFn = requestJson,
) {
  await requestJsonFn("/bridge/publish", {
    body: {
      from: getHeadlessLeadAgentId(sessionName),
      to: "topic:headless.results",
      type: "event",
      payload: { workerId, status, handoff },
    },
  }).catch(() => {});
}

export async function deregisterHeadlessWorkers(
  sessionName,
  workerCount,
  requestJsonFn = requestJson,
) {
  await Promise.all(
    Array.from({ length: workerCount }, (_, index) =>
      requestJsonFn("/bridge/deregister", {
        body: { agentId: getHeadlessWorkerAgentId(sessionName, index) },
      }).catch(() => {}),
    ),
  );
}

function registerHeadlessSynapseWorker(workerId, prompt) {
  registerSynapseSession({
    sessionId: workerId,
    host: "local",
    taskSummary: buildSynapseTaskSummary(prompt),
  });
}

function unregisterHeadlessSynapseWorker(workerId) {
  unregisterSynapseSession(workerId);
}

/** MCP 프로필별 프롬프트 힌트 (tfx-route.sh resolve_mcp_policy의 경량 미러) */
const MCP_PROFILE_HINTS = {
  implement:
    "You have full filesystem read/write access. Implement changes directly.",
  analyze:
    "Focus on reading and analyzing the codebase. Prefer analysis over modification.",
  review: "Review the code for quality, security, and correctness.",
  docs: "Focus on documentation and explanation tasks.",
};

/**
 * CLI별 헤드리스 명령 빌더
 * @param {'codex'|'gemini'|'claude'} cli
 * @param {string} prompt — 실행할 프롬프트
 * @param {string} resultFile — 결과 저장 파일 경로
 * @param {object} [opts]
 * @param {boolean} [opts.handoff=true]
 * @param {string} [opts.mcp] — MCP 프로필 ("implement"|"analyze"|"review"|"docs")
 * @param {string} [opts.contextFile] — 컨텍스트 파일 경로 (최대 32KB, UTF-8 안전 절단)
 * @returns {string} PowerShell 명령
 */
// ── Dashboard attach args for WT ────────────────────────────────

export function buildDashboardAttachArgs(
  sessionName,
  layout,
  workerCount,
  anchor = "window",
) {
  const safeName = String(sessionName).replace(/[^a-zA-Z0-9_-]/g, "");
  const base = anchor === "tab" ? ["-w", "0", "nt"] : ["-w", "new"];
  return [
    ...base,
    "--session",
    safeName,
    "--layout",
    layout,
    "--workers",
    String(workerCount),
  ];
}

export function buildHeadlessCommand(cli, prompt, resultFile, opts = {}) {
  const { handoff = true, mcp, contextFile, model, cwd } = opts;
  const resolvedCli = resolveCliType(cli);

  // contextFile 처리: 32KB(32768 bytes) 초과 시 UTF-8 안전 절단
  let contextPrefix = "";
  if (contextFile && existsSync(contextFile)) {
    let ctx = readFileSync(contextFile, "utf8");
    if (Buffer.byteLength(ctx, "utf8") > 32768) {
      ctx = Buffer.from(ctx).subarray(0, 32768).toString("utf8");
    }
    if (ctx.length > 0) {
      contextPrefix = `<prior_context>\n${ctx}\n</prior_context>\n\n`;
    }
  }

  const mcpHint =
    mcp && MCP_PROFILE_HINTS[mcp]
      ? ` [MCP: ${mcp}] ${MCP_PROFILE_HINTS[mcp]}`
      : "";
  // P2: HANDOFF 지시를 프롬프트에 삽입 (워커가 구조화된 handoff 블록을 출력하도록)
  const handoffHint = handoff ? `\n\n${HANDOFF_INSTRUCTION_SHORT}` : "";
  const fullPrompt = `${contextPrefix}${prompt}${mcpHint}${handoffHint}`;

  // 보안: 프롬프트를 임시 파일에 쓰고 파일 참조로 전달 (셸 주입 방지)
  if (!existsSync(RESULT_DIR)) mkdirSync(RESULT_DIR, { recursive: true });
  const promptFile = join(
    RESULT_DIR,
    "prompt-" + randomUUID().slice(0, 8) + ".txt",
  ).replace(/\\/g, "/");
  writeFileSync(promptFile, fullPrompt, "utf8");

  const backend = getBackend(resolvedCli);
  // 플랫폼 분기: PowerShell은 Get-Content, bash/zsh는 cat
  const promptExpr = IS_WINDOWS
    ? `(Get-Content -Raw '${promptFile}')`
    : `"$(cat '${promptFile.replace(/'/g, "'\\''")}')"`;
  const backendCommand = backend.buildArgs(promptExpr, resultFile, {
    ...opts,
    model,
  });
  const safeCwd =
    typeof cwd === "string" ? cwd.trim().replace(/[\r\n\x00-\x1f]/g, "") : "";
  if (safeCwd && (safeCwd.startsWith("\\\\") || safeCwd.startsWith("//"))) {
    throw new Error(
      "[headless] UNC 경로는 cwd로 사용할 수 없습니다: " + safeCwd,
    );
  }
  if (!safeCwd) return backendCommand;

  // 플랫폼 분기: PowerShell은 Set-Location, bash/zsh는 cd
  if (IS_WINDOWS) {
    return `Set-Location -LiteralPath '${escapePwshSingleQuoted(safeCwd)}'; ${backendCommand}`;
  }
  return `cd '${safeCwd.replace(/'/g, "'\\''")}' && ${backendCommand}`;
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
  // fallback 1: stderr 파일 (codex 실패 시 원인 추적)
  const errFile = `${resultFile}.err`;
  if (existsSync(errFile)) {
    const stderr = readFileSync(errFile, "utf8").trim();
    if (stderr) return `[stderr] ${stderr}`;
  }
  // fallback 2: capture-pane (paneId = "tfx:0.1" 형태)
  return capturePsmuxPane(paneId, 30);
}

// ─── Stall Detection ───

/** Stall detection 기본값 (immutable) */
export const STALL_DEFAULTS = Object.freeze({
  pollInterval: 5_000,
  stallTimeout: 120_000,
  completionTimeout: 900_000,
  maxRestarts: 2,
});

/** CLI pane stall 감지 에러 (STALL_EXHAUSTED | COMPLETION_TIMEOUT) */
export class StallError extends Error {
  constructor(
    message,
    { code = "STALL_DETECTED", category = "transient", recovery = "" } = {},
  ) {
    super(message);
    this.name = "StallError";
    this.code = code;
    this.category = category;
    this.recovery = recovery;
  }
}

/**
 * Stall 모니터 팩토리 — output + resultFile mtime 하이브리드 감지
 * @param {string} paneId
 * @param {string} resultFile
 * @param {{ stallTimeout: number }} config
 * @param {{ capturePsmuxPane?: Function, statSync?: Function }} [deps]
 * @returns {{ poll: () => { snapshot: string, mtimeChanged: boolean, stalled: boolean, elapsed: number } }}
 */
export function createStallMonitor(paneId, resultFile, config, deps = {}) {
  const capture = deps.capturePsmuxPane || capturePsmuxPane;
  const stat = deps.statSync || statSync;
  let lastSnapshot = "";
  let lastMtime = 0;
  let lastChangeAt = Date.now();

  try {
    lastMtime = stat(resultFile).mtimeMs;
  } catch {
    /* not created yet */
  }

  return Object.freeze({
    poll() {
      const snapshot = capture(paneId, 50);
      let currentMtime = 0;
      try {
        currentMtime = stat(resultFile).mtimeMs;
      } catch {
        /* ignore */
      }

      const outputChanged = snapshot !== lastSnapshot;
      const mtimeChanged = currentMtime > 0 && currentMtime !== lastMtime;

      if (outputChanged || mtimeChanged) {
        lastChangeAt = Date.now();
        lastSnapshot = snapshot;
        if (mtimeChanged) lastMtime = currentMtime;
      }

      const elapsed = Date.now() - lastChangeAt;
      return Object.freeze({
        snapshot,
        mtimeChanged,
        stalled: elapsed >= config.stallTimeout,
        elapsed,
      });
    },
  });
}

/**
 * 하이브리드 stall 감지 대기 — output 변화 + resultFile mtime 모니터링.
 * 2분 무변화 시 pane kill → re-dispatch (최대 2회 재시작).
 *
 * @param {string} sessionName
 * @param {string} paneId — 현재 pane 타겟 (예: "tfx:0.1")
 * @param {string} resultFile — 결과 저장 파일 경로
 * @param {object} [opts]
 * @param {number} [opts.pollInterval=5000] — 폴링 간격 ms
 * @param {number} [opts.stallTimeout=120000] — 무변화 stall 판정 ms
 * @param {number} [opts.completionTimeout=900000] — 전체 타임아웃 ms
 * @param {number} [opts.maxRestarts=2] — 최대 재시작 횟수
 * @param {string} [opts.command] — re-dispatch용 원본 명령
 * @param {string} [opts.token] — completion token
 * @param {(snapshot: string) => void} [opts.onPoll] — 폴링 콜백
 * @returns {Promise<{ matched: boolean, exitCode: number|null, restarts: number, stallDetected: boolean, paneId: string, token?: string, logPath?: string|null }>}
 */
export async function waitForCompletionWithStallDetect(
  sessionName,
  paneId,
  resultFile,
  opts = {},
) {
  const {
    pollInterval = 5000,
    stallTimeout = 120000,
    completionTimeout = 900000,
    maxRestarts = 2,
    command,
    token,
    onPoll,
    _deps,
  } = opts;

  // 의존성 (테스트 시 _deps로 주입 가능)
  const deps = _deps || {};
  const _capture = deps.capturePsmuxPane || capturePsmuxPane;
  const _exists = deps.existsSync || existsSync;
  const _stat = deps.statSync || statSync;
  const _readFile = deps.readFileSync || readFileSync;
  const _exec = deps.psmuxExec || psmuxExec;
  const _dispatch = deps.dispatchCommand || dispatchCommand;
  const _startCapture = deps.startCapture || startCapture;

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const buildCompletionRegex = (activeToken) => {
    const completionPatterns = [
      activeToken
        ? `${esc("__TRIFLUX_DONE__:")}${esc(activeToken)}:(\\d+)`
        : `${esc("__TRIFLUX_DONE__:")}\\S+:(\\d+)`,
      activeToken
        ? `${esc("TFX_DONE_")}${esc(activeToken)}:(\\d+)`
        : `${esc("TFX_DONE_")}\\S+:(\\d+)`,
    ];
    return new RegExp(completionPatterns.join("|"), "m");
  };

  let restarts = 0;
  let currentPaneId = paneId;
  let stallDetected = false;
  let currentToken = token;
  let currentLogPath = opts.logPath || null;

  while (true) {
    let lastOutput = "";
    let lastMtime = 0;
    let lastChangeAt = Date.now();
    const startedAt = Date.now();

    // 초기 resultFile mtime
    try {
      if (_exists(resultFile)) lastMtime = _stat(resultFile).mtimeMs;
    } catch {
      /* 무시 */
    }

    while (true) {
      await new Promise((r) => setTimeout(r, pollInterval));
      const now = Date.now();

      // 전체 타임아웃
      if (now - startedAt > completionTimeout) {
        return {
          matched: false,
          exitCode: null,
          restarts,
          stallDetected,
          timedOut: true,
          paneId: currentPaneId,
          token: currentToken,
          logPath: currentLogPath,
        };
      }

      // 1) capture-pane 출력 확인
      const currentOutput = _capture(currentPaneId, 50);
      if (onPoll) {
        try {
          onPoll(currentOutput);
        } catch {
          /* 삼킴 */
        }
      }

      // 2) completion 토큰 감지
      const completionRe = buildCompletionRegex(currentToken);
      const completionMatch = completionRe.exec(currentOutput);
      if (completionMatch) {
        return {
          matched: true,
          exitCode: Number.parseInt(
            completionMatch.slice(1).find(Boolean) || "0",
            10,
          ),
          restarts,
          stallDetected,
          timedOut: false,
          paneId: currentPaneId,
          token: currentToken,
          logPath: currentLogPath,
        };
      }

      // 3) resultFile 존재 + mtime 변화 확인
      let currentMtime = 0;
      try {
        if (_exists(resultFile)) currentMtime = _stat(resultFile).mtimeMs;
      } catch {
        /* 무시 */
      }

      // 4) 변화 감지 → stallTimer 리셋
      const outputChanged = currentOutput !== lastOutput;
      const mtimeChanged = currentMtime > 0 && currentMtime !== lastMtime;

      if (outputChanged || mtimeChanged) {
        lastChangeAt = now;
        lastOutput = currentOutput;
        if (mtimeChanged) lastMtime = currentMtime;
      }

      // resultFile이 갱신되고 내용이 있으면 완료로 간주
      if (mtimeChanged && currentMtime > 0 && _exists(resultFile)) {
        try {
          const content = _readFile(resultFile, "utf8").trim();
          if (content.length > 0) {
            return {
              matched: true,
              exitCode: 0,
              restarts,
              stallDetected,
              timedOut: false,
              paneId: currentPaneId,
              token: currentToken,
              logPath: currentLogPath,
            };
          }
        } catch {
          /* 무시 */
        }
      }

      // 5) stall 판정
      if (now - lastChangeAt >= stallTimeout) {
        stallDetected = true;

        if (restarts >= maxRestarts) {
          const err = new Error("CLI가 반복적으로 멈춤. 수동 확인 필요.");
          err.code = "STALL_EXHAUSTED";
          err.category = "transient";
          err.recovery = "CLI가 반복적으로 멈춤. 수동 확인 필요.";
          err.restarts = restarts;
          throw err;
        }

        // kill pane → re-dispatch
        try {
          _exec(["kill-pane", "-t", currentPaneId]);
        } catch {
          /* 이미 종료 */
        }

        if (command) {
          // 새 pane split + 동일 command re-dispatch
          const newPaneId = _exec([
            "split-window",
            "-t",
            sessionName,
            "-P",
            "-F",
            "#{session_name}:#{window_index}.#{pane_index}",
          ]);
          _startCapture(sessionName, newPaneId);
          const redispatch = _dispatch(sessionName, newPaneId, command);
          currentPaneId = redispatch?.paneId || newPaneId;
          if (redispatch?.token) currentToken = redispatch.token;
          if (redispatch?.logPath) currentLogPath = redispatch.logPath;
        }

        restarts++;
        break; // inner loop 재시작 (stallTimer 리셋)
      }
    }
  }
}

/** progressive 스플릿 모드: lead pane만 생성 후, 워커를 하나씩 추가하며 dispatch */
async function dispatchProgressive(sessionName, assignments, opts = {}) {
  const { layout, safeProgress, dashboardLayout = "single" } = opts;
  const resolvedDashboardLayout = resolveDashboardLayout(
    dashboardLayout,
    assignments.length,
  );
  const session = createPsmuxSession(sessionName, { layout, paneCount: 1 });
  applyTrifluxTheme(sessionName);
  if (safeProgress) {
    safeProgress({
      type: "session_created",
      sessionName,
      panes: session.panes,
      dashboardLayout: resolvedDashboardLayout,
    });
  }

  // dashboard: 워커 pane을 먼저 생성한 후 pane 0에 대시보드를 실행
  // (listPanes로 워커 감지가 가능하려면 워커 pane이 먼저 존재해야 함)

  const dispatches = [];
  for (let i = 0; i < assignments.length; i++) {
    const assignment = assignments[i];
    const paneName = `worker-${i + 1}`;
    const workerId = getHeadlessWorkerAgentId(sessionName, i);
    const resolvedCli = resolveCliType(assignment.cli);
    const brand = CLI_BRAND[resolvedCli] || {
      emoji: "\u{25CF}",
      label: resolvedCli,
      ansi: "",
    };
    const paneTitle = assignment.role
      ? `${brand.emoji} ${resolvedCli} (${assignment.role})`
      : `${brand.emoji} ${resolvedCli}-${i + 1}`;

    let newPaneId;
    // 모든 워커를 split-window로 생성 (lead pane index 0은 비워둠)
    // tui-viewer가 index 0을 건너뛰므로, 워커는 항상 index >= 1에 배치
    newPaneId = psmuxExec([
      "split-window",
      "-t",
      sessionName,
      "-P",
      "-F",
      "#{session_name}:#{window_index}.#{pane_index}",
    ]);

    // 타이틀 설정 (이모지 포함)
    try {
      psmuxExec(["select-pane", "-t", newPaneId, "-T", paneTitle]);
    } catch {
      /* 무시 */
    }
    await registerHeadlessWorker(sessionName, i, assignment.cli);

    if (safeProgress)
      safeProgress({
        type: "worker_added",
        paneName,
        cli: assignment.cli,
        paneTitle,
      });

    // 캡처 시작 + 컬러 배너 + 명령 dispatch
    const resultFile = join(
      RESULT_DIR,
      `${sessionName}-${paneName}.txt`,
    ).replace(/\\/g, "/");
    const cmd = buildHeadlessCommand(
      assignment.cli,
      assignment.prompt,
      resultFile,
      {
        mcp: assignment.mcp,
        model: assignment.model,
        cwd: assignment.cwd || assignment.workdir,
      },
    );
    startCapture(sessionName, newPaneId);
    // pane 간 pipe-pane EBUSY 방지 — 이벤트 루프 해방하며 순차 대기
    if (i > 0) await new Promise((r) => setTimeout(r, 300));
    const dispatch = dispatchCommand(sessionName, newPaneId, cmd);
    registerHeadlessSynapseWorker(workerId, assignment.prompt);

    if (safeProgress)
      safeProgress({ type: "dispatched", paneName, cli: assignment.cli });

    dispatches.push({
      ...dispatch,
      paneId: newPaneId,
      paneName,
      resultFile,
      cli: assignment.cli,
      role: assignment.role,
      command: cmd,
      workerId,
      cwd: assignment.cwd || assignment.workdir,
    });
  }

  // 모든 split 완료 후 레이아웃 한 번만 정렬 (깜빡임 방지)
  try {
    psmuxExec(["select-layout", "-t", sessionName, "tiled"]);
  } catch {
    /* 무시 */
  }

  // v7.1.3: psmux 내부 대시보드 pane 제거 — WT 스플릿에서 tui-viewer 직접 실행

  return dispatches;
}

/** 기존 batch 모드: 모든 pane을 한 번에 생성하여 dispatch */
async function dispatchBatch(sessionName, assignments, opts = {}) {
  const { layout, safeProgress, dashboardLayout = "single" } = opts;
  const paneCount = assignments.length + 1;
  const resolvedDashboardLayout = resolveDashboardLayout(
    dashboardLayout,
    assignments.length,
  );
  // A2b fix: 2x2 레이아웃은 최대 4 pane — 초과 시 tiled로 자동 전환
  const effectiveLayout = layout === "2x2" && paneCount > 4 ? "tiled" : layout;
  const session = createPsmuxSession(sessionName, {
    layout: effectiveLayout,
    paneCount,
  });
  applyTrifluxTheme(sessionName);
  if (safeProgress) {
    safeProgress({
      type: "session_created",
      sessionName,
      panes: session.panes,
      dashboardLayout: resolvedDashboardLayout,
    });
  }

  return await Promise.all(
    assignments.map(async (assignment, i) => {
      const paneName = `worker-${i + 1}`;
      const workerId = getHeadlessWorkerAgentId(sessionName, i);
      const resultFile = join(
        RESULT_DIR,
        `${sessionName}-${paneName}.txt`,
      ).replace(/\\/g, "/");
      const cmd = buildHeadlessCommand(
        assignment.cli,
        assignment.prompt,
        resultFile,
        {
          mcp: assignment.mcp,
          model: assignment.model,
          cwd: assignment.cwd || assignment.workdir,
        },
      );
      const scriptDir = join(RESULT_DIR, sessionName);
      await registerHeadlessWorker(sessionName, i, assignment.cli);
      const dispatch = dispatchCommand(sessionName, paneName, cmd, {
        scriptDir,
        scriptName: paneName,
      });
      registerHeadlessSynapseWorker(workerId, assignment.prompt);

      // P1 fix: 비-progressive에서는 pane 리네임 금지 — 캡처 로그 경로가 타이틀 기반이므로
      // 리네임하면 waitForCompletion이 "codex (role).log"를 찾지만 실제는 "worker-N.log"로 불일치
      // progressive 모드에서는 split-window 시 새 pane에 바로 타이틀이 설정되므로 문제없음

      if (safeProgress)
        safeProgress({ type: "dispatched", paneName, cli: assignment.cli });

      return {
        ...dispatch,
        paneName,
        resultFile,
        cli: assignment.cli,
        role: assignment.role,
        command: cmd,
        workerId,
        cwd: assignment.cwd || assignment.workdir,
      };
    }),
  );
}

/**
 * 모든 dispatch를 병렬 대기하며 완료 결과를 수집한다.
 * @param {string} sessionName
 * @param {Array} dispatches
 * @param {number} timeoutSec
 * @param {Function|null} safeProgress
 * @param {number} progressIntervalSec
 * @returns {Promise<Array<{d, completion, output}>>}
 */
async function awaitAll(
  sessionName,
  dispatches,
  timeoutSec,
  safeProgress,
  progressIntervalSec,
  stallOpts,
) {
  // 병렬 대기 (Promise.all — 모든 pane 동시 폴링, 총 시간 = max(개별 시간))
  return Promise.all(
    dispatches.map(async (d) => {
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

      let completion;
      if (stallOpts?.enabled) {
        // 하이브리드 stall detection 모드
        try {
          const stallPollCb =
            safeProgress && progressIntervalSec > 0
              ? (snapshot) => {
                  try {
                    safeProgress({
                      type: "progress",
                      paneName: d.paneName,
                      cli: d.cli,
                      snapshot: snapshot.split("\n").slice(-15).join("\n"),
                    });
                  } catch {
                    /* 삼킴 */
                  }
                }
              : undefined;

          const stallResult = await waitForCompletionWithStallDetect(
            sessionName,
            d.paneId || d.paneName,
            d.resultFile,
            {
              pollInterval: stallOpts.pollInterval,
              stallTimeout: stallOpts.stallTimeout,
              completionTimeout:
                stallOpts.completionTimeout ?? timeoutSec * 1000,
              maxRestarts: stallOpts.maxRestarts,
              command: d.command,
              token: d.token,
              onPoll: stallPollCb,
            },
          );
          if (stallResult.paneId) d.paneId = stallResult.paneId;
          if (stallResult.token) d.token = stallResult.token;
          if (stallResult.logPath) d.logPath = stallResult.logPath;
          completion = {
            matched: stallResult.matched,
            exitCode: stallResult.exitCode,
            stallDetected: stallResult.stallDetected,
            restarts: stallResult.restarts,
          };
        } catch (stallErr) {
          if (stallErr.code === "STALL_EXHAUSTED") {
            completion = {
              matched: false,
              exitCode: null,
              stallExhausted: true,
              restarts: stallErr.restarts,
            };
          } else {
            throw stallErr;
          }
        }
      } else {
        // 기존 waitForCompletion 경로
        if (d.logPath) pollOpts.logPath = d.logPath;
        completion = await waitForCompletion(
          sessionName,
          d.paneId || d.paneName,
          d.token,
          timeoutSec,
          pollOpts,
        );
      }

      const output = completion.matched
        ? readResult(d.resultFile, d.paneId)
        : "";
      unregisterHeadlessSynapseWorker(d.workerId);

      if (safeProgress) {
        safeProgress({
          type: "completed",
          paneName: d.paneName,
          cli: d.cli,
          matched: completion.matched,
          exitCode: completion.exitCode,
          sessionDead: completion.sessionDead || false,
          stallDetected: completion.stallDetected || false,
          stallExhausted: completion.stallExhausted || false,
        });
      }

      return { d, completion, output };
    }),
  );
}

/**
 * git diff + handoff 파이프라인을 적용하여 최종 결과 배열을 반환한다.
 * @param {Array<{d, completion, output}>} results
 * @returns {Array}
 */
async function collectResults(sessionName, results) {
  // handoff 파이프라인: parse → validate → format (각 워커 결과에 적용)
  return await Promise.all(
    results.map(async ({ d, completion, output }) => {
      const workerGitDiffFiles = collectGitDiffFiles(d.cwd);
      const handoffResult = processHandoff(output, {
        exitCode: completion.exitCode,
        resultFile: d.resultFile,
        cli: d.cli,
        gitDiffFiles: workerGitDiffFiles,
      });
      if (
        completion.exitCode === 0 &&
        workerGitDiffFiles.length === 0 &&
        handoffResult.handoff?.lead_action === "accept"
      ) {
        handoffResult.handoff = {
          ...handoffResult.handoff,
          lead_action: "needs_read",
        };
        handoffResult.formatted = formatHandoffForLead(handoffResult.handoff);
      }
      const status =
        handoffResult.handoff?.status ||
        (completion.matched && completion.exitCode === 0
          ? "completed"
          : "failed");
      await publishHeadlessResult(
        sessionName,
        d.workerId,
        status,
        handoffResult.handoff,
      );

      return {
        cli: d.cli,
        paneName: d.paneName,
        paneId: d.paneId,
        workerId: d.workerId,
        role: d.role,
        matched: completion.matched,
        exitCode: completion.exitCode,
        output,
        resultFile: d.resultFile,
        workerGitDiffFiles,
        sessionDead: completion.sessionDead || false,
        handoff: handoffResult.handoff,
        handoffFormatted: handoffResult.formatted,
        handoffValid: handoffResult.valid,
        handoffFallback: handoffResult.fallback,
      };
    }),
  );
}

function collectGitDiffFiles(cwd) {
  try {
    const diffOut = execSync("git diff --name-only HEAD", {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return diffOut.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
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
 * @param {string} [opts.dashboardLayout='single'] — dashboard viewer 레이아웃
 * @returns {{ sessionName: string, results: Array<{cli: string, paneName: string, matched: boolean, exitCode: number|null, output: string, sessionDead?: boolean}> }}
 */
export async function runHeadless(sessionName, assignments, opts = {}) {
  const {
    timeoutSec = 300,
    layout = "2x2",
    onProgress,
    progressIntervalSec = 0,
    progressive = true,
    dashboard = false,
    dashboardLayout = "single",
    stallDetect,
  } = opts;

  mkdirSync(RESULT_DIR, { recursive: true });

  // Hub version skew pre-flight (fail-open, best-effort)
  requestJson("/status", { method: "GET", timeoutMs: 500 })
    .then((status) => {
      const hubRate = status?.spawn_trace?.max_per_sec;
      const localRate = getMaxSpawnPerSec();
      if (typeof hubRate === "number" && hubRate !== localRate) {
        console.warn(
          `[headless] Hub version skew detected: hub spawn rate=${hubRate}/s, local=${localRate}/s. Restart hub to sync.`,
        );
      }
    })
    .catch(() => {});

  // Synapse: 세션 registration (fire-and-forget, hub 미응답 시 무시)
  const synapseIds = assignments.map(
    (_, i) => `${sessionName}-worker-${i + 1}`,
  );
  for (let i = 0; i < assignments.length; i++) {
    const a = assignments[i];
    requestJson("/synapse/register", {
      method: "POST",
      body: {
        sessionId: synapseIds[i],
        host: "local",
        taskSummary: String(a.prompt || "").slice(0, 100),
        isRemote: false,
      },
      timeoutMs: 1000,
    }).catch(() => {});
  }

  // in-process TUI: dashboard=true이고 stdout이 TTY일 때 직접 구동
  let tui = null;
  const resolvedLayout = resolveDashboardLayout(
    dashboardLayout,
    assignments.length,
  );
  if (dashboard && process.stdout.isTTY) {
    tui = createLogDashboard({
      stream: process.stdout,
      input: process.stdin,
      refreshMs: 200,
      layout: resolvedLayout,
    });
    tui.setStartTime(Date.now());
    // 초기 워커 상태 등록
    for (let i = 0; i < assignments.length; i++) {
      const a = assignments[i];
      tui.updateWorker(`worker-${i + 1}`, {
        cli: a.cli || "codex",
        role: a.role || "",
        status: "pending",
        progress: 0,
      });
    }
  } else if (dashboard) {
    // Issue #116-F: --dashboard 요청이 non-TTY 환경에서 silent skip 되던 혼란 해소.
    // stderr 로만 안내 (stdout 은 readHeadlessResult 파싱 대상이라 건드리지 않는다).
    const logDir = join(tmpdir(), "tfx-headless");
    process.stderr.write(
      `\n⚠ --dashboard requested but stdout is not a TTY; dashboard is skipped.\n` +
        `  Session is running in background. Worker logs:\n` +
        `    ${logDir}${IS_WINDOWS ? "\\" : "/"}${sessionName}-worker-N.txt\n` +
        `    ${logDir}${IS_WINDOWS ? "\\" : "/"}${sessionName}-worker-N.txt.err\n\n`,
    );
  }

  // per-worker state feed: onProgress 이벤트 → tui.updateWorker()
  function feedTui(event) {
    if (!tui) return;
    const { type, paneName, cli, snapshot, matched, exitCode } = event;
    if (!paneName) return;

    if (type === "progress" && snapshot) {
      tui.updateWorker(paneName, {
        cli: cli || "codex",
        status: "running",
        snapshot: snapshot.split("\n").at(-1) || "",
        summary: snapshot.split("\n").at(-1) || "",
        detail: snapshot,
        progress: 0.5,
      });
    } else if (type === "completed") {
      const status = matched && exitCode === 0 ? "completed" : "failed";
      tui.updateWorker(paneName, {
        cli: cli || "codex",
        status,
        progress: 1,
      });
    } else if (type === "worker_added") {
      tui.updateWorker(paneName, {
        cli: cli || "codex",
        status: "running",
        progress: 0.05,
      });
    }
  }

  // Synapse heartbeat: progress 이벤트마다 해당 워커의 세션 갱신
  const feedSynapse = (event) => {
    if (!event?.paneName) return;
    const match = event.paneName.match(/worker-(\d+)/);
    if (!match) return;
    const idx = parseInt(match[1], 10) - 1;
    const sid = synapseIds[idx];
    if (!sid) return;
    requestJson("/synapse/heartbeat", {
      method: "POST",
      body: {
        sessionId: sid,
        partial: { taskSummary: (event.snapshot || "").slice(0, 100) },
      },
      timeoutMs: 500,
    }).catch(() => {});
  };

  // onProgress 예외를 삼켜 실행 흐름 보호 (onPoll과 동일 패턴)
  const combinedProgress = (event) => {
    feedTui(event);
    feedSynapse(event);
    if (onProgress) {
      try {
        onProgress(event);
      } catch {
        /* 콜백 예외 삼킴 */
      }
    }
  };
  const safeProgress = (event) => {
    try {
      combinedProgress(event);
    } catch {
      /* 삼킴 */
    }
  };

  const dispatches = progressive
    ? await dispatchProgressive(sessionName, assignments, {
        layout,
        safeProgress,
        dashboardLayout,
      })
    : await dispatchBatch(sessionName, assignments, {
        layout,
        safeProgress,
        dashboardLayout,
      });

  const results = await awaitAll(
    sessionName,
    dispatches,
    timeoutSec,
    safeProgress,
    progressIntervalSec,
    stallDetect,
  );
  const collected = await collectResults(sessionName, results);

  // 완료 시 TUI에 최종 상태 반영 후 닫기
  if (tui) {
    for (const r of collected) {
      tui.updateWorker(r.paneName, {
        cli: r.cli,
        role: r.role || "",
        status: r.handoff?.status === "failed" ? "failed" : "completed",
        handoff: r.handoff,
        summary: r.handoff?.verdict || (r.matched ? "completed" : "failed"),
        detail: r.output,
        progress: 1,
        elapsed: Math.round(
          (Date.now() - (tui._startedAt || Date.now())) / 1000,
        ),
      });
    }
    tui.render();
    // 최종 화면을 잠깐 유지 후 닫기
    await new Promise((r) => setTimeout(r, 1500));
    tui.close();
  }

  // Synapse: 세션 unregister (fire-and-forget)
  for (const sid of synapseIds) {
    requestJson("/synapse/unregister", {
      method: "POST",
      body: { sessionId: sid },
      timeoutMs: 1000,
    }).catch(() => {});
  }

  return { sessionName, results: collected };
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
    for (let index = 0; index < assignments.length; index++) {
      unregisterHeadlessSynapseWorker(
        getHeadlessWorkerAgentId(sessionName, index),
      );
    }
    await deregisterHeadlessWorkers(sessionName, assignments.length);
    try {
      killPsmuxSession(sessionName);
    } catch {
      /* 무시 */
    }
    // WT split pane은 psmux 종료 시 셸이 끝나면서 자동으로 닫힘
    // 수동 close-pane 불필요 (레이스 컨디션으로 WT 에러 발생)
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
    [
      "status-right",
      " #[fg=#a6adc8]#{pane_title}#[default] │ #[fg=#f9e2af]%H:%M#[default] ",
    ],
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
    try {
      psmuxExec(["set-option", "-t", sessionName, key, value]);
    } catch {
      /* 무시 */
    }
  }
}

/**
 * Windows Terminal에 triflux 프로필을 자동 생성/갱신한다.
 * 반투명 + 비포커스 시 더 투명 + Catppuccin 테마.
 * @returns {boolean} 성공 여부
 */

/**
 * WT 기본 프로필의 폰트 크기를 읽는다.
 * @returns {number} 기본 폰트 크기 (못 읽으면 12)
 */
function _getWtDefaultFontSize() {
  const settingsPaths = [
    join(
      process.env.LOCALAPPDATA || "",
      "Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json",
    ),
    join(
      process.env.LOCALAPPDATA || "",
      "Microsoft/Windows Terminal/settings.json",
    ),
  ];
  for (const p of settingsPaths) {
    if (!existsSync(p)) continue;
    try {
      const settings = JSON.parse(
        readFileSync(p, "utf8").replace(/^\s*\/\/.*$/gm, ""),
      );
      // 기본 프로필 or 첫 프로필의 폰트
      const defaultGuid = settings.defaultProfile;
      const profiles = settings.profiles?.list || [];
      const defaultProfile =
        profiles.find((pr) => pr.guid === defaultGuid) || profiles[0];
      return (
        defaultProfile?.font?.size ||
        settings.profiles?.defaults?.font?.size ||
        12
      );
    } catch {
      /* 다음 */
    }
  }
  return 12;
}

/**
 * 파일을 원자적으로 쓴다 — 임시 파일에 먼저 기록 후 rename으로 교체.
 * 프로세스가 쓰기 도중 충돌해도 원본 파일이 손상되지 않는다.
 * @param {string} filePath — 대상 파일 경로
 * @param {string} data — 쓸 내용
 */
function _atomicWriteSync(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmpPath, data, "utf8");
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      writeFileSync(tmpPath.replace(/\.tmp$/, ".tmp.del"), "");
    } catch {
      /* 무시 */
    }
    throw err;
  }
}

function sanitizeSessionName(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "") || "tfx-session";
}

function buildAttachTitle(sessionName, suffix = "") {
  const base = `▲ ${sanitizeSessionName(sessionName)}`;
  return suffix ? `${base} ${suffix}` : base;
}

// ─── v6.0.0: Lead-Direct Interactive Mode ───

/**
 * Windows Terminal에서 psmux 세션을 자동 attach한다.
 * 1명은 새 탭 단일 attach, 2/3/4명은 새 탭 내 split-pane, 5명 이상은 dashboard로 전환한다.
 *
 * @param {string} sessionName — attach할 psmux 세션 이름
 * @param {object} [opts]
 * @param {number} [workerCount=2]
 * @returns {Promise<boolean>} 성공 여부
 */
export async function autoAttachTerminal(
  sessionName,
  opts = {},
  workerCount = 2,
) {
  if (!process.env.WT_SESSION) return false;

  const wt = createWtManager();
  wt.ensureWtProfile(workerCount);

  try {
    const safeSession = sanitizeSessionName(sessionName);
    if (workerCount >= 5) {
      const resolvedLayout = resolveDashboardLayout(
        opts.dashboardLayout || "single",
        workerCount,
      );
      const viewerPath = join(import.meta.dirname, "tui-viewer.mjs").replace(
        /\\/g,
        "/",
      );
      await wt.createTab({
        title: buildAttachTitle(safeSession, "dashboard"),
        profile: "triflux",
        command: `node "${viewerPath}" --session ${safeSession} --result-dir "${RESULT_DIR}" --layout ${resolvedLayout}`,
      });
    } else {
      const panes = [];
      panes.push({
        title: buildAttachTitle(safeSession),
        profile: "triflux",
        command: `psmux attach-session -t ${safeSession}`,
      });

      if (workerCount >= 2) {
        panes.push({
          direction: workerCount >= 3 ? "V" : "H",
          title: buildAttachTitle(safeSession, "2"),
          profile: "triflux",
          command: `psmux attach-session -t ${safeSession}`,
        });
      }
      if (workerCount >= 3) {
        panes.push({
          direction: "H",
          title: buildAttachTitle(safeSession, "3"),
          profile: "triflux",
          command: `psmux attach-session -t ${safeSession}`,
        });
      }
      if (workerCount >= 4) {
        panes.push({
          direction: "H",
          title: buildAttachTitle(safeSession, "4"),
          profile: "triflux",
          command: `psmux attach-session -t ${safeSession}`,
        });
      }
      await wt.applySplitLayout(panes);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * v7.0: psmux 세션을 WT 탭에 attach (대시보드 + 워커 전체 뷰)
 * @param {string} sessionName
 * @param {number} workerCount
 * @param {string} [dashboardLayout='single']
 * @param {number} [dashboardSize=0.4]
 * @param {string} [dashboardAnchor='window'] — window | tab
 * @returns {Promise<boolean>}
 */
export async function attachDashboardTab(
  sessionName,
  workerCount = 2,
  dashboardLayout = "single",
  dashboardSize = 0.4,
  dashboardAnchor = "window",
) {
  const wt = createWtManager();
  const envInfo = wt.getEnvironmentInfo?.() || {};
  if (!envInfo.hasWindowsTerminal) return false;
  wt.ensureWtProfile(workerCount);

  try {
    const safeSession = sanitizeSessionName(sessionName);
    const resolvedLayout = resolveDashboardLayout(dashboardLayout, workerCount);
    const viewerPath = join(import.meta.dirname, "tui-viewer.mjs").replace(
      /\\/g,
      "/",
    );

    await wt.createTab({
      title: buildAttachTitle(safeSession, "dashboard"),
      profile: "triflux",
      command: `node "${viewerPath}" --session ${safeSession} --result-dir "${RESULT_DIR}" --layout ${resolvedLayout}`,
    });
    return true;
  } catch {
    return false;
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
 * @param {string} [opts.dashboardLayout='single'] — dashboard viewer 레이아웃
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
export async function runHeadlessInteractive(
  sessionName,
  assignments,
  opts = {},
) {
  const {
    autoAttach = false,
    dashboard = false,
    dashboardSize = 0.4,
    dashboardAnchor = "window",
    signal,
    maxIdleSec = 0,
    ...runOpts
  } = opts;
  const headlessOpts = dashboard
    ? { ...runOpts, dashboard: true }
    : { ...runOpts };

  // autoAttach를 session_created 시점에 트리거 (CLI 실행 전에 터미널 열림)
  const userOnProgress = headlessOpts.onProgress;
  let terminalAttached = false;
  const onProgress = (event) => {
    if (autoAttach && event.type === "session_created" && !terminalAttached) {
      terminalAttached = true;
      if (dashboard) {
        // v7.0: psmux attach로 대시보드+워커 전체 세션을 WT 탭에 표시
        attachDashboardTab(
          sessionName,
          assignments.length,
          event.dashboardLayout ||
            resolveDashboardLayout(
              headlessOpts.dashboardLayout,
              assignments.length,
            ),
          dashboardSize,
          dashboardAnchor,
        );
      } else {
        autoAttachTerminal(
          sessionName,
          { dashboardLayout: headlessOpts.dashboardLayout, dashboardAnchor },
          assignments.length,
        );
      }
    }
    if (userOnProgress) userOnProgress(event);
  };
  const interactiveRunOpts = { ...headlessOpts, onProgress };

  // Phase 1: 세션 생성 → 즉시 터미널 팝업 → dispatch → 대기 → 결과 수집
  const { results } = await runHeadless(
    sessionName,
    assignments,
    interactiveRunOpts,
  );

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
      try {
        startCapture(sessionName, paneName);
      } catch {
        /* 이미 활성 — 무시 */
      }
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
      return waitForCompletion(
        sessionName,
        paneName,
        token,
        timeoutSec,
        waitOpts,
      );
    },

    /** 세션 생존 확인 */
    alive() {
      if (this._killed) return false;
      return psmuxSessionExists(sessionName);
    },

    /** 세션 종료 — WT pane은 psmux 종료 시 자동으로 닫힘 */
    kill() {
      if (this._killed) return;
      this._killed = true;
      for (let index = 0; index < assignments.length; index++) {
        unregisterHeadlessSynapseWorker(
          getHeadlessWorkerAgentId(sessionName, index),
        );
      }
      void deregisterHeadlessWorkers(sessionName, assignments.length);
      try {
        killPsmuxSession(sessionName);
      } catch {
        /* 무시 */
      }
      // WT split pane은 psmux 종료 → 셸 종료 → 자동 닫힘
      // 수동 close-pane 불필요 (레이스 컨디션으로 WT 0x80070002 에러 발생)
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

  // 유휴 타임아웃 자동 정리 (resetIdleTimer 단일 경로 사용)
  resetIdleTimer();

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
