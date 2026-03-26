// ============================================================================
// 라인 렌더러 (tier별 행 생성)
// ============================================================================
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  dim, bold, green, red, yellow, cyan,
  claudeOrange, codexWhite, geminiBlue,
  colorByPercent, colorByProvider,
  CLAUDE_ORANGE, CODEX_WHITE, GEMINI_BLUE,
} from "./colors.mjs";
import {
  PROVIDER_PREFIX_WIDTH, ACCOUNT_LABEL_WIDTH,
  FIVE_HOUR_MS, SEVEN_DAY_MS, ONE_DAY_MS,
  TEAM_STATE_PATH, SV_ACCUMULATOR_PATH, LEGACY_SV_ACCUMULATOR,
} from "./constants.mjs";
import {
  readJson, readJsonMigrate, stripAnsi, padAnsiRight, fitText,
  clampPercent, formatPercentCell, formatPlaceholderPercentCell,
  formatTimeCell, formatTimeCellDH,
  formatResetRemaining, formatResetRemainingDayHour,
  getContextPercent, formatTokenCount, formatSvPct, formatSavings,
} from "./utils.mjs";
import { tierBar, tierDimBar } from "./terminal.mjs";
import { deriveGeminiLimits } from "./providers/gemini.mjs";

// ============================================================================
// 최근 벤치마크 diff 파일 읽기
// ============================================================================
export function readLatestBenchmarkDiff() {
  const diffsDir = join(homedir(), ".omc", "state", "cx-auto-tokens", "diffs");
  if (!existsSync(diffsDir)) return null;
  try {
    const files = readdirSync(diffsDir).filter(f => f.endsWith(".json")).sort().reverse();
    if (files.length === 0) return null;
    return readJson(join(diffsDir, files[0]), null);
  } catch { return null; }
}

// 토큰 절약액 누적치 읽기 (tfx-auto token tracker)
export function readTokenSavings() {
  const savingsPath = join(homedir(), ".omc", "state", "tfx-auto-tokens", "savings-total.json");
  const data = readJson(savingsPath, null);
  if (!data || data.totalSaved === 0) return null;
  return data;
}

// sv-accumulator.json에서 누적 토큰/비용 읽기
export function readSvAccumulator() {
  return readJsonMigrate(SV_ACCUMULATOR_PATH, LEGACY_SV_ACCUMULATOR, null);
}

/**
 * 파이프라인 벤치마크 diff 결과를 HUD 요약 문자열로 포맷
 */
export function formatTokenSummary(diff) {
  if (!diff?.delta?.total || !diff?.savings) return "";
  const t = diff.delta.total;
  const s = diff.savings;

  const inputStr = formatTokenCount(t.input);
  const outputStr = formatTokenCount(t.output);
  const actualStr = formatSavings(s.actualCost);
  const claudeStr = formatSavings(s.claudeCost);
  const savedPct = s.claudeCost > 0
    ? Math.round((s.saved / s.claudeCost) * 100)
    : 0;

  return `${dim("tok:")}${inputStr}${dim("in")} ${outputStr}${dim("out")} ` +
    `${dim("cost:")}${actualStr} ` +
    `${dim("sv:")}${green(formatSavings(s.saved))}${dim("(")}${savedPct}%${dim(")")}`;
}

