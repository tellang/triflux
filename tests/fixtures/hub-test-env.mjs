// tests/fixtures/hub-test-env.mjs — shared env guard for hub-spawning tests

export function assertHubAutoTrayDisabled(env) {
  if (env?.TFX_HUB_AUTO_TRAY !== "0") {
    throw new Error("hub-spawning tests must set TFX_HUB_AUTO_TRAY=0");
  }
  return env;
}

export function hubServerTestEnv(overrides = {}, baseEnv = process.env) {
  return assertHubAutoTrayDisabled({
    ...baseEnv,
    ...overrides,
    TFX_HUB_AUTO_TRAY: "0",
  });
}
