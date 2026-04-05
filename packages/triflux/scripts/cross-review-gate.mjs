#!/usr/bin/env node

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { nudge, deny } from "./lib/hook-utils.mjs";
import {
  readStdin,
  parseJson,
  nowSec,
  resolveBaseDir,
  shouldTrackPath,
  expectedReviewer,
  SESSION_TTL_SEC,
  STATE_REL_PATH,
} from "./lib/cross-review-utils.mjs";

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
