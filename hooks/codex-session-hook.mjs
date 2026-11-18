#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { argv, exit, stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { writeCodexSessionRecord } from "../hub/lib/codex-session-registry.mjs";
import { readCodexContext } from "../hub/team/session-context.mjs";

const COMPACT_DEFAULT_MESSAGE =
  "[tfx 압축 스냅샷] 현재 작업 목표와 범위, 결과 파일과 지시서 경로, 남은 일과 다음 단계를 확인하고 이어간다.";
const WORKERS_TABLE_MAX_CHARS = 1800;
const SUCCESSION_THRESHOLD_PCT = 85;
const SUCCESSION_BLOCK_MESSAGE =
  "[tfx-lead] 컨텍스트 사용량이 85%에 도달했다. 인계 파일을 저장하고 tfx-live clear 로 새 대화에 승계하라.";

function parsePayload(stdinData) {
  try {
    const raw = typeof stdinData === "string" ? stdinData : "";
    return raw.trim()
      ? { ok: true, payload: JSON.parse(raw) }
      : { ok: false, payload: {} };
  } catch {
    return { ok: false, payload: {} };
  }
}

function normalizeMode(mode, payload) {
  const direct = String(mode || "")
    .trim()
    .toLowerCase();
  if (direct === "register" || direct === "heartbeat" || direct === "stop") {
    return direct;
  }

  const eventName = String(payload?.hook_event_name || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (eventName === "session_start" || eventName === "sessionstart") {
    return "register";
  }
  if (eventName === "user_prompt_submit" || eventName === "userpromptsubmit") {
    return "heartbeat";
  }
  if (eventName === "stop") {
    return "stop";
  }
  return "";
}

function resolveStateRoot(env = process.env) {
  const base =
    env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state");
  return join(base, "triflux");
}

function writeJsonAtomic(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmpPath, filePath);
}

function isActiveLeadRole(record) {
  return (
    record &&
    typeof record === "object" &&
    (record.sessionRole === "lead" || record.sessionRole === "communication")
  );
}

function findActiveLeadMarker(payload, env = process.env) {
  const dir = join(resolveStateRoot(env), "lead-roles");
  if (!existsSync(dir)) return null;

  const entries = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const filePath = join(dir, name);
    try {
      const record = JSON.parse(readFileSync(filePath, "utf8"));
      if (isActiveLeadRole(record)) {
        entries.push({ filePath, record });
      }
    } catch {}
  }
  if (entries.length === 0) return null;

  const tmuxPane = String(env.TMUX_PANE || "").trim();
  if (tmuxPane) {
    const byPane = entries.find(
      ({ record }) => record.paneId && String(record.paneId).trim() === tmuxPane,
    );
    if (byPane) return byPane;
  }

  const sessionId = String(payload?.session_id || "").trim();
  if (sessionId) {
    const byThread = entries.find(
      ({ record }) =>
        record.threadId && String(record.threadId).trim() === sessionId,
    );
    if (byThread) return byThread;
  }

  if (!tmuxPane && payload?.cwd) {
    const targetCwd = resolve(payload.cwd);
    const byCwd = entries.find(
      ({ record }) =>
        record.cli === "codex" &&
        record.cwd &&
        resolve(record.cwd) === targetCwd,
    );
    if (byCwd) return byCwd;
  }

  return null;
}

function readWorkersTable(cwd) {
  if (!cwd) return "";
  const workersFile = join(cwd, ".omc", "lead", "workers.md");
  if (!existsSync(workersFile)) return "";
  try {
    const lines = readFileSync(workersFile, "utf8")
      .split("\n")
      .filter((line) => line.trimStart().startsWith("|"));
    if (lines.length === 0) return "";
    return lines.join("\n").slice(0, WORKERS_TABLE_MAX_CHARS);
  } catch {
    return "";
  }
}

function readDarwinPressureLevel() {
  try {
    const raw = execFileSync(
      "sysctl",
      ["-n", "kern.memorystatus_vm_pressure_level"],
      {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return Number.parseInt(String(raw).trim(), 10);
  } catch {
    return Number.NaN;
  }
}

function handleRegister(payload, opts, env) {
  const writeSessionRecord = opts.writeSessionRecord || writeCodexSessionRecord;
  try {
    writeSessionRecord(payload);
  } catch {}

  const marker = findActiveLeadMarker(payload, env);
  let markerDirty = false;
  if (
    marker &&
    payload?.session_id &&
    payload.session_id !== marker.record.threadId
  ) {
    marker.record.threadId = payload.session_id;
    markerDirty = true;
  }

  const contextParts = [];
  if (payload?.source === "compact") {
    if (!marker) {
      contextParts.push(COMPACT_DEFAULT_MESSAGE);
    } else {
      const roleLabel =
        marker.record.sessionRole === "communication"
          ? "소통 역할"
          : "리드 역할";
      const roleText = marker.record.role || marker.record.sessionRole;
      const nameText =
        marker.record.name || marker.record.session || "codex-lead";
      contextParts.push(
        `[tfx 압축 스냅샷] ${roleLabel}: ${roleText}, 세션 이름: ${nameText}. 현재 작업 목표와 범위, 결과 파일과 지시서 경로, 남은 일과 다음 단계를 확인하고 이어간다.`,
      );
      const table = readWorkersTable(payload?.cwd || marker.record.cwd);
      if (table) {
        contextParts.push(table);
      }
    }
  }

  if (marker?.record?.pendingHandoff?.path) {
    const handoffPath = marker.record.pendingHandoff.path;
    contextParts.push(
      `[tfx-lead] 인계 파일 ${handoffPath} 를 읽고 역할을 이어간다.`,
    );
    marker.record.pendingHandoff = null;
    markerDirty = true;
  }

  if (marker && markerDirty) {
    writeJsonAtomic(marker.filePath, marker.record);
  }

  if (contextParts.length > 0) {
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: contextParts.join("\n"),
      },
    };
  }
  return null;
}

