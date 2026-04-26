#!/usr/bin/env node
// scripts/check-codex-config-stable.mjs
//
// Wrapper that runs a command (default: npm test) and verifies that
// ~/.codex/config.toml is unchanged before vs after execution.
//
// Issue #193 회귀 가드 — production codex config 가 test/build 도중 mutate
// 되면 즉시 fail 하고 진단 정보를 출력한다. CI 또는 로컬 npm script 에서
// `npm run test:guard-codex-config` 처럼 호출한다.
//
// Exit codes:
//   0  = config 안정. wrap 한 명령의 exit code 그대로 반환 (보통 0)
//   2  = mutation 감지. wrap 한 명령의 exit code 와 무관하게 강제 fail.
//   N  = wrap 한 명령이 N 으로 끝남 (mutation 없음).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CODEX_CONFIG = join(homedir(), ".codex", "config.toml");
const EXPECTED_TFX_HUB_URL = "http://127.0.0.1:27888/mcp";

function readTfxHubUrl(raw) {
  const headerMatch =
    /^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*(?:tfx-hub|"tfx-hub"|'tfx-hub')[ \t]*\][ \t]*\r?$/m.exec(
      raw,
    );
  if (!headerMatch) return null;
  const headerLineEnd = raw.indexOf("\n", headerMatch.index);
  const bodyStart = headerLineEnd === -1 ? raw.length : headerLineEnd + 1;
  const nextSectionRegex = /^[ \t]*\[/gm;
  nextSectionRegex.lastIndex = bodyStart;
  const nextSectionMatch = nextSectionRegex.exec(raw);
  const sectionEnd = nextSectionMatch ? nextSectionMatch.index : raw.length;
  const sectionBody = raw.slice(bodyStart, sectionEnd);
  const urlMatch =
    /^[ \t]*url[ \t]*=[ \t]*(?:"([^"]+)"|'([^']+)')[ \t]*(?:#.*)?\r?$/m.exec(
      sectionBody,
    );
  return urlMatch?.[1] ?? urlMatch?.[2] ?? "";
}

function snapshotConfig() {
  try {
    const stat = statSync(CODEX_CONFIG);
    const data = readFileSync(CODEX_CONFIG);
    const raw = data.toString("utf8");
    const sha = createHash("sha256").update(data).digest("hex");
    return {
      exists: true,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha,
      tfxHubUrl: readTfxHubUrl(raw),
    };
  } catch {
    return { exists: false };
  }
}

function describeChange(before, after) {
  if (!before.exists && !after.exists) return null;
  if (before.exists !== after.exists) {
    return before.exists ? "file deleted" : "file created";
  }
  if (before.sha !== after.sha) {
    return `sha256 differs (size: ${before.size} → ${after.size})`;
  }
  if (before.mtimeMs !== after.mtimeMs) {
    return `mtime differs (${before.mtimeMs} → ${after.mtimeMs})`;
  }
  return null;
}

function describePortDrift(snapshot) {
  if (!snapshot.exists) return null;
  if (snapshot.tfxHubUrl === null) return null;
  if (snapshot.tfxHubUrl === EXPECTED_TFX_HUB_URL) return null;
  return `tfx-hub url is ${JSON.stringify(snapshot.tfxHubUrl)}; expected ${JSON.stringify(EXPECTED_TFX_HUB_URL)}`;
}

const argv = process.argv.slice(2);
const command = argv.length > 0 ? argv : ["npm", "test"];

const before = snapshotConfig();
process.stderr.write(
  `[check-codex-config-stable] before: ${JSON.stringify(before)}\n`,
);

const result = spawnSync(command[0], command.slice(1), {
  stdio: "inherit",
  shell: process.platform === "win32",
});

const after = snapshotConfig();
process.stderr.write(
  `[check-codex-config-stable] after: ${JSON.stringify(after)}\n`,
);

const change = describeChange(before, after);
const portDrift = describePortDrift(after);
if (change || portDrift) {
  process.stderr.write(
    [
      "",
      "=== CONFIG MUTATION DETECTED (#193 회귀) ===",
      `Path:    ${CODEX_CONFIG}`,
      `Change:  ${change || "none"}`,
      portDrift ? `Port:    ${portDrift}` : null,
      "Action:  즉시 backup 으로 복원 + mutation source 추적 필요.",
      "Context: https://github.com/tellang/triflux/issues/193",
      "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  process.exit(2);
}

process.exit(result.status ?? 0);
