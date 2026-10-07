// ============================================================================
// 라인 렌더러 (tier별 행 생성)
// ============================================================================
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  bold,
  CLAUDE_ORANGE,
  CODEX_WHITE,
  claudeOrange,
  codexWhite,
  colorByPercent,
  colorByProvider,
  dim,
  geminiBlue,
  green,
  red,
  yellow,
} from "./colors.mjs";
import {
  ACCOUNT_LABEL_WIDTH,
  FIVE_HOUR_MS,
  PROVIDER_PREFIX_WIDTH,
  SEVEN_DAY_MS,
  TEAM_STATE_DIR,
} from "./constants.mjs";
import { buildContextUsageView } from "./context-monitor.mjs";
import { getTerminalColumns, tierBar, tierDimBar } from "./terminal.mjs";
import {
  clampPercent,
  fitText,
  formatPercentCell,
  formatPlaceholderPercentCell,
  formatResetRemaining,
  formatResetRemainingDayHour,
  formatTimeCell,
  formatTimeCellDH,
  padAnsiRight,
  readJson,
  stripAnsi,
  truncateAnsi,
} from "./utils.mjs";

// ============================================================================
// tfx-multi 상태 행 생성 (v2.2 HUD 통합)
// ============================================================================
export function getTeamRow(currentTier, stateDir = TEAM_STATE_DIR) {
  let latestPath = null;
  let latestMtime = Date.now() - 24 * 60 * 60 * 1000;
  try {
    for (const name of readdirSync(stateDir)) {
      if (!/^team-state-.+\.json$/.test(name)) continue;
      const path = join(stateDir, name);
      try {
        const stat = statSync(path);
        if (stat.isFile() && stat.mtimeMs > latestMtime) {
          latestPath = path;
          latestMtime = stat.mtimeMs;
        }
      } catch {
        // 세션 종료 중 사라진 파일은 제외한다.
      }
    }
  } catch {
    return null;
  }
  const teamState = latestPath ? readJson(latestPath, null) : null;
  if (!teamState?.sessionName) return null;

  const workers = (teamState.members || []).filter((m) => m.role === "worker");
  if (!workers.length) return null;

  const tasks = teamState.tasks || [];
  const completed = tasks.filter((t) => t.status === "completed").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const total = tasks.length || workers.length;

  // 경과 시간 (80col 이상에서만 표시)
  const elapsed =
    teamState.startedAt && (currentTier === "full" || currentTier === "compact")
      ? `${Math.round((Date.now() - teamState.startedAt) / 60000)}m`
      : "";

  // CLI 브랜드: 단일문자 + ANSI 색상 (x=codex, g=gemini, c=claude)
  const cliTag = (cli) =>
    cli === "codex"
      ? bold(codexWhite("x"))
      : cli === "gemini"
        ? bold(geminiBlue("g"))
        : bold(claudeOrange("c"));
  // 멤버 상태: 태그 + 상태기호 (60col 이상)
  const memberIcons =
    currentTier === "full" ||
    currentTier === "compact" ||
    currentTier === "minimal"
      ? workers
          .map((m) => {
            const task = tasks.find((t) => t.owner === m.name);
            const status =
              task?.status === "completed"
                ? green("\u2713")
                : task?.status === "in_progress"
                  ? yellow("\u22EF")
                  : task?.status === "failed"
                    ? red("\u2717")
                    : dim("\u25CC");
            return `${cliTag(m.cli)}${status}`;
          })
          .join(" ")
      : "";

  // 진행 텍스트
  const doneText =
    failed > 0
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
  const cols = getTerminalColumns() || 120;
  const rightRows = rows.filter(
    (row) => stripAnsi(String(row.right || "")).trim().length > 0,
  );
  const rawLeftWidth = rightRows.reduce(
    (max, row) => Math.max(max, stripAnsi(row.left).length),
    0,
  );
  return rows.map((row) => {
    const prefix = padAnsiRight(row.prefix, PROVIDER_PREFIX_WIDTH);
    const hasRight = stripAnsi(String(row.right || "")).trim().length > 0;
    if (!hasRight) {
      return truncateAnsi(`${prefix} ${row.left}`, cols);
    }
    // 자기 left 대비 패딩 상한: 최대 2칸까지만 패딩 (과도한 공백 방지)
    const ownLen = stripAnsi(row.left).length;
    const effectiveWidth = Math.min(rawLeftWidth, ownLen + 2);
    const left = padAnsiRight(row.left, effectiveWidth);
    // 우선순위 기반 truncate: right 먼저 축소, 그래도 넘치면 left 축소
    // prefix(PROVIDER_PREFIX_WIDTH) + " "(1) + left(effectiveWidth) + " | "(3) + right
    const fixedWidth = PROVIDER_PREFIX_WIDTH + 1 + effectiveWidth + 3;
    const availableForRight = cols - fixedWidth;
    if (availableForRight <= 0) {
      return truncateAnsi(`${prefix} ${left}`, cols);
    }
    const rightVisible = stripAnsi(row.right).length;
    const right =
      rightVisible <= availableForRight
        ? row.right
        : truncateAnsi(row.right, availableForRight);
    return `${prefix} ${left} ${dim("|")} ${right}`;
  });
}

