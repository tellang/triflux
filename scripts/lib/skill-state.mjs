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
import { basename, join } from "node:path";

const DEFAULT_STATE_DIR = join(process.cwd(), ".tfx", "state");
const STOP_HOOKS = new Map();

function stateFilePath(stateDir, skillName) {
  return join(stateDir, `${skillName}-active.json`);
}

function assertValidSkillName(skillName) {
  if (basename(skillName) !== skillName) {
    throw new Error(`Invalid skill name: ${skillName}`);
  }
}

function assertValidOnStop(onStop) {
  if (onStop !== undefined && typeof onStop !== "function") {
    throw new TypeError("onStop must be a function");
  }
}

async function readStateFile(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function rememberStopHook(filePath, onStop) {
  if (typeof onStop === "function") {
    STOP_HOOKS.set(filePath, onStop);
    return;
  }
  STOP_HOOKS.delete(filePath);
}

function logStopHookWarning(message, error) {
  if (error) {
    console.warn(message, error);
    return;
  }
  console.warn(message);
}

async function runStopHook(filePath, state, onStop) {
  if (!state?.hasStopHook) {
    STOP_HOOKS.delete(filePath);
    return;
  }

  const hook = onStop ?? STOP_HOOKS.get(filePath);
  STOP_HOOKS.delete(filePath);

  if (typeof hook !== "function") {
    return;
  }

  try {
    await hook({
      skillName: state.skillName,
      filePath,
      state,
    });
  } catch (error) {
    logStopHookWarning(
      `Failed to run stop-hook for skill: ${state.skillName}`,
      error,
    );
  }
}

/**
 * Activate a skill by writing its state file.
 * Throws if the skill is already active.
 *
 * @param {string} skillName
 * @param {{ stateDir?: string, onStop?: (() => Promise<void> | void) }} options
 */
export async function activateSkill(
  skillName,
  { stateDir = DEFAULT_STATE_DIR, onStop } = {},
) {
  assertValidSkillName(skillName);
  assertValidOnStop(onStop);

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

    const state = {
      skillName,
      pid: process.pid,
      activatedAt: Date.now(),
      hasStopHook: typeof onStop === "function",
    };
    await writeFile(tmpPath, JSON.stringify(state), "utf8");
    await rename(tmpPath, filePath);
    rememberStopHook(filePath, onStop);
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
 * @param {{ stateDir?: string, onStop?: (() => Promise<void> | void) }} options
 */
export async function deactivateSkill(
  skillName,
  { stateDir = DEFAULT_STATE_DIR, onStop } = {},
) {
  assertValidOnStop(onStop);

  const filePath = stateFilePath(stateDir, skillName);
  const state = await readStateFile(filePath);

  try {
    await runStopHook(filePath, state, onStop);
  } finally {
    STOP_HOOKS.delete(filePath);
    await rm(filePath, { force: true }).catch(() => {});
  }
}

/**
 * Return all currently active skills by scanning *-active.json files.
 *
 * @param {{ stateDir?: string }} options
 * @returns {Promise<Array<{ skillName: string, pid: number, activatedAt: number, hasStopHook?: boolean }>>}
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
    const state = await readStateFile(join(stateDir, entry));
    if (state) {
      results.push(state);
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

  for (const state of active) {
    let alive = true;
    try {
      process.kill(state.pid, 0);
    } catch {
      alive = false;
    }

    if (!alive) {
      const filePath = stateFilePath(stateDir, state.skillName);
      STOP_HOOKS.delete(filePath);
      if (state.hasStopHook) {
        logStopHookWarning(
          `Skipping stop-hook for orphaned skill state: ${state.skillName}`,
        );
      }
      await rm(filePath, { force: true }).catch(() => {});
      pruned.push(state.skillName);
    }
  }

  return pruned;
}
