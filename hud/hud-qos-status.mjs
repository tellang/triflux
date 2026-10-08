#!/usr/bin/env node

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveHudCliVisibility } from "./cli-policy.mjs";
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
  ANTIGRAVITY_REFRESH_FLAG,
  CLAUDE_BAND_MARKER_DIR,
  CLAUDE_BAND_MARKER_TTL_MS,
  CLAUDE_REFRESH_FLAG,
  CODEX_REFRESH_FLAG,
  getCodexAuthPath,
  getCodexHome,
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
  getAntigravityAuthKind,
  readAntigravityQuotaSnapshot,
  refreshAntigravityQuotaCache,
  scheduleAntigravityQuotaRefresh,
} from "./providers/gemini.mjs";
import {
  getClaudeRows,
  getMicroLine,
  getProviderRow,
  renderAlignedRows,
} from "./renderers.mjs";
import { selectTier } from "./terminal.mjs";
import {
  formatTimeCell,
  formatTimeCellDH,
  readJson,
  readStdinJson,
} from "./utils.mjs";

async function main() {
  if (process.argv.includes(CLAUDE_REFRESH_FLAG)) {
    await fetchClaudeUsage(true);
    return;
  }
  if (process.argv.includes(CODEX_REFRESH_FLAG)) {
    await refreshCodexRateLimitsCache();
    return;
  }
  if (process.argv.includes(ANTIGRAVITY_REFRESH_FLAG)) {
    refreshAntigravityQuotaCache();
    return;
  }

  const stdinPromise = readStdinJson();
  const { showCodex, antigravityAllowed } = resolveHudCliVisibility();
  const accountsConfig = readJson(ACCOUNTS_CONFIG_PATH, { providers: {} });
  const accountsState = readJson(ACCOUNTS_STATE_PATH, { providers: {} });
  const claudeUsageSnapshot = readClaudeUsageSnapshot();
  const codexSnapshot = readCodexRateLimitSnapshot();
  const antigravitySnapshot = antigravityAllowed
    ? readAntigravityQuotaSnapshot()
    : null;
  if (antigravitySnapshot?.shouldRefresh) scheduleAntigravityQuotaRefresh();
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
    (existsSync(getCodexHome()) || hasBrokerCodexAccounts())
  ) {
    scheduleCodexRateLimitRefresh();
  }

  const stdin = await stdinPromise;
  const contextView = buildContextUsageView(stdin);
  const claudeUsage = claudeUsageSnapshot.data
    ? { ...claudeUsageSnapshot.data, stale: claudeUsageSnapshot.isStale }
    : null;
  const codexBuckets = codexSnapshot.buckets;
  const antigravityQuota = antigravityAllowed
    ? { ...antigravitySnapshot?.data, auth: getAntigravityAuthKind() }
    : null;
  const currentTier = selectTier();
  // 회색은 로그인 안 된 경우에만 쓴다. 로그인 상태의 조회 공백은 --% 로만 보인다.
  const codexLoggedOut =
    !codexBuckets &&
    !existsSync(getCodexAuthPath()) &&
    !hasBrokerCodexAccounts();
  if (currentTier === "nano") {
    const microLine = getMicroLine(contextView, claudeUsage, codexBuckets, {
      showCodex,
      codexLoggedOut,
      showAntigravity: antigravityAllowed,
      antigravityQuota,
    });
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
  if (antigravityAllowed) {
    rows.push(
      getProviderRow(
        currentTier,
        "antigravity",
        "a",
        geminiBlue,
        accountsConfig,
        accountsState,
        antigravityQuota,
        getAntigravityAccountLabel(),
      ),
    );
  }

  const outputLines = renderAlignedRows(rows);
  if (outputLines[codexRowIndex] != null && codexLoggedOut) {
    outputLines[codexRowIndex] = `${DIM}${outputLines[codexRowIndex]}${RESET}`;
  }
  // 알림 배너와 TUI 스타일이 HUD 내용에 겹치지 않도록 한다.
  const leadingBreaks = contextView.percent >= 85 ? "\n\n" : "\n";
  const resetLines = outputLines.map((line) => `\x1b[0m${line}`);
  process.stdout.write(`${leadingBreaks}${resetLines.join("\n")}\n`);
}

main().catch(() => {
  process.stdout.write(
    `\x1b[0m${bold(claudeOrange("c"))}: ${dim(`5h:--% ${formatTimeCell("")} 1w:--% ${formatTimeCellDH("")} | CTX:--%`)}\n`,
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
