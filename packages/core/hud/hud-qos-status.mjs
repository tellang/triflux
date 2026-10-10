#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
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
  ANTIGRAVITY_REFRESH_FLAG,
  BAND_FLAG,
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
import { formatTimeCell, formatTimeCellDH, readStdinJson } from "./utils.mjs";

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

  // --band: triflux mods 가 입력창 위에 그릴 줄을 만든다. statusLine 은 band 가 다 그리는 세션에서 비운다.
  const bandMode = process.argv.includes(BAND_FLAG);
  const stdin = await readStdinJson();
  const bandState = bandMode ? "none" : readBandState(stdin?.session_id);
  if (bandState === "all") return;
  // mods 가 넘긴 세션 사용량이 있으면 Claude API 를 따로 조회하지 않는다.
  const bandClaudeUsage = claudeUsageFromRateLimits(stdin?.claude_rate_limits);

  const { showCodex, antigravityAllowed } = resolveHudCliVisibility();
  const claudeUsageSnapshot = readClaudeUsageSnapshot();
  const codexSnapshot = readCodexRateLimitSnapshot();
  const antigravitySnapshot = antigravityAllowed
    ? readAntigravityQuotaSnapshot()
    : null;
  if (antigravitySnapshot?.shouldRefresh) scheduleAntigravityQuotaRefresh();
  // 설정이 없는 홈에서는 갱신 프로세스를 시작하지 않는다.
  if (
    !bandClaudeUsage &&
    claudeUsageSnapshot.shouldRefresh &&
    existsSync(join(homedir(), ".claude"))
  ) {
    scheduleClaudeUsageRefresh();
  }
  if (showCodex && codexSnapshot.shouldRefresh && existsSync(getCodexHome())) {
    scheduleCodexRateLimitRefresh();
  }

  const contextView = buildContextUsageView(stdin);
  const claudeUsage =
    bandClaudeUsage ??
    (claudeUsageSnapshot.data
      ? { ...claudeUsageSnapshot.data, stale: claudeUsageSnapshot.isStale }
      : null);
  const codexBuckets = codexSnapshot.buckets;
  const antigravityQuota = antigravityAllowed
    ? { ...antigravitySnapshot?.data, auth: getAntigravityAuthKind() }
    : null;
  const currentTier = selectTier();
  // 회색은 로그인 안 된 경우에만 쓴다. 로그인 상태의 조회 공백은 --% 로만 보인다.
  const codexLoggedOut =
    showCodex && !codexBuckets && !existsSync(getCodexAuthPath());
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

  const rows =
    bandState === "claude"
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
        antigravityQuota,
        getAntigravityAccountLabel(),
      ),
    );
  }

  const outputLines = renderAlignedRows(rows);
  if (outputLines[codexRowIndex] != null && codexLoggedOut) {
    outputLines[codexRowIndex] = `${DIM}${outputLines[codexRowIndex]}${RESET}`;
  }
  // 알림 배너와 TUI 스타일이 HUD 내용에 겹치지 않도록 한다. band 는 자기 자리에 그리니 띄우지 않는다.
  const leadingBreaks = bandMode
    ? ""
    : contextView.percent >= 85
      ? "\n\n"
      : "\n";
  const resetLines = outputLines.map((line) => `\x1b[0m${line}`);
  process.stdout.write(`${leadingBreaks}${resetLines.join("\n")}\n`);
}

main().catch(() => {
  process.stdout.write(
    `\x1b[0m${bold(claudeOrange("c"))}: ${dim(`5h:--% ${formatTimeCell("")} 1w:--% ${formatTimeCellDH("")} | CTX:--%`)}\n`,
  );
});

// 입력창 위 band 가 무엇을 그리는지: "all" 은 모든 행, "claude" 는 c 행만(10.56.0 mods), "none" 은 없음.
// band 위치를 statusline 으로 고른 세션은 표식에 "off" 를 쓴다.
function readBandState(sessionId) {
  if (!sessionId) return "none";
  try {
    const marker = join(CLAUDE_BAND_MARKER_DIR, sessionId);
    const content = readFileSync(marker, "utf8").trim();
    if (content === "off") return "none";
    if (Date.now() - statSync(marker).mtimeMs >= CLAUDE_BAND_MARKER_TTL_MS)
      return "none";
    return content.startsWith("all:") ? "all" : "claude";
  } catch {
    return "none";
  }
}

// mods 의 $.session.usage() rateLimits 를 HUD 의 Claude 사용량 형식으로 바꾼다.
function claudeUsageFromRateLimits(rateLimits) {
  if (!Array.isArray(rateLimits)) return null;
  const find = (kind) => rateLimits.find((w) => w?.kind === kind);
  const fiveHour = find("five_hour");
  const weekly = find("seven_day");
  if (!fiveHour && !weekly) return null;
  const percent = (w) =>
    Number.isFinite(w?.percentUsed) ? Math.round(w.percentUsed) : null;
  return {
    fiveHourPercent: percent(fiveHour),
    weeklyPercent: percent(weekly),
    fiveHourResetsAt: fiveHour?.resetsAt || null,
    weeklyResetsAt: weekly?.resetsAt || null,
  };
}
