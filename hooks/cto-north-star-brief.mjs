#!/usr/bin/env node
// hooks/cto-north-star-brief.mjs - UserPromptSubmit CTO north-star brief injection

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const MAX_CONTEXT_BYTES = 2048;
const PREFIX = "[CTO NORTH STAR]\n";

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

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function readMarker(markerPath) {
  try {
    if (!existsSync(markerPath)) return null;
    return JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    return null;
  }
}

function writeMarker(markerPath, state) {
  try {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, JSON.stringify(state), "utf8");
  } catch {
    // Marker write failures should not block the hook.
  }
}

function main() {
  const input = readStdinJson();
  if (input.hook_event_name && input.hook_event_name !== "UserPromptSubmit") {
    return;
  }

  const projectRoot =
    typeof input.cwd === "string" && input.cwd.trim()
      ? resolve(input.cwd)
      : typeof input.directory === "string" && input.directory.trim()
        ? resolve(input.directory)
        : process.cwd();
  const lakeDir = join(projectRoot, ".triflux", "lake");
  const briefPath = join(lakeDir, "current.md");
  if (!existsSync(briefPath)) return;

  const brief = readFileSync(briefPath, "utf8");
  if (!brief) return;

  const stats = statSync(briefPath);
  const hash = sha256(brief);
  const markerPath =
    typeof process.env.TRIFLUX_CTO_BRIEF_MARKER === "string" &&
    process.env.TRIFLUX_CTO_BRIEF_MARKER.trim()
      ? resolve(process.env.TRIFLUX_CTO_BRIEF_MARKER)
      : join(lakeDir, ".last-injected");
  const previous = readMarker(markerPath);
  if (previous?.hash === hash) return;

  writeMarker(markerPath, {
    path: briefPath,
    hash,
    mtimeMs: stats.mtimeMs,
    injectedAt: new Date().toISOString(),
  });

  const additionalContext = capUtf8(`${PREFIX}${brief}`, MAX_CONTEXT_BYTES);
  if (!additionalContext) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext,
      },
    }),
  );
}

try {
  main();
} catch {
  process.exit(0);
}