// ============================================================================
// micro tier: 모든 프로바이더를 1줄로 압축
// ============================================================================
export function getMicroLine(
  contextView,
  claudeUsage,
  codexBuckets,
  antigravityReady,
  options = {},
) {
  const { showCodex = true, showGemini = true } = options;
  const ctxView = contextView || buildContextUsageView({});
  // Claude 5h/1w
  const cF =
    claudeUsage?.fiveHourPercent != null
      ? clampPercent(claudeUsage.fiveHourPercent)
      : null;
  const cW =
    claudeUsage?.weeklyPercent != null
      ? clampPercent(claudeUsage.weeklyPercent)
      : null;
  const cVal =
    claudeUsage != null
      ? `${cF != null ? colorByProvider(cF, `${cF}`, claudeOrange) : dim("--")}${dim("/")}${cW != null ? colorByProvider(cW, `${cW}`, claudeOrange) : dim("--")}`
      : dim("--/--");

  // Codex 5h/1w
  let xVal = dim("--/--");
  if (codexBuckets) {
    const mb = codexBuckets.codex || codexBuckets[Object.keys(codexBuckets)[0]];
    if (mb) {
      const xF =
        mb.primary?.used_percent != null
          ? clampPercent(mb.primary.used_percent)
          : null;
      const xW =
        mb.secondary?.used_percent != null
          ? clampPercent(mb.secondary.used_percent)
          : null;
      xVal = `${xF != null ? colorByProvider(xF, `${xF}`, codexWhite) : dim("--")}${dim("/")}${xW != null ? colorByProvider(xW, `${xW}`, codexWhite) : dim("--")}`;
    }
  }

  const cols = getTerminalColumns() || 120;
  // 세그먼트를 모아 join 한다. 차단된 프로바이더를 뺄 때 공백이 겹치지 않는다.
  const segments = [`${bold(claudeOrange("c"))}${dim(":")}${cVal}`];
  if (showCodex) {
    segments.push(`${bold(codexWhite("x"))}${dim(":")}${xVal}`);
  }
  if (showGemini) {
    segments.push(
      `${bold(geminiBlue(antigravityReady ? "a" : "g"))}${dim(":")}${antigravityReady ? "agy" : dim("--")}`,
    );
  }
  segments.push(`${dim("CTX:")}${contextPercentText(ctxView)}`);
  return truncateAnsi(segments.join(" "), cols);
}

// context 는 토큰 수 대신 사용률만 보여 준다.
function contextPercentText(ctxView) {
  const text = ctxView.display === "--" ? "--" : `${ctxView.percent}%`;
  return colorByPercent(ctxView.percent, text);
}

