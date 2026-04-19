import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * @typedef {object} TimelineEvent
 * @property {string} skill
 * @property {string} event
 * @property {string} branch
 * @property {string} session
 * @property {string | undefined} [outcome]
 * @property {number | undefined} [durationS]
 * @property {string} ts
 */

/**
 * @typedef {object} LogEventInput
 * @property {string} skill
 * @property {string} event
 * @property {string} branch
 * @property {string} session
 * @property {string | undefined} [outcome]
 * @property {number | undefined} [durationS]
 */

/**
 * @typedef {object} LastSessionQuery
 * @property {string} branch
 * @property {string | undefined} [skill]
 */

/**
 * @typedef {object} TimelineAdapter
 * @property {(event: LogEventInput) => Promise<void>} logEvent
 * @property {(n?: number) => Promise<TimelineEvent[]>} readRecent
 * @property {(query: LastSessionQuery) => Promise<TimelineEvent | null>} getLastSession
 */

/**
 * @typedef {object} DetectedTimelineAdapter
 * @property {TimelineAdapter} adapter
 * @property {"gstack" | "null"} kind
 */

/**
 * @param {string} filePath
 * @returns {Promise<TimelineEvent[]>}
 */
async function readTimeline(filePath) {
  try {
    const content = await readFile(filePath, "utf8");
    /** @type {TimelineEvent[]} */
    const events = [];

    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;

      try {
        events.push(JSON.parse(line));
      } catch {
        // Skip malformed lines to preserve remaining timeline history.
      }
    }

    return events;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
}

/**
 * @param {string} filePath
 * @param {LogEventInput} event
 * @returns {Promise<void>}
 */
async function appendTimeline(filePath, event) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const entry = {
    ...event,
    ts: new Date().toISOString(),
  };
  await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * @param {() => Promise<string>} resolveFilePath
 * @returns {TimelineAdapter}
 */
function createTimelineAdapter(resolveFilePath) {
  return {
    async logEvent(event) {
      const filePath = await resolveFilePath();
      await appendTimeline(filePath, event);
    },

    async readRecent(n = 10) {
      const filePath = await resolveFilePath();
      const events = await readTimeline(filePath);
      const limit = Number.isFinite(n) ? Math.trunc(n) : 10;
      if (limit <= 0) return [];
      return events.slice(-limit);
    },

    async getLastSession({ branch, skill }) {
      const filePath = await resolveFilePath();
      const events = await readTimeline(filePath);

      for (let index = events.length - 1; index >= 0; index -= 1) {
        const entry = events[index];
        if (!entry?.session) continue;
        if (entry.branch !== branch) continue;
        if (skill && entry.skill !== skill) continue;
        return entry;
      }

      return null;
    },
  };
}

/**
 * @returns {Promise<string>}
 */
async function resolveRepoSlug() {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--show-toplevel"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );
  return path.basename(stdout.trim());
}

/**
 * @returns {Promise<string>}
 */
async function resolveGstackTimelinePath() {
  const slug = await resolveRepoSlug();
  return path.join(os.homedir(), ".gstack", "projects", slug, "timeline.jsonl");
}

/**
 * @returns {Promise<string>}
 */
async function resolveNullTimelinePath() {
  return path.join(process.cwd(), ".omc", "timeline.jsonl");
}

/** @type {TimelineAdapter} */
export const gstackTimelineAdapter = createTimelineAdapter(
  resolveGstackTimelinePath,
);

/** @type {TimelineAdapter} */
export const nullTimelineAdapter = createTimelineAdapter(
  resolveNullTimelinePath,
);

/**
 * @returns {DetectedTimelineAdapter}
 */
export function detectAdapter() {
  const gstackRoot = path.join(os.homedir(), ".gstack");
  if (existsSync(gstackRoot)) {
    return {
      adapter: gstackTimelineAdapter,
      kind: "gstack",
    };
  }

  return {
    adapter: nullTimelineAdapter,
    kind: "null",
  };
}
