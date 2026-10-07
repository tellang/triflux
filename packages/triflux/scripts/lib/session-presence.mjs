// Codex와 Antigravity 세션 hook이 공유하는 presence 기록 함수.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { resolveRoleControlSnapshot } from "../../hub/lib/cto-env.mjs";

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

export function shouldSkipInteractiveRegistration(payload, seams = {}) {
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
