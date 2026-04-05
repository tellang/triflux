import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TFX_START = "<!-- TFX:START -->";
export const TFX_END = "<!-- TFX:END -->";
export const OMC_END = "<!-- OMC:END -->";
const TFX_VERSION_RE = /<!-- TFX:VERSION:([\d.]+) -->/u;

const LEGACY_PATTERNS = [
  /<user_cli_routing>/u,
  /Codex Pro 무료 기간/u,
  /codex exec --dangerously-bypass.*skip-git-repo-check/u,
  /OMC 에이전트 → CLI 매핑/u,
  /Spark 가드레일/u,
];

const DEFAULT_TFX_TEMPLATE = [
  "### triflux CLI routing (managed)",
  "- 이 블록은 triflux setup에서 자동으로 관리됩니다.",
  "- 직접 수정이 필요하면 블록 바깥에 사용자 섹션을 추가하세요.",
].join("\n");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATE_PATH = join(SCRIPT_DIR, "..", "templates", "claudemd-tfx-section.md");

function resolveVersion(version) {
  if (version) return version;
  try {
    const pkgPath = join(SCRIPT_DIR, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function resolveTemplate(template, templatePath = DEFAULT_TEMPLATE_PATH) {
  if (typeof template === "string" && template.trim()) {
    return template.trim();
  }
  if (existsSync(templatePath)) {
    const raw = readFileSync(templatePath, "utf8").trim();
    if (raw) return raw;
  }
  return DEFAULT_TFX_TEMPLATE;
}

function findManagedSection(rawText) {
  const raw = String(rawText || "");
  const startIdx = raw.indexOf(TFX_START);
  const endMarkerIdx = raw.indexOf(TFX_END);
  if (startIdx === -1 || endMarkerIdx === -1 || endMarkerIdx <= startIdx) {
    return {
      found: false,
      content: null,
      version: null,
      startIdx: -1,
      endIdx: -1,
    };
  }

  const endIdx = endMarkerIdx + TFX_END.length;
  const content = raw.slice(startIdx, endIdx);
  const versionMatch = content.match(TFX_VERSION_RE);

  return {
    found: true,
    content,
    version: versionMatch ? versionMatch[1] : null,
    startIdx,
    endIdx,
  };
}

function detectLegacyRange(rawText) {
  const raw = String(rawText || "");
  const matches = LEGACY_PATTERNS.some((pattern) => pattern.test(raw));
  if (!matches) {
    return { found: false, startIdx: -1, endIdx: -1 };
  }

  const startTag = raw.indexOf("<user_cli_routing>");
  const endTag = raw.indexOf("</user_cli_routing>");
  if (startTag === -1 || endTag === -1 || endTag <= startTag) {
    return { found: true, startIdx: -1, endIdx: -1 };
  }

  let removeStart = startTag;
  const userOverridesComment = "<!-- USER OVERRIDES";
  const commentIdx = raw.lastIndexOf(userOverridesComment, startTag);
  if (commentIdx !== -1 && startTag - commentIdx < 200) {
    removeStart = commentIdx;
  }

  return {
    found: true,
    startIdx: removeStart,
    endIdx: endTag + "</user_cli_routing>".length,
  };
}

function normalizeSpacing(text) {
  return String(text || "").replace(/\n{3,}/gu, "\n\n");
}

export function findAllClaudeMdPaths(options = {}) {
  const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
  const homeDir = options.homeDir ? resolve(options.homeDir) : homedir();
  const includeGlobal = options.includeGlobal !== false;
  const includeProject = options.includeProject !== false;

  const candidates = [];
  if (includeGlobal) candidates.push(join(homeDir, ".claude", "CLAUDE.md"));
  if (includeProject) candidates.push(join(cwd, "CLAUDE.md"));

  const seen = new Set();
  const paths = [];
  for (const candidate of candidates) {
    const normalized = resolve(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (existsSync(normalized)) {
      paths.push(normalized);
    }
  }
  return paths;
}

export function writeSection(filePath, options = {}) {
  const absolutePath = resolve(filePath);
  const version = resolveVersion(options.version);
  const template = resolveTemplate(options.template, options.templatePath);
  const block = [
    TFX_START,
    `<!-- TFX:VERSION:${version} -->`,
    template,
    TFX_END,
  ].join("\n");

  if (!existsSync(absolutePath)) {
    writeFileSync(absolutePath, `${block}\n`, "utf8");
    return { action: "created", version, path: absolutePath };
  }

  const raw = readFileSync(absolutePath, "utf8");
  const existing = findManagedSection(raw);

  if (existing.found) {
    const nextContent = `${raw.slice(0, existing.startIdx)}${block}${raw.slice(existing.endIdx)}`;
    writeFileSync(absolutePath, nextContent, "utf8");
    return {
      action: "updated",
      oldVersion: existing.version,
      version,
      path: absolutePath,
    };
  }

  const omcEndIdx = raw.indexOf(OMC_END);
  if (omcEndIdx !== -1) {
    const insertAt = omcEndIdx + OMC_END.length;
    const before = raw.slice(0, insertAt);
    const after = raw.slice(insertAt);
    const nextContent = `${before}\n${block}${after}`;
    writeFileSync(absolutePath, nextContent, "utf8");
    return { action: "inserted_after_omc", version, path: absolutePath };
  }

  const separator = raw.endsWith("\n") ? "" : "\n";
  writeFileSync(absolutePath, `${raw}${separator}${block}\n`, "utf8");
  return { action: "appended", version, path: absolutePath };
}

export function migrateClaudeMd(filePath, options = {}) {
  const absolutePath = resolve(filePath);
  if (!existsSync(absolutePath)) {
    return { action: "no_file", removed: [], path: absolutePath };
  }

  const raw = readFileSync(absolutePath, "utf8");
  const existing = findManagedSection(raw);
  const legacy = detectLegacyRange(raw);

  if (existing.found && !legacy.found) {
    return {
      action: "already_managed",
      removed: [],
      version: existing.version,
      path: absolutePath,
    };
  }

  const removed = [];
  let nextContent = raw;

  if (legacy.found && legacy.startIdx !== -1 && legacy.endIdx !== -1) {
    nextContent = `${nextContent.slice(0, legacy.startIdx)}${nextContent.slice(legacy.endIdx)}`;
    removed.push("<user_cli_routing> block");
  }

  const existingAfterLegacy = findManagedSection(nextContent);
  if (existingAfterLegacy.found) {
    nextContent = `${nextContent.slice(0, existingAfterLegacy.startIdx)}${nextContent.slice(existingAfterLegacy.endIdx)}`;
    removed.push("old TFX block");
  }

  writeFileSync(absolutePath, normalizeSpacing(nextContent), "utf8");
  const writeResult = writeSection(absolutePath, options);

  return {
    action: "migrated",
    removed,
    version: writeResult.version,
    path: absolutePath,
  };
}
