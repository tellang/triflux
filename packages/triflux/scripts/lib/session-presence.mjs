// Codex와 Antigravity 세션 hook이 공유하는 presence 기록 함수.
import { execFile, execFileSync } from "node:child_process";
import { join } from "node:path";
import { resolveRoleControlSnapshot } from "../../hub/lib/cto-env.mjs";
import {
  buildSynapseTaskSummary,
  heartbeatSynapseSession,
  registerSynapseSession,
} from "../../hub/team/synapse-http.mjs";

function parseStartPayload(stdinData) {
  try {
    const raw = typeof stdinData === "string" ? stdinData : "";
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function inferParticipantCli(payload) {
  const direct = String(
    payload?.actor_cli || payload?.cli || payload?.actor?.cli || "",
  )
    .trim()
    .toLowerCase();
  if (direct) return direct;

  const eventName = String(payload?.hook_event_name || "").trim();
  if (eventName === "SessionStart") return "claude";
  if (eventName.toLowerCase().replace(/-/g, "_") === "session_start") {
    return "codex";
  }
  return "participant";
}

async function defaultAppendParticipantCtoEvent(lakeRoot, event) {
  const { appendCtoEvent } = await import("../../cto/events.mjs");
  return appendCtoEvent(lakeRoot, event, {
    lockRetries: 1,
    lockRetryDelayMs: 0,
  });
}

async function defaultResolveParticipantLakeRoot(cwd) {
  const { resolveLakeRootDir } = await import("../../cto/lake-root.mjs");
  const projectRoot = resolveLakeRootDir(cwd, {
    execFileSync: (cmd, args, options = {}) =>
      execFileSync(cmd, args, {
        ...options,
        timeout: 500,
        killSignal: "SIGKILL",
      }),
  });
  return {
    projectRoot,
    lakeRoot: projectRoot ? join(projectRoot, ".triflux", "lake") : "",
  };
}

/**
 * Append a compact CTO `session_started` event for participant hooks.
 * This is intentionally observational only: no cleanup, reconciliation, or
 * summarization policy is performed here. Callers may fire-and-forget it.
 *
 * @param {string} stdinData SessionStart-shaped stdin JSON
 * @param {object} [seams] test seams
 * @returns {Promise<object|null>}
 */
export async function emitParticipantSessionStarted(stdinData, seams = {}) {
  try {
    if (
      !resolveRoleControlSnapshot(seams.env || process.env).auto_collect_enabled
    ) {
      return null;
    }
    const payload = parseStartPayload(stdinData);
    const sessionId = String(payload?.session_id || "").trim();
    if (!sessionId) return null;
    const cwd = typeof payload?.cwd === "string" ? payload.cwd : process.cwd();
    const resolveLakeRoot =
      seams.resolveLakeRoot || defaultResolveParticipantLakeRoot;
    const resolved = await resolveLakeRoot(cwd);
    const projectRoot =
      typeof resolved === "string"
        ? resolved
        : String(resolved?.projectRoot || "");
    const lakeRoot =
      typeof resolved === "string"
        ? join(resolved, ".triflux", "lake")
        : String(resolved?.lakeRoot || "");
    if (!lakeRoot) return null;

    const event = {
      event: "session_started",
      source: "tfx_participant_hook",
      session_id: sessionId,
      project_root: projectRoot || cwd,
      worktree_path: cwd,
      branch: typeof payload?.branch === "string" ? payload.branch : "",
      status: "active",
      actor: {
        cli: inferParticipantCli(payload),
        session_id: sessionId,
        host: typeof payload?.host === "string" ? payload.host : "local",
      },
      summary: `${inferParticipantCli(payload)} session_started ${sessionId}`,
      now: seams.now,
    };

    const append = seams.ctoAppend || defaultAppendParticipantCtoEvent;
    return await append(lakeRoot, event);
  } catch {
    return null;
  }
}

function readAncestorCommands(pid = process.ppid, maxDepth = 6) {
  if (process.platform === "win32") return [];
  const commands = [];
  let currentPid = Number(pid);
  for (let depth = 0; depth < maxDepth; depth++) {
    if (!Number.isInteger(currentPid) || currentPid <= 1) break;
    try {
      const output = execFileSync(
        "ps",
        ["-o", "ppid=", "-o", "command=", "-p", String(currentPid)],
        {
          encoding: "utf8",
          timeout: 200,
          windowsHide: true,
        },
      ).trim();
      const match = output.match(/^(\d+)\s+([\s\S]+)$/);
      if (!match) break;
      commands.push(match[2]);
      currentPid = Number(match[1]);
    } catch {
      break;
    }
  }
  return commands;
}

function commandUsesClaudePrintMode(command) {
  return /\bclaude(?:\s+\S+)*\s+(?:--print|-p)(?:\s|=|$)/u.test(
    String(command || ""),
  );
}

function shouldSkipInteractiveRegistration(payload, seams = {}) {
  const declaredKind = String(
    payload?.sessionKind || payload?.session_kind || "",
  )
    .trim()
    .toLowerCase();
  if (declaredKind === "headless") return true;

  const ancestorCommands = Array.isArray(seams.ancestorCommands)
    ? seams.ancestorCommands
    : readAncestorCommands(seams.parentPid);
  return ancestorCommands.some((command) =>
    commandUsesClaudePrintMode(command),
  );
}

/**
 * cwd 기준 git 컨텍스트(worktree root / branch)를 best-effort, 비동기로 수집.
 * execFileSync 와 달리 호출자(BACKGROUND)를 블로킹하지 않는다. 각 git 호출은
 * tight timeout(1.5s) + 강제 kill 로 묶여 hub/디스크 stall 시에도 잔류하지 않는다.
 * @param {string} cwd
 * @param {(args:string[], cb:(out:string)=>void)=>void} [gitRunner] 테스트용 seam
 * @returns {Promise<{ worktreePath: string, branch: string }>}
 */
function gitContextAsync(cwd, gitRunner = defaultGitRunner) {
  const run = (args) =>
    new Promise((resolve) => {
      try {
        gitRunner(cwd, args, (out) => resolve(out));
      } catch {
        resolve("");
      }
    });
  return Promise.all([
    run(["rev-parse", "--show-toplevel"]),
    run(["rev-parse", "--abbrev-ref", "HEAD"]),
  ]).then(([toplevel, branch]) => ({
    worktreePath: toplevel || cwd,
    branch,
  }));
}

/** 기본 git runner: execFile(async) + tight timeout + kill. 실패는 빈 문자열. */
function defaultGitRunner(cwd, args, cb) {
  execFile(
    "git",
    args,
    {
      cwd,
      encoding: "utf8",
      timeout: 1500,
      killSignal: "SIGKILL",
      windowsHide: true,
    },
    (err, stdout) => {
      cb(err ? "" : String(stdout || "").trim());
    },
  );
}

/**
 * 인터랙티브 세션을 Synapse 레지스트리에 self-register (fire-and-forget).
 * hub 미응답이면 silent no-op. BLOCKING path 에 latency 0 — git 컨텍스트는
 * 블로킹 경로 밖에서 비동기로 enrich 한다 (cwd 만으로 즉시 minimal register).
 *
 * pid 는 의도적으로 보내지 않는다: 이 훅 프로세스의 process.pid 는 short-lived
 * 훅 PID 일 뿐 세션 PID 가 아니므로 오기재가 된다. liveness 는 TTL 이 담당한다.
 *
 * @param {string} stdinData
 * @param {object} [seams] 테스트용 injectable seam
 * @param {Function} [seams.register]  registerSynapseSession 대체
 * @param {Function} [seams.heartbeat] heartbeatSynapseSession 대체
 * @param {Function} [seams.gitRunner] git runner 대체
 * @returns {Promise<object|null>|null} CTO append promise; enrich 는 백그라운드에서 완료
 */
export function registerInteractiveSession(stdinData, seams = {}) {
  let ctoEvent = null;
  const register = seams.register || registerSynapseSession;
  const heartbeat = seams.heartbeat || heartbeatSynapseSession;
  const gitRunner = seams.gitRunner || defaultGitRunner;
  try {
    const payload = parseStartPayload(stdinData);
    const sessionId = String(payload?.session_id || "").trim();
    if (!sessionId) return null;
    if (shouldSkipInteractiveRegistration(payload, seams)) return null;
    const cwd = typeof payload?.cwd === "string" ? payload.cwd : process.cwd();

    // 1) cwd 만으로 즉시 minimal register (블로킹 git 없음, latency 0).
    register({
      sessionId,
      cwd,
      worktreePath: cwd,
      branch: "",
      host: "local",
      sessionKind: "interactive",
      isRemote: false,
    });

    ctoEvent = emitParticipantSessionStarted(stdinData, seams).catch(
      () => null,
    );

    // 2) worktree/branch 는 블로킹 경로 밖에서 비동기 enrich → heartbeat partial.
    gitContextAsync(cwd, gitRunner)
      .then(({ worktreePath, branch }) => {
        if (worktreePath === cwd && !branch) return; // 추가 정보 없음
        heartbeat(sessionId, { worktreePath, branch });
      })
      .catch(() => {});
  } catch {
    /* best-effort — never affects session start */
  }
  return ctoEvent;
}

/**
 * interactive 세션의 사용자 활동을 liveness 로 갱신한다.
 * 이 갱신이 없으면 hub monitor 가 5분 TTL 후 세션을 stale 로 전이시켜
 * `cto status` 의 live_sessions 가 비어 보인다.
 *
 * heartbeat 는 fire-and-forget POST 이므로 호출측 세션 hook 이
 * process.exit 전에 drainPendingSynapse 로 flush 해야 drop 되지 않는다.
 *
 * pid 는 register 와 동일하게 보내지 않는다(91-92 주석): liveness 는 TTL +
 * heartbeat 가 담당한다.
 *
 * @param {string} stdinData UserPromptSubmit stdin JSON
 * @param {object} [seams] 테스트용 injectable seam
 * @param {Function} [seams.heartbeat] heartbeatSynapseSession 대체
 * @returns {void}
 */
export function heartbeatInteractiveSession(stdinData, seams = {}) {
  const heartbeat = seams.heartbeat || heartbeatSynapseSession;
  try {
    const payload = parseStartPayload(stdinData);
    const sessionId = String(payload?.session_id || "").trim();
    if (!sessionId) return;
    const cwd = typeof payload?.cwd === "string" ? payload.cwd : process.cwd();
    const partial = { worktreePath: cwd, host: "local" };
    const prompt = typeof payload?.prompt === "string" ? payload.prompt : "";
    if (prompt) partial.taskSummary = buildSynapseTaskSummary(prompt);
    heartbeat(sessionId, partial);
  } catch {
    /* best-effort — never affects the prompt turn */
  }
}
