#!/usr/bin/env node

// triflux 세션 시작 시 자동 설정 스크립트
// - tfx-route.sh를 ~/.claude/scripts/에 동기화
// - hud-qos-status.mjs를 ~/.claude/hud/에 동기화
// - skills/를 ~/.claude/skills/에 동기화

import { execFileSync, spawn } from "child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join, relative } from "path";
import { fileURLToPath } from "url";
import {
  ensureGlobalClaudeRoutingSection,
  ensureTfxSection,
  getLatestRoutingTable,
} from "./claudemd-sync.mjs";
import { cleanupTmpFiles } from "./tmp-cleanup.mjs";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLAUDE_DIR = join(homedir(), ".claude");
const CODEX_DIR = join(homedir(), ".codex");
const CODEX_CONFIG_PATH = join(CODEX_DIR, "config.toml");
const SETUP_MARKER_PATH = join(CLAUDE_DIR, "cache", "tfx-setup-marker.json");

// ── 로컬 개발 모드 감지 ──

/**
 * PLUGIN_ROOT에 .git 디렉토리가 존재하면 dev mode (git clone 직접 사용)로 판정.
 * @param {string} [root] - 검사할 루트 경로 (기본: PLUGIN_ROOT)
 * @returns {boolean}
 */
function detectDevMode(root = PLUGIN_ROOT) {
  return existsSync(join(root, ".git"));
}

const BREADCRUMB_PATH = join(CLAUDE_DIR, "scripts", ".tfx-pkg-root");

const REQUIRED_CODEX_PROFILES = [
  {
    name: "codex53_high",
    lines: ['model = "gpt-5.3-codex"', 'model_reasoning_effort = "high"'],
  },
  {
    name: "codex53_xhigh",
    lines: ['model = "gpt-5.3-codex"', 'model_reasoning_effort = "xhigh"'],
  },
  {
    name: "spark53_low",
    lines: ['model = "gpt-5.3-codex-spark"', 'model_reasoning_effort = "low"'],
  },
];

const HUD_SYNC_EXCLUDES = new Set(["omc-hud.mjs", "omc-hud.mjs.bak"]);

function scanHudFiles(pluginRoot, claudeDir) {
  const hudRoot = join(pluginRoot, "hud");
  if (!existsSync(hudRoot)) return [];

  const walk = (currentDir) => {
    const entries = readdirSync(currentDir, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    );

    return entries.flatMap((entry) => {
      const absolutePath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        return walk(absolutePath);
      }

      if (
        !entry.isFile() ||
        HUD_SYNC_EXCLUDES.has(entry.name) ||
        !entry.name.endsWith(".mjs")
      ) {
        return [];
      }

      const hudRelativePath = relative(hudRoot, absolutePath);
      const normalizedRelativePath = hudRelativePath.replace(/\\/g, "/");

      return [
        {
          src: absolutePath,
          dst: join(claudeDir, "hud", hudRelativePath),
          label:
            normalizedRelativePath === "hud-qos-status.mjs"
              ? "hud-qos-status.mjs"
              : `hud/${normalizedRelativePath}`,
        },
      ];
    });
  };

  return walk(hudRoot);
}

// ── 파일 동기화 ──

const SYNC_MAP = [
  {
    src: join(PLUGIN_ROOT, "scripts", "tfx-route.sh"),
    dst: join(CLAUDE_DIR, "scripts", "tfx-route.sh"),
    label: "tfx-route.sh",
  },
  {
    src: join(PLUGIN_ROOT, "scripts", "tfx-route-post.mjs"),
    dst: join(CLAUDE_DIR, "scripts", "tfx-route-post.mjs"),
    label: "tfx-route-post.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "scripts", "tfx-route-worker.mjs"),
    dst: join(CLAUDE_DIR, "scripts", "tfx-route-worker.mjs"),
    label: "tfx-route-worker.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "hub", "workers", "codex-mcp.mjs"),
    dst: join(CLAUDE_DIR, "scripts", "hub", "workers", "codex-mcp.mjs"),
    label: "hub/workers/codex-mcp.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "hub", "workers", "delegator-mcp.mjs"),
    dst: join(CLAUDE_DIR, "scripts", "hub", "workers", "delegator-mcp.mjs"),
    label: "hub/workers/delegator-mcp.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "hub", "workers", "interface.mjs"),
    dst: join(CLAUDE_DIR, "scripts", "hub", "workers", "interface.mjs"),
    label: "hub/workers/interface.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "hub", "workers", "gemini-worker.mjs"),
    dst: join(CLAUDE_DIR, "scripts", "hub", "workers", "gemini-worker.mjs"),
    label: "hub/workers/gemini-worker.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "hub", "workers", "claude-worker.mjs"),
    dst: join(CLAUDE_DIR, "scripts", "hub", "workers", "claude-worker.mjs"),
    label: "hub/workers/claude-worker.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "hub", "workers", "worker-utils.mjs"),
    dst: join(CLAUDE_DIR, "scripts", "hub", "workers", "worker-utils.mjs"),
    label: "hub/workers/worker-utils.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "hub", "workers", "factory.mjs"),
    dst: join(CLAUDE_DIR, "scripts", "hub", "workers", "factory.mjs"),
    label: "hub/workers/factory.mjs",
  },
  ...scanHudFiles(PLUGIN_ROOT, CLAUDE_DIR),
  {
    src: join(PLUGIN_ROOT, "scripts", "notion-read.mjs"),
    dst: join(CLAUDE_DIR, "scripts", "notion-read.mjs"),
    label: "notion-read.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "scripts", "tfx-batch-stats.mjs"),
    dst: join(CLAUDE_DIR, "scripts", "tfx-batch-stats.mjs"),
    label: "tfx-batch-stats.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "scripts", "lib", "mcp-filter.mjs"),
    dst: join(CLAUDE_DIR, "scripts", "lib", "mcp-filter.mjs"),
    label: "lib/mcp-filter.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "scripts", "lib", "mcp-server-catalog.mjs"),
    dst: join(CLAUDE_DIR, "scripts", "lib", "mcp-server-catalog.mjs"),
    label: "lib/mcp-server-catalog.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "scripts", "lib", "keyword-rules.mjs"),
    dst: join(CLAUDE_DIR, "scripts", "lib", "keyword-rules.mjs"),
    label: "lib/keyword-rules.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "hub", "team", "agent-map.json"),
    dst: join(CLAUDE_DIR, "hub", "team", "agent-map.json"),
    label: "hub/team/agent-map.json",
  },
  {
    src: join(PLUGIN_ROOT, "scripts", "headless-guard.mjs"),
    dst: join(CLAUDE_DIR, "scripts", "headless-guard.mjs"),
    label: "headless-guard.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "scripts", "headless-guard-fast.sh"),
    dst: join(CLAUDE_DIR, "scripts", "headless-guard-fast.sh"),
    label: "headless-guard-fast.sh",
  },
  {
    src: join(PLUGIN_ROOT, "scripts", "tfx-gate-activate.mjs"),
    dst: join(CLAUDE_DIR, "scripts", "tfx-gate-activate.mjs"),
    label: "tfx-gate-activate.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "scripts", "remote-spawn.mjs"),
    dst: join(CLAUDE_DIR, "scripts", "remote-spawn.mjs"),
    label: "remote-spawn.mjs",
  },
];

