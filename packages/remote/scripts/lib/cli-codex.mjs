// cli-codex.mjs — Codex CLI adapter (Phase 0 PoC).
//
// 책임: agent 이름과 입력 파라미터를 받아 Codex 실행 계획(profile/effort/timeout/runMode)을
// 산출한다. 실제 spawn 은 Phase 1 에서 이관된다 (현재는 tfx-route.sh 가 수행).
//
// 진입점: tfx-route.mjs → selectAdapter("codex") → plan({...}).
// 출처: agent-route-policy.mjs 의 canonical Codex role policy.
// timeoutSec은 lane 예상 소요 시간(advisory)이다. hard ceiling 집행은 Bash route가 소유한다.

export const id = "codex";
export const cliType = "codex";
export const command = "codex";

import {
  CODEX_AGENT_POLICY,
  resolveCodexAgentPolicy,
  resolveCodexAgentProfile,
  resolveNestedCodexAgentProfile,
} from "./agent-route-policy.mjs";

// Compatibility re-exports for launchers which historically imported these
// helpers from this adapter. The policy module owns the semantics.
export { resolveCodexAgentProfile, resolveNestedCodexAgentProfile };

export function plan({
  agent,
  prompt = "",
  mcpProfile = "auto",
  timeoutSec,
  contextFile,
  profileOverride = "auto",
  retryProfile = null,
  nested = false,
} = {}) {
  if (!agent) {
    throw new Error("[cli-codex] agent required");
  }
  const cfg = resolveCodexAgentPolicy(agent);
  const profile = resolveCodexAgentProfile(agent, {
    profileOverride,
    retryProfile,
    nested,
  });
  const effectiveTimeoutSec =
    Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : cfg.timeoutSec;
  return {
    command,
    subcommand: cfg.subcommand ?? "exec",
    profile,
    effort: profile,
    timeoutMs: effectiveTimeoutSec * 1000,
    runMode: cfg.runMode,
    opusOversight: cfg.opusOversight,
    mcpProfile: mcpProfile === "auto" ? cfg.mcpHint : mcpProfile,
    promptLength: prompt.length,
    contextFile: contextFile || null,
  };
}

export function describe() {
  return { id, cliType, command, agents: Object.keys(CODEX_AGENT_POLICY) };
}
