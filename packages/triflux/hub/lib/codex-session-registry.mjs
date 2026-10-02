import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export function registryDir(env = process.env) {
  if (env.TFX_CODEX_SESSION_REGISTRY_DIR) {
    return env.TFX_CODEX_SESSION_REGISTRY_DIR;
  }
  return join(
    env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"),
    "triflux",
    "codex-sessions",
  );
}

function defaultPsFn(pid) {
  try {
    const output = execFileSync(
      "ps",
      ["-o", "ppid=,comm=", "-p", String(pid)],
      {
        encoding: "utf8",
        timeout: 1000,
      },
    );
    const match = output.match(/^\s*(\d+)\s+(.+?)\s*$/);
    return match ? { ppid: Number(match[1]), comm: match[2] } : null;
  } catch {
    return null;
  }
}

export function findCodexAncestorPid({
  startPid = process.ppid,
  psFn = defaultPsFn,
  maxDepth = 8,
} = {}) {
  const seen = new Set();
  let pid = startPid;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) return null;
    seen.add(pid);
    let processInfo;
    try {
      processInfo = psFn(pid);
    } catch {
      return null;
    }
    if (!processInfo) return null;
    if (basename(String(processInfo.comm || "")) === "codex") return pid;
    pid = Number(processInfo.ppid);
  }
  return null;
}

function defaultTmuxFn(paneId) {
  return execFileSync(
    "tmux",
    [
      "display-message",
      "-p",
      "-t",
      paneId,
      "#{session_name}:#{window_id}.#{pane_id}",
    ],
    { encoding: "utf8", timeout: 1000 },
  );
}

function defaultPanePidFn(paneId) {
  return execFileSync(
    "tmux",
    ["display-message", "-p", "-t", paneId, "#{pane_pid}"],
    { encoding: "utf8", timeout: 1000 },
  );
}

function defaultCommandFn(pid) {
  return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 1000,
  });
}

export function resolveTmuxCoordinate({ paneId, tmuxFn = defaultTmuxFn } = {}) {
  if (typeof paneId !== "string" || !paneId.trim()) return null;
  try {
    const coordinate = tmuxFn(paneId).trim();
    return /^.+:@\d+\.%\d+$/.test(coordinate) ? coordinate : null;
  } catch {
    return null;
  }
}

function aliveFromPid(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function pruneDeadRecords(dir) {
  try {
    for (const fileName of readdirSync(dir)) {
      if (!/^\d+\.json$/.test(fileName)) continue;
      const pid = Number(fileName.slice(0, -5));
      if (Number.isSafeInteger(pid) && pid > 0 && !aliveFromPid(pid)) {
        try {
          unlinkSync(join(dir, fileName));
        } catch {
          // Registry upkeep must never affect the hook response.
        }
      }
    }
  } catch {
    // A concurrent removal or permission change must not affect the write.
  }
}

export function writeCodexSessionRecord(
  payload,
  {
    env = process.env,
    now = Date.now,
    psFn = defaultPsFn,
    tmuxFn,
    panePidFn = defaultPanePidFn,
    commandFn = defaultCommandFn,
    dir = registryDir(env),
  } = {},
) {
  if (typeof payload?.session_id !== "string" || !payload.session_id.trim()) {
    return false;
  }
  const paneId = typeof env.TMUX_PANE === "string" ? env.TMUX_PANE.trim() : "";
  if (!paneId) return false;
  const pid = findCodexAncestorPid({ psFn });
  if (pid === null) return false;

  try {
    const command = commandFn(pid);
    if (
      typeof command !== "string" ||
      !command.trim() ||
      command.includes("app-server")
    ) {
      return false;
    }
    const panePidOutput = String(panePidFn(paneId)).trim();
    const panePid = Number(panePidOutput);
    if (
      !/^\d+$/.test(panePidOutput) ||
      !Number.isSafeInteger(panePid) ||
      panePid <= 0
    ) {
      return false;
    }
    const seen = new Set();
    let ancestor = pid;
    for (let depth = 0; depth < 8 && ancestor !== panePid; depth += 1) {
      if (
        !Number.isSafeInteger(ancestor) ||
        ancestor <= 0 ||
        seen.has(ancestor)
      ) {
        return false;
      }
      seen.add(ancestor);
      ancestor = Number(psFn(ancestor)?.ppid);
    }
    if (ancestor !== panePid) return false;
  } catch {
    // Daemons and stale panes cannot prove which TUI owns this thread.
    return false;
  }

  const timestamp = typeof now === "function" ? now() : now;
  const targetDir = dir;
  const target = join(targetDir, `${pid}.json`);
  let startedAt = timestamp;
  try {
    const existing = JSON.parse(readFileSync(target, "utf8"));
    if (
      existing.pid === pid &&
      existing.sessionId === payload.session_id &&
      Number.isFinite(existing.startedAt)
    ) {
      startedAt = existing.startedAt;
    }
  } catch {
    // New record, or an invalid previous record.
  }

  const record = {
    version: 1,
    writer: "triflux",
    pid,
    sessionId: payload.session_id,
    cwd: payload.cwd || process.cwd(),
    tmux: resolveTmuxCoordinate({ paneId, tmuxFn }),
    tmuxPane: paneId,
    source: payload.source || null,
    startedAt,
    updatedAt: timestamp,
  };

  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const temporary = join(
    targetDir,
    `.${pid}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, target);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Keep the original write error.
    }
    throw error;
  }
  pruneDeadRecords(targetDir);
  return true;
}

export function readCodexSessionRecords({
  dir = registryDir(),
  isAlive = aliveFromPid,
} = {}) {
  let fileNames;
  try {
    fileNames = readdirSync(dir);
  } catch {
    return [];
  }
  const records = [];
  for (const fileName of fileNames) {
    if (!fileName.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readFileSync(join(dir, fileName), "utf8"));
      if (
        record &&
        Number.isSafeInteger(record.pid) &&
        record.pid > 0 &&
        typeof record.sessionId === "string" &&
        record.sessionId &&
        isAlive(record.pid)
      ) {
        records.push(record);
      }
    } catch {
      // Ignore a malformed or concurrently removed record.
    }
  }
  return records;
}

export function codexThreadNames({ indexPath } = {}) {
  const path =
    indexPath ||
    join(
      process.env.CODEX_HOME || join(process.env.HOME || homedir(), ".codex"),
      "session_index.jsonl",
    );
  let data;
  try {
    data = readFileSync(path, "utf8");
  } catch {
    return new Map();
  }
  const names = new Map();
  for (const line of data.split("\n")) {
    try {
      const entry = JSON.parse(line);
      if (
        typeof entry.id === "string" &&
        typeof entry.thread_name === "string"
      ) {
        names.set(entry.id, entry.thread_name);
      }
    } catch {
      // Ignore malformed or incomplete lines.
    }
  }
  return names;
}