function getVersion(filePath) {
  try {
    const content = readFileSync(filePath, "utf8");
    const match = content.match(/VERSION\s*=\s*"([^"]+)"/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function shouldSyncTextFile(src, dst) {
  if (!existsSync(dst)) return true;
  try {
    return readFileSync(src, "utf8") !== readFileSync(dst, "utf8");
  } catch {
    return true;
  }
}

function getPackageVersion() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, "package.json"), "utf8"))
      .version;
  } catch {
    return null;
  }
}

function readMarker() {
  if (!existsSync(SETUP_MARKER_PATH)) return null;

  try {
    return JSON.parse(readFileSync(SETUP_MARKER_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writeMarker(marker) {
  const markerDir = dirname(SETUP_MARKER_PATH);
  if (!existsSync(markerDir)) mkdirSync(markerDir, { recursive: true });
  writeFileSync(
    SETUP_MARKER_PATH,
    JSON.stringify(marker, null, 2) + "\n",
    "utf8",
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function _normalizeErrorMessage(error, fallback = "unknown error") {
  const isMeaningful = (value) => {
    if (typeof value !== "string") return false;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return false;
    return normalized !== "undefined" && normalized !== "null";
  };

  if (error instanceof Error && isMeaningful(error.message)) {
    return error.message.trim();
  }
  if (isMeaningful(error)) return error.trim();
  if (error && typeof error === "object") {
    const candidate = /** @type {{ message?: unknown }} */ (error).message;
    if (isMeaningful(candidate)) return candidate.trim();
  }
  return fallback;
}

function hasProfileSection(tomlContent, profileName) {
  const section = `^\\[profiles\\.${escapeRegExp(profileName)}\\]\\s*$`;
  return new RegExp(section, "m").test(tomlContent);
}

function replaceProfileSection(tomlContent, profileName, lines) {
  const header = `[profiles.${profileName}]`;
  const sectionRe = new RegExp(
    `^\\[profiles\\.${escapeRegExp(profileName)}\\]\\s*\\n?(?:(?!\\[)[^\\n]*\\n?)*`,
    "m",
  );
  const replacement = `${header}\n${lines.join("\n")}\n`;
  return tomlContent.replace(sectionRe, replacement);
}

// ── 스킬 별칭 (하나의 소스 스킬을 다른 이름으로도 노출) ──

const SKILL_ALIASES = [
  { alias: "tfx-autopilot", source: "tfx-auto" },
  { alias: "tfx-persist", source: "tfx-auto" },
  { alias: "tfx-fullcycle", source: "tfx-auto" },
];

// ── 폐기 예정 스킬 목록 ──

const DEPRECATED_SKILLS = ["tfx-codex-route", "tfx-gemini-route"];

// ── 구형 Codex 모델 (마이그레이션 안내 대상) ──

const LEGACY_CODEX_MODELS = ["o4-mini", "o3", "codex-mini-latest"];

/**
 * 별칭 스킬 디렉토리를 동기화한다.
 * 소스 스킬의 SKILL.md와 하위 파일을 별칭 디렉토리에 복사하면서
 * SKILL.md 내부의 소스 이름 참조를 별칭으로 치환한다.
 * @param {string} srcDir - 소스 스킬 디렉토리
 * @param {string} dstDir - 대상(별칭) 디렉토리
 * @param {{ alias: string, source: string }} meta - 별칭 메타 정보
 * @returns {number} 동기화된 파일 수
 */
function syncAliasedSkillDir(srcDir, dstDir, { alias, source }) {
  if (!existsSync(srcDir)) return 0;
  if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });

  let count = 0;
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = join(srcDir, entry.name);
    const dstPath = join(dstDir, entry.name);

    if (entry.isDirectory()) {
      count += syncAliasedSkillDir(srcPath, dstPath, { alias, source });
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;

    const srcContent = readFileSync(srcPath, "utf8");
    const aliased = srcContent.replaceAll(source, alias);
    const existing = existsSync(dstPath) ? readFileSync(dstPath, "utf8") : null;
    if (aliased !== existing) {
      writeFileSync(dstPath, aliased, "utf8");
      count++;
    }
  }
  return count;
}

/**
 * 설치된 스킬 디렉토리에서 패키지에 더 이상 없는 tfx-* 스킬을 제거한다.
 * @param {string} installedDir - ~/.claude/skills
 * @param {string} pkgDir - PLUGIN_ROOT/skills
 * @returns {{ count: number, removed: string[] }}
 */
function cleanupStaleSkills(installedDir, pkgDir) {
  const removed = [];
  if (!existsSync(installedDir)) return { count: 0, removed };

  const pkgNames = new Set();
  if (existsSync(pkgDir)) {
    for (const n of readdirSync(pkgDir)) pkgNames.add(n);
  }
  for (const { alias } of SKILL_ALIASES) pkgNames.add(alias);
  for (const dep of DEPRECATED_SKILLS) pkgNames.add(dep);

  for (const name of readdirSync(installedDir)) {
    if (!name.startsWith("tfx-")) continue;
    if (pkgNames.has(name)) continue;

    const skillPath = join(installedDir, name);
    try {
      const entries = readdirSync(skillPath);
      for (const f of entries) unlinkSync(join(skillPath, f));
      // rmdir only works on empty dirs; ignore errors for nested
      try {
        readdirSync(skillPath).length === 0 && unlinkSync(skillPath);
      } catch {}
    } catch {
      /* best effort */
    }
    removed.push(name);
  }
  return { count: removed.length, removed };
}

/**
 * 훅 커맨드 문자열에서 스크립트 파일명을 추출한다.
 * 예: 'node "/path/to/safety-guard.mjs"' → "safety-guard.mjs"
 * @param {string|undefined} command
 * @returns {string|null}
 */
function extractManagedHookFilename(command) {
  if (typeof command !== "string") return null;
  const match = command.match(/([^/\\"\s]+\.(?:mjs|js|sh|cjs))(?:["'\s]|$)/);
  return match ? match[1] : null;
}

/**
 * hook-registry.json에서 관리 대상 훅 목록을 플랫 배열로 반환한다.
 * @param {string} registryPath - hook-registry.json 경로
 * @returns {Array<{ event: string, id: string, fileName: string, matcher: string, command: string, priority: number, enabled: boolean }>}
 */
function getManagedRegistryHooks(registryPath) {
  if (!existsSync(registryPath)) return [];
  try {
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    const events = registry.events || {};
    const result = [];
    for (const [event, hooks] of Object.entries(events)) {
      if (!Array.isArray(hooks)) continue;
      for (const hook of hooks) {
        if (!hook.enabled) continue;
        const fileName = extractManagedHookFilename(hook.command);
        result.push({
          event,
          id: hook.id || "",
          fileName,
          matcher: hook.matcher || "*",
          command: hook.command || "",
          priority: hook.priority ?? 100,
          enabled: hook.enabled,
        });
      }
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * hook-registry.json 기준으로 settings.json에 누락된 훅을 자동 등록한다.
 * @param {{ settingsPath: string, registryPath: string }} opts
 * @returns {{ ok: boolean, changed: boolean, added: string[] }}
 */
function ensureHooksInSettings({ settingsPath, registryPath }) {
  try {
    const managed = getManagedRegistryHooks(registryPath);
    if (managed.length === 0) return { ok: true, changed: false, added: [] };

    let settings = {};
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    }
    if (!settings.hooks) settings.hooks = {};

    const added = [];
    for (const spec of managed) {
      if (!Array.isArray(settings.hooks[spec.event])) {
        settings.hooks[spec.event] = [];
      }
      const entries = settings.hooks[spec.event];
      const alreadyRegistered = entries.some(
        (entry) =>
          Array.isArray(entry?.hooks) &&
          entry.hooks.some(
            (h) => extractManagedHookFilename(h?.command) === spec.fileName,
          ),
      );
      if (alreadyRegistered) continue;

      entries.push({
        matcher: spec.matcher,
        hooks: [{ type: "command", command: spec.command, timeout: 5 }],
      });
      added.push(spec.id || spec.fileName);
    }

    if (added.length > 0) {
      writeFileSync(
        settingsPath,
        JSON.stringify(settings, null, 2) + "\n",
        "utf8",
      );
    }
    return { ok: true, changed: added.length > 0, added };
  } catch {
    return { ok: false, changed: false, added: [] };
  }
}

/**
 * Codex config.json에 tfx-hub MCP 서버 엔트리를 보장한다.
 * @param {{ mcpUrl: string, createIfMissing?: boolean, enabled?: boolean }} opts
 * @returns {{ ok: boolean, changed: boolean, reason?: string }}
 */
function ensureCodexHubServerConfig({
  configFile,
  mcpUrl,
  createIfMissing = false,
  enabled = false,
}) {
  try {
    const codexConfigDir = join(homedir(), ".codex");
    const configPath = configFile || join(codexConfigDir, "config.json");

    if (!existsSync(configPath)) {
      if (!createIfMissing)
        return { ok: true, changed: false, reason: "no-config" };
      const dir = dirname(configPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const config = { mcpServers: { "tfx-hub": { url: mcpUrl, enabled } } };
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
      return { ok: true, changed: true };
    }

    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (!config.mcpServers) config.mcpServers = {};

    const existing = config.mcpServers["tfx-hub"];
    const desired = { ...(existing || {}), url: mcpUrl, enabled };

    if (
      existing &&
      existing.url === desired.url &&
      existing.enabled === desired.enabled
    ) {
      return { ok: true, changed: false };
    }

    const updated = {
      ...config,
      mcpServers: { ...config.mcpServers, "tfx-hub": desired },
    };
    writeFileSync(configPath, JSON.stringify(updated, null, 2) + "\n", "utf8");
    return { ok: true, changed: true };
  } catch (err) {
    return { ok: false, changed: false, reason: err?.message || "unknown" };
  }
}

function ensureCodexProfiles() {
  try {
    if (!existsSync(CODEX_DIR)) mkdirSync(CODEX_DIR, { recursive: true });

    const original = existsSync(CODEX_CONFIG_PATH)
      ? readFileSync(CODEX_CONFIG_PATH, "utf8")
      : "";

    let updated = original;
    let changed = 0;

    for (const profile of REQUIRED_CODEX_PROFILES) {
      const desired = `[profiles.${profile.name}]\n${profile.lines.join("\n")}\n`;

      if (hasProfileSection(updated, profile.name)) {
        // 기존 프로필이 있으면 강제 갱신
        const before = updated;
        updated = replaceProfileSection(updated, profile.name, profile.lines);
        if (updated !== before) changed++;
      } else {
        // 없으면 추가
        if (updated.length > 0 && !updated.endsWith("\n")) updated += "\n";
        if (updated.trim().length > 0) updated += "\n";
        updated += desired;
        changed++;
      }
    }

    // headless 모드에서 승인 없이 실행하려면 sandbox 설정 필수
    // Codex 0.117.0+: config.toml 설정과 CLI 플래그 중복 시 에러
    if (process.platform === "win32" && !updated.includes("[windows]")) {
      if (updated.length > 0 && !updated.endsWith("\n")) updated += "\n";
      updated += '\n[windows]\nsandbox = "elevated"\n';
      changed++;
    }

    if (changed > 0) {
      writeFileSync(CODEX_CONFIG_PATH, updated, "utf8");
    }

    return { ok: true, changed };
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message.trim()
        : "unknown error";
    return { ok: false, changed: 0, message };
  }
}

function syncClaudeRoutingSections() {
  try {
    const routingTable = getLatestRoutingTable();
    return [
      ensureTfxSection(join(PLUGIN_ROOT, "CLAUDE.md"), routingTable),
      ensureGlobalClaudeRoutingSection(CLAUDE_DIR),
    ];
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "routing_sync_failed";
    return [
      {
        action: "unchanged",
        path: join(PLUGIN_ROOT, "CLAUDE.md"),
        skipped: true,
        reason,
      },
    ];
  }
}

export {
  BREADCRUMB_PATH,
  CLAUDE_DIR,
  cleanupStaleSkills,
  DEPRECATED_SKILLS,
  detectDevMode,
  ensureCodexHubServerConfig,
  ensureCodexProfiles,
  ensureHooksInSettings,
  extractManagedHookFilename,
  getManagedRegistryHooks,
  getVersion,
  hasProfileSection,
  LEGACY_CODEX_MODELS,
  PLUGIN_ROOT,
  REQUIRED_CODEX_PROFILES,
  readMarker,
  replaceProfileSection,
  SETUP_MARKER_PATH,
  SKILL_ALIASES,
  SYNC_MAP,
  scanHudFiles,
  syncAliasedSkillDir,
  writeMarker,
};

async function main() {
  const isSync = process.argv.includes("--sync");
  const isForce = process.argv.includes("--force");
  const isDev = detectDevMode();

  if (isDev) {
    console.log("  [dev] \uB85C\uCEEC \uAC1C\uBC1C \uBAA8\uB4DC \uAC10\uC9C0");
  }

  if (isSync) {
    console.log(
      "  [sync] \uBA85\uC2DC\uC801 \uC7AC\uB3D9\uAE30\uD654 \uC2E4\uD589",
    );
  }

  const pkgVersion = getPackageVersion();
  const marker = readMarker();
  const claudeRoutingResults = syncClaudeRoutingSections();
  const claudeRoutingChangedCount = claudeRoutingResults.filter(
    (result) => result.action === "created" || result.action === "updated",
  ).length;
  if (pkgVersion && marker?.version === pkgVersion && !isForce) {
    if (claudeRoutingChangedCount > 0) {
      console.log(
        `setup: skip core sync (v${pkgVersion} already synced, CLAUDE.md ${claudeRoutingChangedCount}건 반영)`,
      );
    } else {
      console.log(`setup: skip (v${pkgVersion} already synced)`);
    }
    process.exit(0);
  }

  let synced = claudeRoutingChangedCount;

  // ── Memory Doctor (P0 자동 수정) ──
  const isCIEnv = process.env.CI === "true" || process.env.DOCKER === "true";
  if (!isCIEnv) {
    try {
      const { createMemoryDoctor } = await import("../hub/memory-doctor.mjs");
      const projectSlug = process
        .cwd()
        .replace(/^([A-Z]):/u, "$1-")
        .replace(/[\\/]/gu, "-");
      const memDir = join(CLAUDE_DIR, "projects", projectSlug, "memory");
      if (existsSync(memDir)) {
        const doctor = createMemoryDoctor({
          memoryDir: memDir,
          rulesDir: join(process.cwd(), ".claude", "rules"),
          projectDir: process.cwd(),
          claudeDir: CLAUDE_DIR,
        });
        const { checks, healthScore } = doctor.scan();
        const p0Auto = checks.filter(
          (c) => c.severity === "P0" && c.autofix && !c.passed,
        );
        if (p0Auto.length > 0) {
          doctor.fixAll({ severity: "P0" });
          console.log(
            `  memory-doctor: ${p0Auto.length}건 P0 자동 수정 (health: ${healthScore})`,
          );
          synced += p0Auto.length;
        }
      }
    } catch (err) {
      console.log(`  memory-doctor: skip (${err.message})`);
    }
  }

  for (const { src, dst } of SYNC_MAP) {
    if (!existsSync(src)) continue;

    const dstDir = dirname(dst);
    if (!existsSync(dstDir)) {
      mkdirSync(dstDir, { recursive: true });
    }

    if (!existsSync(dst)) {
      copyFileSync(src, dst);
      try {
        chmodSync(dst, 0o755);
      } catch {}
      synced++;
    } else {
      if (shouldSyncTextFile(src, dst)) {
        copyFileSync(src, dst);
        try {
          chmodSync(dst, 0o755);
        } catch {}
        synced++;
      }
    }
  }

  try {
    const claudeGuide = ensureGlobalClaudeRoutingSection(CLAUDE_DIR);
    if (claudeGuide.changed) synced++;
  } catch (e) {
    console.log(`  \x1b[33m⚠\x1b[0m CLAUDE.md 라우팅: ${e.message}`);
  }

  // ── Worker 의존성 동기화 (MCP SDK + transitive deps) ──

  const workerNodeModules = join(CLAUDE_DIR, "scripts", "node_modules");
  const mcpSdkPath = join(workerNodeModules, "@modelcontextprotocol", "sdk");
  const srcNodeModules = join(PLUGIN_ROOT, "node_modules");

  // native 모듈은 제외 (플랫폼 의존적, worker에서 불필요)
  const SKIP_PACKAGES = new Set([
    "better-sqlite3",
    "prebuild-install",
    "node-abi",
    "node-addon-api",
  ]);

  if (!existsSync(mcpSdkPath) && existsSync(srcNodeModules)) {
    try {
      const { cpSync } = await import("fs");
      for (const entry of readdirSync(srcNodeModules)) {
        if (SKIP_PACKAGES.has(entry)) continue;

        const src = join(srcNodeModules, entry);
        const dst = join(workerNodeModules, entry);
        if (existsSync(dst)) continue;

        mkdirSync(dirname(dst), { recursive: true });
        cpSync(src, dst, { recursive: true });
      }
      synced++;
    } catch {
      // best effort: 의존성 복사 실패 시 exec fallback으로 동작
    }
  }

  // ── 패키지 루트 breadcrumb 기록 ──
  // tfx-route.sh가 hub/server.mjs, hub/bridge.mjs를 찾을 수 있도록
  // 패키지 루트 경로를 ~/.claude/scripts/.tfx-pkg-root에 기록한다.
  // dev mode에서는 항상 최신 경로를 기록 (--sync 시 강제 갱신).
  {
    const pkgRootForward = PLUGIN_ROOT.replace(/\\/g, "/");
    const currentBreadcrumb = existsSync(BREADCRUMB_PATH)
      ? readFileSync(BREADCRUMB_PATH, "utf8").trim()
      : "";
    if (currentBreadcrumb !== pkgRootForward || isSync) {
      const breadcrumbDir = dirname(BREADCRUMB_PATH);
      if (!existsSync(breadcrumbDir))
        mkdirSync(breadcrumbDir, { recursive: true });
      writeFileSync(BREADCRUMB_PATH, pkgRootForward + "\n", "utf8");
      synced++;
    }
  }

  // ── 에이전트 동기화 (.claude/agents/ → ~/.claude/agents/) ──
  // slim-wrapper 등 커스텀 에이전트를 글로벌에 배포하여
  // 다른 프로젝트에서도 subagent_type으로 참조 가능하게 한다.

  const agentsSrc = join(PLUGIN_ROOT, ".claude", "agents");
  const agentsDst = join(CLAUDE_DIR, "agents");

  if (existsSync(agentsSrc)) {
    if (!existsSync(agentsDst)) mkdirSync(agentsDst, { recursive: true });

    for (const name of readdirSync(agentsSrc)) {
      if (!name.endsWith(".md")) continue;

      const src = join(agentsSrc, name);
      const dst = join(agentsDst, name);

      if (!existsSync(dst)) {
        copyFileSync(src, dst);
        synced++;
      } else if (shouldSyncTextFile(src, dst)) {
        copyFileSync(src, dst);
        synced++;
      }
    }
  }

  // ── 스킬 동기화 ──
  // SKILL.md + 하위 디렉토리(references/ 등)를 재귀적으로 동기화

  const skillsSrc = join(PLUGIN_ROOT, "skills");
  const skillsDst = join(CLAUDE_DIR, "skills");

  function syncSkillDir(srcDir, dstDir) {
    if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });

    let count = 0;
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const srcPath = join(srcDir, entry.name);
      const dstPath = join(dstDir, entry.name);

      if (entry.isDirectory()) {
        count += syncSkillDir(srcPath, dstPath);
      } else if (entry.name.endsWith(".md")) {
        if (shouldSyncTextFile(srcPath, dstPath)) {
          copyFileSync(srcPath, dstPath);
          count++;
        }
      }
    }
    return count;
  }

  if (existsSync(skillsSrc)) {
    for (const name of readdirSync(skillsSrc)) {
      const skillDir = join(skillsSrc, name);
      const skillMd = join(skillDir, "SKILL.md");
      if (!existsSync(skillMd)) continue;

      synced += syncSkillDir(skillDir, join(skillsDst, name));
    }
  }

  // ── settings.json 통합 R/W ──
  // 3개 섹션(statusLine, agentTeams, hooks)을 1회 read → 일괄 수정 → 1회 write

  const settingsPath = join(CLAUDE_DIR, "settings.json");
  const hudPath = join(CLAUDE_DIR, "hud", "hud-qos-status.mjs");

  /**
   * statusLine 섹션 적용.
   * @param {object} s - settings 객체 (직접 변경)
   * @returns {boolean} 변경 여부
   */
  function applyStatusLine(s) {
    if (!existsSync(hudPath)) return false;
    const currentCmd = s.statusLine?.command || "";
    if (currentCmd.includes("hud-qos-status.mjs")) return false;

    const nodePath = process.execPath.replace(/\\/g, "/");
    const hudForward = hudPath.replace(/\\/g, "/");
    const nodeRef = nodePath.includes(" ") ? `"${nodePath}"` : nodePath;
    const hudRef = hudForward.includes(" ") ? `"${hudForward}"` : hudForward;

    s.statusLine = { type: "command", command: `${nodeRef} ${hudRef}` };
    return true;
  }

  /**
   * Agent Teams 환경변수 섹션 적용.
   * @param {object} s - settings 객체 (직접 변경)
   * @returns {boolean} 변경 여부
   */
  function applyAgentTeams(s) {
    if (!s.env) s.env = {};
    let changed = false;

    if (s.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS !== "1") {
      s.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
      changed = true;
    }
    // teammateMode: auto (tmux 밖이면 in-process, 안이면 split-pane)
    if (!s.teammateMode) {
      s.teammateMode = "auto";
      changed = true;
    }
    return changed;
  }

  /**
   * Remote Control 자동 활성화.
   * 모든 세션에서 remote control URL을 자동 발급하도록 설정.
   * @param {object} s - settings 객체 (직접 변경)
   * @returns {boolean} 변경 여부
   */
  function applyRemoteControl(s) {
    if (s.remoteControlAtStartup === true) return false;
    if (process.env.TFX_REMOTE_CONTROL !== "1" && !detectDevMode())
      return false;
    s.remoteControlAtStartup = true;
    return true;
  }

  /**
   * SessionStart + PreToolUse 훅 섹션 적용.
   * @param {object} s - settings 객체 (직접 변경)
   * @returns {boolean} 변경 여부
   */
  function applyHooks(s) {
    if (!s.hooks) s.hooks = {};
    let changed = false;

    // ── SessionStart 훅 ──
    if (!Array.isArray(s.hooks.SessionStart)) s.hooks.SessionStart = [];

    const hasTrifluxHooks = s.hooks.SessionStart.some(
      (entry) =>
        Array.isArray(entry.hooks) &&
        entry.hooks.some(
          (h) => typeof h.command === "string" && h.command.includes("triflux"),
        ),
    );

    if (!hasTrifluxHooks) {
      const nodePath = process.execPath.replace(/\\/g, "/");
      const nodeRef = nodePath.includes(" ") ? `"${nodePath}"` : nodePath;
      const pluginRoot = PLUGIN_ROOT.replace(/\\/g, "/");

      s.hooks.SessionStart.push({
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: `${nodeRef} "${pluginRoot}/scripts/setup.mjs"`,
            timeout: 10,
          },
          {
            type: "command",
            command: `${nodeRef} "${pluginRoot}/scripts/hub-ensure.mjs"`,
            timeout: 8,
          },
          {
            type: "command",
            command: `${nodeRef} "${pluginRoot}/scripts/preflight-cache.mjs"`,
            timeout: 5,
          },
        ],
      });
      changed = true;
    }

    // ── PreToolUse 훅: headless-guard (auto-route) ──
    if (!Array.isArray(s.hooks.PreToolUse)) s.hooks.PreToolUse = [];

    const guardScriptPath = join(
      CLAUDE_DIR,
      "scripts",
      "headless-guard-fast.sh",
    ).replace(/\\/g, "/");
    const hasGuardHook = s.hooks.PreToolUse.some(
      (entry) =>
        Array.isArray(entry.hooks) &&
        entry.hooks.some(
          (h) =>
            typeof h.command === "string" &&
            h.command.includes("headless-guard"),
        ),
    );

    if (!hasGuardHook && existsSync(guardScriptPath.replace(/\//g, "\\"))) {
      s.hooks.PreToolUse.push({
        matcher: "Bash|Agent",
        hooks: [
          {
            type: "command",
            command: `bash "${guardScriptPath}"`,
            timeout: 3,
          },
        ],
      });
      changed = true;
    } else if (hasGuardHook) {
      // 기존 훅 경로를 동기화된 경로로 업데이트
      for (const entry of s.hooks.PreToolUse) {
        if (!Array.isArray(entry.hooks)) continue;
        for (const h of entry.hooks) {
          if (
            typeof h.command === "string" &&
            h.command.includes("headless-guard") &&
            !h.command.includes(guardScriptPath)
          ) {
            h.command = `bash "${guardScriptPath}"`;
            changed = true;
          }
        }
      }
    }

    // ── PreToolUse 훅: tfx-gate-activate (Skill 감지 → A+B gate) ──
    const gateScriptPath = join(
      CLAUDE_DIR,
      "scripts",
      "tfx-gate-activate.mjs",
    ).replace(/\\/g, "/");
    const hasGateHook = s.hooks.PreToolUse.some(
      (entry) =>
        Array.isArray(entry.hooks) &&
        entry.hooks.some(
          (h) =>
            typeof h.command === "string" &&
            h.command.includes("tfx-gate-activate"),
        ),
    );

    if (!hasGateHook && existsSync(gateScriptPath.replace(/\//g, "\\"))) {
      s.hooks.PreToolUse.push({
        matcher: "Skill",
        hooks: [
          {
            type: "command",
            command: `node "${gateScriptPath}"`,
            timeout: 2,
          },
        ],
      });
      changed = true;
    } else if (hasGateHook) {
      for (const entry of s.hooks.PreToolUse) {
        if (!Array.isArray(entry.hooks)) continue;
        for (const h of entry.hooks) {
          if (
            typeof h.command === "string" &&
            h.command.includes("tfx-gate-activate") &&
            !h.command.includes(gateScriptPath)
          ) {
            h.command = `node "${gateScriptPath}"`;
            changed = true;
          }
        }
      }
    }

    return changed;
  }

  // 1회 읽기
  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      /* 기존 설정 보존 */
    }
  }

  // 3개 섹션 일괄 수정 (각각 try-catch로 독립 실행)
  let settingsChanged = false;
  try {
    if (applyStatusLine(settings)) {
      settingsChanged = true;
      synced++;
    }
  } catch {}
  try {
    if (applyAgentTeams(settings)) {
      settingsChanged = true;
      synced++;
    }
  } catch {}
  try {
    if (applyRemoteControl(settings)) {
      settingsChanged = true;
      synced++;
    }
  } catch {}
  try {
    if (applyHooks(settings)) {
      settingsChanged = true;
      synced++;
    }
  } catch {}

  // 1회 쓰기
  if (settingsChanged) {
    try {
      writeFileSync(
        settingsPath,
        JSON.stringify(settings, null, 2) + "\n",
        "utf8",
      );
    } catch {
      // settings.json 쓰기 실패 시 무시
    }
  }

  // ── HUD 캐시 pre-warm (백그라운드) ──

  const preWarmHudPath = join(CLAUDE_DIR, "hud", "hud-qos-status.mjs");
  if (existsSync(preWarmHudPath)) {
    const refreshFlags = [
      ["--refresh-claude-usage"],
      ["--refresh-codex-rate-limits"],
      ["--refresh-gemini-quota", "--account", "gemini-main"],
      ["--refresh-gemini-session"],
    ];
    for (const args of refreshFlags) {
      try {
        const child = spawn(process.execPath, [preWarmHudPath, ...args], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        child.unref();
      } catch {
        /* pre-warm 실패 무시 */
      }
    }
    console.log("  \x1b[32m✓\x1b[0m HUD cache pre-warm (background)");
  }

  // ── Stale PID 파일 정리 (hub 좀비 방지) ──

  const HUB_PID_FILE = join(CLAUDE_DIR, "cache", "tfx-hub", "hub.pid");
  if (existsSync(HUB_PID_FILE)) {
    try {
      const pidInfo = JSON.parse(readFileSync(HUB_PID_FILE, "utf8"));
      process.kill(pidInfo.pid, 0); // 프로세스 존재 확인 (신호 미전송)
    } catch {
      try {
        unlinkSync(HUB_PID_FILE);
      } catch {} // 죽은 프로세스면 PID 파일 삭제
      synced++;
    }
  }

  // ── psmux 자동 설치 (Windows, headless 모드용) ──

  if (process.platform === "win32") {
    try {
      execFileSync("where", ["psmux"], { stdio: "ignore" });
    } catch {
      // psmux 미설치 — winget으로 자동 설치 시도
      console.log("  psmux 미설치 — winget으로 설치 중...");
      try {
        execFileSync(
          "winget",
          [
            "install",
            "--id",
            "marlocarlo.psmux",
            "--accept-package-agreements",
            "--accept-source-agreements",
          ],
          {
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 60000,
          },
        );
        console.log("  \x1b[32m✓\x1b[0m psmux 설치 완료");
        synced++;
      } catch {
        console.log(
          "  \x1b[33m⚠\x1b[0m psmux 자동 설치 실패 — 수동 설치: winget install psmux",
        );
      }
    }
  }

  // ── HUD 에러 캐시 자동 클리어 (업데이트/재설치 시) ──

  const cacheDir = join(CLAUDE_DIR, "cache");
  const staleFiles = [
    "claude-usage-cache.json",
    ".claude-refresh-lock",
    "codex-rate-limits-cache.json",
  ];

  for (const name of staleFiles) {
    const fp = join(cacheDir, name);
    if (!existsSync(fp)) continue;
    try {
      const content = readFileSync(fp, "utf8");
      const parsed = JSON.parse(content);
      // 에러 상태이거나 락 파일이면 삭제 → 새 세션에서 fresh start
      if (parsed.error || name.startsWith(".")) {
        unlinkSync(fp);
        synced++;
      }
    } catch {
      // 파싱 실패 파일도 삭제
      try {
        unlinkSync(fp);
      } catch {}
    }
  }

  // ── Windows bash PATH 자동 설정 ──
  // Codex/Gemini가 cmd에는 있지만 bash에서 못 찾는 문제 해결

  if (process.platform === "win32") {
    const npmBin = join(process.env.APPDATA || "", "npm");
    if (existsSync(npmBin)) {
      const bashrcPath = join(homedir(), ".bashrc");
      const pathExport = 'export PATH="$PATH:$APPDATA/npm"';
      let needsUpdate = true;

      if (existsSync(bashrcPath)) {
        const content = readFileSync(bashrcPath, "utf8");
        if (
          content.includes("APPDATA/npm") ||
          content.includes("APPDATA\\npm")
        ) {
          needsUpdate = false;
        }
      }

      if (needsUpdate) {
        const line = `\n# triflux: Codex/Gemini CLI를 bash에서 사용하기 위한 PATH 설정\n${pathExport}\n`;
        try {
          writeFileSync(
            bashrcPath,
            (existsSync(bashrcPath) ? readFileSync(bashrcPath, "utf8") : "") +
              line,
            "utf8",
          );
          synced++;
        } catch {}
      }
    }
  }

  // ── Codex 프로필 자동 보정 ──

  const codexProfilesResult = ensureCodexProfiles();
  if (codexProfilesResult.ok && codexProfilesResult.changed > 0) {
    synced++;
  }

  // ── CLAUDE.md 라우팅 섹션 자동 동기화 ──

  try {
    const routingTable = getLatestRoutingTable();
    const projectResult = ensureTfxSection(
      join(PLUGIN_ROOT, "CLAUDE.md"),
      routingTable,
    );
    if (projectResult.action !== "unchanged") {
      console.log(
        `  \x1b[32m✓\x1b[0m CLAUDE.md (project): ${projectResult.action}`,
      );
      synced++;
    }
    const globalResult = ensureGlobalClaudeRoutingSection(CLAUDE_DIR);
    if (globalResult.action !== "unchanged") {
      console.log(
        `  \x1b[32m✓\x1b[0m CLAUDE.md (global): ${globalResult.action}`,
      );
      synced++;
    }
  } catch (error) {
    console.log(`  \x1b[33m⚠\x1b[0m CLAUDE.md 동기화 실패: ${error.message}`);
  }
  // ── MCP 인벤토리 백그라운드 갱신 ──

  const mcpCheck = join(PLUGIN_ROOT, "scripts", "mcp-check.mjs");
  if (existsSync(mcpCheck)) {
    const child = spawn(process.execPath, [mcpCheck], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref(); // 부모 프로세스와 분리 — 비동기 실행
  }

  // ── /tmp 임시 파일 자동 정리 (setup 지연 방지: fire-and-forget) ──
  cleanupTmpFiles().catch(() => {});

  // ── npm 글로벌 패키지 동기화 ──
  // dev mode가 아닌 경우(npm install로 설치), 글로벌 triflux 패키지 버전을 확인하고
  // 로컬 버전과 다르면 업데이트를 안내한다. dev mode에서는 git 기반이므로 skip.
  if (pkgVersion && !isDev) {
    try {
      const globalVer = execFileSync(
        "npm",
        ["list", "-g", "triflux", "--json", "--depth=0"],
        {
          encoding: "utf8",
          timeout: 10000,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const parsed = JSON.parse(globalVer);
      const installedVer = parsed?.dependencies?.triflux?.version;
      if (installedVer && installedVer !== pkgVersion) {
        const tag = pkgVersion.includes("alpha") ? "alpha" : "latest";
        console.log(
          `  npm: triflux global ${installedVer} → ${pkgVersion} (npm i -g triflux@${tag})`,
        );
      }
    } catch {
      // npm list 실패 = 글로벌 미설치. 안내만 출력.
      if (pkgVersion.includes("alpha")) {
        console.log(
          "  npm: triflux global 미설치 (npm i -g triflux@alpha 로 설치 가능)",
        );
      }
    }
  }

  if (pkgVersion) {
    writeMarker({ version: pkgVersion, timestamp: Date.now() });
  }

  // ── postinstall 배너 (npm install 시에만 출력) ──

  if (process.env.npm_lifecycle_event === "postinstall") {
    const G = "\x1b[32m";
    const C = "\x1b[36m";
    const Y = "\x1b[33m";
    const D = "\x1b[2m";
    const B = "\x1b[1m";
    const R = "\x1b[0m";

    const ver = (() => {
      return pkgVersion || "?";
    })();

    console.log(`
${B}╔═══════════════════════════════════════════════╗${R}
${B}║${R}  ${C}triflux${R} ${D}v${ver}${R} ${B}— Setup Complete${R}             ${B}║${R}
${B}╚═══════════════════════════════════════════════╝${R}

  ${G}✓${R} tfx-route.sh     → ~/.claude/scripts/
  ${G}✓${R} hud-qos-status   → ~/.claude/hud/
  ${G}✓${R} ${synced > 0 ? synced + " files synced" : "all files up to date"}
  ${G}✓${R} HUD statusLine   → settings.json

${B}Commands:${R}
  ${C}triflux${R} setup     파일 동기화 + HUD 설정
  ${C}triflux${R} doctor    CLI 진단 (Codex/Gemini 확인)
  ${C}triflux${R} list      설치된 스킬 목록
  ${C}triflux${R} update    최신 안정 버전으로 업데이트
  ${C}triflux${R} update --dev  dev 채널로 업데이트 (${D}dev 별칭 지원${R})

${B}Shortcuts:${R}
  ${C}tfx${R}                 triflux 축약
  ${C}tfx-setup${R}            triflux setup
  ${C}tfx-doctor${R}           triflux doctor

${B}Skills (Claude Code):${R}
  ${C}/tfx-auto${R}   "작업"   자동 분류 + 병렬 실행
  ${C}/tfx-auto-codex${R} "작업" Codex 리드 + Gemini 유지
  ${C}/tfx-codex${R}  "작업"   Codex 전용 모드
  ${C}/tfx-gemini${R} "작업"   Gemini 전용 모드
  ${C}/tfx-setup${R}           HUD 설정 + 진단

${Y}!${R} 세션 재시작 후 스킬이 활성화됩니다
${D}https://github.com/tellang/triflux${R}
`);
  }

  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
