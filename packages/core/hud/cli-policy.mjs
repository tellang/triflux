// setup이 hud/**를 ~/.claude/hud/로, scripts/lib/*를 ~/.claude/scripts/lib/로
// 동기화하고 packages/core, packages/triflux 미러도 같은 상대 레이아웃이라 상대 경로 import를 고정한다.
// statusline은 예외로 죽으면 안 되므로 판독 실패 시 전부 표시로 돌아간다.

import { resolveCliPolicy } from "../scripts/lib/machine-profile.mjs";

export function resolveHudCliVisibility(env = process.env, opts = {}) {
  try {
    const resolver =
      typeof opts.resolve === "function" ? opts.resolve : resolveCliPolicy;
    const policy = opts.policy ?? resolver(env, opts);
    return {
      showCodex: policy?.codexDisabled !== true,
      antigravityAllowed: policy?.antigravityDisabled !== true,
      policy: policy ?? null,
    };
  } catch {
    return { showCodex: true, antigravityAllowed: true, policy: null };
  }
}
