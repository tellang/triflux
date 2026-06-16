#!/usr/bin/env node
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { refreshClaudeSessionProjectionCwd } from "../hub/team/claude-session-projection.mjs";

function readStdin() {
  try {
    return Promise.resolve(readFileSync(0, "utf8"));
  } catch {
    return Promise.resolve("");
  }
}

export function resolveCwdChangedPayload(input = {}, env = process.env) {
  const sessionId = String(
    input.session_id ??
      input.sessionId ??
      input.session?.id ??
      env.CLAUDE_CODE_SESSION_ID ??
      env.CLAUDE_SESSION_ID ??
      "",
  ).trim();
  const cwd = String(
    input.cwd ??
      input.new_cwd ??
      input.newCwd ??
      input.current_cwd ??
      input.workspace?.cwd ??
      input.source?.cwd ??
      "",
  ).trim();
  const configDir = path.resolve(
    env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
  );
  return {
    eventName: String(input.hook_event_name || ""),
    sessionId,
    cwd,
    sessionsDir: path.join(configDir, "sessions"),
  };
}

export async function handleCwdChangedHook(stdinText, env = process.env) {
  let input = {};
  try {
    input = stdinText.trim() ? JSON.parse(stdinText) : {};
  } catch {
    return { code: 0, stdout: "" };
  }
  const payload = resolveCwdChangedPayload(input, env);
  if (payload.eventName && payload.eventName !== "CwdChanged") {
    return { code: 0, stdout: "" };
  }
  if (!payload.sessionId || !payload.cwd) return { code: 0, stdout: "" };

  const result = await refreshClaudeSessionProjectionCwd({
    sessionsDir: payload.sessionsDir,
    sessionId: payload.sessionId,
    cwd: payload.cwd,
  });
  if (!result.updated) return { code: 0, stdout: "" };
  return {
    code: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "CwdChanged",
        additionalContext: `Triflux projection cwd refreshed: ${payload.cwd}`,
      },
    }),
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await handleCwdChangedHook(await readStdin());
  if (result.stdout) process.stdout.write(result.stdout);
  process.exit(result.code);
}