// ============================================================================
// Claude 행 렌더러
// ============================================================================
export function getClaudeRows(currentTier, contextView, claudeUsage) {
  const ctxView = contextView || buildContextUsageView({});
  const prefix = `${bold(claudeOrange("c"))}:`;
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

  const fStr =
    hasData && fiveHourPercent != null
      ? colorByProvider(
          fiveHourPercent,
          formatPercentCell(fiveHourPercent),
          claudeOrange,
        )
      : dim(formatPlaceholderPercentCell());
  const wStr =
    hasData && weeklyPercent != null
      ? colorByProvider(
          weeklyPercent,
          formatPercentCell(weeklyPercent),
          claudeOrange,
        )
      : dim(formatPlaceholderPercentCell());
  const fBar =
    hasData && fiveHourPercent != null
      ? tierBar(currentTier, fiveHourPercent, CLAUDE_ORANGE)
      : tierDimBar(currentTier);
  const wBar =
    hasData && weeklyPercent != null
      ? tierBar(currentTier, weeklyPercent, CLAUDE_ORANGE)
      : tierDimBar(currentTier);
  const fTime = formatTimeCell(fiveHourReset);
  const wTime = formatTimeCellDH(weeklyReset);

  if (currentTier === "nano" || currentTier === "micro") {
    const fShort =
      hasData && fiveHourPercent != null
        ? colorByProvider(fiveHourPercent, `${fiveHourPercent}%`, claudeOrange)
        : dim("--");
    const wShort =
      hasData && weeklyPercent != null
        ? colorByProvider(weeklyPercent, `${weeklyPercent}%`, claudeOrange)
        : dim("--");
    const quotaSection = `${fShort}${dim("/")}${wShort}`;
    return [{ prefix, left: quotaSection, right: "" }];
  }

  if (currentTier === "minimal") {
    const staleTag = claudeUsage?.stale ? ` ${dim("[stale]")}` : "";
    const quotaSection = `${dim("5h:")}${fStr} ${dim("1w:")}${wStr}${staleTag}`;
    const right = `${dim("CTX:")}${contextPercentText(ctxView)}`;
    return [{ prefix, left: quotaSection, right }];
  }

  if (currentTier === "compact") {
    const staleTag = claudeUsage?.stale ? ` ${dim("[stale]")}` : "";
    const quotaSection = `${dim("5h:")}${fStr} ${dim(fTime)} ${dim("1w:")}${wStr} ${dim(wTime)}${staleTag}`;
    const warning = ctxView.warningTag
      ? ` ${dim("|")} ${yellow(ctxView.warningTag)}`
      : "";
    const contextSection = `${dim("CTX:")}${contextPercentText(ctxView)}${warning}`;
    return [{ prefix, left: quotaSection, right: contextSection }];
  }

  // full tier (>= 120 cols)
  const staleTag = claudeUsage?.stale ? ` ${dim("[stale]")}` : "";
  const quotaSection = `${dim("5h:")}${fBar}${fStr} ${dim(fTime)} ${dim("1w:")}${wBar}${wStr} ${dim(wTime)}${staleTag}`;
  const warning = ctxView.warningTag
    ? ` ${dim("|")} ${yellow(ctxView.warningTag)}`
    : "";
  const contextSection = `${dim("CTX:")}${contextPercentText(ctxView)}${warning}`;
  return [{ prefix, left: quotaSection, right: contextSection }];
}

// ============================================================================
// 계정 라벨 + 범용 프로바이더 행 렌더러
// ============================================================================
export function getAccountLabel(
  provider,
  accountsConfig,
  accountsState,
  codexEmail,
) {
  const providerConfig = accountsConfig?.providers?.[provider] || [];
  const providerState = accountsState?.providers?.[provider] || {};
  const lastId = providerState.last_selected_id;
  const picked = providerConfig.find((a) => a.id === lastId) ||
    providerConfig[0] || { id: `${provider}-main`, label: provider };
  let label = picked.label || picked.id;
  if (codexEmail) label = codexEmail;
  if (label.includes("@")) label = label.split("@")[0];
  return label;
}

