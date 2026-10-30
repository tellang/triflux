import { buildContextUsageView } from "./context-monitor.mjs";
import { clampPercent, formatTokenCount } from "./utils.mjs";

export async function sessionStatus(stdin, env = process.env) {
  let jev = "Jev ?";
  try {
    const { isJevEnabled } = await import("../hub/lib/jev-addon.mjs");
    jev = isJevEnabled({ env }) ? "Jev ON" : "Jev OFF";
  } catch {
    // 설정을 판정하지 못한 것은 런타임 호출 실패의 증거가 아니다.
  }
  const window = stdin?.context_window;
  const view = buildContextUsageView(stdin);
  let remaining = "미확인";
  const usageValues = Object.entries(window?.current_usage || {})
    .filter(([key]) =>
      [
        "total_tokens",
        "input_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
      ].includes(key),
    )
    .map(([, value]) => value);
  const knownZero =
    usageValues.length > 0 &&
    usageValues.every((value) => value === 0) &&
    Number.isFinite(window?.context_window_size) &&
    window.context_window_size > 0;
  if (knownZero) {
    remaining = `${formatTokenCount(window.context_window_size).replace("K", "k")} 남음`;
  } else if (view.source === "stdin.tokens") {
    remaining = `${formatTokenCount(Math.max(0, view.limitTokens - view.usedTokens)).replace("K", "k")} 남음`;
  } else {
    const value =
      window?.remaining_percentage ??
      (window?.used_percentage == null ? null : 100 - window.used_percentage);
    if (typeof value === "number" && Number.isFinite(value))
      remaining = `${clampPercent(value)}% 남음`;
  }
  return `${jev} | 문맥 ${remaining}`;
}