// ============================================================================
// tfx-multi 상태 행 생성 (v2.2 HUD 통합)
// ============================================================================
export function getTeamRow(currentTier) {
  const teamState = readJson(TEAM_STATE_PATH, null);
  if (!teamState || !teamState.sessionName) return null;

  // 팀 생존 확인: startedAt 기준 24시간 초과면 stale로 간주
  if (teamState.startedAt && (Date.now() - teamState.startedAt) > 24 * 60 * 60 * 1000) return null;

  const workers = (teamState.members || []).filter((m) => m.role === "worker");
  if (!workers.length) return null;

  const tasks = teamState.tasks || [];
  const completed = tasks.filter((t) => t.status === "completed").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const total = tasks.length || workers.length;

  // 경과 시간 (80col 이상에서만 표시)
  const elapsed = (teamState.startedAt && (currentTier === "full" || currentTier === "compact"))
    ? `${Math.round((Date.now() - teamState.startedAt) / 60000)}m`
    : "";

  // CLI 브랜드: 단일문자 + ANSI 색상 (x=codex, g=gemini, c=claude)
  const cliTag = (cli) => cli === "codex" ? bold(codexWhite("x")) : cli === "gemini" ? bold(geminiBlue("g")) : bold(claudeOrange("c"));
  // 멤버 상태: 태그 + 상태기호 (60col 이상)
  const memberIcons = (currentTier === "full" || currentTier === "compact" || currentTier === "minimal") ? workers.map((m) => {
    const task = tasks.find((t) => t.owner === m.name);
    const status = task?.status === "completed" ? green("\u2713")
      : task?.status === "in_progress" ? yellow("\u22EF")
      : task?.status === "failed" ? red("\u2717")
      : dim("\u25CC");
    return `${cliTag(m.cli)}${status}`;
  }).join(" ") : "";

  // 진행 텍스트
  const doneText = failed > 0
    ? `${completed}/${total} ${red(`${failed}\u2717`)}`
    : `${completed}/${total}`;

  const leftText = elapsed ? `${doneText} ${dim(elapsed)}` : doneText;

  return {
    prefix: bold(claudeOrange("\u25B2")),
    left: leftText,
    right: memberIcons,
  };
}

// ============================================================================
// 행 정렬 렌더링
// ============================================================================
export function renderAlignedRows(rows) {
  const rightRows = rows.filter((row) => stripAnsi(String(row.right || "")).trim().length > 0);
  const rawLeftWidth = rightRows.reduce((max, row) => Math.max(max, stripAnsi(row.left).length), 0);
  return rows.map((row) => {
    const prefix = padAnsiRight(row.prefix, PROVIDER_PREFIX_WIDTH);
    const hasRight = stripAnsi(String(row.right || "")).trim().length > 0;
    if (!hasRight) {
      return `${prefix} ${row.left}`;
    }
    // 자기 left 대비 패딩 상한: 최대 2칸까지만 패딩 (과도한 공백 방지)
    const ownLen = stripAnsi(row.left).length;
    const effectiveWidth = Math.min(rawLeftWidth, ownLen + 2);
    const left = padAnsiRight(row.left, effectiveWidth);
    return `${prefix} ${left} ${dim("|")} ${row.right}`;
  });
}

// ============================================================================
// micro tier: 모든 프로바이더를 1줄로 압축
// ============================================================================
export function getMicroLine(stdin, claudeUsage, codexBuckets, geminiSession, geminiBucket, combinedSvPct) {
  const ctx = getContextPercent(stdin);

  // Claude 5h/1w
  const cF = claudeUsage?.fiveHourPercent != null ? clampPercent(claudeUsage.fiveHourPercent) : null;
  const cW = claudeUsage?.weeklyPercent != null ? clampPercent(claudeUsage.weeklyPercent) : null;
  const cVal = claudeUsage != null
    ? `${cF != null ? colorByProvider(cF, `${cF}`, claudeOrange) : dim("--")}${dim("/")}${cW != null ? colorByProvider(cW, `${cW}`, claudeOrange) : dim("--")}`
    : dim("--/--");

  // Codex 5h/1w
  let xVal = dim("--/--");
  if (codexBuckets) {
    const mb = codexBuckets.codex || codexBuckets[Object.keys(codexBuckets)[0]];
    if (mb) {
      const xF = mb.primary?.used_percent != null ? clampPercent(mb.primary.used_percent) : null;
      const xW = mb.secondary?.used_percent != null ? clampPercent(mb.secondary.used_percent) : null;
      xVal = `${xF != null ? colorByProvider(xF, `${xF}`, codexWhite) : dim("--")}${dim("/")}${xW != null ? colorByProvider(xW, `${xW}`, codexWhite) : dim("--")}`;
    }
  }

  // Gemini
  let gVal;
  if (geminiBucket) {
    const gl = deriveGeminiLimits(geminiBucket);
    const gU = gl ? gl.usedPct : clampPercent((1 - (geminiBucket.remainingFraction ?? 1)) * 100);
    gVal = colorByProvider(gU, `${gU}`, geminiBlue);
  } else if ((geminiSession?.total || 0) > 0) {
    gVal = geminiBlue("\u221E");
  } else {
    gVal = dim("--");
  }

  // sv
  const sv = formatSvPct(combinedSvPct || 0).trim();

  return `${bold(claudeOrange("c"))}${dim(":")}${cVal} ` +
    `${bold(codexWhite("x"))}${dim(":")}${xVal} ` +
    `${bold(geminiBlue("g"))}${dim(":")}${gVal} ` +
    `${dim("sv:")}${sv} ` +
    `${dim("ctx:")}${colorByPercent(ctx, `${ctx}%`)}`;
}

