#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { readPreflightCache } from "./preflight-cache.mjs";
import { checkCli, checkHub, detectCodexAuthState } from "./lib/env-probe.mjs";
import { SEARCH_SERVER_ORDER, MCP_SERVER_DOMAIN_TAGS } from "./lib/mcp-server-catalog.mjs";

export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const WARMUP_METADATA_FILE = ["state", "warmup-metadata.json"];
const AUTH_SENSITIVE_TARGETS = new Set(["codexSkills", "tierEnvironment", "searchEngines"]);

export const CACHE_TARGETS = Object.freeze({
  codexSkills: Object.freeze({
    key: "codexSkills",
    file: ["cache", "codex-skills.json"],
  }),
  tierEnvironment: Object.freeze({
    key: "tierEnvironment",
    file: ["state", "tier-environment.json"],
  }),
  projectMeta: Object.freeze({
    key: "projectMeta",
    file: ["cache", "project-meta.json"],
  }),
  searchEngines: Object.freeze({
    key: "searchEngines",
    file: ["state", "search-engines.json"],
  }),
});

const ROLE_KEYWORDS = {
  plan: ["plan", "계획", "decompos", "strategy", "설계"],
  auto: ["autonomous", "자율", "auto-execute", "autopilot", "full auto"],
  persist: ["loop", "반복", "completion", "persist", "until", "끝까지"],
  investigate: ["investigate", "research", "조사", "분석", "analysis"],
  review: ["review", "리뷰", "inspect", "검수"],
};

function resolveHomeDir(homeDir = homedir()) {
  return homeDir;
}

function resolveRootDirs(cwd = process.cwd()) {
  const omcDir = join(cwd, ".omc");
  return {
    cwd,
    omcDir,
    cacheDir: join(omcDir, "cache"),
    stateDir: join(omcDir, "state"),
  };
}

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

