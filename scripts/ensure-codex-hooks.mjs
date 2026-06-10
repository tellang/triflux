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

// codex CLI 0.137+ 는 hooks.state 를 table-header 형식
// ([hooks.state."<key>"] + trusted_hash = "...") 으로 직렬화한다. 과거
// 이 설치기는 inline dotted-key 형식("<key>" = { trusted_hash = ... }) 으로
// 기록했는데, codex 가 같은 키를 table 형식으로 재기록한 config 에 inline 을
// 다시 append 하면 TOML duplicate key 가 되어 codex 전 호출이 즉사한다
// (2026-06-10 실측, issue #394 배경). 기록은 codex canonical 인 table-header
// 형식만 사용하고, strip 은 양 형식 모두 인식한다.
function stateBlock(key, hash) {
  return `[hooks.state.${escapeTomlKey(key)}]\ntrusted_hash = "${hash}"`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function managedKeyPatterns(managedKeys, hooksPath) {
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
  return escapedKeys;
}

function stripManagedStateLines(content, managedKeys, hooksPath) {
  if (!content) return "";
  const escapedKeys = managedKeyPatterns(managedKeys, hooksPath);
  const inlineRe = new RegExp(
    `^\\s*(?:${escapedKeys.join("|")})\\s*=\\s*\\{\\s*trusted_hash\\s*=.*\\}\\s*$`,
    "gm",
  );
  const tableRe = new RegExp(
    `^\\[hooks\\.state\\.(?:${escapedKeys.join("|")})\\]\\s*\\n(?:[ \\t]*trusted_hash[^\\n]*\\n?)*`,
    "gm",
  );
  return content
    .replace(inlineRe, "")
    .replace(tableRe, "")
    .replace(/\n{3,}/g, "\n\n");
}

// 관리 키의 현재 상태를 양 형식 모두에서 수집한다. 멱등 판정용:
// 모든 entry 가 정확히 1회 존재하고 hash 가 일치하면 재기록하지 않는다.
function collectManagedState(content, managedKeys, hooksPath) {
  if (!content) return [];
  const escapedKeys = managedKeyPatterns(managedKeys, hooksPath);
  const found = [];
  const inlineRe = new RegExp(
    `^\\s*(${escapedKeys.join("|")})\\s*=\\s*\\{\\s*trusted_hash\\s*=\\s*"([^"]+)"`,
    "gm",
  );
  const tableRe = new RegExp(
    `^\\[hooks\\.state\\.(${escapedKeys.join("|")})\\]\\s*\\n[ \\t]*trusted_hash\\s*=\\s*"([^"]+)"`,
    "gm",
  );
  for (const re of [inlineRe, tableRe]) {
    let m = re.exec(content);
    while (m) {
      found.push({ key: m[1].replace(/^"|"$/g, ""), hash: m[2] });
      m = re.exec(content);
    }
  }
  return found;
}

function hooksStateConverged(content, entries, hooksPath) {
  const managedKeys = new Set(entries.map((entry) => entry.key));
  const found = collectManagedState(content, managedKeys, hooksPath);
  return entries.every((entry) => {
    const matches = found.filter((f) => f.key === entry.key);
    return matches.length === 1 && matches[0].hash === entry.hash;
  });
}

function mergeHooksState(content, entries, hooksPath) {
  const managedKeys = new Set(entries.map((entry) => entry.key));
  // 이미 수렴 상태(각 키 정확히 1회 + hash 일치, 형식 무관)면 무변경.
  // SessionStart 마다 호출되므로 이 조기 종료가 없으면 config 를 매 세션
  // 재기록하게 된다.
  if (hooksStateConverged(content, entries, hooksPath)) {
    return content;
  }
  let updated = stripManagedStateLines(content, managedKeys, hooksPath);
  const blocks = entries.map((entry) => stateBlock(entry.key, entry.hash));
  // table-header 서브테이블은 TOML 상 부모 [hooks.state] 재선언이 아니므로
  // 파일 끝 append 가 항상 유효하다. 빈 [hooks.state] 헤더가 남아 있어도
  // (서브테이블 선언과 공존 가능) 무해해서 건드리지 않는다.
  if (updated.length > 0 && !updated.endsWith("\n")) updated += "\n";
  if (updated.length > 0 && !updated.endsWith("\n\n")) updated += "\n";
  return `${updated}${blocks.join("\n\n")}\n`;
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