// ============================================================================
// Claude 행 렌더러
// ============================================================================
export function getClaudeRows(currentTier, stdin, claudeUsage, combinedSvPct) {
  const contextPercent = getContextPercent(stdin);
  const prefix = `${bold(claudeOrange("c"))}:`;

  // 절약 퍼센트
  const svStr = formatSvPct(combinedSvPct || 0);
  const svSuffix = `${dim("sv:")}${svStr}`;

  // API 실측 데이터
  const fiveHourPercent = claudeUsage?.fiveHourPercent ?? null;
  const weeklyPercent = claudeUsage?.weeklyPercent ?? null;
  const fiveHourReset = claudeUsage?.fiveHourResetsAt
    ? formatResetRemaining(claudeUsage.fiveHourResetsAt, FIVE_HOUR_MS)
    : "n/a";
  const weeklyReset = claudeUsage?.weeklyResetsAt
    ? formatResetRemainingDayHour(claudeUsage.weeklyResetsAt, SEVEN_DAY_MS)
    : "n/a";

  const hasData = claudeUsage != null;

  const fStr = hasData && fiveHourPercent != null ? colorByProvider(fiveHourPercent, formatPercentCell(fiveHourPercent), claudeOrange) : dim(formatPlaceholderPercentCell());
  const wStr = hasData && weeklyPercent != null ? colorByProvider(weeklyPercent, formatPercentCell(weeklyPercent), claudeOrange) : dim(formatPlaceholderPercentCell());
  const fBar = hasData && fiveHourPercent != null ? tierBar(currentTier, fiveHourPercent, CLAUDE_ORANGE) : tierDimBar(currentTier);
  const wBar = hasData && weeklyPercent != null ? tierBar(currentTier, weeklyPercent, CLAUDE_ORANGE) : tierDimBar(currentTier);
  const fTime = formatTimeCell(fiveHourReset);
  const wTime = formatTimeCellDH(weeklyReset);

  if (currentTier === "nano" || currentTier === "micro") {
    const fShort = hasData && fiveHourPercent != null ? colorByProvider(fiveHourPercent, `${fiveHourPercent}%`, claudeOrange) : dim("--");
    const wShort = hasData && weeklyPercent != null ? colorByProvider(weeklyPercent, `${weeklyPercent}%`, claudeOrange) : dim("--");
    const quotaSection = `${fShort}${dim("/")}${wShort}`;
    return [{ prefix, left: quotaSection, right: "" }];
  }

  if (currentTier === "minimal") {
    const quotaSection = `${dim("5h:")}${fStr} ${dim("1w:")}${wStr}`;
    return [{ prefix, left: quotaSection, right: "" }];
  }

  if (currentTier === "compact") {
    const quotaSection = `${dim("5h:")}${fStr} ${dim(fTime)} ${dim("1w:")}${wStr} ${dim(wTime)}`;
    const contextSection = `${svSuffix} ${dim("|")} ${dim("ctx:")}${colorByPercent(contextPercent, `${contextPercent}%`)}`;
    return [{ prefix, left: quotaSection, right: contextSection }];
  }

  // full tier (>= 120 cols)
  const quotaSection = `${dim("5h:")}${fBar}${fStr} ${dim(fTime)} ${dim("1w:")}${wBar}${wStr} ${dim(wTime)}`;
  const contextSection = `${svSuffix} ${dim("|")} ${dim("ctx:")}${colorByPercent(contextPercent, `${contextPercent}%`)}`;
  return [{ prefix, left: quotaSection, right: contextSection }];
}

