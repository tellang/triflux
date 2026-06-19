import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const EFFORT_BY_SUFFIX = {
  xhigh: "xhigh",
  high: "high",
  med: "medium",
  medium: "medium",
  low: "low",
};

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

/**
 * Resolve a Codex effort profile name (e.g. "gpt55_high") to the `-c key=value`
 * config overrides that `codex exec` accepts, so the headless CLI lanes can
 * select a profile WITHOUT `codex exec --profile <name>`. codex 0.134+ rejects
 * `--profile X` whenever config.toml still contains an inline `[profiles.X]`
 * table (which codex itself re-injects when it rewrites config.toml), so the
 * `-c` form is immune and needs no config mutation / sanitize race.
 *
 * SSOT = the per-profile file `~/.codex/<name>.config.toml` written by
 * `tfx setup`; falls back to deriving the effort from the `<...>_<effort>`
 * naming convention when the file is absent. Returns the keys that resolve, in
 * `key="value"` TOML-scalar form ready to be shell-quoted by the caller.
 *
 * NOTE: the Codex MCP transport does the structured-arg equivalent in
 * hub/workers/codex-mcp.mjs (resolveCodexProfileConfig → model + config object);
 * this returns the CLI `-c` string form for the same per-profile file.
 *
 * @param {string} profileName
 * @param {{ codexHome?: string }} [opts]
 * @returns {string[]} e.g. ['model="gpt-5.5"', 'model_reasoning_effort="high"']
 */
export function codexProfileConfigOverrides(profileName, opts = {}) {
  if (typeof profileName !== "string" || !profileName) return [];
  const codexHome =
    opts.codexHome || process.env.CODEX_HOME || join(homedir(), ".codex");
  let model = null;
  let effort = null;
  try {
    const raw = readFileSync(
      join(codexHome, `${profileName}.config.toml`),
      "utf8",
    );
    model = readProfileScalar(raw, "model");
    effort = readProfileScalar(raw, "model_reasoning_effort");
  } catch {
    const suffix = /_(xhigh|high|med|medium|low)$/.exec(profileName);
    if (suffix) effort = EFFORT_BY_SUFFIX[suffix[1]] || null;
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
  // Atomic replace. config.toml is shared global state: a codex session may be
  // reading it while another entry point (tfx-route, the codex session hook, or
  // a parallel swarm worker) sanitizes it. Write the sanitized content to a
  // unique temp file in the same directory, then rename — rename is atomic on
  // the same filesystem, so no reader ever observes a torn/half-written config.
  // Concurrent sanitizers each rename their own complete temp; last writer wins
  // without corruption (the content is identical anyway since the migration is
  // deterministic). The pid keeps temp names unique across separate processes.
  const tmpPath = `${configPath}.tmp-${process.pid}-${stamp(now)}`;
  writeFileSync(tmpPath, sanitized.toml, "utf8");
  renameSync(tmpPath, configPath);
  return sanitized;
}