function writeJSON(filePath, payload) {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function normalizeTargets(targets) {
  if (!targets?.length) return Object.keys(CACHE_TARGETS);
  const allowed = new Set(Object.keys(CACHE_TARGETS));
  return [...new Set(targets)].filter((target) => allowed.has(target));
}

export function resolveTargetPath(target, { cwd = process.cwd() } = {}) {
  const spec = CACHE_TARGETS[target];
  if (!spec) throw new Error(`unknown cache target: ${target}`);

  const { omcDir } = resolveRootDirs(cwd);
  return join(omcDir, ...spec.file);
}

function resolveWarmupMetadataPath({ cwd = process.cwd() } = {}) {
  const { omcDir } = resolveRootDirs(cwd);
  return join(omcDir, ...WARMUP_METADATA_FILE);
}

function readWarmupMetadata(options = {}) {
  const metadataPath = resolveWarmupMetadataPath(options);
  if (!existsSync(metadataPath)) return null;
  try {
    return JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch {
    return null;
  }
}

function resolveTtlMs(target, options = {}) {
  if (Number.isFinite(options.ttlByTarget?.[target])) {
    return Math.max(0, Math.trunc(options.ttlByTarget[target]));
  }
  if (Number.isFinite(options.ttlMs)) {
    return Math.max(0, Math.trunc(options.ttlMs));
  }
  return DEFAULT_CACHE_TTL_MS;
}

function isFresh(target, options = {}) {
  const filePath = resolveTargetPath(target, options);
  if (!existsSync(filePath)) return false;

  try {
    const ttlMs = resolveTtlMs(target, options);
    const now = options.now ?? Date.now();
    const stat = statSync(filePath);
    return ttlMs > 0 && (now - stat.mtimeMs) < ttlMs;
  } catch {
    return false;
  }
}

function classifyRole(description) {
  const lower = (description || "").toLowerCase();
  for (const [role, keywords] of Object.entries(ROLE_KEYWORDS)) {
    if (keywords.some((keyword) => lower.includes(keyword))) return role;
  }
  return "general";
}

function parseSkillFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim() || null;
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim() || null;
  return name ? { name, description } : null;
}

export function scanCodexSkills(options = {}) {
  const homeDir = resolveHomeDir(options.homeDir);
  const codexSkillsDir = join(homeDir, ".codex", "skills");
  const skills = [];

  if (existsSync(codexSkillsDir)) {
    for (const entry of readdirSync(codexSkillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const skillMd = join(codexSkillsDir, entry.name, "SKILL.md");
      if (!existsSync(skillMd)) continue;

      try {
        const content = readFileSync(skillMd, "utf8");
        const frontmatter = parseSkillFrontmatter(content);
        const name = frontmatter?.name || entry.name;
        const description = frontmatter?.description || "";
        skills.push({
          name,
          role: classifyRole(description),
          description: description.slice(0, 200),
          source: "custom",
          path: skillMd,
        });
      } catch {
        skills.push({
          name: entry.name,
          role: "general",
          description: "",
          source: "custom",
          path: skillMd,
        });
      }
    }
  }

  const builtinSkills = [
    { name: "web-clone", role: "general", description: "Clone and analyze web pages" },
    { name: "help", role: "general", description: "Show available commands" },
    { name: "note", role: "general", description: "Save notes during session" },
    { name: "worker", role: "auto", description: "Spawn background worker for tasks" },
  ];

  for (const builtin of builtinSkills) {
    if (skills.some((skill) => skill.name === builtin.name)) continue;
    if (existsSync(join(codexSkillsDir, builtin.name))) continue;
    skills.push({ ...builtin, source: "builtin" });
  }

  skills.sort((left, right) => left.name.localeCompare(right.name));

  return {
    scanned_at: new Date(options.now ?? Date.now()).toISOString(),
    codex_skills_dir: codexSkillsDir,
    total: skills.length,
    skills,
  };
}

export function probeTierEnvironment(options = {}) {
  const homeDir = resolveHomeDir(options.homeDir);
  const preflight = options.preflight ?? readPreflightCache();
  const execSyncFn = options.execSyncFn || execSync;
  const codexAuth = preflight?.codex_plan ?? detectCodexAuthState({ homeDir });

  const codexCheck = preflight?.codex || checkCli("codex", { execSyncFn });
  const geminiCheck = preflight?.gemini || checkCli("gemini", { execSyncFn });
  const hubCheck = preflight?.hub || checkHub({
    pkgRoot: options.pkgRoot,
    restart: options.hubRestart === true,
    requestTimeoutMs: options.hubTimeoutMs ?? 1000,
    pollAttempts: options.hubRestart === true ? 8 : 0,
    execSyncFn,
  });
  const checks = {
    psmux: false,
    hub: !!hubCheck?.ok,
    codex: !!codexCheck?.ok,
    gemini: !!geminiCheck?.ok,
    wt: false,
  };

  try {
    execSyncFn("psmux --version", {
      stdio: "ignore",
      timeout: 2000,
      windowsHide: true,
    });
    checks.psmux = true;
  } catch {}

  if (process.platform === "win32") {
    try {
      execSyncFn("where wt.exe", {
        stdio: "ignore",
        timeout: 2000,
        windowsHide: true,
      });
      checks.wt = true;
    } catch {}
  }

  let tier = "minimal";
  if (checks.codex || checks.gemini) tier = "standard";
  if (checks.psmux && checks.hub && (checks.codex || checks.gemini)) tier = "full";

  const agents = ["claude"];
  if (checks.codex) agents.push("codex");
  if (checks.gemini) agents.push("gemini");

  return {
    probed_at: new Date(options.now ?? Date.now()).toISOString(),
    tier,
    checks,
    available_agents: agents,
    codex_plan: codexAuth.source == null
      ? { plan: codexAuth.plan }
      : { plan: codexAuth.plan, source: codexAuth.source },
    source: {
      preflight: !!preflight,
      home_dir: homeDir,
      hub_state: hubCheck?.state || "unknown",
    },
  };
}

function getCodexAuthFingerprint(options = {}) {
  if (typeof options.preflight?.codex_plan?.fingerprint === "string") {
    return options.preflight.codex_plan.fingerprint;
  }
  return detectCodexAuthState({ homeDir: resolveHomeDir(options.homeDir) }).fingerprint;
}

function hasAuthFingerprintChanged(target, options = {}) {
  if (!AUTH_SENSITIVE_TARGETS.has(target)) return false;
  const nextFingerprint = getCodexAuthFingerprint(options);
  const previousFingerprint = readWarmupMetadata(options)?.codex_auth_fingerprint || null;
  if (previousFingerprint === null) return false;
  return previousFingerprint !== nextFingerprint;
}

export function extractProjectMeta(options = {}) {
  const cwd = options.cwd || process.cwd();
  const execSyncFn = options.execSyncFn || execSync;

  let name = basename(cwd);
  let description = "";
  let lang = "unknown";
  let testCmd = null;
  let isGit = false;

  try {
    const toplevel = execSyncFn("git rev-parse --show-toplevel", {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
      cwd,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    name = basename(toplevel);
    isGit = true;
  } catch {}

  const packageJsonPath = join(cwd, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      name = pkg.name || name;
      description = pkg.description || "";
      testCmd = pkg.scripts?.test || null;
      lang = "JavaScript/ESM (Node.js)";
    } catch {}
  } else if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "setup.py"))) {
    lang = "Python";
  } else if (existsSync(join(cwd, "Cargo.toml"))) {
    lang = "Rust";
  } else if (existsSync(join(cwd, "go.mod"))) {
    lang = "Go";
  }

  return {
    extracted_at: new Date(options.now ?? Date.now()).toISOString(),
    name,
    description: description.slice(0, 300),
    lang,
    test_cmd: testCmd,
    is_git: isGit,
  };
}

