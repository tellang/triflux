#!/usr/bin/env node

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const SESSION_TTL_SEC = 30 * 60;
const STATE_REL_PATH = join(".omc", "state", "cross-review.json");

function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("error", () => resolve(""));
  });
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function resolveBaseDir(payload) {
  if (typeof payload?.cwd === "string" && payload.cwd.trim()) return payload.cwd;
  if (typeof payload?.directory === "string" && payload.directory.trim()) return payload.directory;
  return process.cwd();
}

function expectedReviewer(author) {
  if (author === "claude") return "codex";
  if (author === "codex") return "claude";
  if (author === "gemini") return "claude";
  return "";
}

function shouldTrackPath(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) return false;

  const lower = filePath.toLowerCase();
  if (lower.startsWith(".omc/") || lower.startsWith(".claude/")) return false;
  if (lower === "package-lock.json" || lower.endsWith("/package-lock.json")) return false;
  if (/\.(md|lock|yml|yaml)$/i.test(lower)) return false;
  return true;
}

function loadState(statePath) {
  if (!existsSync(statePath)) return null;

  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const startedAt = Number(state?.session_start || 0);
    const expired = !startedAt || nowSec() - startedAt > SESSION_TTL_SEC;
    if (expired) {
      try {
        unlinkSync(statePath);
      } catch {}
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

function isGitCommitCommand(command) {
  if (typeof command !== "string") return false;
  return /\bgit\s+commit\b/i.test(command);
}

function nudge(message) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: message,
    },
  }));
  process.exit(0);
}

function deny(message) {
  process.stderr.write(message);
  process.exit(2);
}

function summarizePending(entries) {
  return entries
    .map((item) => {
      const reviewer = item.expectedReviewer || "cross-reviewer";
      return `  * ${item.path} (author=${item.author}, reviewer=${reviewer})`;
    })
    .join("\n");
}

async function main() {
  if (process.env.TFX_SKIP_CROSS_REVIEW === "1") {
    process.exit(0);
  }

  const raw = await readStdin();
  if (!raw.trim()) process.exit(0);

  const payload = parseJson(raw);
  if (!payload) process.exit(0);

  const toolName = payload.tool_name || "";
  const toolInput = payload.tool_input || {};

  if (toolName !== "Bash") process.exit(0);
  if (!isGitCommitCommand(toolInput.command || "")) process.exit(0);

  // cwd 전파: tracker와 동일한 resolveBaseDir 사용
  const baseDir = resolveBaseDir(payload);
  const statePath = join(baseDir, STATE_REL_PATH);

  const state = loadState(statePath);
  if (!state || !state.files || typeof state.files !== "object") process.exit(0);

  const pending = [];
  const selfApproved = [];

  for (const [path, info] of Object.entries(state.files)) {
    if (!shouldTrackPath(path)) continue;
    const meta = info && typeof info === "object" ? info : {};
    const author = String(meta.author || "").toLowerCase();
    const reviewer = String(meta.reviewer || "").toLowerCase();
    const reviewed = meta.reviewed === true;
    const requiredReviewer = expectedReviewer(author);

    // tracker가 설정한 self_approved 플래그 명시적 체크
    if (meta.self_approved === true) {
      selfApproved.push({ path, author, reviewer: meta.reviewer || author, expectedReviewer: requiredReviewer });
      continue;
    }

    if (reviewed && reviewer && reviewer === author) {
      selfApproved.push({ path, author, reviewer, expectedReviewer: requiredReviewer });
      continue;
    }

    if (reviewed && requiredReviewer && reviewer && reviewer !== requiredReviewer) {
      selfApproved.push({ path, author, reviewer, expectedReviewer: requiredReviewer });
      continue;
    }

    if (!reviewed) {
      pending.push({ path, author, expectedReviewer: requiredReviewer });
    }
  }

  if (selfApproved.length > 0) {
    const lines = selfApproved
      .map((item) => `  * ${item.path} (author=${item.author}, reviewer=${item.reviewer}, required=${item.expectedReviewer || "n/a"})`)
      .join("\n");
    deny(
      `[cross-review] self-approve 차단: 동일/비허용 reviewer가 감지되었습니다.\n${lines}\n` +
      "규칙: author=claude -> reviewer=codex, author=codex -> reviewer=claude",
    );
  }

  if (pending.length > 0) {
    nudge(
      `[cross-review] git commit 전에 교차 검증이 필요합니다.\n${summarizePending(pending)}\n` +
      "규칙: author=claude -> reviewer=codex, author=codex -> reviewer=claude",
    );
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
