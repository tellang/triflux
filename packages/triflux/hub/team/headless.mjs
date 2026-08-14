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
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNestedCodexAgentProfile } from "../../scripts/lib/cli-codex.mjs";
import { requestJson } from "../bridge.mjs";
import { escapePwshSingleQuoted } from "../cli-adapter-base.mjs";
import { getMaxSpawnPerSec } from "../lib/spawn-trace.mjs";
import {
  createActivityLifecycle,
  isActivityLifecycleEnabled,
  resolveHardCeilingMs,
  resolveStallInterventionMs,
} from "../lib/worker-lifecycle.mjs";
import { IS_WINDOWS } from "../platform.mjs";
import { getBackend } from "./backend.mjs";
import {
  buildDaemonControlAuth,
  buildDaemonExecDispatchPayload,
  deriveClaudeDaemonPaths as deriveClaudeControlPaths,
  dispatchClaudeDaemonJob,
  killDaemonJob,
  sendKillBySessionId,
} from "./claude-daemon-control.mjs";
import { startClaudeNativeBridge } from "./claude-native-bridge.mjs";
import { removeClaudeSessionProjection } from "./claude-session-projection.mjs";
import { resolveDashboardLayout } from "./dashboard-layout.mjs";
import {
  formatHandoffForLead,
  HANDOFF_INSTRUCTION_SHORT,
  processHandoff,
} from "./handoff.mjs";
import {
  createFileActivitySource,
  createInterventionLadder,
} from "./intervention.mjs";
import {
  capturePsmuxPane,
  createPsmuxSession,
  dispatchCommand,
  killPsmuxSession,
  psmuxExec,
  psmuxSessionExists,
  sendKeysToPane,
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
const DAEMON_COMPLETION_PREFIX = "__TFX_HEADLESS_DONE__:";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/** CLI별 브랜드 — 이모지 + 공식 색상 (HUD와 통일) */
const CLI_BRAND = {
  codex: { emoji: "\u{26AA}", label: "Codex", ansi: "\x1b[97m" }, // ⚪ bright white (codexWhite)
  gemini: { emoji: "\u{1F535}", label: "Gemini", ansi: "\x1b[38;5;39m" }, // 🔵 geminiBlue
  antigravity: {
    emoji: "\u{1F535}",
    label: "Antigravity",
    ansi: "\x1b[38;5;39m",
  },
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
// scripts/tfx-route.sh also validates route agents from agent-map.json.
const VALID_ROUTE_AGENTS = new Set(Object.keys(AGENT_TO_CLI));

/**
 * 에이전트 역할명 또는 CLI 이름을 CLI 타입("codex"|"antigravity"|"claude")으로 해석한다.
 * route_agent()가 적용되지 않는 headless 경로에서 사용.
 * @param {string} agentOrCli — "executor", "codex", "designer" 등
 * @returns {'codex'|'antigravity'|'claude'} CLI 타입
 */
export function resolveCliType(agentOrCli) {
  return AGENT_TO_CLI[agentOrCli] || agentOrCli;
}

function resolveHeadlessCliType(agentOrCli) {
  const resolved = resolveCliType(agentOrCli);
  return resolved === "gemini" ? "antigravity" : resolved;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function resolveHeadlessRouteScript(opts = {}) {
  const candidates = [
    opts.routeScript,
    process.env.TFX_ROUTE_SCRIPT,
    process.env.TFX_DELEGATOR_ROUTE_SCRIPT,
    join(process.cwd(), "scripts", "tfx-route.sh"),
    join(SCRIPT_DIR, "..", "..", "scripts", "tfx-route.sh"),
    process.env.HOME
      ? join(process.env.HOME, ".claude", "scripts", "tfx-route.sh")
      : "",
    "tfx-route.sh",
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate === "tfx-route.sh" || existsSync(candidate)) {
      return candidate;
    }
  }

  return "tfx-route.sh";
}

function resolveRouteAgentForHeadless(resolvedCli, opts = {}) {
  const role = String(opts.role || "").trim();
  if (
    role &&
    VALID_ROUTE_AGENTS.has(role) &&
    !["gemini", "antigravity", "agy"].includes(role)
  ) {
    return role;
  }
  return resolvedCli === "antigravity" ? "antigravity" : resolvedCli;
}

export function normalizeHeadlessRole(role) {
  const normalized = String(role || "")
    .trim()
    .toLowerCase();
  return normalized && VALID_ROUTE_AGENTS.has(normalized) ? normalized : "";
}

export function resolveHeadlessDisplayName(assignment = {}, paneName = "") {
  const normalized = String(assignment.displayName || "")
    .trim()
    .replace(/[\r\n\x00-\x1f]/g, " ");
  return normalized || paneName || "";
}

export function normalizeHeadlessAssignment(assignment = {}, index = 0) {
  const paneName = `worker-${index + 1}`;
  return {
    ...assignment,
    role: normalizeHeadlessRole(assignment.role),
    displayName: resolveHeadlessDisplayName(assignment, paneName),
  };
}

function buildRouteBackedHeadlessCommand(
  resolvedCli,
  promptFile,
  resultFile,
  opts = {},
) {
  const routeScript = resolveHeadlessRouteScript(opts);
  const routeAgent = resolveRouteAgentForHeadless(resolvedCli, opts);
  const mcp = String(opts.mcp || "auto");
  const timeout =
    Number.isFinite(Number(opts.timeoutSec)) && Number(opts.timeoutSec) > 0
      ? String(Math.trunc(Number(opts.timeoutSec)))
      : "";
  const timeoutArg = timeout ? ` ${shellQuote(timeout)}` : "";
  const routeMode = resolvedCli === "antigravity" ? "antigravity" : resolvedCli;
  const codexProfileEnv =
    resolvedCli === "codex" && opts.codexProfile
      ? `TFX_CODEX_PROFILE=${shellQuote(opts.codexProfile)} `
      : "";
  const lifecycleEnv = [
    "TFX_HARD_CEILING_SEC",
    "TFX_STALL_THRESHOLD",
    "TFX_STALL_INTERVENTION_SEC",
  ]
    .filter((key) => process.env[key])
    .map((key) => `${key}=${shellQuote(process.env[key])} `)
    .join("");
  const script =
    `__tfx_prompt=$(cat ${shellQuote(promptFile)}); ` +
    `${lifecycleEnv}${codexProfileEnv}TFX_CLI_MODE=${shellQuote(routeMode)} ` +
    `bash ${shellQuote(routeScript)} ${shellQuote(routeAgent)} "$__tfx_prompt" ${shellQuote(mcp)}${timeoutArg} ` +
    `> ${shellQuote(resultFile)} 2>${shellQuote(`${resultFile}.err`)} < /dev/null`;
  return `bash -lc ${shellQuote(script)}`;
}

export function getHeadlessWorkerAgentId(sessionName, index) {
  return `headless-${sessionName}-${index}`;
}

export function getHeadlessLeadAgentId(sessionName) {
  return `headless-${sessionName}-lead`;
}

const HUB_CLI_VALUES = new Set(["codex", "gemini", "claude", "other"]);
const presenceOwnerByAgent = new Map();
function normalizeCliForHub(cli) {
  return HUB_CLI_VALUES.has(cli) ? cli : "other";
}

export async function registerHeadlessWorker(
  sessionName,
  index,
  cli,
  requestJsonFn = requestJson,
) {
  const agentId = getHeadlessWorkerAgentId(sessionName, index);
  const result = await requestJsonFn("/bridge/register", {
    body: {
      agent_id: agentId,
      cli: normalizeCliForHub(cli),
      topics: ["headless.worker"],
      capabilities: [cli],
    },
  }).catch(() => null);
  if (result?.ok && result.data?.presence_generation != null) {
    presenceOwnerByAgent.set(agentId, {
      presence_generation: result.data.presence_generation,
      hub_instance_id: result.data.hub_instance_id,
      store_fingerprint: result.data.store_fingerprint,
    });
  }
  return result;
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
        body: {
          agent_id: getHeadlessWorkerAgentId(sessionName, index),
          ...(presenceOwnerByAgent.get(
            getHeadlessWorkerAgentId(sessionName, index),
          ) || {}),
        },
      })
        .catch(() => {})
        .finally(() =>
          presenceOwnerByAgent.delete(
            getHeadlessWorkerAgentId(sessionName, index),
          ),
        ),
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
    "You have full filesystem read/write access. Implement changes directly. After changes, run the narrowest relevant test/lint for the files you touched; if none can run, state why and the next-best check.",
  analyze:
    "Focus on reading and analyzing the codebase. Prefer analysis over modification.",
  review: "Review the code for quality, security, and correctness.",
  docs: "Focus on documentation and explanation tasks.",
};

