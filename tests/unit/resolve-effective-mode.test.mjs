// tests/unit/resolve-effective-mode.test.mjs — pure fallback 분기 검증 (#114)

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  ensureTmuxOrExit,
  normalizeTeammateMode,
  resolveEffectiveMode,
} from "../../hub/team/cli/services/runtime-mode.mjs";

const withTTY = {
  hasWt: () => true,
  hasWtSession: () => true,
  isTTY: true,
  env: {},
};
const withoutTTY = { ...withTTY, isTTY: false };

test("wt + wt.exe 없음 → in-process 로 fallback", () => {
  const { mode, warnings } = resolveEffectiveMode("wt", {
    ...withTTY,
    hasWt: () => false,
  });
  assert.equal(mode, "in-process");
  assert.match(warnings.join("|"), /wt\.exe 미발견/);
});

test("wt + WT_SESSION 없음 → in-process 로 fallback", () => {
  const { mode, warnings } = resolveEffectiveMode("wt", {
    ...withTTY,
    hasWt: () => true,
    hasWtSession: () => false,
  });
  assert.equal(mode, "in-process");
  assert.match(warnings.join("|"), /WT_SESSION 미감지/);
});

test("in-process + non-TTY → headless 로 fallback (#114)", () => {
  const { mode, warnings } = resolveEffectiveMode("in-process", withoutTTY);
  assert.equal(mode, "headless");
  assert.match(warnings.join("|"), /#114/);
});

test("in-process + non-TTY + TFX_FORCE_IN_PROCESS=1 → in-process 유지", () => {
  const { mode, warnings } = resolveEffectiveMode("in-process", {
    ...withoutTTY,
    env: { TFX_FORCE_IN_PROCESS: "1" },
  });
  assert.equal(mode, "in-process");
  assert.equal(warnings.length, 0);
});

test("in-process + TTY → in-process 유지", () => {
  const { mode, warnings } = resolveEffectiveMode("in-process", withTTY);
  assert.equal(mode, "in-process");
  assert.equal(warnings.length, 0);
});

test("headless → non-TTY 에도 그대로 headless", () => {
  const { mode, warnings } = resolveEffectiveMode("headless", withoutTTY);
  assert.equal(mode, "headless");
  assert.equal(warnings.length, 0);
});

test("combined: wt + wt.exe 없음 + non-TTY → headless (2단계 fallback)", () => {
  const { mode, warnings } = resolveEffectiveMode("wt", {
    ...withoutTTY,
    hasWt: () => false,
  });
  assert.equal(mode, "headless");
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /wt\.exe 미발견/);
  assert.match(warnings[1], /#114/);
});

test("darwin auto는 감지 결과가 psmux여도 psmux 경로를 배제한다", () => {
  assert.equal(
    normalizeTeammateMode("auto", {
      platform: "darwin",
      env: {},
      detectMultiplexer: () => "psmux",
    }),
    "in-process",
  );
});

test("linux explicit wt/psmux는 in-process로 정규화한다", () => {
  const deps = {
    platform: "linux",
    env: {},
    detectMultiplexer: () => null,
  };
  assert.equal(normalizeTeammateMode("wt", deps), "in-process");
  assert.equal(normalizeTeammateMode("psmux", deps), "in-process");
});

test("win32 psmux 정책은 기존 identity를 유지한다", () => {
  assert.equal(
    normalizeTeammateMode("psmux", {
      platform: "win32",
      env: {},
      detectMultiplexer: () => "psmux",
    }),
    "psmux",
  );
});

test("darwin ensureTmuxOrExit는 psmux를 tmux 대체로 인정하지 않는다", () => {
  assert.throws(
    () =>
      ensureTmuxOrExit({
        platform: "darwin",
        detectMultiplexer: () => "psmux",
      }),
    (error) => error?.code === "TMUX_REQUIRED",
  );
});

test("win32 ensureTmuxOrExit는 psmux를 허용한다", () => {
  assert.equal(
    ensureTmuxOrExit({
      platform: "win32",
      detectMultiplexer: () => "psmux",
    }),
    "psmux",
  );
});
