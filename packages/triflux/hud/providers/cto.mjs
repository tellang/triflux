import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CTO_LAKE_CURRENT_RELATIVE_PATH,
  CTO_STATUS_LINE_MAX_CHARS,
  CTO_STATUS_STALE_MS,
} from "../constants.mjs";

function oneLine(value) {
  return String(value || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function capLine(line) {
  const text = oneLine(line);
  if (text.length <= CTO_STATUS_LINE_MAX_CHARS) return text;
  return `${text.slice(0, CTO_STATUS_LINE_MAX_CHARS - 3)}...`;
}

function resolveCurrentPath({ currentPath, rootDir } = {}) {
  if (currentPath) return currentPath;
  return join(rootDir || process.cwd(), CTO_LAKE_CURRENT_RELATIVE_PATH);
}

function extractBriefVersion(lines) {
  const versionLine = lines.find((line) => /^brief_version:\s*/i.test(line));
  return oneLine(versionLine?.replace(/^brief_version:\s*/i, "")) || null;
}

function extractStatusLine(lines) {
  const summaryLine = lines.find((line) => /^summary:\s*/i.test(line));
  const summary = oneLine(summaryLine?.replace(/^summary:\s*/i, ""));
  if (summary) return capLine(summary);

  const sectionHeaders = new Set([
    "repo_state",
    "active_goals",
    "swarm_shards",
    "hub_status",
    "recent_events",
    "generated_at",
    "injection_note",
  ]);
  const fallback = lines.find((line) => {
    const clean = oneLine(line);
    return (
      clean && !/^brief_version:\s*/i.test(clean) && !sectionHeaders.has(clean)
    );
  });
  return fallback ? capLine(fallback) : null;
}

export function readCtoStatus(options = {}) {
  try {
    const currentPath = resolveCurrentPath(options);
    const stat = statSync(currentPath);
    const raw = readFileSync(currentPath, "utf8");
    const lines = raw.split(/\r?\n/u).map(oneLine).filter(Boolean);
    const line = extractStatusLine(lines);
    if (!line) return null;

    const version = extractBriefVersion(lines);
    const isStale = Date.now() - stat.mtimeMs > CTO_STATUS_STALE_MS;
    return {
      line,
      rightTag: isStale ? "stale" : version || "cto",
    };
  } catch {
    return null;
  }
}
