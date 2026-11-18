import { writeAgyContext } from "../hub/lib/agy-context.mjs";
import { buildContextUsageView } from "./context-monitor.mjs";
import { clampPercent } from "./utils.mjs";

export function recordAgyContext(stdin, env = process.env) {
  if (stdin?.product !== "antigravity") return false;
  const view = buildContextUsageView(stdin);
  if (view.source === "none") return false;
  const model = stdin.model;
  return writeAgyContext(
    {
      conversationId: stdin.conversation_id,
      usedPercentage: view.percent,
      windowSize: view.limitTokens,
      usedTokens: view.usedTokens,
      model:
        typeof model === "string"
          ? model
          : (model?.id ?? model?.display_name ?? null),
    },
    { env },
  );
}

export async function sessionStatus(stdin, env = process.env) {
  let jev = "";
  try {
    const { isJevEnabled } = await import("../hub/lib/jev-addon.mjs");
    jev = isJevEnabled({ env }) ? "j" : "";
  } catch {
    // 설정을 판정하지 못한 것은 런타임 호출 실패의 증거가 아니다.
  }
  const window = stdin?.context_window;
  const view = buildContextUsageView(stdin);
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
  const hasUsage =
    usageValues.length > 0 &&
    usageValues.every((value) => Number.isFinite(value) && value >= 0);
  const hasWindow =
    Number.isFinite(window?.context_window_size) &&
    window.context_window_size > 0;
  const knownZero = hasUsage && usageValues.every((value) => value === 0);
  let context = "ctx:--";
  if (hasWindow && hasUsage && (knownZero || view.source === "stdin.tokens")) {
    const used = knownZero ? 0 : view.usedTokens;
    context = `ctx:${clampPercent((used / window.context_window_size) * 100)}%`;
  } else if (
    !(stdin?.product === "antigravity" && window?.context_window_size === 0)
  ) {
    const used = Number.isFinite(window?.used_percentage)
      ? clampPercent(window.used_percentage)
      : Number.isFinite(window?.remaining_percentage)
        ? 100 - clampPercent(window.remaining_percentage)
        : null;
    if (used != null) context = `ctx:${used}%`;
  }
  return { context, jev };
}