// ============================================================================
// 계정 라벨 + 범용 프로바이더 행 렌더러
// ============================================================================
export function getAccountLabel(provider, accountsConfig, accountsState, codexEmail) {
  const providerConfig = accountsConfig?.providers?.[provider] || [];
  const providerState = accountsState?.providers?.[provider] || {};
  const lastId = providerState.last_selected_id;
  const picked = providerConfig.find((a) => a.id === lastId) || providerConfig[0]
    || { id: `${provider}-main`, label: provider };
  let label = picked.label || picked.id;
  if (codexEmail) label = codexEmail;
  if (label.includes("@")) label = label.split("@")[0];
  return label;
}

export function getProviderRow(currentTier, provider, marker, markerColor, qosProfile, accountsConfig, accountsState, realQuota, codexEmail, savingsMultiplier, modelLabel) {
  const accountLabel = fitText(getAccountLabel(provider, accountsConfig, accountsState, codexEmail), ACCOUNT_LABEL_WIDTH);

  // 절약 퍼센트 섹션
  const svPct = savingsMultiplier != null ? Math.round(savingsMultiplier * 100) : null;
  const svStr = formatSvPct(svPct);
  const modelLabelStr = modelLabel ? ` ${markerColor(modelLabel)}` : "";

  // 프로바이더별 색상 프로필
  const provAnsi = provider === "codex" ? CODEX_WHITE : provider === "gemini" ? GEMINI_BLUE : GREEN;
  const provFn = provider === "codex" ? codexWhite : provider === "gemini" ? geminiBlue : green;

  let quotaSection;
  let extraRightSection = "";

  if (currentTier === "nano" || currentTier === "micro") {
    const minPrefix = `${bold(markerColor(`${marker}`))}:`;
    if (realQuota?.type === "codex") {
      const main = realQuota.buckets.codex || realQuota.buckets[Object.keys(realQuota.buckets)[0]];
      if (main) {
        const fiveP = main.primary?.used_percent != null ? clampPercent(main.primary.used_percent) : null;
        const weekP = main.secondary?.used_percent != null ? clampPercent(main.secondary.used_percent) : null;
        const fCellN = fiveP != null ? colorByProvider(fiveP, `${fiveP}%`, provFn) : dim("--%");
        const wCellN = weekP != null ? colorByProvider(weekP, `${weekP}%`, provFn) : dim("--%");
        return { prefix: minPrefix, left: `${fCellN}${dim("/")}${wCellN}`, right: "" };
      }
    }
    if (realQuota?.type === "gemini") {
      const pools = realQuota.pools || {};
      if (pools.pro || pools.flash) {
        const pP = pools.pro ? clampPercent(Math.round((1 - (pools.pro.remainingFraction ?? 1)) * 100)) : null;
        const pF = pools.flash ? clampPercent(Math.round((1 - (pools.flash.remainingFraction ?? 1)) * 100)) : null;
        const pStr = pP != null ? colorByProvider(pP, `${pP}`, provFn) : dim("--");
        const fStr = pF != null ? colorByProvider(pF, `${pF}`, provFn) : dim("--");
        return { prefix: minPrefix, left: `${pStr}${dim("/")}${fStr}`, right: "" };
      }
    }
    return { prefix: minPrefix, left: dim("--/--"), right: "" };
  }

  if (currentTier === "minimal") {
    if (realQuota?.type === "codex") {
      const main = realQuota.buckets.codex || realQuota.buckets[Object.keys(realQuota.buckets)[0]];
      if (main) {
        const fiveP = main.primary?.used_percent != null ? clampPercent(main.primary.used_percent) : null;
        const weekP = main.secondary?.used_percent != null ? clampPercent(main.secondary.used_percent) : null;
        const fCell = fiveP != null ? colorByProvider(fiveP, formatPercentCell(fiveP), provFn) : dim(formatPlaceholderPercentCell());
        const wCell = weekP != null ? colorByProvider(weekP, formatPercentCell(weekP), provFn) : dim(formatPlaceholderPercentCell());
        quotaSection = `${dim("5h:")}${fCell} ${dim("1w:")}${wCell}`;
      }
    }
    if (realQuota?.type === "gemini") {
      const pools = realQuota.pools || {};
      if (pools.pro || pools.flash) {
        const slot = (bucket, label) => {
          if (!bucket) return `${dim(label + ":")}${dim(formatPlaceholderPercentCell())}`;
          const gl = deriveGeminiLimits(bucket);
          const usedP = gl ? gl.usedPct : clampPercent((1 - (bucket.remainingFraction ?? 1)) * 100);
          return `${dim(label + ":")}${colorByProvider(usedP, formatPercentCell(usedP), provFn)}`;
        };
        quotaSection = `${slot(pools.pro, "Pr")} ${slot(pools.flash, "Fl")}`;
      } else {
        quotaSection = `${dim("Pr:")}${dim(formatPlaceholderPercentCell())} ${dim("Fl:")}${dim(formatPlaceholderPercentCell())}`;
      }
    }
    if (!quotaSection) {
      quotaSection = `${dim("5h:")}${dim(formatPlaceholderPercentCell())} ${dim("1w:")}${dim(formatPlaceholderPercentCell())}`;
    }
    const prefix = `${bold(markerColor(`${marker}`))}:`;
    return { prefix, left: quotaSection, right: accountLabel ? markerColor(accountLabel) : "" };
  }

  if (currentTier === "compact") {
    if (realQuota?.type === "codex") {
      const main = realQuota.buckets.codex || realQuota.buckets[Object.keys(realQuota.buckets)[0]];
      if (main) {
        const fiveP = main.primary?.used_percent != null ? clampPercent(main.primary.used_percent) : null;
        const weekP = main.secondary?.used_percent != null ? clampPercent(main.secondary.used_percent) : null;
        const fCell = fiveP != null ? colorByProvider(fiveP, formatPercentCell(fiveP), provFn) : dim(formatPlaceholderPercentCell());
        const wCell = weekP != null ? colorByProvider(weekP, formatPercentCell(weekP), provFn) : dim(formatPlaceholderPercentCell());
        const fiveReset = formatResetRemaining(main.primary?.resets_at, FIVE_HOUR_MS) || "n/a";
        const weekReset = formatResetRemainingDayHour(main.secondary?.resets_at, SEVEN_DAY_MS) || "n/a";
        quotaSection = `${dim("5h:")}${fCell} ${dim(formatTimeCell(fiveReset))} ${dim("1w:")}${wCell} ${dim(formatTimeCellDH(weekReset))}`;
      }
    }
    if (realQuota?.type === "gemini") {
      const pools = realQuota.pools || {};
      const hasAnyPool = pools.pro || pools.flash;
      if (hasAnyPool) {
        const slot = (bucket, label) => {
          if (!bucket) return `${dim(label + ":")}${dim(formatPlaceholderPercentCell())} ${dim(formatTimeCell("n/a"))}`;
          const gl = deriveGeminiLimits(bucket);
          const usedP = gl ? gl.usedPct : clampPercent((1 - (bucket.remainingFraction ?? 1)) * 100);
          const rstRemaining = formatResetRemaining(bucket.resetTime, ONE_DAY_MS) || "n/a";
          return `${dim(label + ":")}${colorByProvider(usedP, formatPercentCell(usedP), provFn)} ${dim(formatTimeCell(rstRemaining))}`;
        };
        quotaSection = `${slot(pools.pro, "Pr")} ${slot(pools.flash, "Fl")}`;
      } else {
        quotaSection = `${dim("Pr:")}${dim(formatPlaceholderPercentCell())} ${dim(formatTimeCell("n/a"))} ${dim("Fl:")}${dim(formatPlaceholderPercentCell())} ${dim(formatTimeCell("n/a"))}`;
      }
    }
    if (!quotaSection) {
      quotaSection = `${dim("5h:")}${dim(formatPlaceholderPercentCell())} ${dim(formatTimeCell("n/a"))} ${dim("1w:")}${dim(formatPlaceholderPercentCell())} ${dim(formatTimeCellDH("--d--h"))}`;
    }
    const prefix = `${bold(markerColor(`${marker}`))}:`;
    const compactRight = [svStr ? `${dim("sv:")}${svStr}` : "", accountLabel ? markerColor(accountLabel) : ""].filter(Boolean).join(" ");
    return { prefix, left: quotaSection, right: compactRight };
  }

  // full tier
  if (realQuota?.type === "codex") {
    const main = realQuota.buckets.codex || realQuota.buckets[Object.keys(realQuota.buckets)[0]];
    if (main) {
      const fiveP = main.primary?.used_percent != null ? clampPercent(main.primary.used_percent) : null;
      const weekP = main.secondary?.used_percent != null ? clampPercent(main.secondary.used_percent) : null;
      const fiveReset = formatResetRemaining(main.primary?.resets_at, FIVE_HOUR_MS) || "n/a";
      const weekReset = formatResetRemainingDayHour(main.secondary?.resets_at, SEVEN_DAY_MS) || "n/a";
      const fCell = fiveP != null ? colorByProvider(fiveP, formatPercentCell(fiveP), provFn) : dim(formatPlaceholderPercentCell());
      const wCell = weekP != null ? colorByProvider(weekP, formatPercentCell(weekP), provFn) : dim(formatPlaceholderPercentCell());
      const fBar = fiveP != null ? tierBar(currentTier, fiveP, provAnsi) : tierDimBar(currentTier);
      const wBar = weekP != null ? tierBar(currentTier, weekP, provAnsi) : tierDimBar(currentTier);
      quotaSection = `${dim("5h:")}${fBar}${fCell} ` +
        `${dim(formatTimeCell(fiveReset))} ` +
        `${dim("1w:")}${wBar}${wCell} ` +
        `${dim(formatTimeCellDH(weekReset))}`;
    }
  }

  if (realQuota?.type === "gemini") {
    const pools = realQuota.pools || {};
    const hasAnyPool = pools.pro || pools.flash;

    if (hasAnyPool) {
      const slot = (bucket, label) => {
        if (!bucket) {
          return `${dim(label + ":")}${tierDimBar(currentTier)}${dim(formatPlaceholderPercentCell())} ${dim(formatTimeCell("n/a"))}`;
        }
        const gl = deriveGeminiLimits(bucket);
        const usedP = gl ? gl.usedPct : clampPercent((1 - (bucket.remainingFraction ?? 1)) * 100);
        const rstRemaining = formatResetRemaining(bucket.resetTime, ONE_DAY_MS) || "n/a";
        return `${dim(label + ":")}${tierBar(currentTier, usedP, provAnsi)}${colorByProvider(usedP, formatPercentCell(usedP), provFn)} ${dim(formatTimeCell(rstRemaining))}`;
      };

      quotaSection = `${slot(pools.pro, "Pr")} ${slot(pools.flash, "Fl")}`;
    } else {
      quotaSection = `${dim("Pr:")}${tierDimBar(currentTier)}${dim(formatPlaceholderPercentCell())} ${dim(formatTimeCell("n/a"))} ` +
        `${dim("Fl:")}${tierDimBar(currentTier)}${dim(formatPlaceholderPercentCell())} ${dim(formatTimeCell("n/a"))}`;
    }
  }

  // 폴백
  if (!quotaSection) {
    quotaSection = `${dim("5h:")}${tierDimBar(currentTier)}${dim(formatPlaceholderPercentCell())} ${dim(formatTimeCell("n/a"))} ${dim("1w:")}${tierDimBar(currentTier)}${dim(formatPlaceholderPercentCell())} ${dim(formatTimeCellDH("--d--h"))}`;
  }

  const prefix = `${bold(markerColor(`${marker}`))}:`;
  const accountSection = `${markerColor(accountLabel)}`;
  const svSection = svStr ? `${dim("sv:")}${svStr}` : "";
  const modelLabelSection = modelLabel ? markerColor(modelLabel) : "";
  const rightParts = [svSection, accountSection, modelLabelSection].filter(Boolean);
  return {
    prefix,
    left: quotaSection,
    right: rightParts.join(` ${dim("|")} `),
  };
}
