#!/usr/bin/env node

// ============================================================================
// HUD QoS Status — 메인 오케스트레이터
// 각 모듈에서 색상, 터미널, 프로바이더, 렌더러를 가져와 조합한다.
// ============================================================================

import { DIM, RESET, bold, dim, green, claudeOrange, codexWhite, geminiBlue, colorByPercent } from "./colors.mjs";
import {
  QOS_PATH, ACCOUNTS_CONFIG_PATH, ACCOUNTS_STATE_PATH,
  CLAUDE_REFRESH_FLAG, CODEX_REFRESH_FLAG,
  GEMINI_REFRESH_FLAG, GEMINI_SESSION_REFRESH_FLAG,
  GEMINI_PRO_POOL, GEMINI_FLASH_POOL,
} from "./constants.mjs";
import {
  readJson, readStdinJson, getContextPercent, getProviderAccountId, getCliArgValue,
} from "./utils.mjs";
import { selectTier } from "./terminal.mjs";

// Claude provider
import {
  readClaudeUsageSnapshot, scheduleClaudeUsageRefresh, fetchClaudeUsage,
} from "./providers/claude.mjs";

// Codex provider
import {
  getCodexEmail, readCodexRateLimitSnapshot,
  refreshCodexRateLimitsCache, scheduleCodexRateLimitRefresh,
} from "./providers/codex.mjs";

// Gemini provider
import {
  getGeminiEmail, buildGeminiAuthContext,
  readGeminiQuotaSnapshot, readGeminiSessionSnapshot,
  fetchGeminiQuota, refreshGeminiSessionCache,
  scheduleGeminiQuotaRefresh, scheduleGeminiSessionRefresh,
} from "./providers/gemini.mjs";

// Renderers
import {
  getClaudeRows, getProviderRow, getTeamRow,
  renderAlignedRows, getMicroLine,
  readLatestBenchmarkDiff, formatTokenSummary,
  readTokenSavings, readSvAccumulator,
} from "./renderers.mjs";

