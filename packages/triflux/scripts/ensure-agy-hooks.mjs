#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(__dirname);
const TRIFLUX_HOOK_BASENAME = "agy-session-hook.mjs";
// Named hook group key in agy's hooks.json. agy maps top-level names to event
// configs, unlike Codex which nests everything under a single `hooks` object.
const HOOK_GROUP_NAME = "triflux-session";

function atomicWriteFile(path, content) {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, path);
}

function quoteCommandPath(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildCommand(nodeBin, hookScriptPath) {
  // No mode argument: the agy hook derives register vs heartbeat from the
  // payload's invocationNum (first invocation registers, later ones heartbeat).
  // Quote both executable and script path so installs under paths with spaces
  // round-trip through agy's command executor without shell word-splitting.
  return `${quoteCommandPath(nodeBin)} ${quoteCommandPath(hookScriptPath)}`;
}

function normalizeHooksJson(raw) {
  try {
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    // Unreadable hooks.json: start from an empty map rather than clobbering with
    // a parse error. A backup of the original is taken before any write.
    return {};
  }
}

// agy fires a single PreInvocation handler before every model call. One entry
// covers both register and heartbeat because the hook self-selects on
// invocationNum. (agy has no SessionStart / UserPromptSubmit split like Codex.)
// agy 1.0.7 uses direct hook entries for PreInvocation/Stop and matcher+hooks
// entries only for tool hooks such as PostToolUse.
function buildDesiredGroup({ nodeBin, hookScriptPath }) {
  return {
    enabled: true,
    PreInvocation: [
      {
        type: "command",
        command: buildCommand(nodeBin, hookScriptPath),
        timeout: 15,
      },
    ],
  };
}

function formatHooksJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
}

export function ensureAgyHooks(opts = {}) {
  // agy's customization directory. Skip cleanly when the user has no agy
  // install (no ~/.gemini/config), mirroring ensureCodexHooks' ~/.codex gate.
  const geminiConfigHome =
    opts.geminiConfigHome || join(homedir(), ".gemini", "config");
  // Never install into the real user HOME while the test runner is active.
  // scripts/test-lock.mjs sets TEST_LOCK_PID for every test process, and it is
  // inherited by in-process callers (runCritical/runDeferred -> ensureCriticalSetup)
  // and any spawned setup.mjs. Installer unit tests pass an explicit
  // geminiConfigHome seam, which bypasses this guard.
  if (!opts.geminiConfigHome && process.env.TEST_LOCK_PID) {
    return { skipped: true, changed: false };
  }
  if (!existsSync(geminiConfigHome)) {
    return { skipped: true, changed: false };
  }

  const hooksPath = resolve(geminiConfigHome, "hooks.json");
  const hookScriptPath = resolve(
    opts.hookScriptPath || join(PROJECT_ROOT, "hooks", TRIFLUX_HOOK_BASENAME),
  );
  const nodeBin = opts.nodeBin || process.execPath;
  const desired = buildDesiredGroup({ nodeBin, hookScriptPath });

  const original = existsSync(hooksPath) ? readFileSync(hooksPath, "utf8") : "";
  const hooksJson = normalizeHooksJson(original);
  // Upsert only our named group; every other user-authored group is preserved.
  // If the user explicitly disabled our group, keep that opt-out intact.
  if (hooksJson[HOOK_GROUP_NAME]?.enabled !== false) {
    hooksJson[HOOK_GROUP_NAME] = desired;
  }
  const next = formatHooksJson(hooksJson);

  const changed = original !== next;
  if (changed) {
    mkdirSync(dirname(hooksPath), { recursive: true });
    if (original) {
      const backupPath = `${hooksPath}.bak-tfx-agy-hooks-${opts.backupTimestamp || timestamp()}`;
      if (!existsSync(backupPath)) {
        writeFileSync(backupPath, original, "utf8");
      }
    }
    atomicWriteFile(hooksPath, next);
  }

  return { skipped: false, changed, hooksPath };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = ensureAgyHooks();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
