// hub/hub-lifecycle.mjs — Hub process lifecycle helpers

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HUB_DEFAULT_PORT = 27888;

const HUB_PID_FILE = join(homedir(), ".claude", "cache", "tfx-hub", "hub.pid");
const EPHEMERAL_ENV_KEYS = [
  "TFX_WORKER_SANDBOX_SCOPE",
  "TFX_WORKER_INDEX",
  "TFX_TEAM_TASK_ID",
  "TFX_TEAM_AGENT_NAME",
  "TFX_EPHEMERAL",
];

function parsePositiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parsePortFromUrl(value) {
  try {
    return parsePositiveInt(new URL(String(value)).port);
  } catch {
    return null;
  }
}

export function isHubServerCommand(command) {
  return /(^|[\\/,\s])hub[\\/]server\.mjs(?=$|[\s"'`])/i.test(
    String(command || ""),
  );
}

export function isWorktreeOrEphemeralHubContext({
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const normalizedCwd = String(cwd || "").replace(/\\/g, "/");
  if (
    normalizedCwd.includes("/.claude/worktrees/") ||
    normalizedCwd.includes("/.worktrees/") ||
    normalizedCwd.includes("/.codex-swarm/wt-") ||
    /(^|\/)wt-[^/]+(?:\/|$)/u.test(normalizedCwd)
  ) {
    return true;
  }
  return EPHEMERAL_ENV_KEYS.some((key) => String(env?.[key] || "").length > 0);
}

export function resolveHubPortForContext({
  port,
  env = process.env,
  cwd = process.cwd(),
  defaultPort = HUB_DEFAULT_PORT,
} = {}) {
  const envPort = parsePositiveInt(port) ?? parsePositiveInt(env?.TFX_HUB_PORT);
  const urlPort = parsePortFromUrl(env?.TFX_HUB_URL);
  const resolvedPort = envPort ?? urlPort ?? defaultPort;
  if (
    resolvedPort !== defaultPort &&
    // Test-only opt-in seam: TFX_HUB_ALLOW_EPHEMERAL_PORT=1 lets an ephemeral
    // context (worktree cwd / TFX_TEAM_* env) honor the resolved port instead
    // of clamping to the canonical default. Default-off — production unchanged.
    String(env?.TFX_HUB_ALLOW_EPHEMERAL_PORT ?? "") !== "1" &&
    isWorktreeOrEphemeralHubContext({ cwd, env })
  ) {
    return defaultPort;
  }
  return resolvedPort;
}

export function collectHubProcesses(
  psOutput = "",
  { currentPid = process.pid } = {},
) {
  const ownPid = Number(currentPid);
  return String(psOutput)
    .split(/\r?\n/u)
    .flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u);
      if (!match) return [];
      const pid = Number.parseInt(match[1], 10);
      const ppid = Number.parseInt(match[2], 10);
      const command = match[3].trim();
      if (!Number.isFinite(pid) || pid === ownPid) return [];
      if (!/\bnode(?:\s|$)|\/node(?:\s|$)/u.test(command)) return [];
      if (!isHubServerCommand(command)) return [];
      return [{ pid, ppid, command }];
    });
}

function readPidFilePid({
  pidFilePath = HUB_PID_FILE,
  readFile = readFileSync,
} = {}) {
  try {
    const info = JSON.parse(readFile(pidFilePath, "utf8"));
    const pid = Number(info?.pid);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function findListeningPidsForPort(
  port = HUB_DEFAULT_PORT,
  { execFileSyncFn = execFileSync } = {},
) {
  try {
    const output = execFileSyncFn(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      {
        encoding: "utf8",
        timeout: 1000,
        maxBuffer: 1024 * 1024,
      },
    );
    return String(output)
      .split(/\r?\n/u)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isFinite(pid) && pid > 0);
  } catch {
    return [];
  }
}

async function waitForExit(
  pid,
  { killFn = process.kill, graceMs = 5000, pollMs = 100 } = {},
) {
  const deadline = Date.now() + Math.max(0, graceMs);
  while (Date.now() <= deadline) {
    try {
      killFn(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  try {
    killFn(pid, 0);
    return false;
  } catch {
    return true;
  }
}

export async function reapExistingHubProcesses({
  currentPid = process.pid,
  pidFilePath = HUB_PID_FILE,
  execFileSyncFn = execFileSync,
  killFn = process.kill,
  readPidFileFn,
  findListeningPidsForPortFn,
  waitForExitFn,
  graceMs = 5000,
  pollMs = 100,
} = {}) {
  let output = "";
  try {
    output = execFileSyncFn("ps", ["-axo", "pid,ppid,command"], {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    return {
      candidates: [],
      reaped: [],
      preserved: {
        currentPid: Number(currentPid),
        pidFilePid: null,
        defaultPortPids: [],
      },
    };
  }

  const current = Number(currentPid);
  const pidFileInfo =
    typeof readPidFileFn === "function"
      ? readPidFileFn()
      : { pid: readPidFilePid({ pidFilePath }) };
  const pidFilePid = parsePositiveInt(pidFileInfo?.pid);
  const defaultPortPids = [
    ...new Set(
      (typeof findListeningPidsForPortFn === "function"
        ? findListeningPidsForPortFn(HUB_DEFAULT_PORT)
        : findListeningPidsForPort(HUB_DEFAULT_PORT, { execFileSyncFn })
      ).map(Number),
    ),
  ].filter((pid) => Number.isFinite(pid) && pid > 0);

  const preservedPids = new Set(
    [current, pidFilePid, ...defaultPortPids].filter(
      (pid) => Number.isFinite(pid) && pid > 0,
    ),
  );
  const candidates = collectHubProcesses(output, { currentPid: current });
  const reaped = [];
  const failed = [];

  for (const processInfo of candidates) {
    if (preservedPids.has(processInfo.pid)) continue;
    try {
      killFn(processInfo.pid, "SIGTERM");
      const exited =
        typeof waitForExitFn === "function"
          ? await waitForExitFn(processInfo.pid, { killFn, graceMs, pollMs })
          : await waitForExit(processInfo.pid, { killFn, graceMs, pollMs });
      if (!exited) {
        try {
          killFn(processInfo.pid, "SIGKILL");
        } catch (error) {
          failed.push({
            pid: processInfo.pid,
            signal: "SIGKILL",
            error: String(error?.message || error),
          });
        }
      }
      reaped.push(processInfo);
    } catch (error) {
      failed.push({
        pid: processInfo.pid,
        signal: "SIGTERM",
        error: String(error?.message || error),
      });
    }
  }

  return {
    candidates,
    reaped,
    failed,
    preserved: {
      currentPid: current,
      pidFilePid,
      defaultPortPids,
    },
  };
}
