#!/usr/bin/env node

import { createHash } from "node:crypto";
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
const SESSION_START_MATCHER = "startup|resume|clear";
const TRIFLUX_HOOK_BASENAME = "codex-session-hook.mjs";

function atomicWriteFile(path, content) {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, path);
}

function quoteCommandPath(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildCommand(nodeBin, hookScriptPath, mode) {
  return `${nodeBin} ${quoteCommandPath(hookScriptPath)} ${mode}`;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalJson(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

export function computeTrustedHookHash({
  eventName,
  matcher,
  command,
  timeout,
  statusMessage,
}) {
  const hook = {
    type: "command",
    command,
    timeout: Math.max(1, Number(timeout ?? 600)),
    async: false,
  };
  if (statusMessage) hook.statusMessage = statusMessage;
  const identity = {
    event_name: eventName,
    ...(matcher ? { matcher } : {}),
    hooks: [hook],
  };
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalJson(identity)))
    .digest("hex")}`;
}

function normalizeHooksJson(raw) {
  try {
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { hooks: {} };
    }
    if (!parsed.hooks || typeof parsed.hooks !== "object") parsed.hooks = {};
    return parsed;
  } catch {
    return { hooks: {} };
  }
}

function isTrifluxHookGroup(group) {
  return Array.isArray(group?.hooks)
    ? group.hooks.some(
        (hook) =>
          typeof hook?.command === "string" &&
          hook.command.includes(TRIFLUX_HOOK_BASENAME),
      )
    : false;
}

function upsertHookGroup(groups, desired) {
  const list = Array.isArray(groups) ? [...groups] : [];
  const existingIndex = list.findIndex((group) => isTrifluxHookGroup(group));
  if (existingIndex >= 0) {
    list[existingIndex] = desired;
    return { groups: list, index: existingIndex };
  }
  list.push(desired);
  return { groups: list, index: list.length - 1 };
}

function buildDesiredGroups({ nodeBin, hookScriptPath }) {
  return {
    SessionStart: {
      matcher: SESSION_START_MATCHER,
      hooks: [
        {
          type: "command",
          command: buildCommand(nodeBin, hookScriptPath, "register"),
          timeout: 15,
        },
      ],
    },
    UserPromptSubmit: {
      hooks: [
        {
          type: "command",
          command: buildCommand(nodeBin, hookScriptPath, "heartbeat"),
          timeout: 10,
        },
      ],
    },
  };
}

function formatHooksJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function escapeTomlKey(key) {
  return `"${String(key).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function stateLine(key, hash) {
  return `${escapeTomlKey(key)} = { trusted_hash = "${hash}" }`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripManagedStateLines(content, managedKeys, hooksPath) {
  if (!content) return "";
  const escapedKeys = [...managedKeys].map((key) =>
    escapeRegExp(escapeTomlKey(key)),
  );
  for (const label of ["session_start", "user_prompt_submit"]) {
    escapedKeys.push(
      escapeRegExp(escapeTomlKey(`${hooksPath}:${label}:`)).replace(
        /"$/,
        '\\d+:\\d+"',
      ),
    );
  }
  const re = new RegExp(
    `^\\s*(?:${escapedKeys.join("|")})\\s*=\\s*\\{\\s*trusted_hash\\s*=.*\\}\\s*$`,
    "gm",
  );
  return content.replace(re, "").replace(/\n{3,}/g, "\n\n");
}

function mergeHooksState(content, entries, hooksPath) {
  const managedKeys = new Set(entries.map((entry) => entry.key));
  let updated = stripManagedStateLines(content, managedKeys, hooksPath);
  const lines = entries.map((entry) => stateLine(entry.key, entry.hash));
  const sectionRe = /^\[hooks\.state\]\s*$/m;
  const match = sectionRe.exec(updated);

  if (!match) {
    if (updated.length > 0 && !updated.endsWith("\n")) updated += "\n";
    if (updated.length > 0 && !updated.endsWith("\n\n")) updated += "\n";
    return `${updated}[hooks.state]\n${lines.join("\n")}\n`;
  }

  const sectionStart = match.index;
  const afterHeader = match.index + match[0].length;
  const nextSectionMatch = /^\[[^\]]+\]\s*$/m.exec(updated.slice(afterHeader));
  const sectionEnd = nextSectionMatch
    ? afterHeader + nextSectionMatch.index
    : updated.length;
  let sectionBody = updated.slice(sectionStart, sectionEnd).trimEnd();
  sectionBody += `\n${lines.join("\n")}\n`;
  return (
    updated.slice(0, sectionStart) + sectionBody + updated.slice(sectionEnd)
  );
}

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
}

export function ensureCodexHooks(opts = {}) {
  const codexHome = opts.codexHome || join(homedir(), ".codex");
  if (!existsSync(codexHome)) {
    return { skipped: true, changedHooks: false, changedConfig: false };
  }

  const hooksPath = resolve(codexHome, "hooks.json");
  const configPath = resolve(codexHome, "config.toml");
  const hookScriptPath = resolve(
    opts.hookScriptPath || join(PROJECT_ROOT, "hooks", TRIFLUX_HOOK_BASENAME),
  );
  const nodeBin = opts.nodeBin || process.execPath;
  const desired = buildDesiredGroups({ nodeBin, hookScriptPath });

  const hooksJson = normalizeHooksJson(
    existsSync(hooksPath) ? readFileSync(hooksPath, "utf8") : "",
  );
  const sessionStart = upsertHookGroup(
    hooksJson.hooks.SessionStart,
    desired.SessionStart,
  );
  const promptSubmit = upsertHookGroup(
    hooksJson.hooks.UserPromptSubmit,
    desired.UserPromptSubmit,
  );
  hooksJson.hooks.SessionStart = sessionStart.groups;
  hooksJson.hooks.UserPromptSubmit = promptSubmit.groups;

  const originalHooks = existsSync(hooksPath)
    ? readFileSync(hooksPath, "utf8")
    : "";
  const nextHooks = formatHooksJson(hooksJson);
  const changedHooks = originalHooks !== nextHooks;
  if (changedHooks) {
    mkdirSync(dirname(hooksPath), { recursive: true });
    atomicWriteFile(hooksPath, nextHooks);
  }

  const stateEntries = [
    {
      key: `${hooksPath}:session_start:${sessionStart.index}:0`,
      hash: computeTrustedHookHash({
        eventName: "session_start",
        matcher: desired.SessionStart.matcher,
        command: desired.SessionStart.hooks[0].command,
        timeout: desired.SessionStart.hooks[0].timeout,
      }),
    },
    {
      key: `${hooksPath}:user_prompt_submit:${promptSubmit.index}:0`,
      hash: computeTrustedHookHash({
        eventName: "user_prompt_submit",
        command: desired.UserPromptSubmit.hooks[0].command,
        timeout: desired.UserPromptSubmit.hooks[0].timeout,
      }),
    },
  ];

  const originalConfig = existsSync(configPath)
    ? readFileSync(configPath, "utf8")
    : "";
  const nextConfig = mergeHooksState(originalConfig, stateEntries, hooksPath);
  const changedConfig = originalConfig !== nextConfig;
  if (changedConfig) {
    if (existsSync(configPath)) {
      const backupPath = `${configPath}.bak-tfx-codex-hooks-${opts.backupTimestamp || timestamp()}`;
      if (!existsSync(backupPath)) {
        writeFileSync(backupPath, originalConfig, "utf8");
      }
    }
    atomicWriteFile(configPath, nextConfig);
  }

  return {
    skipped: false,
    changedHooks,
    changedConfig,
    hooksPath,
    configPath,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = ensureCodexHooks();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
