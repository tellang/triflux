import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeRotatedBackup } from "./backup-rotation.mjs";
import {
  modelEffortFromProfile,
  normalizeCodexProfileName,
  resolveCodexModelEffort,
} from "@triflux/core/scripts/lib/model-effort.mjs";
import {
  CODEX_FAMILY_PROFILES,
  modelFamilyPaths,
  resolveModelFamilies,
  writeModelFile,
} from "./model-family-resolver.mjs";

export { normalizeCodexProfileName };

export function managedCodexProfileContents(opts = {}) {
  const { profiles, families } = resolveModelFamilies("codex", opts);
  const contents = {};
  for (const [name, { model, effort }] of Object.entries(profiles)) {
    contents[name] =
      `model = "${model}"\nmodel_reasoning_effort = "${effort}"\n`;
  }
  for (const [family, { model }] of Object.entries(families)) {
    contents[family] = `model = "${model}"\n`;
  }
  return { profiles, contents };
}

export function ensureManagedCodexProfiles(opts = {}) {
  const { codexHome } = modelFamilyPaths(opts);
  const { profiles, contents } = managedCodexProfileContents(opts);
  let changed = 0;
  const families = new Set(
    Object.values(CODEX_FAMILY_PROFILES).map(({ family }) => family),
  );
  for (const [name, content] of Object.entries(contents)) {
    const path = join(codexHome, `${name}.config.toml`);
    if (families.has(name) && existsSync(path)) {
      const existing = readFileSync(path, "utf8");
      if (existing !== content) {
        const backup = writeRotatedBackup(path, existing, {
          label: "bak-model-family",
          suffix: stamp(),
          mode: privateFileMode(path),
        });
        opts.notice?.(`Codex 가족 프로필 백업: ${backup}`);
      }
    }
    if (writeModelFile(path, content)) changed++;
  }
  return { changed, profiles };
}

function readProfileScalar(raw, key) {
  const match = String(raw).match(
    new RegExp(
      `^\\s*${key}\\s*=\\s*(?:"([^"\\n]*)"|'([^'\\n]*)'|([^#\\n]*?))\\s*(?:#.*)?$`,
      "m",
    ),
  );
  if (!match) return null;
  const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
  return value || null;
}

// 관리 이름의 effort는 변환 표가 정한다. custom 파일은 ultra 제한 판정에 사용한다.
export function resolveCodexProfileConfigValues(profileName, opts = {}) {
  if (typeof profileName !== "string" || !profileName) {
    return { model: null, effort: null };
  }
  const normalizedProfileName = normalizeCodexProfileName(profileName);
  const managed = modelEffortFromProfile("codex", normalizedProfileName);
  const codexHome =
    opts.codexHome || process.env.CODEX_HOME || join(homedir(), ".codex");
  let model = null;
  let effort = managed ? resolveCodexModelEffort(managed, opts).effort : null;
  try {
    const raw = readFileSync(
      join(codexHome, `${normalizedProfileName}.config.toml`),
      "utf8",
    );
    model = readProfileScalar(raw, "model");
    if (!managed) effort = readProfileScalar(raw, "model_reasoning_effort");
  } catch {}
  return { model, effort };
}

export function codexProfileConfigOverrides(profileName, opts = {}) {
  const normalizedProfileName = normalizeCodexProfileName(profileName);
  let { model, effort } = resolveCodexProfileConfigValues(
    normalizedProfileName,
    opts,
  );
  if (opts.enforceCanonicalProfile === true) {
    if (Object.hasOwn(CODEX_FAMILY_PROFILES, normalizedProfileName)) {
      ({ model, effort } = resolveModelFamilies("codex", {
        ...opts,
        allowCommand: false,
        persist: false,
      }).profiles[normalizedProfileName]);
    }
  }
  if (opts.disallowUltra === true && effort?.toLowerCase() === "ultra") {
    ({ model, effort } = resolveModelFamilies("codex", {
      ...opts,
      allowCommand: false,
      persist: false,
    }).profiles.astra_max);
  }
  const overrides = [];
  if (model) overrides.push(`model="${model}"`);
  if (effort) overrides.push(`model_reasoning_effort="${effort}"`);
  return overrides;
}

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
      // 옮겨 온 프로필 본문에 MCP env 키가 있을 수 있다.
      writeFileSync(profilePath, body, { encoding: "utf8", mode: 0o600 });
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

// config.toml 에는 MCP env 키가 들어갈 수 있다. 다시 쓸 때 원본 권한을 지키고 없으면 0600 으로 만든다.
export function privateFileMode(path) {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return 0o600;
  }
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
  const mode = privateFileMode(configPath);
  writeRotatedBackup(configPath, source, {
    label: backupPrefix,
    suffix: stamp(now),
    mode,
  });
  // Atomic replace. config.toml is shared global state: a codex session may be
  // reading it while another entry point (tfx-route, the codex session hook, or
  // a parallel swarm worker) sanitizes it. Write the sanitized content to a
  // unique temp file in the same directory, then rename — rename is atomic on
  // the same filesystem, so no reader ever observes a torn/half-written config.
  // Concurrent sanitizers each rename their own complete temp; last writer wins
  // without corruption (the content is identical anyway since the migration is
  // deterministic). The pid keeps temp names unique across separate processes.
  const tmpPath = `${configPath}.tmp-${process.pid}-${stamp(now)}`;
  writeFileSync(tmpPath, sanitized.toml, { encoding: "utf8", mode });
  renameSync(tmpPath, configPath);
  return sanitized;
}
