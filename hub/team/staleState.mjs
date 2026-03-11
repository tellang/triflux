// hub/team/staleState.mjs
// .omc/state 아래에 남은 stale team 상태를 탐지/정리한다.

import { existsSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

export const TEAM_STATE_FILE_NAME = "team-state.json";
export const STALE_TEAM_MAX_AGE_MS = 60 * 60 * 1000;

function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function parseStartedAtMs(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function findPidCandidates(state) {
  const pidSet = new Set();
  const pushPid = (value) => {
    const pid = Number(value);
    if (Number.isInteger(pid) && pid > 0) pidSet.add(pid);
  };

  pushPid(state?.pid);
  pushPid(state?.processId);
  pushPid(state?.process_id);
  pushPid(state?.leadPid);
  pushPid(state?.lead_pid);
  pushPid(state?.native?.supervisorPid);
  pushPid(state?.native?.supervisor_pid);

  return Array.from(pidSet);
}

function findSessionNames(state) {
  const sessionNameSet = new Set();
  const pushName = (value) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed) sessionNameSet.add(trimmed);
  };

  pushName(state?.sessionName);
  pushName(state?.session_name);
  pushName(state?.native?.teamName);
  pushName(state?.native?.team_name);

  return Array.from(sessionNameSet);
}

function findProcessTokens(state, sessionId) {
  const tokenSet = new Set();
  const pushToken = (value) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed.length >= 6) tokenSet.add(trimmed.toLowerCase());
  };

  pushToken(sessionId);
  pushToken(state?.session_id);
  pushToken(state?.sessionId);
  pushToken(state?.teamName);
  pushToken(state?.team_name);
  pushToken(state?.name);
  pushToken(state?.native?.teamName);
  pushToken(state?.native?.team_name);

  return Array.from(tokenSet);
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function normalizeProcessEntries(processEntries = []) {
  if (!Array.isArray(processEntries)) return [];

  return processEntries.map((entry) => ({
    pid: Number(entry?.pid ?? entry?.ProcessId ?? 0),
    command: String(entry?.command ?? entry?.CommandLine ?? entry?.Name ?? "").toLowerCase(),
  }));
}

function readProcessEntries() {
  try {
    if (process.platform === "win32") {
      const raw = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress",
        ],
        {
          encoding: "utf8",
          timeout: 10000,
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        },
      ).trim();

      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return normalizeProcessEntries(Array.isArray(parsed) ? parsed : [parsed]);
    }

    const raw = execFileSync("ps", ["-ax", "-o", "pid=,command="], {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (!raw) return [];
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = /^(\d+)\s+(.*)$/.exec(line);
        return {
          pid: Number(match?.[1] || 0),
          command: String(match?.[2] || "").toLowerCase(),
        };
      });
  } catch {
    return [];
  }
}

function resolveLiveness(state, sessionId, liveSessionNames, processEntries) {
  const pidCandidates = findPidCandidates(state);
  for (const pid of pidCandidates) {
    if (isPidAlive(pid)) {
      return { active: true, reason: `pid:${pid}` };
    }
  }

  const sessionNames = findSessionNames(state);
  for (const sessionName of sessionNames) {
    if (liveSessionNames.has(sessionName)) {
      return { active: true, reason: `session:${sessionName}` };
    }
  }

  const processTokens = findProcessTokens(state, sessionId);
  if (processTokens.length > 0) {
    const matched = processEntries.find((entry) => (
      entry.pid > 0 && processTokens.some((token) => entry.command.includes(token))
    ));
    if (matched) {
      return { active: true, reason: `command:${matched.pid}` };
    }
  }

  return { active: false, reason: "process_missing" };
}

function collectTeamStateTargets(stateRoot) {
  const targets = [];
  const rootStateFile = join(stateRoot, TEAM_STATE_FILE_NAME);
  if (existsSync(rootStateFile)) {
    targets.push({
      scope: "root",
      sessionId: "root",
      stateFile: rootStateFile,
      cleanupPath: rootStateFile,
      cleanupType: "file",
    });
  }

  const sessionsDir = join(stateRoot, "sessions");
  const sessionsStat = safeStat(sessionsDir);
  if (!sessionsStat?.isDirectory()) {
    return targets;
  }

  for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sessionDir = join(sessionsDir, entry.name);
    const stateFile = join(sessionDir, TEAM_STATE_FILE_NAME);
    if (!existsSync(stateFile)) continue;

    targets.push({
      scope: "session",
      sessionId: entry.name,
      stateFile,
      cleanupPath: sessionDir,
      cleanupType: "dir",
    });
  }

  return targets;
}

export function findNearestOmcStateDir(startDir = process.cwd()) {
  let currentDir = resolve(startDir);

  while (true) {
    const candidate = join(currentDir, ".omc", "state");
    const candidateStat = safeStat(candidate);
    if (candidateStat?.isDirectory()) {
      return candidate;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

export function inspectStaleOmcTeams(options = {}) {
  const stateRoot = options.stateRoot || findNearestOmcStateDir(options.startDir || process.cwd());
  if (!stateRoot) {
    return { stateRoot: null, entries: [] };
  }

  const liveSessionNames = new Set(options.liveSessionNames || []);
  const processEntries = normalizeProcessEntries(options.processEntries || readProcessEntries());
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : STALE_TEAM_MAX_AGE_MS;
  const targets = collectTeamStateTargets(stateRoot);
  const entries = [];

  for (const target of targets) {
    let state = null;
    try {
      state = JSON.parse(readFileSync(target.stateFile, "utf8"));
    } catch {
      continue;
    }

    const fileStat = safeStat(target.stateFile);
    const startedAtMs = parseStartedAtMs(state?.started_at)
      ?? parseStartedAtMs(state?.startedAt)
      ?? fileStat?.mtimeMs
      ?? null;
    const ageMs = startedAtMs == null ? null : Math.max(0, nowMs - startedAtMs);
    const liveness = resolveLiveness(state, target.sessionId, liveSessionNames, processEntries);
    const stale = ageMs != null && ageMs >= maxAgeMs && !liveness.active;

    entries.push({
      ...target,
      teamName: state?.teamName || state?.team_name || state?.native?.teamName || state?.name || null,
      state,
      startedAtMs,
      ageMs,
      ageSec: ageMs == null ? null : Math.floor(ageMs / 1000),
      active: liveness.active,
      activeReason: liveness.reason,
      stale,
    });
  }

  return {
    stateRoot,
    entries: entries
      .filter((entry) => entry.stale)
      .sort((left, right) => (right.ageMs || 0) - (left.ageMs || 0)),
  };
}

export function cleanupStaleOmcTeams(entries = []) {
  let cleaned = 0;
  let failed = 0;
  const results = [];

  for (const entry of entries) {
    try {
      if (entry.cleanupType === "dir") {
        rmSync(entry.cleanupPath, { recursive: true, force: true });
      } else {
        unlinkSync(entry.cleanupPath);
      }

      cleaned += 1;
      results.push({ ok: true, entry });
    } catch (error) {
      failed += 1;
      results.push({ ok: false, entry, error });
    }
  }

  return { cleaned, failed, results };
}
