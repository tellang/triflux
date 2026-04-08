import {
  access,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_STATE_DIR = join(process.cwd(), ".tfx", "state");

function stateFilePath(stateDir, skillName) {
  return join(stateDir, `${skillName}-active.json`);
}

function assertValidSkillName(skillName) {
  if (
    skillName.includes("/") ||
    skillName.includes("\\") ||
    skillName.includes("..")
  ) {
    throw new Error(`Invalid skill name: ${skillName}`);
  }
}

/**
 * Activate a skill by writing its state file.
 * Throws if the skill is already active.
 *
 * @param {string} skillName
 * @param {{ stateDir?: string }} options
 */
export async function activateSkill(
  skillName,
  { stateDir = DEFAULT_STATE_DIR } = {},
) {
  assertValidSkillName(skillName);
  await mkdir(stateDir, { recursive: true });

  const filePath = stateFilePath(stateDir, skillName);
  const lockPath = `${filePath}.lock`;
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let lockHandle;
  try {
    lockHandle = await open(lockPath, "wx");
    try {
      await access(filePath);
      throw new Error(`Skill already active: ${skillName}`);
    } catch (error) {
      if (error?.message === `Skill already active: ${skillName}`) {
        throw error;
      }
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    const state = { skillName, pid: process.pid, activatedAt: Date.now() };
    await writeFile(tmpPath, JSON.stringify(state), "utf8");
    await rename(tmpPath, filePath);
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {});
    if (lockHandle) {
      await lockHandle.close().catch(() => {});
    }
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

/**
 * Deactivate a skill by removing its state file.
 * Does not throw if the file does not exist.
 *
 * @param {string} skillName
 * @param {{ stateDir?: string }} options
 */
export async function deactivateSkill(
  skillName,
  { stateDir = DEFAULT_STATE_DIR } = {},
) {
  const filePath = stateFilePath(stateDir, skillName);
  try {
    await rm(filePath, { force: true });
  } catch {
    // ignore
  }
}

/**
 * Return all currently active skills by scanning *-active.json files.
 *
 * @param {{ stateDir?: string }} options
 * @returns {Promise<Array<{ skillName: string, pid: number, activatedAt: number }>>}
 */
export async function getActiveSkills({ stateDir = DEFAULT_STATE_DIR } = {}) {
  let entries;
  try {
    entries = await readdir(stateDir);
  } catch {
    return [];
  }

  const results = [];
  for (const entry of entries) {
    if (!entry.endsWith("-active.json")) continue;
    try {
      const raw = await readFile(join(stateDir, entry), "utf8");
      results.push(JSON.parse(raw));
    } catch {
      // skip malformed files
    }
  }
  return results;
}

/**
 * Remove state files for skills whose processes are no longer alive.
 *
 * @param {{ stateDir?: string }} options
 * @returns {Promise<string[]>} list of pruned skill names
 */
export async function pruneOrphanSkillStates({
  stateDir = DEFAULT_STATE_DIR,
} = {}) {
  const active = await getActiveSkills({ stateDir });
  const pruned = [];

  for (const { skillName, pid } of active) {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }

    if (!alive) {
      await deactivateSkill(skillName, { stateDir });
      pruned.push(skillName);
    }
  }

  return pruned;
}
