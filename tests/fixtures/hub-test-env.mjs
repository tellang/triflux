// tests/fixtures/hub-test-env.mjs — shared env guard for hub-spawning tests

import { ROUTE_CLI_POLICY_DEFAULTS } from "./route-cli-policy-env.mjs";

export function assertHubAutoTrayDisabled(env) {
  if (env?.TFX_HUB_AUTO_TRAY !== "0") {
    throw new Error("hub-spawning tests must set TFX_HUB_AUTO_TRAY=0");
  }
  return env;
}

export function hubServerTestEnv(overrides = {}, baseEnv = process.env) {
  return assertHubAutoTrayDisabled({
    ...baseEnv,
    // 머신 전역 CLI disable 정책을 자식 route 프로세스가 물려받지 않게 한다.
    // overrides 뒤가 아니라 앞에 두므로 호출자가 자기 값으로 덮을 수 있다.
    ...ROUTE_CLI_POLICY_DEFAULTS,
    ...overrides,
    TFX_HUB_AUTO_TRAY: "0",
  });
}
