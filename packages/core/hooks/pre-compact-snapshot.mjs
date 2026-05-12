#!/usr/bin/env node
// hooks/pre-compact-snapshot.mjs — PreCompact hook
//
// Compaction 직전에 짧은 상태 스냅샷을 주입한다. 민감 데이터는 읽지 않고,
// repo-local 상태와 git 요약만 3KB 이하로 제한한다.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_CONTEXT_BYTES = 3000;
const STALE_RUN_MS = 30 * 60 * 1000;
const PROJECT_ROOT = process.env.CLAUDE_CWD || process.cwd();

function readStdinJson() {
  try {
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
  } catch {
    return "";
  }
}

function summarizeGit() {
  const branch =
    git(["branch", "--show-current"]) || git(["rev-parse", "--short", "HEAD"]);
  const status = git(["status", "--short"]);
  const rows = status ? status.split(/\r?\n/).filter(Boolean) : [];
  return {
    branch: branch || "unknown",
    dirty: rows.length,
    sample: rows.slice(0, 8),
  };
}

function readJsonIfSmall(path, maxBytes = 24_000) {
  try {
    if (!existsSync(path)) return null;
    if (statSync(path).size > maxBytes) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function summarizeModeState(root) {
  const stateDir = join(root, ".omx", "state");
  if (!existsSync(stateDir)) return [];
  try {
    return readdirSync(stateDir)
      .filter((name) => name.endsWith("-state.json"))
      .flatMap((name) => {
        const state = readJsonIfSmall(join(stateDir, name));
        if (!state || state.active === false) return [];
        return [
          {
            mode: state.mode || name.replace(/-state\.json$/, ""),
            phase: state.current_phase || state.phase || null,
            active: state.active !== false,
          },
        ];
      })
      .slice(0, 8);
  } catch {
    return [];
  }
}

function summarizeRetryState(input) {
  const sessionId = input.session_id || input.sessionId || "";
  if (!sessionId) return null;
  const candidates = [
    join(PROJECT_ROOT, ".omc", "state", `retry-${sessionId}.json`),
    join(homedir(), ".omc", "state", `retry-${sessionId}.json`),
  ];
  for (const path of candidates) {
    const state = readJsonIfSmall(path);
    if (!state) continue;
    return {
      phase: state.phase || state.current_phase || null,
      iteration: state.iteration ?? state.retry_count ?? null,
      max: state.max_iterations ?? state.max ?? null,
    };
  }
  return null;
}

function countStaleSwarmRuns(nowMs = Date.now()) {
  const logsRoot = join(PROJECT_ROOT, ".triflux", "swarm-logs");
  if (!existsSync(logsRoot)) return 0;
  try {
    return readdirSync(logsRoot, { withFileTypes: true }).filter((entry) => {
      if (!entry.isDirectory() || !entry.name.startsWith("run-")) return false;
      const eventPath = join(logsRoot, entry.name, "swarm-events.jsonl");
      if (!existsSync(eventPath)) return false;
      try {
        return nowMs - statSync(eventPath).mtimeMs > STALE_RUN_MS;
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}

function truncateUtf8(text, maxBytes) {
  let output = text;
  while (Buffer.byteLength(output, "utf8") > maxBytes) {
    output = output.slice(0, Math.max(0, output.length - 200));
  }
  return output;
}

export function buildSnapshot(input = readStdinJson()) {
  const gitState = summarizeGit();
  const activeModes = summarizeModeState(PROJECT_ROOT);
  const retry = summarizeRetryState(input);
  const staleSwarmRuns = countStaleSwarmRuns();

  const lines = [
    "[triflux pre-compact snapshot]",
    `cwd: ${PROJECT_ROOT}`,
    `git: ${gitState.branch}; dirty=${gitState.dirty}`,
  ];
  if (gitState.sample.length) {
    lines.push(`dirty_sample: ${gitState.sample.join(" | ")}`);
  }
  if (activeModes.length) {
    lines.push(
      `active_modes: ${activeModes
        .map((m) => `${m.mode}${m.phase ? `:${m.phase}` : ""}`)
        .join(", ")}`,
    );
  }
  if (retry) {
    lines.push(
      `retry: phase=${retry.phase || "-"} iteration=${retry.iteration ?? "-"}/${retry.max ?? "-"}`,
    );
  }
  if (staleSwarmRuns > 0) {
    lines.push(`stale_swarm_runs: ${staleSwarmRuns}`);
  }

  return truncateUtf8(lines.join("\n"), MAX_CONTEXT_BYTES);
}

function main() {
  const snapshot = buildSnapshot();
  if (!snapshot.trim()) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreCompact",
        additionalContext: snapshot,
      },
    }),
  );
}

try {
  if (import.meta.url.endsWith(process.argv[1]?.split(/[\\/]/).pop() || "")) {
    main();
  }
} catch {
  process.exit(0);
}
