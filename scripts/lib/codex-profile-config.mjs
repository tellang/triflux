import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PROFILE_SECTION_PREFIX = "profiles.";
const SAFE_PROFILE_FILE_RE = /^[A-Za-z0-9_.-]+$/;

function lineChunks(source = "") {
  return String(source).match(/[^\n]*\n|[^\n]+$/g) || [];
}

function parseSectionHeader(line) {
  const match = String(line)
    .trimEnd()
    .match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
  return match ? match[1].trim() : null;
}

function profileNameFromSection(section) {
  if (!section?.startsWith(PROFILE_SECTION_PREFIX)) return null;
  return section.slice(PROFILE_SECTION_PREFIX.length).trim();
}

function isTopLevelProfileSelector(line) {
  return /^\s*profile\s*=/.test(line);
}

function normalizeProfileBody(lines) {
  const body = lines.join("").replace(/^\s+/, "").replace(/\s+$/, "");
  return body ? `${body}\n` : "";
}

export function listLegacyCodexProfileSections(source = "") {
  const names = [];
  for (const line of lineChunks(source)) {
    const name = profileNameFromSection(parseSectionHeader(line));
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export function sanitizeCodexProfileConfig(
  source = "",
  { codexHome = null, migrateProfileFiles = true } = {},
) {
  const output = [];
  const removedProfiles = [];
  const migratedProfiles = [];
  const skippedProfileFiles = [];
  const captured = new Map();
  let currentProfile = null;
  let seenSection = false;
  let removedTopLevelProfileSelector = false;

  for (const line of lineChunks(source)) {
    const section = parseSectionHeader(line);
    if (section) {
      seenSection = true;
      const profileName = profileNameFromSection(section);
      if (profileName) {
        currentProfile = profileName;
        if (!removedProfiles.includes(profileName))
          removedProfiles.push(profileName);
        if (!captured.has(profileName)) captured.set(profileName, []);
        continue;
      }
      currentProfile = null;
      output.push(line);
      continue;
    }

    if (!seenSection && isTopLevelProfileSelector(line)) {
      removedTopLevelProfileSelector = true;
      continue;
    }

    if (currentProfile) {
      captured.get(currentProfile)?.push(line);
      continue;
    }

    output.push(line);
  }

  if (codexHome && migrateProfileFiles) {
    mkdirSync(codexHome, { recursive: true });
    for (const [profileName, bodyLines] of captured.entries()) {
      if (!SAFE_PROFILE_FILE_RE.test(profileName)) {
        skippedProfileFiles.push(profileName);
        continue;
      }
      const body = normalizeProfileBody(bodyLines);
      if (!body) {
        skippedProfileFiles.push(profileName);
        continue;
      }
      const profilePath = join(codexHome, `${profileName}.config.toml`);
      if (existsSync(profilePath)) {
        skippedProfileFiles.push(profileName);
        continue;
      }
      writeFileSync(profilePath, body, "utf8");
      migratedProfiles.push(profileName);
    }
  }

  const toml = output.join("");
  return {
    changed: toml !== String(source),
    toml,
    removedProfiles,
    migratedProfiles,
    skippedProfileFiles,
    removedTopLevelProfileSelector,
  };
}

function stamp(now = () => new Date()) {
  return now()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*$/, "")
    .replace("T", "-");
}

export function sanitizeCodexProfileConfigFile(
  configPath,
  {
    codexHome = dirname(configPath),
    backupPrefix = "bak-codex-profile-sanitize",
    now = () => new Date(),
  } = {},
) {
  if (!configPath || !existsSync(configPath)) {
    return { changed: false, removedProfiles: [], migratedProfiles: [] };
  }
  const source = readFileSync(configPath, "utf8");
  const sanitized = sanitizeCodexProfileConfig(source, { codexHome });
  if (!sanitized.changed) return sanitized;
  writeFileSync(`${configPath}.${backupPrefix}-${stamp(now)}`, source, "utf8");
  writeFileSync(configPath, sanitized.toml, "utf8");
  return sanitized;
}
