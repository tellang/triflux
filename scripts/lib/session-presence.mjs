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

/** 참가 세션의 시작 이벤트만 기록한다. */
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

/** git 조회는 세션 시작을 막지 않도록 비동기로 실행한다. */
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

/** git 조회 실패는 빈 문자열로 처리한다. */
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

/** 세션을 즉시 등록하고 git 정보는 뒤이어 갱신한다. 훅 PID는 세션 PID가 아니다. */
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

    gitContextAsync(cwd, gitRunner)
      .then(({ worktreePath, branch }) => {
        if (worktreePath === cwd && !branch) return;
        heartbeat(sessionId, { worktreePath, branch });
      })
      .catch(() => {});
  } catch {
    /* 세션 시작은 계속한다. */
  }
  return ctoEvent;
}

/** 사용자 활동을 갱신한다. 호출자는 종료 전에 전송을 완료해야 한다. */
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
    /* 프롬프트 처리는 계속한다. */
  }
}
