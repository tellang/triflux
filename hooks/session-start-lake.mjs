#!/usr/bin/env node
// hooks/session-start-lake.mjs — SessionStart CTO north-star brief injection

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const MAX_CONTEXT_BYTES = 2048;

function readStdinJson() {
  try {
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function capUtf8(input, maxBytes) {
  if (Buffer.byteLength(input, "utf8") <= maxBytes) return input;

  let used = 0;
  let output = "";
  for (const char of input) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (used + charBytes > maxBytes) break;
    output += char;
    used += charBytes;
  }
  return output;
}

function main() {
  const input = readStdinJson();
  if (input.hook_event_name && input.hook_event_name !== "SessionStart") {
    return;
  }

  const projectRoot =
    typeof input.cwd === "string" && input.cwd.trim()
      ? resolve(input.cwd)
      : process.cwd();
  const briefPath = join(projectRoot, ".triflux", "lake", "current.md");
  if (!existsSync(briefPath)) return;

  const brief = capUtf8(readFileSync(briefPath, "utf8"), MAX_CONTEXT_BYTES);
  if (!brief) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: brief,
      },
    }),
  );
}

try {
  main();
} catch {
  process.exit(0);
}