function loadMcpInventory(options = {}) {
  const inventoryPath = join(resolveHomeDir(options.homeDir), ".claude", "cache", "mcp-inventory.json");
  try {
    return JSON.parse(readFileSync(inventoryPath, "utf8"));
  } catch {
    return null;
  }
}

function loadMcpConfigs(options = {}) {
  const cwd = options.cwd || process.cwd();
  const homeDir = resolveHomeDir(options.homeDir);
  const configPaths = [
    join(homeDir, ".claude", "settings.json"),
    join(homeDir, ".claude", "settings.local.json"),
    join(cwd, ".claude", "mcp.json"),
    join(cwd, ".mcp.json"),
  ];

  const servers = {};

  for (const configPath of configPaths) {
    try {
      const data = JSON.parse(readFileSync(configPath, "utf8"));
      const mcpServers = data.mcpServers || {};
      for (const [name, config] of Object.entries(mcpServers)) {
        servers[name] = {
          configured: true,
          source: basename(configPath),
          ...config,
        };
      }
    } catch {}
  }

  return servers;
}

export function checkSearchEngines(options = {}) {
  const inventory = options.inventory ?? loadMcpInventory(options);
  const configuredServers = options.configuredServers ?? loadMcpConfigs(options);
  const engines = [];

  const knownSearchServers = [...SEARCH_SERVER_ORDER, "context7"];
  const allServerNames = new Set(knownSearchServers);

  if (inventory) {
    for (const scope of ["codex", "gemini", "claude"]) {
      const scopeData = inventory[scope];
      if (!scopeData?.servers) continue;
      for (const server of scopeData.servers) {
        const tags = server.domain_tags || MCP_SERVER_DOMAIN_TAGS[server.name] || [];
        if (tags.includes("search") || tags.includes("web") || tags.includes("research")) {
          allServerNames.add(server.name);
        }
      }
    }
  }

  for (const name of Object.keys(configuredServers)) {
    const tags = MCP_SERVER_DOMAIN_TAGS[name] || [];
    if (tags.includes("search") || tags.includes("web") || knownSearchServers.includes(name)) {
      allServerNames.add(name);
    }
  }

  for (const name of allServerNames) {
    const configured = !!configuredServers[name];
    const tags = MCP_SERVER_DOMAIN_TAGS[name] || [];

    let inventoryStatus = null;
    if (inventory) {
      for (const scope of ["codex", "gemini", "claude"]) {
        const server = inventory[scope]?.servers?.find((item) => item.name === name);
        if (server) {
          inventoryStatus = {
            scope,
            status: server.status,
            tool_count: server.tool_count,
          };
          break;
        }
      }
    }

    let status = "unavailable";
    if (inventoryStatus?.status === "enabled" || inventoryStatus?.status === "configured") {
      status = "available";
    } else if (configured) {
      status = "configured";
    }

    engines.push({
      name,
      status,
      domain_tags: tags,
      configured,
      inventory: inventoryStatus,
      source: configuredServers[name]?.source || null,
    });
  }

  engines.sort((left, right) => {
    const leftIndex = SEARCH_SERVER_ORDER.indexOf(left.name);
    const rightIndex = SEARCH_SERVER_ORDER.indexOf(right.name);
    if (leftIndex !== -1 && rightIndex !== -1) return leftIndex - rightIndex;
    if (leftIndex !== -1) return -1;
    if (rightIndex !== -1) return 1;
    return left.name.localeCompare(right.name);
  });

  const available = engines.filter((engine) => engine.status === "available");

  return {
    checked_at: new Date(options.now ?? Date.now()).toISOString(),
    primary_engine: available[0]?.name || null,
    available_count: available.length,
    total_count: engines.length,
    engines,
  };
}

