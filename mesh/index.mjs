import { readdirSync } from "node:fs";
import { join } from "node:path";

export { createMeshBudget } from "./mesh-budget.mjs";
export { createHeartbeatMonitor } from "./mesh-heartbeat.mjs";
export {
  createMessage,
  deserialize,
  MSG_TYPES,
  serialize,
  validate,
} from "./mesh-protocol.mjs";
export { createMessageQueue } from "./mesh-queue.mjs";
export { createRegistry } from "./mesh-registry.mjs";
export { routeMessage, routeOrDeadLetter } from "./mesh-router.mjs";

/**
 * Loads skills assigned to a specific agent from a skills directory.
 * Reuses the same directory-scan approach as generateSkillDocs().
 *
 * @param {string} agentId - The agent identifier
 * @param {string} skillsDir - Path to the skills directory
 * @returns {Promise<string[]>} Array of skill names available to this agent
 */
export async function loadSkillsForAgent(agentId, skillsDir) {
  if (!agentId || typeof agentId !== "string") {
    throw new TypeError("agentId must be a non-empty string");
  }
  if (!skillsDir || typeof skillsDir !== "string") {
    throw new TypeError("skillsDir must be a non-empty string");
  }

  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillName = entry.name;
    const skillPath = join(skillsDir, skillName, "SKILL.md");
    let skillContent = null;
    try {
      const { readFileSync } = await import("node:fs");
      skillContent = readFileSync(skillPath, "utf8");
    } catch {
      // Skill has no SKILL.md — include it anyway
    }

    // If SKILL.md mentions the agentId or no agent restriction, include it
    const isRestricted = skillContent
      ? /^agents?\s*:/im.test(skillContent)
      : false;

    if (!isRestricted) {
      skills.push(skillName);
      continue;
    }

    if (skillContent?.includes(agentId)) {
      skills.push(skillName);
    }
  }

  return skills;
}
