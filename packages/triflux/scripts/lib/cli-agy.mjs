// cli-agy.mjs — Antigravity (agy) CLI adapter (Phase 0 PoC).
//
// 책임: agy 1.1.27 부터 --print 는 값(프롬프트)이 필수이고 stdin 프롬프트는 거부되므로
// plan() 은 프롬프트를 args 의 --print 값으로 넣고 stdinMode="argv" 를 돌려준다.
// --print 뒤에 다른 플래그가 오면 그 플래그를 프롬프트로 삼키므로 항상 마지막에 둔다.
//
// 출처: scripts/tfx-route.sh route_agent() L1052-L1059, run_codex_exec() L2036-L2046.
//        .claude/rules/tfx-update-logic.md Antigravity CLI 1.0.0 정밀 sanity matrix.
// timeoutSec은 lane 예상 소요 시간(advisory)이다. hard ceiling 집행은 Bash route가 소유한다.

import { resolveGeminiModel, resolveGeminiProfileForPurpose } from "./gemini-profiles.mjs";

export const id = "agy";
export const cliType = "antigravity";
export const command = "agy";

// #310: agent-map.json normalizes upstream callers to antigravity,
// but this adapter also accepts the direct `agy` route for compatibility.
const AGENT_PROFILES = {
  antigravity: {
    profile: "agy_v1",
    timeoutSec: 900,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "docs",
  },
  agy: {
    profile: "agy_v1",
    timeoutSec: 900,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "docs",
  },
};

const DEFAULT_PROFILE = AGENT_PROFILES.antigravity;

export function plan({
  agent,
  prompt = "",
  mcpProfile = "auto",
  timeoutSec,
  contextFile,
  geminiProfilesPath,
} = {}) {
  if (!agent) {
    throw new Error("[cli-agy] agent required");
  }
  const cfg = AGENT_PROFILES[agent] ?? DEFAULT_PROFILE;
  const effectiveTimeoutSec =
    Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : cfg.timeoutSec;
  return {
    command,
    profile: cfg.profile,
    effort: cfg.profile,
    // effort 는 역할별 SSOT(gemini-profiles.mjs): designer → High, writer → Medium ...
    geminiProfile: resolveGeminiProfileForPurpose(agent),
    model: resolveGeminiModel(resolveGeminiProfileForPurpose(agent), {
      profilesPath: geminiProfilesPath,
    }),
    args: [
      "--dangerously-skip-permissions",
      "--model",
      resolveGeminiModel(resolveGeminiProfileForPurpose(agent), {
        profilesPath: geminiProfilesPath,
      }),
      "--print",
      prompt,
    ],
    stdinMode: "argv",
    timeoutMs: effectiveTimeoutSec * 1000,
    runMode: cfg.runMode,
    opusOversight: cfg.opusOversight,
    mcpProfile: mcpProfile === "auto" ? cfg.mcpHint : mcpProfile,
    promptLength: prompt.length,
    contextFile: contextFile || null,
  };
}

export function describe() {
  return { id, cliType, command, agents: Object.keys(AGENT_PROFILES) };
}
