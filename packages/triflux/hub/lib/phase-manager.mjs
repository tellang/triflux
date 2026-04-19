import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";

/**
 * @typedef {"Research" | "Strategy" | "Execution" | "Validation"} WorkPhase
 */

/**
 * @typedef {"active" | "complete" | "failed"} PhaseStatus
 */

/**
 * @typedef {WorkPhase | "complete"} LegacyPhase
 */

/**
 * @typedef {object} PhaseRecord
 * @property {WorkPhase | "complete"} phase
 * @property {PhaseStatus} phaseStatus
 * @property {WorkPhase | null} lastPhase
 */

export const PHASE_ENUM = Object.freeze([
  "Research",
  "Strategy",
  "Execution",
  "Validation",
]);

export const PHASE_STATUS = Object.freeze(["active", "complete", "failed"]);

const PHASE_SET = new Set(PHASE_ENUM);
const PHASE_STATUS_SET = new Set(PHASE_STATUS);

/**
 * @returns {string}
 */
function getHomeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

/**
 * @param {unknown} value
 * @returns {value is WorkPhase}
 */
function isWorkPhase(value) {
  return PHASE_SET.has(String(value));
}

/**
 * @param {unknown} value
 * @returns {value is PhaseStatus}
 */
function isPhaseStatus(value) {
  return PHASE_STATUS_SET.has(String(value));
}

/**
 * @param {unknown} value
 * @returns {WorkPhase | null}
 */
function coerceWorkPhase(value) {
  const phase = coerceLegacyPhase(value);
  return phase === "complete" ? null : phase;
}

/**
 * @param {string} runId
 * @returns {{fullcycleStatePath: string, phaseStatePath: string}}
 */
function getRunPaths(runId) {
  return {
    fullcycleStatePath: join(
      process.cwd(),
      ".tfx",
      "fullcycle",
      runId,
      "state.json",
    ),
    phaseStatePath: join(process.cwd(), ".tfx", "phases", `${runId}.json`),
  };
}

/**
 * @param {string} runId
 * @returns {string | null}
 */
function resolveReadPath(runId) {
  const { fullcycleStatePath, phaseStatePath } = getRunPaths(runId);
  if (existsSync(fullcycleStatePath)) return fullcycleStatePath;
  if (existsSync(phaseStatePath)) return phaseStatePath;
  return null;
}

/**
 * @param {string} runId
 * @returns {string}
 */
function resolveWritePath(runId) {
  const { fullcycleStatePath, phaseStatePath } = getRunPaths(runId);
  const fullcycleDir = dirname(fullcycleStatePath);

  if (
    existsSync(fullcycleStatePath) ||
    existsSync(fullcycleDir) ||
    !existsSync(phaseStatePath)
  ) {
    return fullcycleStatePath;
  }

  return phaseStatePath;
}

/**
 * @param {string} tempPath
 * @param {string} targetPath
 * @returns {Promise<void>}
 */
async function safeReplaceFile(tempPath, targetPath) {
  try {
    await rename(tempPath, targetPath);
  } catch (error) {
    if (!["EEXIST", "EPERM", "EACCES"].includes(error?.code)) {
      try {
        await unlink(tempPath);
      } catch {}
      throw error;
    }

    try {
      await unlink(targetPath);
    } catch {}

    await rename(tempPath, targetPath);
  }
}

/**
 * @param {string} targetPath
 * @param {Record<string, unknown>} payload
 * @returns {Promise<void>}
 */
async function writeJsonAtomic(targetPath, payload) {
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await safeReplaceFile(tempPath, targetPath);
}

/**
 * @param {string} targetPath
 * @param {string} content
 * @returns {Promise<void>}
 */
async function writeTextAtomic(targetPath, content) {
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(tempPath, content, {
    encoding: "utf8",
    mode: 0o600,
  });
  await safeReplaceFile(tempPath, targetPath);
}

/**
 * @param {string} filePath
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function readJsonFile(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * @param {Record<string, unknown>} data
 * @returns {PhaseRecord | null}
 */
function phaseRecordFromData(data) {
  const explicitPhase = isWorkPhase(data.phase) ? data.phase : null;
  const explicitStatus = isPhaseStatus(data.phase_status)
    ? data.phase_status
    : null;
  const explicitLastPhase = isWorkPhase(data.last_phase)
    ? data.last_phase
    : null;
  const legacyLastPhase =
    explicitLastPhase || coerceWorkPhase(data.last_successful_phase);

  if (explicitPhase) {
    return {
      phase: explicitPhase,
      phaseStatus: explicitStatus || "active",
      lastPhase: legacyLastPhase,
    };
  }

  const legacyPhase = coerceLegacyPhase(data.current_phase);
  if (!legacyPhase) {
    return null;
  }

  if (legacyPhase === "complete") {
    return {
      phase: legacyLastPhase || "complete",
      phaseStatus: explicitStatus || "complete",
      lastPhase: legacyLastPhase,
    };
  }

  return {
    phase: legacyPhase,
    phaseStatus: explicitStatus || "active",
    lastPhase: legacyLastPhase,
  };
}

/**
 * @param {WorkPhase | "complete"} phase
 * @returns {string}
 */
function toLegacyPhaseName(phase) {
  return phase === "complete" ? "complete" : phase.toLowerCase();
}

/**
 * @param {Record<string, unknown>} data
 * @param {PhaseRecord} record
 * @returns {Record<string, unknown>}
 */
