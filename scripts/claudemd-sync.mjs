import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TFX_START, OMC_END, writeSection } from "./lib/claudemd-scanner.mjs";

import { execFileSync } from "node:child_process";

function resolveProjectRoot() {
  // 1. git root (가장 신뢰)
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch { /* not a git repo */ }
  // 2. cwd fallback (npm 사용자 등)
  return process.cwd();
}

const PROJECT_ROOT = resolveProjectRoot();
const PROJECT_CLAUDE_MD_PATH = join(PROJECT_ROOT, "CLAUDE.md");
const ROUTING_TAG_OPEN = "<routing>";
const ROUTING_TAG_CLOSE = "</routing>";
// Legacy heading fallback
const ROUTING_SECTION_HEADING = "## triflux CLI 라우팅";

function findRoutingSection(markdown) {
  const content = String(markdown || "");

  // XML 태그 기반 (우선)
  const openIdx = content.indexOf(ROUTING_TAG_OPEN);
  const closeIdx = content.indexOf(ROUTING_TAG_CLOSE);
  if (openIdx !== -1 && closeIdx !== -1 && closeIdx > openIdx) {
    const endIndex = closeIdx + ROUTING_TAG_CLOSE.length;
    return {
      found: true,
      startIndex: openIdx,
      endIndex: content[endIndex] === "\n" ? endIndex + 1 : endIndex,
      section: content.slice(openIdx, endIndex),
    };
  }

  // Legacy heading fallback
  const headingPattern = new RegExp(`(^|\\n)${ROUTING_SECTION_HEADING.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?=\\n|$)`, "u");
  const match = headingPattern.exec(content);

  if (!match) {
    return { found: false, startIndex: -1, endIndex: -1, section: "" };
  }

  const startIndex = match.index + match[1].length;
  const nextHeadingIndex = content.indexOf("\n## ", startIndex + ROUTING_SECTION_HEADING.length);
  const endIndex = nextHeadingIndex === -1 ? content.length : nextHeadingIndex + 1;

  return {
    found: true,
    startIndex,
    endIndex,
    section: content.slice(startIndex, endIndex),
  };
}

function normalizeRoutingSection(routingTable) {
  const section = String(routingTable || "").trim();
  return section ? `${section}\n` : "";
}

function buildNextMarkdown(currentMarkdown, routingSection) {
  const current = String(currentMarkdown || "");
  const nextSection = normalizeRoutingSection(routingSection);
  const existing = findRoutingSection(current);

  if (existing.found) {
    return `${current.slice(0, existing.startIndex)}${nextSection}${current.slice(existing.endIndex)}`;
  }

  if (!current) {
    return nextSection;
  }

  const separator = current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  return `${current}${separator}${nextSection}`;
}

function toSkippedResult(path, reason) {
  return { action: "unchanged", path, skipped: true, reason };
}

export function getLatestRoutingTable() {
  if (!existsSync(PROJECT_CLAUDE_MD_PATH)) {
    throw new Error(`project CLAUDE.md not found: ${PROJECT_CLAUDE_MD_PATH}`);
  }

  const projectMarkdown = readFileSync(PROJECT_CLAUDE_MD_PATH, "utf8");
  const section = findRoutingSection(projectMarkdown);

  if (!section.found) {
    throw new Error(`routing section not found in: ${PROJECT_CLAUDE_MD_PATH}`);
  }

  return section.section.trim();
}

export function ensureTfxSection(claudeMdPath, routingTable) {
  if (!existsSync(claudeMdPath)) {
    return toSkippedResult(claudeMdPath, "missing_file");
  }

  const currentMarkdown = readFileSync(claudeMdPath, "utf8");
  const nextMarkdown = buildNextMarkdown(currentMarkdown, routingTable);

  if (nextMarkdown === currentMarkdown) {
    return { action: "unchanged", path: claudeMdPath };
  }

  writeFileSync(claudeMdPath, nextMarkdown, "utf8");

  return {
    action: findRoutingSection(currentMarkdown).found ? "updated" : "created",
    path: claudeMdPath,
  };
}

export function ensureTfxCrown(claudeMdPath, options = {}) {
  const absolutePath = resolve(claudeMdPath);
  if (!existsSync(absolutePath)) {
    return toSkippedResult(absolutePath, "missing_file");
  }

  const content = readFileSync(absolutePath, "utf8");
  const startIdx = content.indexOf(TFX_START);
  const omcEndIdx = content.indexOf(OMC_END);

  if (startIdx === -1) {
    const result = writeSection(absolutePath, options);
    return { action: result.action, path: absolutePath };
  }

  const expectedPos = omcEndIdx !== -1 ? omcEndIdx + OMC_END.length : 0;
  const textBefore = content.slice(expectedPos, startIdx).trim();

  if (textBefore.length === 0) {
    return { action: "unchanged", path: absolutePath };
  }

  const result = writeSection(absolutePath, options);
  return { action: "repositioned", path: absolutePath, detail: result.action };
}

export function ensureGlobalClaudeRoutingSection(claudeDir) {
  const claudeMdPath = join(claudeDir, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) {
    return toSkippedResult(claudeMdPath, "missing_file");
  }

  try {
    return ensureTfxSection(claudeMdPath, getLatestRoutingTable());
  } catch (error) {
    const reason = error instanceof Error ? error.message : "routing_table_unavailable";
    return toSkippedResult(claudeMdPath, reason);
  }
}
