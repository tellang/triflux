#!/usr/bin/env node

// hooks/post-tool-tips.mjs — opt-in targeted PostToolUse rules reminders (#245)
//
// This hook is intentionally quiet by default. Set TFX_POST_TOOL_TIPS=1 to emit
// bounded reminders after Bash/Edit/Write touches high-impact triflux paths.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";

const MAX_MESSAGE_CHARS = 1200;
const MAX_STATE_ENTRIES = 80;
const DEDUPE_TTL_MS = 60 * 60 * 1000;
const STATE_DIR =
  process.env.TRIFLUX_POST_TOOL_TIPS_STATE_DIR ||
  join(tmpdir(), "tfx-post-tool-tips");
const STATE_FILE = join(STATE_DIR, "seen.json");

const RULES = [
  {
    id: "hook-lifecycle",
    label: "hook lifecycle",
    patterns: [
      /^hooks\/(hook-registry\.json|hooks\.json|hook-orchestrator\.mjs)$/,
      /^hooks\/.*\.(mjs|json)$/,
    ],
    message:
      "hook lifecycle change: keep registry/settings narrow, mirror package hooks, run the focused hook test and npm run release:check-mirror before commit.",
  },
  {
    id: "package-hook-mirror",
    label: "package hook mirror",
    patterns: [/^packages\/(triflux|core)\/hooks\//],
    message:
      "package hook mirror change: keep root, packages/triflux, and packages/core lifecycle hook behavior aligned; do not leave core partially mirrored.",
  },
  {
    id: "team-runtime",
    label: "team runtime",
    patterns: [/^hub\/team\//, /^mesh\//, /^hooks\/pipeline-stop\.mjs$/],
    message:
      "team runtime change: verify swarm/retry/pipeline state transitions and avoid blocking user abort or cleanup paths.",
  },
  {
    id: "mcp-surface",
    label: "MCP surface",
    patterns: [
      /^scripts\/mcp/,
      /^scripts\/lib\/mcp-/,
      /^hooks\/mcp-config-watcher\.mjs$/,
      /^\.mcp\.json$/,
    ],
    message:
      "MCP surface change: preserve stdio MCP remediation, gateway fallback, and transport degradation behavior across macOS/Linux/Windows.",
  },
  {
    id: "instruction-source",
    label: "instruction source",
    patterns: [/^AGENTS\.md$/, /^CLAUDE\.md$/, /^\.claude\/rules\//],
    message:
      "instruction source change: do not mix policy edits with unrelated implementation; preserve exact psmux/WT/Codex routing constraints.",
  },
];

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function isEnabled() {
  return process.env.TFX_POST_TOOL_TIPS === "1";
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeSlash(value) {
  return String(value || "").replace(/\\/g, "/");
}

function cwdFromInput(input) {
  return resolve(input.cwd || process.env.CLAUDE_CWD || process.cwd());
}

function toRepoRelative(candidate, cwd) {
  if (!candidate || typeof candidate !== "string") return null;
  const stripped = candidate.trim().replace(/^["']|["']$/g, "");
  if (!stripped) return null;
  if (/^[a-z]+:\/\//i.test(stripped)) return null;

  const absolute = isAbsolute(stripped) ? stripped : resolve(cwd, stripped);
  const normalizedAbs = normalize(absolute);
  const normalizedCwd = normalize(cwd);
  const rel = normalizeSlash(relative(normalizedCwd, normalizedAbs));

  if (!rel || rel === ".") return null;
  if (rel.startsWith("../") || rel === "..") return null;
  return rel;
}

function extractEditWritePath(input, cwd) {
  const filePath = input.tool_input?.file_path || input.tool_input?.path;
  const rel = toRepoRelative(filePath, cwd);
  return rel ? [rel] : [];
}

function tokenizeCommand(command) {
  const tokens = [];
  let current = "";
  let quote = null;

  for (const ch of String(command || "")) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function looksLikePathToken(token) {
  if (!token || token.startsWith("-")) return false;
  if (
    /^(node|npm|pnpm|bun|npx|git|cat|sed|awk|rg|grep|bash|sh|zsh)$/.test(token)
  )
    return false;
  return /^(hooks|packages|hub|mesh|scripts|\.claude|AGENTS\.md|CLAUDE\.md|\.mcp\.json)(\/|$)/.test(
    normalizeSlash(token),
  );
}

function extractBashPaths(input, cwd) {
  const command = input.tool_input?.command || "";
  const paths = [];
  for (const token of tokenizeCommand(command)) {
    const cleaned = token.replace(/[,:;]+$/g, "");
    if (!cleaned || cleaned.startsWith("-")) continue;

    const rel = toRepoRelative(cleaned, cwd);
    if (!rel) continue;
    if (!isAbsolute(cleaned) && !looksLikePathToken(cleaned)) continue;
    paths.push(rel);
  }
  return paths;
}

function extractTouchedPaths(input) {
  const toolName = input.tool_name || "";
  const cwd = cwdFromInput(input);

  if (toolName === "Edit" || toolName === "Write")
    return extractEditWritePath(input, cwd);
  if (toolName === "Bash") return extractBashPaths(input, cwd);
  return [];
}

function canonicalPathKey(relPath, cwd) {
  const absolute = resolve(cwd, relPath);
  try {
    return normalizeSlash(realpathSync(absolute));
  } catch {
    return normalizeSlash(absolute);
  }
}

function matchRules(relPaths, cwd) {
  const matched = [];
  const seen = new Set();

  for (const relPath of relPaths) {
    const normalizedRel = normalizeSlash(relPath);
    for (const rule of RULES) {
      if (!rule.patterns.some((pattern) => pattern.test(normalizedRel)))
        continue;
      const key = `${rule.id}:${canonicalPathKey(normalizedRel, cwd)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matched.push({ rule, relPath: normalizedRel, key });
    }
  }

  return matched;
}

function loadState() {
  if (!existsSync(STATE_FILE)) return { entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.entries !== "object"
    )
      return { entries: {} };
    return parsed;
  } catch {
    return { entries: {} };
  }
}

function saveState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function hashKey(value) {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function filterUnseen(matches) {
  if (matches.length === 0) return [];

  const now = Date.now();
  const state = loadState();
  const entries = Object.fromEntries(
    Object.entries(state.entries || {}).filter(
      ([, ts]) => now - Number(ts || 0) <= DEDUPE_TTL_MS,
    ),
  );

  const unseen = [];
  for (const match of matches) {
    const key = hashKey(match.key);
    if (entries[key]) continue;
    entries[key] = now;
    unseen.push(match);
  }

  const trimmed = Object.entries(entries)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, MAX_STATE_ENTRIES);
  saveState({ entries: Object.fromEntries(trimmed) });

  return unseen;
}

function buildMessage(matches) {
  if (matches.length === 0) return "";

  const lines = ["[post-tool-tips] targeted triflux reminder:"];
  for (const { rule, relPath } of matches) {
    lines.push(`- ${rule.label} (${relPath}): ${rule.message}`);
  }

  let message = lines.join("\n");
  if (message.length > MAX_MESSAGE_CHARS) {
    message = `${message.slice(0, MAX_MESSAGE_CHARS - 40).trimEnd()}\n[post-tool-tips] truncated`;
  }
  return message;
}

function main() {
  if (!isEnabled()) process.exit(0);

  const input = safeJsonParse(readStdin());
  if (!input || input.hook_event_name !== "PostToolUse") process.exit(0);

  const cwd = cwdFromInput(input);
  const paths = extractTouchedPaths(input);
  if (paths.length === 0) process.exit(0);

  const matches = matchRules(paths, cwd);
  const unseen = filterUnseen(matches);
  const message = buildMessage(unseen);

  if (message) process.stdout.write(JSON.stringify({ systemMessage: message }));
}

try {
  main();
} catch {
  process.exit(0);
}