function applyPhaseRecord(data, record) {
  const next = {
    ...data,
    phase_status: record.phaseStatus,
    current_phase: toLegacyPhaseName(record.phase),
  };

  if (record.phase !== "complete") {
    next.phase = record.phase;
  }

  if (record.lastPhase) {
    next.last_phase = record.lastPhase;
    next.last_successful_phase = record.lastPhase.toLowerCase();
  }

  if (record.phaseStatus === "complete" && record.phase !== "complete") {
    next.last_phase = record.phase;
    next.last_successful_phase = record.phase.toLowerCase();
  }

  return next;
}

/**
 * @param {string} content
 * @returns {{lines: string[], bodyLines: string[], eol: string} | null}
 */
function parseFrontmatter(content) {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);

  if (lines[0] !== "---") {
    return null;
  }

  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex === -1) {
    return null;
  }

  return {
    lines: lines.slice(1, closingIndex),
    bodyLines: lines.slice(closingIndex + 1),
    eol,
  };
}

/**
 * @param {string[]} lines
 * @param {Record<string, string>} fields
 * @returns {string[]}
 */
function upsertFrontmatterLines(lines, fields) {
  const nextLines = [...lines];

  for (const [key, value] of Object.entries(fields)) {
    const keyPrefix = `${key}:`;
    const index = nextLines.findIndex((line) => line.startsWith(keyPrefix));

    if (index >= 0) {
      nextLines[index] = `${key}: ${value}`;
      continue;
    }

    nextLines.push(`${key}: ${value}`);
  }

  return nextLines;
}

/**
 * @param {string} content
 * @param {Record<string, string>} fields
 * @returns {string | null}
 */
function injectFrontmatterFields(content, fields) {
  const parsed = parseFrontmatter(content);
  if (!parsed) {
    return null;
  }

  const updatedLines = upsertFrontmatterLines(parsed.lines, fields);
  return ["---", ...updatedLines, "---", ...parsed.bodyLines].join(parsed.eol);
}

/**
 * @param {string} runId
 * @returns {Promise<PhaseRecord | null>}
 */
export async function readPhase(runId) {
  const statePath = resolveReadPath(runId);
  if (!statePath) {
    return null;
  }

  const data = await readJsonFile(statePath);
  if (!data) {
    return null;
  }

  const record = phaseRecordFromData(data);
  if (!record) {
    return null;
  }

  if (!isWorkPhase(data.phase)) {
    await writeJsonAtomic(statePath, applyPhaseRecord(data, record));
  }

  return record;
}

/**
 * @param {string} runId
 * @param {WorkPhase} phase
 * @param {PhaseStatus} [status="active"]
 * @returns {Promise<void>}
 */
export async function writePhase(runId, phase, status = "active") {
  if (!isWorkPhase(phase)) {
    throw new Error(`Invalid phase: ${phase}`);
  }

  if (!isPhaseStatus(status)) {
    throw new Error(`Invalid phase status: ${status}`);
  }

  const statePath = resolveWritePath(runId);
  const current = (await readJsonFile(statePath)) || {};
  const next = {
    ...current,
    run_id: current.run_id || runId,
    phase,
    phase_status: status,
    current_phase: phase.toLowerCase(),
  };

  if (status === "complete") {
    next.last_phase = phase;
    next.last_successful_phase = phase.toLowerCase();
  }

  await writeJsonAtomic(statePath, next);
}

/**
 * @param {string} runId
 * @param {string} slug
 * @returns {Promise<void>}
 */
export async function syncToGstack(runId, slug) {
  const gstackRoot = join(getHomeDir(), ".gstack");
  if (!existsSync(gstackRoot)) {
    return;
  }

  const record = await readPhase(runId);
  if (!record) {
    return;
  }

  const phase = record.phase === "complete" ? record.lastPhase : record.phase;
  if (!phase) {
    return;
  }

  const checkpointsDir = join(gstackRoot, "projects", slug, "checkpoints");
  if (!existsSync(checkpointsDir)) {
    return;
  }

  const entries = await readdir(checkpointsDir, { withFileTypes: true });
  const markdownFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(checkpointsDir, entry.name));

  if (markdownFiles.length === 0) {
    return;
  }

  const latestFile = (
    await Promise.all(
      markdownFiles.map(async (filePath) => ({
        filePath,
        stats: await stat(filePath),
      })),
    )
  ).sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs)[0]
    ?.filePath;

  if (!latestFile) {
    return;
  }

  const currentContent = await readFile(latestFile, "utf8");
  const nextContent = injectFrontmatterFields(currentContent, {
    phase,
    triflux_run_id: runId,
  });

  if (!nextContent || nextContent === currentContent) {
    return;
  }

  await writeTextAtomic(latestFile, nextContent);
}

/**
 * @param {unknown} text
 * @returns {LegacyPhase | null}
 */
export function coerceLegacyPhase(text) {
  if (text == null) {
    return null;
  }

  const value = String(text).trim();
  if (!value) {
    return null;
  }

  if (/^complete$/i.test(value)) {
    return "complete";
  }

  if (/interview|research|phase1/i.test(value)) {
    return "Research";
  }

  if (/plan|strategy|phase2/i.test(value)) {
    return "Strategy";
  }

  if (/exec|ship|phase3|phase4/i.test(value)) {
    return "Execution";
  }

  if (/valid|qa|review|phase5/i.test(value)) {
    return "Validation";
  }

  return null;
}
