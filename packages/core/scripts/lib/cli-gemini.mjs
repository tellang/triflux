// cli-gemini.mjs — legacy Gemini adapter alias.
// The public "gemini" label remains accepted, but the executable plan is AGY.

import * as agyAdapter from "./cli-agy.mjs";

export const id = "gemini";
export const cliType = "antigravity";
export const command = "agy";

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
  return agyAdapter.plan({
    agent: agent === "gemini" ? "antigravity" : agent,
    prompt,
    mcpProfile,
    timeoutSec,
    contextFile,
  });
}

export function describe() {
  return {
    id,
    cliType,
    command,
    aliases: ["gemini"],
    agents: ["gemini", "designer", "writer", "antigravity", "agy"],
  };
}