async function handleHeartbeat(payload, opts, env) {
  const writeSessionRecord = opts.writeSessionRecord || writeCodexSessionRecord;
  try {
    writeSessionRecord(payload);
  } catch {}

  const marker = findActiveLeadMarker(payload, env);
  if (!marker) return null;
  if ((opts.platform ?? process.platform) !== "darwin") return null;

  const level = Number(
    typeof opts.readPressureLevel === "function"
      ? await opts.readPressureLevel()
      : readDarwinPressureLevel(),
  );
  if (!Number.isFinite(level)) return null;

  const rawKey =
    marker.record.session ||
    marker.record.paneId ||
    payload?.session_id ||
    basename(marker.filePath, ".json");
  const safeKey = String(rawKey).replace(/[^a-zA-Z0-9._-]/g, "_");
  const statePath = join(
    resolveStateRoot(env),
    "pressure",
    `codex-${safeKey}.json`,
  );

  let previousLevel = null;
  if (existsSync(statePath)) {
    try {
      previousLevel = JSON.parse(readFileSync(statePath, "utf8"))?.level ?? null;
    } catch {}
  }

  if (previousLevel === level) return null;

  writeJsonAtomic(statePath, {
    level,
    updatedAt: new Date().toISOString(),
  });

  if (level === 2 || level === 4) {
    const label = level === 4 ? "critical(4)" : "warn(2)";
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `[tfx-pressure] macOS 메모리 압박 단계가 ${label}로 바뀌었다. 새 워커 생성을 줄이고 끝난 워커를 닫아라.`,
      },
    };
  }
  return null;
}

async function handleStop(payload, opts, env) {
  if (payload?.stop_hook_active || payload?.stopHookActive) {
    return null;
  }
  const marker = findActiveLeadMarker(payload, env);
  if (!marker) return null;

  const readContext = opts.readContext || readCodexContext;
  const ctx = await readContext(
    payload?.transcript_path || null,
    payload?.session_id,
  );
  const contextPct = Number(ctx?.contextPct);
  const sessionId = payload?.session_id ?? marker.record.threadId ?? null;

  if (
    Number.isFinite(contextPct) &&
    contextPct >= SUCCESSION_THRESHOLD_PCT &&
    sessionId &&
    marker.record.notifiedThreadId !== sessionId
  ) {
    marker.record.notifiedThreadId = sessionId;
    marker.record.notifiedThreshold = SUCCESSION_THRESHOLD_PCT;
    writeJsonAtomic(marker.filePath, marker.record);
    return {
      decision: "block",
      reason: SUCCESSION_BLOCK_MESSAGE,
      systemMessage: SUCCESSION_BLOCK_MESSAGE,
    };
  }
  return null;
}

function swallowStdoutWrite(_chunk, encodingOrCallback, callback) {
  const done =
    typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
  if (typeof done === "function") done();
  return true;
}

async function runHookSideEffectsWithStdoutSuppressed(fn) {
  const originalStdoutWrite = stdout.write;
  const originalConsoleDebug = console.debug;
  const originalConsoleInfo = console.info;
  const originalConsoleLog = console.log;

  stdout.write = swallowStdoutWrite;
  console.debug = () => {};
  console.info = () => {};
  console.log = () => {};
  try {
    return await fn();
  } finally {
    stdout.write = originalStdoutWrite;
    console.debug = originalConsoleDebug;
    console.info = originalConsoleInfo;
    console.log = originalConsoleLog;
  }
}

export async function runCodexSessionHook(stdinData, opts = {}) {
  let output = "{}\n";
  const parsed = parsePayload(stdinData);
  const mode = parsed.ok
    ? normalizeMode(opts.argvMode ?? argv[2], parsed.payload)
    : "";
  const env = opts.env || process.env;

  try {
    const response = await runHookSideEffectsWithStdoutSuppressed(async () => {
      if (mode === "register") {
        return handleRegister(parsed.payload, opts, env);
      }
      if (mode === "heartbeat") {
        return await handleHeartbeat(parsed.payload, opts, env);
      }
      if (mode === "stop") {
        return await handleStop(parsed.payload, opts, env);
      }
      return null;
    });
    if (response && typeof response === "object") {
      output = `${JSON.stringify(response)}\n`;
    }
  } catch {
    // 로컬 기록 실패가 세션을 막지 않게 한다.
  }

  if (opts.writeStdout !== false) {
    stdout.write(output);
  }
  return output;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => {
      data += chunk;
    });
    stdin.on("end", () => resolve(data));
    stdin.on("error", () => resolve(data));
  });
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  const stdinData = await readStdin();
  await runCodexSessionHook(stdinData);
  exit(0);
}