function buildTarget(target, options = {}) {
  const filePath = resolveTargetPath(target, options);
  if (!options.force && isFresh(target, options) && !hasAuthFingerprintChanged(target, options)) {
    return { target, status: "skipped", file: filePath, reason: "fresh" };
  }

  let payload;
  if (target === "codexSkills") payload = scanCodexSkills(options);
  else if (target === "tierEnvironment") payload = probeTierEnvironment(options);
  else if (target === "projectMeta") payload = extractProjectMeta(options);
  else if (target === "searchEngines") payload = checkSearchEngines(options);
  else throw new Error(`unknown cache target: ${target}`);

  writeJSON(filePath, payload);
  return { target, status: "built", file: filePath, payload };
}

export function buildCodexSkills(options = {}) {
  return buildTarget("codexSkills", options);
}

export function buildTierEnvironment(options = {}) {
  return buildTarget("tierEnvironment", options);
}

export function buildProjectMeta(options = {}) {
  return buildTarget("projectMeta", options);
}

export function buildSearchEngines(options = {}) {
  return buildTarget("searchEngines", options);
}

export function buildAll(options = {}) {
  const targets = normalizeTargets(options.targets);
  const dirs = resolveRootDirs(options.cwd);
  ensureDir(dirs.cacheDir);
  ensureDir(dirs.stateDir);

  const results = [];
  for (const target of targets) {
    try {
      results.push(buildTarget(target, options));
    } catch (error) {
      results.push({
        target,
        status: "failed",
        file: resolveTargetPath(target, options),
        error: error.message,
      });
    }
  }

  const built = results.filter((result) => result.status === "built").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const authFingerprint = getCodexAuthFingerprint(options);

  if (failed === 0) {
    writeJSON(resolveWarmupMetadataPath(options), {
      updated_at: new Date(options.now ?? Date.now()).toISOString(),
      codex_auth_fingerprint: authFingerprint,
      targets,
    });
  }

  return {
    ok: failed === 0,
    built,
    skipped,
    failed,
    results,
  };
}

export function formatBuildSummary(summary, { label = "cache-warmup" } = {}) {
  const details = summary.results
    .filter((result) => result.status !== "failed")
    .map((result) => `${result.target}:${result.status}`);

  if (summary.failed > 0) {
    const errors = summary.results
      .filter((result) => result.status === "failed")
      .map((result) => `${result.target}:failed`);
    return `${label}: partial (${[...details, ...errors].join(", ")})`;
  }

  return `${label}: ok (${details.join(", ")})`;
}

export async function runCli(options = {}) {
  const force = options.force ?? process.argv.includes("--force");
  const summary = buildAll({ ...options, force });
  console.log(formatBuildSummary(summary));
  if (!summary.ok) process.exitCode = 1;
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runCli();
}