/**
 * CLI별 헤드리스 명령 빌더
 * @param {'codex'|'antigravity'|'claude'} cli
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
  const resolvedCli = resolveHeadlessCliType(cli);

  // contextFile 처리: 32KB(32768 bytes) 초과 시 UTF-8 안전 절단
  let contextPrefix = "";
  if (contextFile && existsSync(contextFile)) {
    const contextSource = resolve(contextFile);
    let ctx = readFileSync(contextFile, "utf8");
    let truncated = false;
    if (Buffer.byteLength(ctx, "utf8") > 32768) {
      ctx = Buffer.from(ctx).subarray(0, 32768).toString("utf8");
      truncated = true;
    }
    if (truncated) {
      ctx = `${ctx}\n[... truncated at 32KB]`;
    }
    if (ctx.length > 0) {
      contextPrefix = `<prior_context source="${contextSource}" truncated="${truncated ? "true" : "false"}">\n${ctx}\n</prior_context>\nBase your work on the prior_context above; if it conflicts with the task below, the task wins.\n\n`;
    }
  }

  const mcpHint =
    mcp && MCP_PROFILE_HINTS[mcp]
      ? `\n\n[MCP: ${mcp}]\n${MCP_PROFILE_HINTS[mcp]}`
      : "";
  const workspaceHint = cwd
    ? `\n\n[workspace] root(절대경로): ${resolve(cwd)}. 모든 상대경로는 이 루트 기준. 파일 쓰기/커밋 전 \`git rev-parse --show-toplevel\` 이 이 root 와 일치하는지 확인하고 불일치 시 중단·보고.`
    : "";
  // P2: HANDOFF 지시를 프롬프트에 삽입 (워커가 구조화된 handoff 블록을 출력하도록)
  const handoffHint = handoff ? `\n\n${HANDOFF_INSTRUCTION_SHORT}` : "";
  const fullPrompt = `${contextPrefix}${prompt}${mcpHint}${workspaceHint}${handoffHint}`;

  // 보안: 프롬프트를 임시 파일에 쓰고 파일 참조로 전달 (셸 주입 방지).
  // 이전 구현은 `"$(cat 'PATH')"` shell-expansion expression 을 만들어
  // backend.buildArgs 에 전달했는데, 새 stdin-prompt 모드 (PR #252) 가
  // 그 literal 을 user message 로 해석해서 codex 가 prompt 가 아닌
  // shell expression 자체를 받는 회귀가 있었다. 이제 fullPrompt 를 그대로
  // 전달하고 buildExecCommand 가 자체적으로 tmp file 작성 + stdin redirect.
  if (!existsSync(RESULT_DIR)) mkdirSync(RESULT_DIR, { recursive: true });
  const promptFile = join(
    RESULT_DIR,
    "prompt-" + randomUUID().slice(0, 8) + ".txt",
  ).replace(/\\/g, "/");
  writeFileSync(promptFile, fullPrompt, "utf8");
  void IS_WINDOWS; // referenced for diagnostic guard chain below

  // Codex와 Antigravity는 tfx-route.sh를 통해서만 headless 실행한다. 이 경로가
  // disable/fallback/fail-loud 정책의 유일한 판정원이다. 여기서 같은 정책을
  // 재구현하면 shell route와 headless backend가 서로 다른 결론을 낼 수 있다.
  const codexProfile =
    resolvedCli === "codex"
      ? resolveNestedCodexAgentProfile(opts.role || cli, {
          profileOverride: opts.profile ?? "auto",
          globalProfile: process.env.TFX_CODEX_PROFILE,
          codexHome: process.env.CODEX_HOME,
        })
      : undefined;
  const backendCommand =
    resolvedCli === "codex" || resolvedCli === "antigravity"
      ? buildRouteBackedHeadlessCommand(resolvedCli, promptFile, resultFile, {
          ...opts,
          codexProfile,
          mcp,
        })
      : getBackend(resolvedCli).buildArgs(fullPrompt, resultFile, {
          ...opts,
          model,
          promptFile,
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildDaemonWrappedCommand(command, token) {
  return `{ ${command}; __ec=$?; echo "${DAEMON_COMPLETION_PREFIX}${token}:$__ec"; }`;
}

export function waitForDaemonCompletionFromMessages(
  messages,
  { token, resultFile } = {},
) {
  const completionRegex = new RegExp(
    `${escapeRegExp(DAEMON_COMPLETION_PREFIX)}${escapeRegExp(token)}:(\\d+)`,
  );
  const stream = [];
  let matched = false;
  let exitCode = null;

  for (const message of messages) {
    if (Array.isArray(message?.streamTail)) {
      stream.push(...message.streamTail.map((line) => `${line}\n`));
    }
    if (typeof message?.line !== "string") continue;
    const match = completionRegex.exec(message.line);
    if (match) {
      const beforeCompletion = message.line.slice(0, match.index);
      if (beforeCompletion) stream.push(beforeCompletion);
      matched = true;
      exitCode = Number.parseInt(match[1], 10);
      continue;
    }
    stream.push(message.line);
  }

  if (resultFile) {
    writeFileSync(`${resultFile}.partial`, stream.join(""), "utf8");
  }

  return { matched, exitCode };
}

/**
 * 이전 run 의 stale .txt / .partial / .err 를 제거한다.
 * Issue #118 Codex review R1 HIGH: resultFile 경로 재사용 시 (워커 restart 또는
 * 동일 세션명 재실행) 이전 run 의 HANDOFF 가 새 run 결과로 오인될 수 있다.
 *
 * Issue #118 R2 MEDIUM: Windows 에서 locked/open 파일로 인한 삭제 실패를
 * silent swallow 하면 stale artifact 가 살아남아 bug 가 non-deterministic 하게
 * 재발한다. ENOENT 외 에러는 경고 로그 + 재시도(1회) 후 계속.
 * @param {string} resultFile
 */
