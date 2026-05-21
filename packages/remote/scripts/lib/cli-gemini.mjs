// cli-gemini.mjs — Gemini CLI adapter (Phase 0 PoC).
//
// 책임: Gemini 프로파일/모델/timeout 매핑. resolve_gemini_profile() 의 결과는 Phase 1 에서
// 통합한다 (Phase 0 은 라벨만 전달).
//
// 출처: scripts/tfx-route.sh route_agent() L1045-L1050.

export const id = "gemini";
export const cliType = "gemini";
export const command = "gemini";

const AGENT_PROFILES = {
  designer: {
    profile: "pro31",
    timeoutSec: 900,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "docs",
  },
  gemini: {
    profile: "pro31",
    timeoutSec: 900,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "docs",
  },
  writer: {
    profile: "flash3",
    timeoutSec: 900,
    runMode: "bg",
    opusOversight: false,
    mcpHint: "docs",
  },
};

const DEFAULT_PROFILE = AGENT_PROFILES.gemini;

export function plan({
  agent,
  prompt = "",
  mcpProfile = "auto",
  timeoutSec,
  contextFile,
} = {}) {
  if (!agent) {
    throw new Error("[cli-gemini] agent required");
  }
  const cfg = AGENT_PROFILES[agent] ?? DEFAULT_PROFILE;
  const effectiveTimeoutSec =
    Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : cfg.timeoutSec;
  return {
    command,
    profile: cfg.profile,
    effort: cfg.profile,
    args: ["-m", cfg.profile, "-y", "--prompt"],
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
