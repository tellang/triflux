// HUD CLI 표시 정책 판정 (순수 함수)
//
// machine profile 의 TFX_DISABLE_CODEX / TFX_DISABLE_ANTIGRAVITY 를 읽어서 HUD 가
// 어떤 프로바이더 행을 그릴지 정한다. 판독 자체는 scripts/lib/machine-profile.mjs
// 가 단일 정본이고, 이 모듈은 그 결과를 HUD 표시 결정으로 접기만 한다.
//
// 상대 경로 import 를 고정하는 이유: setup 이 hud/** 를 ~/.claude/hud/ 로,
// scripts/lib/* 를 ~/.claude/scripts/lib/ 로 각각 동기화한다. 그래서 설치본에서도
// ../scripts/lib/ 가 repo 와 같은 파일을 가리킨다. packages/core 와
// packages/triflux 미러도 같은 상대 레이아웃이다.
//
// fail-open 원칙: HUD 는 statusline 이라 어떤 예외에서도 죽으면 안 된다. 정책
// 판독이 실패하면 전부 표시하는 쪽으로 돌아간다.

import { resolveCliPolicy } from "../scripts/lib/machine-profile.mjs";

/**
 * HUD 가 codex / antigravity 행을 그릴 수 있는지 판정한다.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{
 *   policy?: ReturnType<typeof resolveCliPolicy>|null,
 *   resolve?: (env: NodeJS.ProcessEnv, opts: object) => ReturnType<typeof resolveCliPolicy>,
 *   profile?: object,
 *   platform?: string,
 *   home?: string,
 * }} [opts] policy 는 이미 계산한 정책 주입, resolve 는 테스트용 판독 시임이다.
 * @returns {{ showCodex: boolean, antigravityAllowed: boolean, policy: object|null }}
 */
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

/**
 * antigravity / gemini 슬롯 행을 그릴지 판정한다.
 *
 * antigravity 가 허용이면 기존 동작 그대로 항상 그린다. 정책으로 꺼졌을 때만
 * gemini 폴백 정보가 하나라도 있는지 보고, 전부 비어 있으면 행을 생략한다.
 *
 * @param {{
 *   antigravityAllowed?: boolean,
 *   antigravityReady?: boolean,
 *   geminiEmail?: unknown,
 *   geminiBucket?: unknown,
 *   geminiSession?: unknown,
 * }} [args]
 * @returns {boolean}
 */
export function shouldRenderGeminiFallbackRow({
  antigravityAllowed = true,
  antigravityReady = false,
  geminiEmail = null,
  geminiBucket = null,
  geminiSession = null,
} = {}) {
  if (antigravityAllowed || antigravityReady) return true;
  return Boolean(geminiEmail || geminiBucket || geminiSession);
}