export function cleanStaleResultArtifacts(resultFile) {
  for (const suffix of ["", ".partial", ".err"]) {
    const path = `${resultFile}${suffix}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        rmSync(path);
        break;
      } catch (err) {
        if (err?.code === "ENOENT") break; // 이미 없음 — 정상
        if (attempt === 0) continue; // 1회 재시도
        // 재시도도 실패: locked 파일일 수 있음. 경고 로그 후 계속 진행
        // (dispatch 중단 시 워커 자체가 시작 못하므로 best-effort 유지)
        console.warn(
          `[headless] cleanStaleResultArtifacts: ${path} 삭제 실패 (${err?.code || "unknown"}). stale leak 가능.`,
        );
      }
    }
  }
}

/**
 * 결과 파일 읽기 (없으면 capture-pane fallback)
 * Issue #118 fallback chain: .txt → .partial ([partial] prefix) → .err → capture-pane
 * @param {string} resultFile
 * @param {string} paneId
 * @returns {string}
 */
export function readResult(resultFile, paneId) {
  if (existsSync(resultFile)) {
    return readFileSync(resultFile, "utf8").trim();
  }
  // Issue #118 fallback 0: timeout 직전 persist 된 부분 출력 (.partial)
  const partialFile = `${resultFile}.partial`;
  if (existsSync(partialFile)) {
    const partial = readFileSync(partialFile, "utf8").trim();
    if (partial) return `[partial] ${partial}`;
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
  interventionTimeout: resolveStallInterventionMs(),
  hardCeiling: resolveHardCeilingMs(),
  maxRestarts: 2,
  maxInterventions: 1,
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

function createHeadlessIntervention(dispatch, fallback) {
  return async (context) => {
    if (typeof fallback === "function")
      return (await fallback(context)) === true;

    const isDaemon = context.channel === "daemon";
    const readActivitySignature = isDaemon
      ? createFileActivitySource({ files: [dispatch.resultFile] })
      : () => {
          let mtime = 0;
          try {
            mtime = statSync(dispatch.resultFile).mtimeMs;
          } catch {
            /* result file has not been written yet */
          }
          return `${capturePsmuxPane(context.paneId || dispatch.paneId, 50)}\0${mtime}`;
        };
    const ladder = createInterventionLadder({
      target: isDaemon
        ? {
            channel: "claude-daemon",
            cli: dispatch.cli || "claude",
            sessionId: dispatch.sessionId,
            daemon: {
              controlSock: dispatch.controlSock,
              short: dispatch.daemonShort,
              sessionId: dispatch.sessionId,
              configDir: dispatch.daemonPaths?.configDir,
            },
          }
        : {
            channel: "tmux-pane",
            paneId: context.paneId || dispatch.paneId,
            cli: dispatch.cli,
            sessionId: dispatch.sessionId,
          },
      readActivitySignature,
      deps: {
        // 이 트랙이 재실행 소유자다. pane 채널은 기존 completion wrapper를 다시
        // dispatch하여 token/result 계약을 보존한다.
        resumeHandler: async () => {
          if (isDaemon || !dispatch.command) return { ok: false };
          const restarted = dispatchCommand(
            context.sessionName,
            context.paneId || dispatch.paneId,
            dispatch.command,
          );
          return { ok: Boolean(restarted) };
        },
      },
    });
    const outcome = await ladder.intervene();
    return outcome.outcome === "reactivated" || outcome.outcome === "resumed";
  };
}

export function createActivityPollGuard({
  resultFile,
  lifecycle,
  interveneContext,
  statSyncFn = statSync,
}) {
  const controller = new AbortController();
  let lastMtime = 0;
  let checking = false;

  const finishIfTimedOut = async () => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    try {
      if (await lifecycle.check(interveneContext)) controller.abort();
    } finally {
      checking = false;
    }
  };

  return Object.freeze({
    signal: controller.signal,
    observe(content) {
      let mtime = 0;
      try {
        mtime = statSyncFn(resultFile).mtimeMs;
      } catch {
        /* result file has not been created yet */
      }
      lifecycle.observe(`${content}\0${mtime}`);
      lastMtime = mtime || lastMtime;
      void finishIfTimedOut();
    },
    get timeoutReason() {
      return lifecycle.timeoutReason;
    },
    get lastMtime() {
      return lastMtime;
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
 * @param {number} [opts.hardCeiling] — 활동과 무관한 절대 상한 ms
 * @param {number} [opts.completionTimeout] — hardCeiling의 하위호환 alias
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
    maxRestarts = 2,
    maxInterventions = 1,
    command,
    token,
    onPoll,
    onIntervene,
    _deps,
  } = opts;
  const hardCeiling =
    opts.hardCeiling ??
    opts.completionTimeout ??
    (isActivityLifecycleEnabled() ? resolveHardCeilingMs() : 900_000);

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
  let interventions = 0;
  const runStartedAt = Date.now();
  let currentPaneId = paneId;
  let stallDetected = false;
  let currentToken = token;
  let currentLogPath = opts.logPath || null;

  while (true) {
    let lastOutput = "";
    let lastMtime = 0;
    let lastChangeAt = Date.now();

    // 초기 resultFile mtime
    try {
      if (_exists(resultFile)) lastMtime = _stat(resultFile).mtimeMs;
    } catch {
      /* 무시 */
    }

    while (true) {
      await new Promise((r) => setTimeout(r, pollInterval));
      const now = Date.now();

      // 절대 상한은 재시작과 활동 여부를 관통하는 유일한 wall-clock kill이다.
      if (now - runStartedAt > hardCeiling) {
        // Issue #118: timeout kill 전에 capture-pane 출력을 .partial 파일로 persist.
        // resultFile(`.txt`)이 아직 생성되지 않았을 수 있으므로 readResult 가 fallback 으로 읽는다.
        try {
          const partialSnapshot = _capture(currentPaneId, 200);
          if (partialSnapshot && partialSnapshot.trim().length > 0) {
            const writer = deps.writeFileSync || writeFileSync;
            writer(`${resultFile}.partial`, partialSnapshot, "utf8");
          }
        } catch {
          /* best-effort, timeout 은 이미 확정 */
        }
        return {
          matched: false,
          exitCode: null,
          restarts,
          stallDetected,
          timedOut: true,
          timeoutReason: "hard_ceiling",
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
          if (onIntervene && interventions < maxInterventions) {
            interventions += 1;
            let handled = false;
            try {
              handled =
                (await onIntervene({
                  channel: "pane",
                  sessionName,
                  paneId: currentPaneId,
                  resultFile,
                  inactiveMs: now - lastChangeAt,
                  restarts,
                  interventions,
                })) === true;
            } catch {
              handled = false;
            }
            if (handled) {
              lastChangeAt = Date.now();
              continue;
            }
          }
          const err = new Error("CLI가 반복적으로 멈춤. 수동 확인 필요.");
          err.code = "STALL_EXHAUSTED";
          err.category = "transient";
          err.recovery = "CLI가 반복적으로 멈춤. 수동 확인 필요.";
          err.restarts = restarts;
          err.interventions = interventions;
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

function createHeadlessSessionOwnership(killSession) {
  let owned = false;
  let ownedSessionName = "";

  return {
    get owned() {
      return owned;
    },

    acquire(sessionName) {
      if (owned) return false;
      ownedSessionName = String(sessionName);
      owned = true;
      return true;
    },

    release() {
      if (!owned) return false;
      const sessionName = ownedSessionName;
      owned = false;
      ownedSessionName = "";
      try {
        killSession(sessionName);
      } catch {
        /* cleanup is best-effort and ownership release is idempotent */
      }
      return true;
    },
  };
}

/** progressive 스플릿 모드: lead pane만 생성 후, 워커를 하나씩 추가하며 dispatch */
async function dispatchProgressive(sessionName, assignments, opts = {}) {
  const {
    layout,
    safeProgress,
    dashboardLayout = "single",
    sessionOwnership,
    _deps: deps = {},
  } = opts;
  const resolvedDashboardLayout = resolveDashboardLayout(
    dashboardLayout,
    assignments.length,
  );
  const createSession = deps.createPsmuxSession || createPsmuxSession;
  const applyTheme = deps.applyTrifluxTheme || applyTrifluxTheme;
  const session = createSession(sessionName, { layout, paneCount: 1 });
  sessionOwnership.acquire(session.sessionName || sessionName);
  applyTheme(sessionName);
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
    const displayName = resolveHeadlessDisplayName(assignment, paneName);
    const workerId = getHeadlessWorkerAgentId(sessionName, i);
    const resolvedCli = resolveHeadlessCliType(assignment.cli);
    const brand = CLI_BRAND[resolvedCli] || {
      emoji: "\u{25CF}",
      label: resolvedCli,
      ansi: "",
    };
    const paneTitle = `${brand.emoji} ${resolvedCli} (${displayName})`;

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
    await registerHeadlessWorker(sessionName, i, resolvedCli);

    if (safeProgress)
      safeProgress({
        type: "worker_added",
        paneName,
        displayName,
        cli: resolvedCli,
        paneTitle,
      });

    // 캡처 시작 + 컬러 배너 + 명령 dispatch
    const resultFile = join(
      RESULT_DIR,
      `${sessionName}-${paneName}.txt`,
    ).replace(/\\/g, "/");
    // Issue #118 review R1 HIGH: stale artifact 제거 (이전 run / restart 잔재)
    cleanStaleResultArtifacts(resultFile);
    const cmd = buildHeadlessCommand(
      assignment.cli,
      assignment.prompt,
      resultFile,
      {
        mcp: assignment.mcp,
        role: assignment.role,
        model: assignment.model,
        profile: assignment.profile,
        cwd: assignment.cwd || assignment.workdir,
      },
    );
    startCapture(sessionName, newPaneId);
    // pane 간 pipe-pane EBUSY 방지 — 이벤트 루프 해방하며 순차 대기
    if (i > 0) await new Promise((r) => setTimeout(r, 300));
    const dispatch = dispatchCommand(sessionName, newPaneId, cmd);
    registerHeadlessSynapseWorker(workerId, assignment.prompt);

    if (safeProgress)
      safeProgress({ type: "dispatched", paneName, cli: resolvedCli });

    dispatches.push({
      ...dispatch,
      paneId: newPaneId,
      paneName,
      displayName,
      resultFile,
      cli: resolvedCli,
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
  const {
    layout,
    safeProgress,
    dashboardLayout = "single",
    sessionOwnership,
    _deps: deps = {},
  } = opts;
  const paneCount = assignments.length + 1;
  const resolvedDashboardLayout = resolveDashboardLayout(
    dashboardLayout,
    assignments.length,
  );
  // A2b fix: 2x2 레이아웃은 최대 4 pane — 초과 시 tiled로 자동 전환
  const effectiveLayout = layout === "2x2" && paneCount > 4 ? "tiled" : layout;
  const createSession = deps.createPsmuxSession || createPsmuxSession;
  const applyTheme = deps.applyTrifluxTheme || applyTrifluxTheme;
  const session = createSession(sessionName, {
    layout: effectiveLayout,
    paneCount,
  });
  sessionOwnership.acquire(session.sessionName || sessionName);
  applyTheme(sessionName);
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
      const displayName = resolveHeadlessDisplayName(assignment, paneName);
      const workerId = getHeadlessWorkerAgentId(sessionName, i);
      const resolvedCli = resolveHeadlessCliType(assignment.cli);
      const resultFile = join(
        RESULT_DIR,
        `${sessionName}-${paneName}.txt`,
      ).replace(/\\/g, "/");
      // Issue #118 review R1 HIGH: stale artifact 제거 (이전 run / restart 잔재)
      cleanStaleResultArtifacts(resultFile);
      const cmd = buildHeadlessCommand(
        assignment.cli,
        assignment.prompt,
        resultFile,
        {
          mcp: assignment.mcp,
          role: assignment.role,
          model: assignment.model,
          profile: assignment.profile,
          cwd: assignment.cwd || assignment.workdir,
        },
      );
      const scriptDir = join(RESULT_DIR, sessionName);
      await registerHeadlessWorker(sessionName, i, resolvedCli);
      const dispatch = dispatchCommand(sessionName, paneName, cmd, {
        scriptDir,
        scriptName: paneName,
      });
      registerHeadlessSynapseWorker(workerId, assignment.prompt);

      // P1 fix: 비-progressive에서는 pane 리네임 금지 — 캡처 로그 경로가 타이틀 기반이므로
      // 리네임하면 waitForCompletion이 "codex (role).log"를 찾지만 실제는 "worker-N.log"로 불일치
      // progressive 모드에서는 split-window 시 새 pane에 바로 타이틀이 설정되므로 문제없음

      if (safeProgress)
        safeProgress({
          type: "dispatched",
          paneName,
          displayName,
          cli: resolvedCli,
        });

      return {
        ...dispatch,
        paneName,
        displayName,
        resultFile,
        cli: resolvedCli,
        role: assignment.role,
        command: cmd,
        workerId,
        cwd: assignment.cwd || assignment.workdir,
      };
    }),
  );
}

async function dispatchDaemonBatch(sessionName, assignments, opts = {}) {
  const { safeProgress, configDir } = opts;
  const paths = deriveClaudeControlPaths({ configDir });
  const dispatches = [];

  try {
    for (let i = 0; i < assignments.length; i += 1) {
      const assignment = assignments[i];
      const paneName = `worker-${i + 1}`;
      const displayName = resolveHeadlessDisplayName(assignment, paneName);
      const workerId = getHeadlessWorkerAgentId(sessionName, i);
      const resolvedCli = resolveHeadlessCliType(assignment.cli);
      const resultFile = join(
        RESULT_DIR,
        `${sessionName}-${paneName}.txt`,
      ).replace(/\\/g, "/");
      cleanStaleResultArtifacts(resultFile);
      const command = buildHeadlessCommand(
        assignment.cli,
        assignment.prompt,
        resultFile,
        {
          mcp: assignment.mcp,
          role: assignment.role,
          model: assignment.model,
          profile: assignment.profile,
          cwd: assignment.cwd || assignment.workdir,
        },
      );
      const token = randomUUID().slice(0, 10);
      const short = randomUUID().replace(/-/g, "").slice(0, 8);
      const name = `Triflux ${resolvedCli || "worker"} ${displayName}`;
      const record = {
        paneId: `daemon:${short}`,
        paneName,
        displayName,
        resultFile,
        cli: resolvedCli,
        role: assignment.role,
        command,
        token,
        workerId,
        cwd: assignment.cwd || assignment.workdir,
        daemonShort: short,
        daemonPaths: paths,
        controlSock: paths.controlSock,
        sessionId: "",
        sessionProjectionPath: "",
        daemonCompletionMatched: false,
      };
      dispatches.push(record);

      const payload = buildDaemonExecDispatchPayload({
        short,
        cwd: assignment.cwd || assignment.workdir || process.cwd(),
        command: buildDaemonWrappedCommand(command, token),
        name,
      });
      record.sessionId = payload.sessionId;
      // buildDaemonWrappedCommand + token completion 시맨틱은 헬퍼 밖(headless 전용)에
      // 남기고, dispatch→pid→bridge→projection 시퀀스만 공유 헬퍼로 위임한다.
      // CRITICAL: waitForDaemonCompletion 이 나중에 record.daemonCompletionMatched 를
      // 변경하고 cleanupDaemonDispatches 가 같은 record 를 읽으므로, 헬퍼가 새 객체를
      // 반환해도 record 를 교체하지 말고 plain 필드를 Object.assign 한다.
      const dispatched = await dispatchClaudeDaemonJob({
        paths,
        controlSock: paths.controlSock,
        payload,
        agent: resolvedCli || "codex",
        name,
        cwd: assignment.cwd || assignment.workdir || process.cwd(),
        dispatchTimeoutMs: 5000,
      }).catch((error) => {
        throw new Error(
          `[headless] Claude daemon dispatch failed for ${paneName}: ${
            error?.message || error
          }`,
        );
      });
      Object.assign(record, {
        sessionId: dispatched.sessionId,
        sessionProjectionPath: dispatched.sessionProjectionPath,
      });
      await registerHeadlessWorker(sessionName, i, resolvedCli);
      registerHeadlessSynapseWorker(workerId, assignment.prompt);
      if (safeProgress) {
        safeProgress({ type: "dispatched", paneName, cli: resolvedCli });
      }
    }
  } catch (error) {
    await cleanupDaemonDispatches(dispatches);
    throw error;
  }

  return dispatches;
}

export async function cleanupDaemonDispatches(dispatches) {
  await Promise.all(
    dispatches.map(async (dispatch) => {
      if (dispatch.sessionProjectionPath) {
        await removeClaudeSessionProjection(
          dispatch.sessionProjectionPath,
        ).catch(() => {});
      }
      if (
        dispatch.daemonCompletionMatched === true &&
        dispatch.daemonPaths &&
        dispatch.sessionId
      ) {
        await sendKillBySessionId({
          daemonPaths: dispatch.daemonPaths,
          sessionId: dispatch.sessionId,
        }).catch(() => {});
      }
      if (dispatch.controlSock && dispatch.daemonShort) {
        const controlAuth = await buildDaemonControlAuth(
          dispatch.daemonPaths?.configDir,
        ).catch(() => ({}));
        await killDaemonJob(
          dispatch.controlSock,
          dispatch.daemonShort,
          controlAuth,
        ).catch(() => {});
      }
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
  lifecycle,
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
              displayName: d.displayName,
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
                      displayName: d.displayName,
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
              hardCeiling: lifecycle?.enabled
                ? (stallOpts.hardCeiling ??
                  stallOpts.completionTimeout ??
                  lifecycle.hardCeilingMs)
                : (stallOpts.completionTimeout ?? timeoutSec * 1000),
              maxRestarts: stallOpts.maxRestarts,
              maxInterventions: stallOpts.maxInterventions,
              command: d.command,
              token: d.token,
              onPoll: stallPollCb,
              onIntervene: lifecycle?.enabled
                ? createHeadlessIntervention(
                    d,
                    stallOpts.onIntervene ?? lifecycle.onIntervene,
                  )
                : undefined,
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
      } else if (lifecycle?.enabled) {
        if (d.logPath) pollOpts.logPath = d.logPath;
        const activity = createActivityLifecycle({
          interventionMs: lifecycle.interventionMs,
          hardCeilingMs: lifecycle.hardCeilingMs,
          onIntervene: createHeadlessIntervention(d, lifecycle.onIntervene),
        });
        const guard = createActivityPollGuard({
          resultFile: d.resultFile,
          lifecycle: activity,
          interveneContext: {
            channel: "pane",
            sessionName,
            paneId: d.paneId || d.paneName,
            resultFile: d.resultFile,
          },
        });
        const userOnPoll = pollOpts.onPoll;
        pollOpts.onPoll = (info) => {
          guard.observe(info.content);
          userOnPoll?.(info);
        };
        pollOpts.signal = guard.signal;
        completion = await waitForCompletion(
          sessionName,
          d.paneId || d.paneName,
          d.token,
          Math.ceil(lifecycle.hardCeilingMs / 1000),
          pollOpts,
        );
        if (!completion.matched && !completion.sessionDead) {
          completion.timedOut = true;
          completion.timeoutReason = guard.timeoutReason || "hard_ceiling";
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

      // Issue #118: matched=false(timeout kill) 에도 capture-pane 스냅샷을
      // .partial 로 persist 하여 readResult fallback chain 이 복구할 수 있도록 한다.
      if (!completion.matched) {
        try {
          const snap = capturePsmuxPane(d.paneId || d.paneName, 200);
          if (snap && snap.trim().length > 0) {
            writeFileSync(`${d.resultFile}.partial`, snap, "utf8");
          }
        } catch {
          /* best-effort */
        }
      }

      const output = readResult(d.resultFile, d.paneId);
      unregisterHeadlessSynapseWorker(d.workerId);

      if (safeProgress) {
        safeProgress({
          type: "completed",
          paneName: d.paneName,
          displayName: d.displayName,
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

export async function waitForDaemonCompletion(
  dispatch,
  timeoutSec,
  safeProgress,
  progressIntervalSec,
  lifecycle = null,
) {
  const messages = [];
  const socket = net.connect(dispatch.controlSock);
  let buffer = "";
  let settled = false;
  let lastProgressAt = 0;
  const activity = lifecycle?.enabled
    ? createActivityLifecycle({
        interventionMs: lifecycle.interventionMs,
        hardCeilingMs: lifecycle.hardCeilingMs,
        onIntervene: createHeadlessIntervention(
          dispatch,
          lifecycle.onIntervene,
        ),
      })
    : null;

  return await new Promise((resolve) => {
    const finish = (completion, timeoutReason = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(timer);
      socket.destroy();
      const finalCompletion =
        completion ||
        waitForDaemonCompletionFromMessages(messages, {
          token: dispatch.token,
          resultFile: dispatch.resultFile,
        });
      if (!finalCompletion.matched && timeoutReason) {
        finalCompletion.timedOut = true;
        finalCompletion.timeoutReason = timeoutReason;
      }
      if (finalCompletion.matched) {
        dispatch.daemonCompletionMatched = true;
        cleanupDaemonDispatches([dispatch]).catch(() => {});
      } else {
        buildDaemonControlAuth(dispatch.daemonPaths?.configDir)
          .catch(() => ({}))
          .then((controlAuth) =>
            killDaemonJob(
              dispatch.controlSock,
              dispatch.daemonShort,
              controlAuth,
            ),
          )
          .catch(() => {});
      }
      resolve(finalCompletion);
    };

    const timer = activity
      ? setInterval(() => {
          void activity
            .check({
              channel: "daemon",
              controlSock: dispatch.controlSock,
              daemonShort: dispatch.daemonShort,
              resultFile: dispatch.resultFile,
            })
            .then((reason) => {
              if (reason) finish(null, reason);
            });
        }, lifecycle.checkIntervalMs ?? 5_000)
      : setTimeout(
          () => finish(null, "wall_clock"),
          Math.max(0, timeoutSec * 1000),
        );
    if (typeof timer.unref === "function") timer.unref();

    socket.on("error", () => finish(null, "socket_error"));
    socket.on("close", () => {
      if (!settled) finish(null, "socket_closed");
    });
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          proto: 1,
          op: "subscribe",
          short: dispatch.daemonShort,
          tail: 20,
        })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        messages.push(message);
        activity?.observe();
        if (
          safeProgress &&
          progressIntervalSec > 0 &&
          typeof message.line === "string"
        ) {
          const now = Date.now();
          if (now - lastProgressAt >= progressIntervalSec * 1000) {
            lastProgressAt = now;
            safeProgress({
              type: "progress",
              paneName: dispatch.paneName,
              displayName: dispatch.displayName,
              cli: dispatch.cli,
              snapshot: message.line.split("\n").slice(-15).join("\n"),
            });
          }
        }
        const completion = waitForDaemonCompletionFromMessages(messages, {
          token: dispatch.token,
          resultFile: dispatch.resultFile,
        });
        if (completion.matched) finish(completion);
      }
    });
  });
}

async function awaitAllDaemon(
  dispatches,
  timeoutSec,
  safeProgress,
  progressIntervalSec,
  lifecycle,
) {
  return Promise.all(
    dispatches.map(async (d) => {
      const completion = await waitForDaemonCompletion(
        d,
        timeoutSec,
        safeProgress,
        progressIntervalSec,
        lifecycle,
      );
      const output = readResult(d.resultFile, d.paneId);
      unregisterHeadlessSynapseWorker(d.workerId);

      if (safeProgress) {
        safeProgress({
          type: "completed",
          paneName: d.paneName,
          displayName: d.displayName,
          cli: d.cli,
          matched: completion.matched,
          exitCode: completion.exitCode,
          sessionDead: false,
          stallDetected: false,
          stallExhausted: false,
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
        displayName: d.displayName,
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
 * @param {number} [opts.timeoutSec=900] — lane 예산; lifecycle 활성 시 kill 판정에는 쓰지 않음
 * @param {string} [opts.layout='2x2'] — pane 레이아웃
 * @param {(event: object) => void} [opts.onProgress] — 진행 콜백
 * @param {number} [opts.progressIntervalSec=0] — N초마다 progress 이벤트 발화 (0=비활성)
 * @param {boolean} [opts.progressive=true] — true면 pane을 하나씩 split-window로 추가 (실시간 스플릿)
 * @param {string} [opts.dashboardLayout='single'] — dashboard viewer 레이아웃
 * @returns {{ sessionName: string, results: Array<{cli: string, paneName: string, matched: boolean, exitCode: number|null, output: string, sessionDead?: boolean}>, sessionOwnership: {owned: boolean, acquire: (sessionName: string) => boolean, release: () => boolean} }}
 */
export async function runHeadless(sessionName, assignments, opts = {}) {
  const deps = opts._deps || {};
  const sessionOwnership =
    opts._sessionOwnership ||
    createHeadlessSessionOwnership(deps.killPsmuxSession || killPsmuxSession);
  let {
    timeoutSec = 900,
    layout = "2x2",
    onProgress,
    progressIntervalSec = 0,
    progressive = true,
    autoAttach = false,
    dashboard = false,
    dashboardLayout = "single",
    stallDetect,
    nativeBridge = false,
    nativeBridgeMode = "roster",
    onIntervene,
  } = opts;
  if (!Number.isFinite(Number(timeoutSec)) || Number(timeoutSec) <= 0)
    timeoutSec = 900;
  else timeoutSec = Number(timeoutSec);
  const lifecycle = {
    enabled: isActivityLifecycleEnabled(),
    interventionMs: resolveStallInterventionMs(),
    hardCeilingMs: resolveHardCeilingMs(),
    onIntervene,
  };

  mkdirSync(RESULT_DIR, { recursive: true });
  const normalizedAssignments = (assignments || []).map((assignment, index) =>
    normalizeHeadlessAssignment(assignment, index),
  );

  if (normalizedAssignments.length === 0) {
    return { sessionName, results: [], sessionOwnership };
  }

  let nativeBridgeHandle = null;
  let daemonDispatches = [];
  let runCompleted = false;
  let completedResults = [];
  let runFailed = false;
  let runError;
  if (nativeBridge && nativeBridgeMode === "claude-wrapper") {
    throw new Error(
      "[headless] --native-bridge-mode claude-wrapper is reserved and not implemented yet",
    );
  }
  if (
    nativeBridge &&
    (nativeBridgeMode === "roster" || nativeBridgeMode === "interactive-attach")
  ) {
    nativeBridgeHandle = await startClaudeNativeBridge({
      sessionName,
      assignments: normalizedAssignments,
      cwd: process.cwd(),
      workerType:
        nativeBridgeMode === "interactive-attach" ? "interactive" : "headless",
      onKill() {
        sessionOwnership.release();
      },
    });
    process.stderr.write(
      `[headless] Claude native bridge roster written: ${nativeBridgeHandle.rosterPath}\n`,
    );
  }

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
  const synapseIds = normalizedAssignments.map(
    (_, i) => `${sessionName}-worker-${i + 1}`,
  );
  for (let i = 0; i < normalizedAssignments.length; i++) {
    const a = normalizedAssignments[i];
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
    normalizedAssignments.length,
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
    for (let i = 0; i < normalizedAssignments.length; i++) {
      const a = normalizedAssignments[i];
      const paneName = `worker-${i + 1}`;
      tui.updateWorker(paneName, {
        cli: resolveHeadlessCliType(a.cli || "codex"),
        displayName: resolveHeadlessDisplayName(a, paneName),
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
    const { type, paneName, displayName, cli, snapshot, matched, exitCode } =
      event;
    if (!paneName) return;

    if (type === "progress" && snapshot) {
      tui.updateWorker(paneName, {
        cli: cli || "codex",
        displayName,
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
        displayName,
        status,
        progress: 1,
      });
    } else if (type === "worker_added") {
      tui.updateWorker(paneName, {
        cli: cli || "codex",
        displayName,
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

  const HUB_ACTIVITY_MIN_INTERVAL_MS = 30_000;
  const lastHubBeatByWorker = new Map();
  const feedHubActivity = (event) => {
    if (event?.type !== "progress" || !event.paneName) return;
    const match = event.paneName.match(/worker-(\d+)/);
    if (!match) return;
    const idx = parseInt(match[1], 10) - 1;
    const agentId = getHeadlessWorkerAgentId(sessionName, idx);
    const nowMs = Date.now();
    if (
      (lastHubBeatByWorker.get(agentId) || 0) + HUB_ACTIVITY_MIN_INTERVAL_MS >
      nowMs
    )
      return;
    lastHubBeatByWorker.set(agentId, nowMs);
    requestJson("/bridge/heartbeat", {
      method: "POST",
      body: {
        agent_id: agentId,
        ...(presenceOwnerByAgent.get(agentId) || {}),
      },
      timeoutMs: 500,
    }).catch(() => {});
    const assignJobId = normalizedAssignments[idx]?.assignJobId;
    if (assignJobId)
      requestJson("/bridge/assign/result", {
        method: "POST",
        body: { job_id: assignJobId, worker_agent: agentId, status: "running" },
        timeoutMs: 500,
      }).catch(() => {});
  };

  // onProgress 예외를 삼켜 실행 흐름 보호 (onPoll과 동일 패턴)
  const combinedProgress = (event) => {
    nativeBridgeHandle?.handleProgress(event);
    feedTui(event);
    feedSynapse(event);
    feedHubActivity(event);
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

  try {
    const progressiveDispatch = deps.dispatchProgressive || dispatchProgressive;
    const batchDispatch = deps.dispatchBatch || dispatchBatch;
    const dispatches =
      nativeBridge && nativeBridgeMode === "agents"
        ? await dispatchDaemonBatch(sessionName, normalizedAssignments, {
            safeProgress,
          })
        : progressive
          ? await progressiveDispatch(sessionName, normalizedAssignments, {
              layout,
              safeProgress,
              dashboardLayout,
              sessionOwnership,
              _deps: deps,
            })
          : await batchDispatch(sessionName, normalizedAssignments, {
              layout,
              safeProgress,
              dashboardLayout,
              sessionOwnership,
              _deps: deps,
            });
    if (nativeBridge && nativeBridgeMode === "agents") {
      daemonDispatches = dispatches;
      const createObservationSession =
        deps.createDaemonObservationSession || createDaemonObservationSession;
      let observation = null;
      try {
        observation = createObservationSession(sessionName, dispatches, {
          autoAttach,
          dashboard,
          dashboardLayout,
          onProgress: safeProgress,
          _deps: deps,
        });
      } catch (error) {
        emitObserverWarning(
          safeProgress,
          sessionName,
          "observer_session_create",
          error,
          "observer setup failed",
        );
      }
      if (observation) {
        sessionOwnership.acquire(observation.sessionName);
        safeProgress({
          type: "session_created",
          sessionName: observation.sessionName,
          panes: observation.panes,
          dashboardLayout: observation.dashboardLayout,
          observationSource: "daemon-files",
        });
      }
    }

    const results =
      nativeBridge && nativeBridgeMode === "agents"
        ? await awaitAllDaemon(
            dispatches,
            timeoutSec,
            safeProgress,
            progressIntervalSec,
            lifecycle,
          )
        : await awaitAll(
            sessionName,
            dispatches,
            timeoutSec,
            safeProgress,
            progressIntervalSec,
            stallDetect,
            lifecycle,
          );
    const collected = await collectResults(sessionName, results);
    for (const result of collected) nativeBridgeHandle?.completeWorker(result);

    // 완료 시 TUI에 최종 상태 반영 후 닫기
    if (tui) {
      for (const r of collected) {
        tui.updateWorker(r.paneName, {
          cli: r.cli,
          displayName: r.displayName,
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

    runCompleted = true;
    completedResults = collected;
  } catch (error) {
    runFailed = true;
    runError = error;
  }

  if (!runCompleted) sessionOwnership.release();
  try {
    // Synapse: 세션 unregister (fire-and-forget)
    for (const sid of synapseIds) {
      requestJson("/synapse/unregister", {
        method: "POST",
        body: { sessionId: sid },
        timeoutMs: 1000,
      }).catch(() => {});
    }
    if (nativeBridgeHandle) await nativeBridgeHandle.close();
    if (daemonDispatches.length > 0) {
      await cleanupDaemonDispatches(daemonDispatches);
    }
  } catch (error) {
    sessionOwnership.release();
    if (!runFailed) {
      runFailed = true;
      runError = error;
    }
  }

  if (runFailed) throw runError;
  return { sessionName, results: completedResults, sessionOwnership };
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
  const deps = opts._deps || {};
  const run = deps.runHeadless || runHeadless;
  const sessionOwnership = createHeadlessSessionOwnership(
    deps.killPsmuxSession || killPsmuxSession,
  );

  try {
    return await run(sessionName, assignments, {
      ...runOpts,
      _sessionOwnership: sessionOwnership,
    });
  } finally {
    try {
      for (let index = 0; index < assignments.length; index++) {
        unregisterHeadlessSynapseWorker(
          getHeadlessWorkerAgentId(sessionName, index),
        );
      }
      await deregisterHeadlessWorkers(sessionName, assignments.length);
    } finally {
      sessionOwnership.release();
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

function observerWarningMessage(cause, fallbackMessage) {
  if (cause instanceof Error && cause.message) return cause.message;
  const message = String(cause ?? "").trim();
  return message || fallbackMessage;
}

function safelyDeliverProgress(onProgress, event) {
  if (typeof onProgress !== "function") return;
  try {
    const result = onProgress(event);
    if (result?.catch) void result.catch(() => {});
  } catch {
    /* observer diagnostics are best-effort and must remain fail-open */
  }
}

function emitObserverWarning(
  onProgress,
  sessionName,
  stage,
  cause,
  fallbackMessage,
) {
  safelyDeliverProgress(onProgress, {
    type: "observer_warning",
    stage,
    message: observerWarningMessage(cause, fallbackMessage),
    sessionName: sanitizeSessionName(sessionName),
  });
}

// ─── v6.0.0: Lead-Direct Interactive Mode ───

/**
 * daemon/native-bridge worker를 read-only로 관찰하는 tmux session을 만든다.
 * 실제 worker process는 daemon에 남고, viewer는 result/partial/stderr 파일만 읽는다.
 *
 * @param {string} sessionName
 * @param {Array<{resultFile:string}>} dispatches
 * @param {object} [opts]
 * @returns {{sessionName:string, panes:string[], dashboardLayout:string}|null}
 */
export function createDaemonObservationSession(
  sessionName,
  dispatches,
  opts = {},
) {
  const deps = opts._deps || {};
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  if (!opts.autoAttach) return null;
  if (platform !== "darwin" && platform !== "linux") return null;
  if (!String(env.TMUX || "").trim()) return null;
  if (!/^%\d+$/u.test(String(env.TMUX_PANE || ""))) return null;
  if (!Array.isArray(dispatches) || dispatches.length === 0) return null;

  const safeSessionName = sanitizeSessionName(sessionName);
  const resolvedLayout = opts.dashboard
    ? resolveDashboardLayout(opts.dashboardLayout, dispatches.length)
    : "lite";
  const createSession = deps.createPsmuxSession || createPsmuxSession;
  const applyTheme = deps.applyTrifluxTheme || applyTrifluxTheme;
  const sendKeys = deps.sendKeysToPane || sendKeysToPane;
  const killSession = deps.killPsmuxSession || killPsmuxSession;
  let created = false;
  let stage = "observer_session_create";

  try {
    const session = createSession(safeSessionName, {
      layout: "2x2",
      paneCount: 1,
    });
    created = true;
    stage = "observer_theme";
    applyTheme(safeSessionName);
    stage = "observer_viewer_start";
    const targetPane = session.panes?.[0];
    if (!targetPane) throw new Error("observer pane was not created");

    const viewerCommand = [
      "exec",
      shellQuote(process.execPath),
      shellQuote(join(SCRIPT_DIR, "tui-viewer.mjs")),
      "--session",
      shellQuote(safeSessionName),
      "--result-dir",
      shellQuote(RESULT_DIR),
      "--layout",
      shellQuote(resolvedLayout),
      "--source",
      "files",
      "--workers",
      String(dispatches.length),
    ].join(" ");
    sendKeys(targetPane, viewerCommand, true);

    return {
      sessionName: safeSessionName,
      panes: session.panes,
      dashboardLayout: resolvedLayout,
    };
  } catch (error) {
    if (created) {
      try {
        killSession(safeSessionName);
      } catch {
        /* fail-open: observer failure must not stop daemon workers */
      }
    }
    emitObserverWarning(
      opts.onProgress,
      safeSessionName,
      stage,
      error,
      "observer setup failed",
    );
    return null;
  }
}

/**
 * attached tmux의 현재 leader pane 옆에 headless session view를 연다.
 * 새 pane의 attach client는 headless session 종료와 함께 자연스럽게 종료된다.
 *
 * @param {string} sessionName
 * @param {object} [opts]
 * @returns {boolean} split 요청 성공 여부
 */
export function attachHeadlessTmuxPane(sessionName, opts = {}) {
  const deps = opts._deps || {};
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  if (platform !== "darwin" && platform !== "linux") return false;
  const tmuxEnv = String(env.TMUX || "");
  if (!tmuxEnv.trim()) return false;

  const socketPath = tmuxEnv.split(",", 1)[0];
  if (!socketPath.trim()) return false;

  const targetPane = String(env.TMUX_PANE || "");
  if (!/^%\d+$/u.test(targetPane)) return false;

  const exec = deps.psmuxExec || psmuxExec;
  try {
    exec([
      "split-window",
      "-v",
      "-l",
      "30%",
      "-t",
      targetPane,
      "env",
      "-u",
      "TMUX",
      "tmux",
      "-S",
      socketPath,
      "attach-session",
      "-t",
      sanitizeSessionName(sessionName),
    ]);
    return true;
  } catch (error) {
    emitObserverWarning(
      opts.onProgress,
      sessionName,
      "tmux_split",
      error,
      "tmux split failed",
    );
    return false;
  }
}

/**
 * session_created auto-attach를 정확히 한 번 라우팅하는 progress handler.
 * Windows는 기존 WT helper를, macOS/Linux는 현재 tmux window split을 쓴다.
 *
 * @param {string} sessionName
 * @param {number} workerCount
 * @param {object} [opts]
 * @returns {(event: object) => void}
 */
export function createHeadlessAutoAttachHandler(
  sessionName,
  workerCount,
  opts = {},
) {
  const {
    autoAttach = false,
    dashboard = false,
    dashboardLayout = "single",
    dashboardSize = 0.4,
    dashboardAnchor = "window",
    onProgress,
  } = opts;
  const deps = opts._deps || {};
  let terminalAttached = false;

  return (event) => {
    if (autoAttach && event.type === "session_created" && !terminalAttached) {
      terminalAttached = true;
      let warningReported = false;
      const reportAttachWarning = (warningEvent) => {
        warningReported = true;
        safelyDeliverProgress(onProgress, warningEvent);
      };
      const reportAttachFailure = (cause, fallbackMessage) => {
        warningReported = true;
        emitObserverWarning(
          onProgress,
          sessionName,
          "auto_attach",
          cause,
          fallbackMessage,
        );
      };
      try {
        const platform = deps.platform ?? process.platform;
        let attachResult;
        if (platform === "win32" && dashboard) {
          const attach = deps.attachDashboardTab || attachDashboardTab;
          attachResult = attach(
            sessionName,
            workerCount,
            event.dashboardLayout ||
              resolveDashboardLayout(dashboardLayout, workerCount),
            dashboardSize,
            dashboardAnchor,
          );
        } else if (platform === "win32") {
          const attach = deps.autoAttachTerminal || autoAttachTerminal;
          attachResult = attach(
            sessionName,
            { dashboardLayout, dashboardAnchor },
            workerCount,
          );
        } else {
          const attach = deps.attachHeadlessTmuxPane || attachHeadlessTmuxPane;
          attachResult = attach(sessionName, {
            _deps: deps,
            onProgress: reportAttachWarning,
          });
        }
        if (attachResult === false && !warningReported) {
          reportAttachFailure(null, "auto-attach returned false");
        } else if (attachResult?.then) {
          void Promise.resolve(attachResult).then(
            (result) => {
              if (result === false && !warningReported) {
                reportAttachFailure(null, "auto-attach returned false");
              }
            },
            (error) => reportAttachFailure(error, "auto-attach rejected"),
          );
        }
      } catch (error) {
        reportAttachFailure(error, "auto-attach failed");
      }
    }
    if (onProgress) onProgress(event);
  };
}

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
  if (process.platform !== "win32") return false;
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
 * @param {boolean} [opts.autoAttach=false] — 현재 platform의 관찰 pane/tab 자동 attach
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
  const onProgress = createHeadlessAutoAttachHandler(
    sessionName,
    assignments.length,
    {
      autoAttach,
      dashboard,
      dashboardLayout: headlessOpts.dashboardLayout,
      dashboardSize,
      dashboardAnchor,
      onProgress: userOnProgress,
      _deps: headlessOpts._deps,
    },
  );
  const interactiveRunOpts = {
    ...headlessOpts,
    autoAttach,
    dashboard,
    onProgress,
  };
  const deps = headlessOpts._deps || {};
  const run = deps.runHeadless || runHeadless;
  let sessionOwnership = createHeadlessSessionOwnership(
    deps.killPsmuxSession || killPsmuxSession,
  );

  // Phase 1: 세션 생성 → 즉시 관찰 pane/tab attach → dispatch → 대기 → 결과 수집
  const runResult = await run(sessionName, assignments, {
    ...interactiveRunOpts,
    _sessionOwnership: sessionOwnership,
  });
  const { results } = runResult;
  sessionOwnership = runResult.sessionOwnership || sessionOwnership;

  // Phase 2: 세션을 유지하고 interactive handle 반환
  // Fix P2: paneId를 dispatches에 포함 (snapshots에서 필요)
  const dispatches = results.map((r, i) => ({
    paneName: r.paneName,
    displayName: r.displayName,
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

    /** 세션 종료 — attach pane/tab은 psmux 종료 시 자동으로 닫힘 */
    kill() {
      if (this._killed) return;
      this._killed = true;
      for (let index = 0; index < assignments.length; index++) {
        unregisterHeadlessSynapseWorker(
          getHeadlessWorkerAgentId(sessionName, index),
        );
      }
      void deregisterHeadlessWorkers(sessionName, assignments.length);
      sessionOwnership.release();
      // attach pane/tab은 psmux 종료 → attach client 종료 → 자동 닫힘
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
