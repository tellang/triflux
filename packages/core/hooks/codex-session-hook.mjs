#!/usr/bin/env node

import { argv, exit, stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { writeCodexSessionRecord } from "../hub/lib/codex-session-registry.mjs";

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
  if (direct === "register" || direct === "heartbeat") return direct;

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
  return "";
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
  const output = "{}\n";
  const parsed = parsePayload(stdinData);
  const mode = parsed.ok
    ? normalizeMode(opts.argvMode ?? argv[2], parsed.payload)
    : "";
  const writeSessionRecord = opts.writeSessionRecord || writeCodexSessionRecord;

  try {
    await runHookSideEffectsWithStdoutSuppressed(async () => {
      if (mode === "register" || mode === "heartbeat") {
        writeSessionRecord(parsed.payload);
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
  await runCodexSessionHook(stdinData);
  exit(0);
}