// ============================================================================
// 메인
// ============================================================================
async function main() {
  // 백그라운드 Claude 사용량 리프레시
  if (process.argv.includes(CLAUDE_REFRESH_FLAG)) {
    await fetchClaudeUsage(true);
    return;
  }

  if (process.argv.includes(CODEX_REFRESH_FLAG)) {
    refreshCodexRateLimitsCache();
    return;
  }

  if (process.argv.includes(GEMINI_SESSION_REFRESH_FLAG)) {
    refreshGeminiSessionCache();
    return;
  }

  // 백그라운드 Gemini 쿼터 리프레시 전용 실행 모드
  if (process.argv.includes(GEMINI_REFRESH_FLAG)) {
    const accountId = getCliArgValue("--account") || "gemini-main";
    const authContext = buildGeminiAuthContext(accountId);
    await fetchGeminiQuota(accountId, { authContext, forceRefresh: true });
    return;
  }

  // 메인 HUD 경로: 즉시 렌더 우선
  const stdinPromise = readStdinJson();

  const qosProfile = readJson(QOS_PATH, { providers: {} });
  const accountsConfig = readJson(ACCOUNTS_CONFIG_PATH, { providers: {} });
  const accountsState = readJson(ACCOUNTS_STATE_PATH, { providers: {} });
  const claudeUsageSnapshot = readClaudeUsageSnapshot();
  if (claudeUsageSnapshot.shouldRefresh) {
    scheduleClaudeUsageRefresh();
  }
  const geminiAccountId = getProviderAccountId("gemini", accountsConfig, accountsState);
  const codexSnapshot = readCodexRateLimitSnapshot();
  const geminiSessionSnapshot = readGeminiSessionSnapshot();
  const geminiAuthContext = buildGeminiAuthContext(geminiAccountId);
  const geminiQuotaSnapshot = readGeminiQuotaSnapshot(geminiAccountId, geminiAuthContext);
  if (codexSnapshot.shouldRefresh) {
    scheduleCodexRateLimitRefresh();
  }
  if (geminiSessionSnapshot.shouldRefresh) {
    scheduleGeminiSessionRefresh();
  }
  if (geminiQuotaSnapshot.shouldRefresh) {
    scheduleGeminiQuotaRefresh(geminiAccountId);
  }

  // 실측 데이터 추출
  const stdin = await stdinPromise;
  const codexEmail = getCodexEmail();
  const geminiEmail = getGeminiEmail();
  const codexBuckets = codexSnapshot.buckets;
  const geminiSession = geminiSessionSnapshot.session;
  const geminiQuota = geminiQuotaSnapshot.quota;

  // 누적 절약 데이터 읽기
  const svSavings = readTokenSavings();
  const svAccumulator = readSvAccumulator();
  const totalCostSaved = svSavings?.totalSaved || svAccumulator?.totalCostSaved || 0;

  // 세션/누적 토큰 → context 대비 절약 배수 (개별 provider sv%)
  const ctxCapacity = stdin?.context_window?.context_window_size || 200000;
  let codexSv = null;
  if (svAccumulator?.codex?.tokens > 0) {
    codexSv = svAccumulator.codex.tokens / ctxCapacity;
  } else if (codexBuckets) {
    const main = codexBuckets.codex || codexBuckets[Object.keys(codexBuckets)[0]];
    if (main?.tokens?.total_tokens) codexSv = main.tokens.total_tokens / ctxCapacity;
  }
  let geminiSv = null;
  if (svAccumulator?.gemini?.tokens > 0) {
    geminiSv = svAccumulator.gemini.tokens / ctxCapacity;
  } else {
    const geminiTokens = geminiSession?.total || null;
    geminiSv = geminiTokens ? geminiTokens / ctxCapacity : null;
  }

  // Gemini: 3풀 버킷 추출 (Pro/Flash/Lite — 각 풀 내 모델들은 쿼터 공유)
  const geminiModel = geminiSession?.model || "gemini-3-flash-preview";
  const geminiBuckets = geminiQuota?.buckets || [];
  const geminiBucket = geminiBuckets.find((b) => b.modelId === geminiModel)
    || geminiBuckets.find((b) => b.modelId === "gemini-3-flash-preview")
    || null;
  const geminiProBucket = geminiBuckets.find((b) => GEMINI_PRO_POOL.has(b.modelId)) || null;
  const geminiFlashBucket = geminiBuckets.find((b) => GEMINI_FLASH_POOL.has(b.modelId)) || null;
  const geminiLiteBucket = geminiBuckets.find((b) => b.modelId?.includes("flash-lite")) || null;

  // 합산 절약: Codex+Gemini sv% 합산 (컨텍스트 대비 위임 토큰 비율)
  const combinedSvPct = Math.round(((codexSv ?? 0) + (geminiSv ?? 0)) * 100);

  // 인디케이터 인식 tier 선택 (stdin + Claude 사용량 기반)
  const CURRENT_TIER = selectTier(stdin, claudeUsageSnapshot.data);

  // nano tier: 1줄 모드 (극소 폭 또는 알림 배너 대응)
  if (CURRENT_TIER === "nano") {
    const microLine = getMicroLine(stdin, claudeUsageSnapshot.data, codexBuckets,
      geminiSession, geminiBucket, combinedSvPct);
    process.stdout.write(`\x1b[0m${microLine}\n`);
    return;
  }

  const codexQuotaData = codexBuckets ? { type: "codex", buckets: codexBuckets } : null;
  const geminiQuotaData = {
    type: "gemini",
    quotaBucket: geminiBucket,
    pools: { pro: geminiProBucket, flash: geminiFlashBucket, lite: geminiLiteBucket },
    session: geminiSession,
  };

  const rows = [
    ...getClaudeRows(CURRENT_TIER, stdin, claudeUsageSnapshot.data, combinedSvPct),
    getProviderRow(CURRENT_TIER, "codex", "x", codexWhite, qosProfile, accountsConfig, accountsState,
      codexQuotaData, codexEmail, codexSv, null),
    getProviderRow(CURRENT_TIER, "gemini", "g", geminiBlue, qosProfile, accountsConfig, accountsState,
      geminiQuotaData, geminiEmail, geminiSv, null),
  ];

  // tfx-multi 활성 시 팀 상태 행 추가 (v2.2)
  const teamRow = getTeamRow(CURRENT_TIER);
  if (teamRow) rows.push(teamRow);

  // 최근 벤치마크 diff → 토큰 요약 행 추가
  const latestDiff = readLatestBenchmarkDiff();
  if (latestDiff) {
    const summary = formatTokenSummary(latestDiff);
    if (summary) {
      rows.push({ prefix: `${dim("$")}:`, left: summary, right: "" });
    }
  }

  // 비활성 프로바이더 dim 처리: 데이터 없으면 전체 줄 dim
  const codexActive = codexBuckets != null;
  const geminiActive = (geminiSession?.total || 0) > 0 || geminiBucket != null
    || geminiProBucket != null || geminiFlashBucket != null;

  let outputLines = renderAlignedRows(rows);

  // 비활성 줄 dim 래핑 (rows 순서: [claude, codex, gemini])
  if (outputLines.length >= 3) {
    if (!codexActive) outputLines[1] = `${DIM}${outputLines[1]}${RESET}`;
    if (!geminiActive) outputLines[2] = `${DIM}${outputLines[2]}${RESET}`;
  }

  // 선행 개행: 알림 배너(노란 글씨)가 빈 첫 줄에 오도록 → HUD 내용 보호
  const contextPercent = getContextPercent(stdin);
  const leadingBreaks = contextPercent >= 85 ? "\n\n" : "\n";
  // 줄별 RESET: Claude Code TUI 스타일 간섭 방지 (색상 밝기 버그 수정)
  const resetedLines = outputLines.map(line => `\x1b[0m${line}`);
  process.stdout.write(`${leadingBreaks}${resetedLines.join("\n")}\n`);
}

main().catch(() => {
  process.stdout.write(`\x1b[0m${bold(claudeOrange("c"))}: ${dim("5h:")}${green("0%")} ${dim("(n/a)")} ${dim("1w:")}${green("0%")} ${dim("(n/a)")} ${dim("|")} ${dim("ctx:")}${green("0%")}\n`);
});
