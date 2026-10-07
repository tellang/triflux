#!/usr/bin/env node

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  resolveHudCliVisibility,
  shouldRenderGeminiFallbackRow,
} from "./cli-policy.mjs";
import {
  bold,
  claudeOrange,
  codexWhite,
  DIM,
  dim,
  geminiBlue,
  RESET,
} from "./colors.mjs";
import {
  ACCOUNTS_CONFIG_PATH,
  ACCOUNTS_STATE_PATH,
  CLAUDE_BAND_MARKER_DIR,
  CLAUDE_BAND_MARKER_TTL_MS,
  CLAUDE_REFRESH_FLAG,
  CODEX_REFRESH_FLAG,
  TFX_PREFLIGHT_CACHE_PATH,
  TFX_PREFLIGHT_CACHE_STALE_MS,
} from "./constants.mjs";
import { buildContextUsageView } from "./context-monitor.mjs";
import {
  fetchClaudeUsage,
  readClaudeUsageSnapshot,
  scheduleClaudeUsageRefresh,
} from "./providers/claude.mjs";
import {
  getCodexEmail,
  hasBrokerCodexAccounts,
  readCodexRateLimitSnapshot,
  refreshCodexRateLimitsCache,
  scheduleCodexRateLimitRefresh,
} from "./providers/codex.mjs";
import {
  getAntigravityAccountLabel,
  getAntigravityCurrentModel,
  getAntigravityModelAbbrev,
  getGeminiEmail,
} from "./providers/gemini.mjs";
import {
  getClaudeRows,
  getMicroLine,
  getProviderRow,
  getTeamRow,
  renderAlignedRows,
} from "./renderers.mjs";
import { selectTier } from "./terminal.mjs";
import { readJson, readStdinJson } from "./utils.mjs";

async function main() {
  if (process.argv.includes(CLAUDE_REFRESH_FLAG)) {
    await fetchClaudeUsage(true);
    return;
  }
  if (process.argv.includes(CODEX_REFRESH_FLAG)) {
    await refreshCodexRateLimitsCache();
    return;
  }

  const stdinPromise = readStdinJson();
  const preflightCache = readJson(TFX_PREFLIGHT_CACHE_PATH, null);
  const preflightTimestamp = Number(preflightCache?.timestamp);
  const preflightFresh =
    Number.isFinite(preflightTimestamp) &&
    Date.now() - preflightTimestamp <= TFX_PREFLIGHT_CACHE_STALE_MS;
  const { showCodex, antigravityAllowed } = resolveHudCliVisibility();
  const antigravityReady =
    antigravityAllowed &&
    preflightFresh &&
    preflightCache?.antigravity?.ok === true;
  const accountsConfig = readJson(ACCOUNTS_CONFIG_PATH, { providers: {} });
  const accountsState = readJson(ACCOUNTS_STATE_PATH, { providers: {} });
  const claudeUsageSnapshot = readClaudeUsageSnapshot();
  const codexSnapshot = readCodexRateLimitSnapshot();
  // 설정이 없는 홈에서는 갱신 프로세스를 시작하지 않는다.
  if (
    claudeUsageSnapshot.shouldRefresh &&
    existsSync(join(homedir(), ".claude"))
  ) {
    scheduleClaudeUsageRefresh();
  }
  if (
    showCodex &&
    codexSnapshot.shouldRefresh &&
    (existsSync(join(homedir(), ".codex")) || hasBrokerCodexAccounts())
  ) {
    scheduleCodexRateLimitRefresh();
  }

  const stdin = await stdinPromise;
  const contextView = buildContextUsageView(stdin);
  const claudeUsage = claudeUsageSnapshot.data
    ? { ...claudeUsageSnapshot.data, stale: claudeUsageSnapshot.isStale }
    : null;
  const codexBuckets = codexSnapshot.buckets;
  const currentTier = selectTier();
  const geminiEmail = getGeminiEmail();
  const showGeminiRow = shouldRenderGeminiFallbackRow({
    antigravityAllowed,
    antigravityReady,
    geminiEmail,
  });

  if (currentTier === "nano") {
    const microLine = getMicroLine(
      contextView,
      claudeUsage,
      codexBuckets,
      antigravityReady,
      { showCodex, showGemini: showGeminiRow },
    );
    process.stdout.write(`\x1b[0m${microLine}\n`);
    return;
  }

  const rows = isClaudeBandActive(stdin?.session_id)
    ? []
    : getClaudeRows(currentTier, contextView, claudeUsage);
  let codexRowIndex = -1;
  if (showCodex) {
    codexRowIndex = rows.length;
    rows.push(
      getProviderRow(
        currentTier,
        "codex",
        "x",
        codexWhite,
        accountsConfig,
        accountsState,
        codexBuckets ? { type: "codex", buckets: codexBuckets } : null,
        getCodexEmail(),
      ),
    );
  }
  let geminiRowIndex = -1;
  if (showGeminiRow) {
    geminiRowIndex = rows.length;
    rows.push(
      getProviderRow(
        currentTier,
        antigravityReady ? "antigravity" : "gemini",
        antigravityReady ? "a" : "g",
        geminiBlue,
        accountsConfig,
        accountsState,
        antigravityReady
          ? {
              currentAbbrev: getAntigravityModelAbbrev(
                getAntigravityCurrentModel(),
              ),
            }
          : null,
        antigravityReady ? getAntigravityAccountLabel() : geminiEmail,
      ),
    );
  }
  const teamRow = getTeamRow(currentTier);
  if (teamRow) rows.push(teamRow);

  const outputLines = renderAlignedRows(rows);
  if (!codexBuckets && outputLines[codexRowIndex] != null) {
    outputLines[codexRowIndex] = `${DIM}${outputLines[codexRowIndex]}${RESET}`;
  }
  if (!antigravityReady && outputLines[geminiRowIndex] != null) {
    outputLines[geminiRowIndex] = dim(outputLines[geminiRowIndex]);
  }
  // 알림 배너와 TUI 스타일이 HUD 내용에 겹치지 않도록 한다.
  const leadingBreaks = contextView.percent >= 85 ? "\n\n" : "\n";
  const resetLines = outputLines.map((line) => `\x1b[0m${line}`);
  process.stdout.write(`${leadingBreaks}${resetLines.join("\n")}\n`);
}

main().catch(() => {
  process.stdout.write(
    `\x1b[0m${bold(claudeOrange("c"))}: ${dim("5h:--% (n/a) 1w:--% (n/a) | ctx:--%")}\n`,
  );
});

// 프롬프트 위 band가 같은 정보를 그리는 세션에서는 Claude 행을 생략한다.
function isClaudeBandActive(sessionId) {
  if (!sessionId) return false;
  try {
    const { mtimeMs } = statSync(join(CLAUDE_BAND_MARKER_DIR, sessionId));
    return Date.now() - mtimeMs < CLAUDE_BAND_MARKER_TTL_MS;
  } catch {
    return false;
  }
}
