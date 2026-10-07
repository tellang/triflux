#!/usr/bin/env node

import { argv, exit, stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import {
  emitParticipantSessionStarted,
  shouldSkipInteractiveRegistration,
} from "../scripts/lib/session-presence.mjs";

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

/**
 * Convert an Antigravity hook payload into the Codex-shaped session payload
 * consumed by the shared fast session registration helpers.
 *
 * Antigravity hook payloads use camelCase system metadata (`conversationId`,
 * `workspacePaths`) rather than Codex's `session_id`/`cwd`. The
 * `conversationId` is the stable per-conversation UUID; the first mounted
 * workspace path is the effective cwd.
 *
 * @param {Record<string, unknown> | null | undefined} payload
 * @returns {string} JSON string with `{ session_id, cwd, actor_cli }`.
 */
export function toSessionPayload(payload) {
  const sessionId = String(payload?.conversationId || "").trim();
  const workspacePaths = Array.isArray(payload?.workspacePaths)
    ? payload.workspacePaths
    : [];
  const cwd =
    typeof workspacePaths[0] === "string" && workspacePaths[0]
      ? workspacePaths[0]
      : process.cwd();
  return JSON.stringify({ session_id: sessionId, cwd, actor_cli: "agy" });
}

/**
 * Decide whether a PreInvocation payload should register or heartbeat.
 *
 * agy has no distinct SessionStart/UserPromptSubmit events. PreInvocation fires
 * before every model call, so per-conversation `invocationNum` gates register
 * (first call) vs heartbeat (later calls). An explicit argv mode overrides this,
 * mirroring the Codex hook.
 *
 * @param {string | null | undefined} argvMode
 * @param {Record<string, unknown> | null | undefined} payload
 * @returns {"register" | "heartbeat"}
 */
export function normalizeMode(argvMode, payload) {
  const direct = String(argvMode || "")
    .trim()
    .toLowerCase();
  if (direct === "register" || direct === "heartbeat") return direct;

  const invocationNum = Number(payload?.invocationNum);
  if (Number.isFinite(invocationNum)) {
    return invocationNum <= 1 ? "register" : "heartbeat";
  }
  // 첫 호출 정보가 없으면 시작 기록을 남긴다.
  return "register";
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

export async function runAgySessionHook(stdinData, opts = {}) {
  const output = "{}\n";
  const parsed = parsePayload(stdinData);
  if (!parsed.ok) {
    if (opts.writeStdout !== false) stdout.write(output);
    return output;
  }

  const sessionPayload = toSessionPayload(parsed.payload);
  const sessionId = JSON.parse(sessionPayload).session_id;
  // No conversation id means nothing to register; stay a silent no-op.
  if (!sessionId) {
    if (opts.writeStdout !== false) stdout.write(output);
    return output;
  }

  const mode = normalizeMode(opts.argvMode ?? argv[2], parsed.payload);
  const emitSessionStarted =
    opts.emitSessionStarted || emitParticipantSessionStarted;

  try {
    await runHookSideEffectsWithStdoutSuppressed(async () => {
      if (
        mode === "register" &&
        !shouldSkipInteractiveRegistration(JSON.parse(sessionPayload), opts)
      ) {
        try {
          await emitSessionStarted(sessionPayload);
        } catch {}
      }
    });
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
  await runAgySessionHook(stdinData);
  exit(0);
}
