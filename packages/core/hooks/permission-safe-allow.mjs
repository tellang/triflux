#!/usr/bin/env node

import { stdin, stdout } from "node:process";

const META_PATTERNS = [/&&/, /\|\|/, /[;|<>`]/, /\$\(/];
const SHELL_EXPANSION_PATTERN =
  /(?:^|[^\\])\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}]*\}|[?*#@$!0-9-])|(?:^|\s)~[A-Za-z0-9_-]*(?=\/|$)/;
const RISKY_PATTERNS = [
  /(^|\s)rm(\s|$)/,
  /(^|\s)mv(\s|$)/,
  /(^|\s)cp(\s|$)/,
  /(^|\s)curl(\s|$)/,
  /(^|\s)wget(\s|$)/,
  /(^|\s)sudo(\s|$)/,
  /(^|\s)chmod(\s|$)/,
  /(^|\s)chown(\s|$)/,
  /(^|\s)git\s+push(\s|$)/,
  /(^|\s)git\s+reset(\s|$)/,
  /(^|\s)git\s+clean(\s|$)/,
  /(^|\s)npm\s+publish(\s|$)/,
  /(^|\s)pnpm\s+publish(\s|$)/,
  /(^|\s)yarn\s+publish(\s|$)/,
];
const SEARCH_EXTERNAL_INPUT_FLAGS = new Set([
  "--exclude-from",
  "--file",
  "--files-from",
  "--ignore-file",
  "--pre",
  "--pre-glob",
]);
const FIND_SIDE_EFFECT_OPERATORS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
  "-ok",
  "-okdir",
]);

function silentlyExit() {
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let input = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => {
      input += chunk;
    });
    stdin.on("end", () => resolve(input));
    stdin.resume();
  });
}

function shellWords(command) {
  const words = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  let match;
  while ((match = pattern.exec(command)) !== null) {
    words.push(match[1] ?? match[2] ?? match[3]);
  }
  return words;
}

function isRepoRelativePath(value) {
  if (!value || value.startsWith("/") || value.startsWith("~")) return false;
  if (value === ".") return true;
  if (value === ".." || value.startsWith("../") || value.includes("/../"))
    return false;
  return /^[A-Za-z0-9._/*?@{}+,:=-][A-Za-z0-9._/*?'@{}+,:=-]*$/.test(value);
}

function hasUnsafeSurface(command) {
  return (
    META_PATTERNS.some((pattern) => pattern.test(command)) ||
    SHELL_EXPANSION_PATTERN.test(command) ||
    RISKY_PATTERNS.some((pattern) => pattern.test(command))
  );
}

function isExternalSearchInputFlag(word) {
  return (
    SEARCH_EXTERNAL_INPUT_FLAGS.has(word) ||
    [...SEARCH_EXTERNAL_INPUT_FLAGS].some((flag) =>
      word.startsWith(`${flag}=`),
    ) ||
    /^-[^-]*f/.test(word)
  );
}

function allowGit(words, command) {
  if (command === "git status" || command === "git status --short")
    return "git status";
  if (command === "git diff --stat" || command === "git diff --cached --stat")
    return "git diff stat";
  if (command === "git branch --show-current") return "git branch";
  if (words[0] === "git" && words[1] === "log" && words[2] === "--oneline") {
    const rest = words.slice(3);
    if (
      rest.every(
        (word) =>
          /^[A-Za-z0-9._/@{}~^:+,=-]+$/.test(word) && !word.startsWith("-"),
      )
    ) {
      return "git log";
    }
  }
  return null;
}

function allowListing(words) {
  if (words[0] === "pwd" && words.length === 1) return "pwd";

  if (words[0] === "ls") {
    const args = words.slice(1);
    if (
      args.every(
        (word) => /^-[A-Za-z0-9]+$/.test(word) || isRepoRelativePath(word),
      )
    ) {
      return "ls";
    }
  }

  if (words[0] === "find") {
    const args = words.slice(1);
    if (args.some((word) => FIND_SIDE_EFFECT_OPERATORS.has(word))) return null;
    const firstOption = args.findIndex((word) => word.startsWith("-"));
    const pathArgs = (
      firstOption === -1 ? args : args.slice(0, firstOption)
    ).filter(Boolean);
    if (pathArgs.length === 0 || pathArgs.every(isRepoRelativePath)) {
      return "find";
    }
  }

  return null;
}

function allowSearch(words) {
  if (words[0] !== "rg" && words[0] !== "grep") return null;
  const args = words.slice(1);
  if (args.length === 0) return null;
  if (
    args.some(
      (word) =>
        isExternalSearchInputFlag(word) ||
        word.startsWith("/") ||
        word.startsWith("~") ||
        word.startsWith("$") ||
        word === ".." ||
        word.startsWith("../") ||
        word.includes("/../"),
    )
  ) {
    return null;
  }
  return `${words[0]} search`;
}

function allowTargetedTest(words) {
  if (words[0] !== "node" || words[1] !== "scripts/test-lock.mjs") return null;
  if (!words.includes("--test")) return null;
  const args = words.slice(2);
  const allowedFlags = new Set(["--test", "--test-force-exit"]);
  const pathArgs = [];
  for (const word of args) {
    if (allowedFlags.has(word)) continue;
    if (/^--test-concurrency=\d+$/.test(word)) continue;
    if (word.startsWith("-")) return null;
    pathArgs.push(word);
  }
  if (pathArgs.length === 0) return null;
  if (
    pathArgs.every(
      (word) =>
        word.startsWith("tests/") || word.startsWith("scripts/__tests__/"),
    ) &&
    pathArgs.every(isRepoRelativePath)
  ) {
    return "targeted test";
  }
  return null;
}

function allowNpm(command) {
  // npm scripts are intentionally not auto-allowed: package.json can redefine
  // them to perform arbitrary side effects. Prefer explicit node test commands.
  void command;
  return null;
}

function allowanceReason(command) {
  const trimmed = command.trim().replace(/\s+/g, " ");
  if (!trimmed || hasUnsafeSurface(trimmed)) return null;

  const words = shellWords(trimmed);
  if (words.length === 0) return null;

  return (
    allowGit(words, trimmed) ??
    allowListing(words) ??
    allowSearch(words) ??
    allowTargetedTest(words) ??
    allowNpm(trimmed)
  );
}

function hasAskSuggestion(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasAskSuggestion);
  if (value.behavior === "ask") return true;
  if (value.decision?.behavior === "ask") return true;
  return Object.values(value).some(hasAskSuggestion);
}

function emitAllow(reason) {
  stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
        additionalContext: `[permission-safe-allow] allowed: ${reason}`,
      },
    }),
  );
}

const input = await readStdin();
let payload;
try {
  payload = JSON.parse(input || "{}");
} catch {
  silentlyExit();
}

if (
  payload?.hook_event_name !== "PermissionRequest" ||
  payload?.tool_name !== "Bash"
) {
  silentlyExit();
}

if (
  hasAskSuggestion(
    payload.permission_suggestions ?? payload.permissionSuggestions,
  )
) {
  silentlyExit();
}

const command = payload?.tool_input?.command ?? payload?.command;
if (typeof command !== "string") {
  silentlyExit();
}

const reason = allowanceReason(command);
if (!reason) {
  silentlyExit();
}

emitAllow(reason);