export function getProviderRow(
  currentTier,
  provider,
  marker,
  markerColor,
  accountsConfig,
  accountsState,
  realQuota,
  codexEmail,
) {
  const accountLabel = fitText(
    getAccountLabel(provider, accountsConfig, accountsState, codexEmail),
    ACCOUNT_LABEL_WIDTH,
  );

  const prefix = `${bold(markerColor(marker))}:`;
  if (provider === "antigravity" || provider === "gemini") {
    return {
      prefix,
      left:
        provider === "antigravity"
          ? markerColor(realQuota?.currentAbbrev || "agy")
          : dim("--"),
      right: accountLabel ? markerColor(accountLabel) : "",
    };
  }
  const provAnsi = CODEX_WHITE;
  const provFn = codexWhite;
  let quotaSection;

  if (currentTier === "nano" || currentTier === "micro") {
    const minPrefix = `${bold(markerColor(`${marker}`))}:`;
    if (realQuota?.type === "codex") {
      const main =
        realQuota.buckets.codex ||
        realQuota.buckets[Object.keys(realQuota.buckets)[0]];
      if (main) {
        const fiveP =
          main.primary?.used_percent != null
            ? clampPercent(main.primary.used_percent)
            : null;
        const weekP =
          main.secondary?.used_percent != null
            ? clampPercent(main.secondary.used_percent)
            : null;
        const fCellN =
          fiveP != null
            ? colorByProvider(fiveP, `${fiveP}%`, provFn)
            : dim("--%");
        const wCellN =
          weekP != null
            ? colorByProvider(weekP, `${weekP}%`, provFn)
            : dim("--%");
        return {
          prefix: minPrefix,
          left: `${fCellN}${dim("/")}${wCellN}`,
          right: "",
        };
      }
    }
    return { prefix: minPrefix, left: dim("--/--"), right: "" };
  }

  if (currentTier === "minimal") {
    if (realQuota?.type === "codex") {
      const main =
        realQuota.buckets.codex ||
        realQuota.buckets[Object.keys(realQuota.buckets)[0]];
      if (main) {
        const fiveP =
          main.primary?.used_percent != null
            ? clampPercent(main.primary.used_percent)
            : null;
        const weekP =
          main.secondary?.used_percent != null
            ? clampPercent(main.secondary.used_percent)
            : null;
        const fCell =
          fiveP != null
            ? colorByProvider(fiveP, formatPercentCell(fiveP), provFn)
            : dim(formatPlaceholderPercentCell());
        const wCell =
          weekP != null
            ? colorByProvider(weekP, formatPercentCell(weekP), provFn)
            : dim(formatPlaceholderPercentCell());
        quotaSection = `${dim("5h:")}${fCell} ${dim("1w:")}${wCell}`;
      }
    }
    if (!quotaSection) {
      quotaSection = `${dim("5h:")}${dim(formatPlaceholderPercentCell())} ${dim("1w:")}${dim(formatPlaceholderPercentCell())}`;
    }
    return {
      prefix,
      left: quotaSection,
      right: accountLabel ? markerColor(accountLabel) : "",
    };
  }

  if (currentTier === "compact") {
    if (realQuota?.type === "codex") {
      const main =
        realQuota.buckets.codex ||
        realQuota.buckets[Object.keys(realQuota.buckets)[0]];
      if (main) {
        const fiveP =
          main.primary?.used_percent != null
            ? clampPercent(main.primary.used_percent)
            : null;
        const weekP =
          main.secondary?.used_percent != null
            ? clampPercent(main.secondary.used_percent)
            : null;
        const fCell =
          fiveP != null
            ? colorByProvider(fiveP, formatPercentCell(fiveP), provFn)
            : dim(formatPlaceholderPercentCell());
        const wCell =
          weekP != null
            ? colorByProvider(weekP, formatPercentCell(weekP), provFn)
            : dim(formatPlaceholderPercentCell());
        const fiveReset =
          formatResetRemaining(main.primary?.resets_at) || "n/a";
        const weekReset =
          formatResetRemainingDayHour(main.secondary?.resets_at) || "n/a";
        quotaSection = `${dim("5h:")}${fCell} ${dim(formatTimeCell(fiveReset))} ${dim("1w:")}${wCell} ${dim(formatTimeCellDH(weekReset))}`;
        if (main.mixedWindows) quotaSection += dim("*");
      }
    }
    if (!quotaSection) {
      quotaSection = `${dim("5h:")}${dim(formatPlaceholderPercentCell())} ${dim(formatTimeCell("n/a"))} ${dim("1w:")}${dim(formatPlaceholderPercentCell())} ${dim(formatTimeCellDH("--d--h"))}`;
    }
    const compactRight = [accountLabel ? markerColor(accountLabel) : ""]
      .filter(Boolean)
      .join(" ");
    return { prefix, left: quotaSection, right: compactRight };
  }

  // full tier

  if (realQuota?.type === "codex") {
    const main =
      realQuota.buckets.codex ||
      realQuota.buckets[Object.keys(realQuota.buckets)[0]];
    if (main) {
      const fiveP =
        main.primary?.used_percent != null
          ? clampPercent(main.primary.used_percent)
          : null;
      const weekP =
        main.secondary?.used_percent != null
          ? clampPercent(main.secondary.used_percent)
          : null;
      const fiveReset = formatResetRemaining(main.primary?.resets_at) || "n/a";
      const weekReset =
        formatResetRemainingDayHour(main.secondary?.resets_at) || "n/a";
      const fCell =
        fiveP != null
          ? colorByProvider(fiveP, formatPercentCell(fiveP), provFn)
          : dim(formatPlaceholderPercentCell());
      const wCell =
        weekP != null
          ? colorByProvider(weekP, formatPercentCell(weekP), provFn)
          : dim(formatPlaceholderPercentCell());
      const fBar =
        fiveP != null
          ? tierBar(currentTier, fiveP, provAnsi)
          : tierDimBar(currentTier);
      const wBar =
        weekP != null
          ? tierBar(currentTier, weekP, provAnsi)
          : tierDimBar(currentTier);
      quotaSection =
        `${dim("5h:")}${fBar}${fCell} ` +
        `${dim(formatTimeCell(fiveReset))} ` +
        `${dim("1w:")}${wBar}${wCell} ` +
        `${dim(formatTimeCellDH(weekReset))}`;
      if (main.mixedWindows) quotaSection += dim("*");
    }
  }

  // 폴백
  if (!quotaSection) {
    quotaSection = `${dim("5h:")}${tierDimBar(currentTier)}${dim(formatPlaceholderPercentCell())} ${dim(formatTimeCell("n/a"))} ${dim("1w:")}${tierDimBar(currentTier)}${dim(formatPlaceholderPercentCell())} ${dim(formatTimeCellDH("--d--h"))}`;
  }

  const accountSection = `${markerColor(accountLabel)}`;
  return {
    prefix,
    left: quotaSection,
    right: accountSection,
  };
}
