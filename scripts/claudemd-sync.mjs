import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OMC_END, TFX_START, writeSection } from "./lib/claudemd-scanner.mjs";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));
const GLOBAL_CLAUDE_MD_PATH = join(homedir(), ".claude", "CLAUDE.md");
const PKG_CLAUDE_MD_PATH = join(PKG_ROOT, "CLAUDE.md");
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
  const headingPattern = new RegExp(
    `(^|\\n)${ROUTING_SECTION_HEADING.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?=\\n|$)`,
    "u",
  );
  const match = headingPattern.exec(content);

  if (!match) {
    return { found: false, startIndex: -1, endIndex: -1, section: "" };
  }

  const startIndex = match.index + match[1].length;
  const nextHeadingIndex = content.indexOf(
    "\n## ",
    startIndex + ROUTING_SECTION_HEADING.length,
  );
  const endIndex =
    nextHeadingIndex === -1 ? content.length : nextHeadingIndex + 1;

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

  const separator = current.endsWith("\n\n")
    ? ""
    : current.endsWith("\n")
      ? "\n"
      : "\n\n";
  return `${current}${separator}${nextSection}`;
}

function toSkippedResult(path, reason) {
  return { action: "unchanged", path, skipped: true, reason };
}

export function getLatestRoutingTable() {
  // 1차: 사용자 글로벌 ~/.claude/CLAUDE.md (어디서든 접근 가능한 공통 경로)
  for (const candidate of [GLOBAL_CLAUDE_MD_PATH, PKG_CLAUDE_MD_PATH]) {
    if (!existsSync(candidate)) continue;
    const section = findRoutingSection(readFileSync(candidate, "utf8"));
    if (section.found) return section.section.trim();
  }
  // 2차 fallback: 패키지 CLAUDE.md도 없으면 에러
  throw new Error(
    `routing section not found in: ${GLOBAL_CLAUDE_MD_PATH} or ${PKG_CLAUDE_MD_PATH}`,
  );
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
  // routing은 프로젝트 CLAUDE.md에만 유지. global 중복 주입 중단.
  const claudeMdPath = join(claudeDir, "CLAUDE.md");
  return {
    action: "unchanged",
    path: claudeMdPath,
    skipped: true,
    reason: "global_sync_disabled",
  };
}
