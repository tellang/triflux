#!/usr/bin/env node
// triflux 세션 시작 시 자동 설정 스크립트
// - tfx-route.sh를 ~/.claude/scripts/에 동기화
// - hud-qos-status.mjs를 ~/.claude/hud/에 동기화
// - skills/를 ~/.claude/skills/에 동기화

import { copyFileSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, chmodSync, unlinkSync, rmSync } from "fs";
import { join, dirname, basename } from "path";
import { homedir } from "os";
import { spawn, execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { cleanupTmpFiles } from "./tmp-cleanup.mjs";
import { buildAll as buildCacheWarmup } from "./cache-warmup.mjs";
import { ensureGeminiProfiles } from "./lib/gemini-profiles.mjs";
import { loadRegistry, remediate, scanForStdioServers } from "./lib/mcp-guard-engine.mjs";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLAUDE_DIR = join(homedir(), ".claude");
const CODEX_DIR = join(homedir(), ".codex");
const CODEX_CONFIG_PATH = join(CODEX_DIR, "config.toml");

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
    lines: [
      'model = "gpt-5.3-codex"',
      'model_reasoning_effort = "high"',
    ],
  },
  {
    name: "codex53_xhigh",
    lines: [
      'model = "gpt-5.3-codex"',
      'model_reasoning_effort = "xhigh"',
    ],
  },
  {
    name: "spark53_low",
    lines: [
      'model = "gpt-5.3-codex-spark"',
      'model_reasoning_effort = "low"',
    ],
    proOnly: true, // Pro 플랜 전용 — Plus/기본에서는 미동작
  },
];

const SKILL_ALIASES = [
  {
    alias: "tfx-ralph",
    source: "tfx-persist",
  },
];

/** 패키지에서 제거된 스킬 목록 — setup/update 시 ~/.claude/skills/에서 자동 삭제 */
const DEPRECATED_SKILLS = [
  "tfx-eval",
  "tfx-learn",
  "tfx-wrapup",
];

/** 마이그레이션 대상 구형 Codex 모델 — 이 모델을 사용하는 프로필을 감지하여 안내 */
const LEGACY_CODEX_MODELS = ["o4-mini", "o3", "o3-pro", "o1", "o1-mini", "o1-pro", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "codex-mini-latest"];

/**
 * ~/.claude/skills/ 에서 패키지에 없는 stale tfx-* 스킬을 제거한다.
 * @param {string} skillsDst - ~/.claude/skills/ 경로
 * @param {string} skillsSrc - 패키지의 skills/ 경로
 * @returns {{ removed: string[], count: number }}
 */
function cleanupStaleSkills(skillsDst, skillsSrc) {
  const removed = [];
  if (!existsSync(skillsDst)) return { removed, count: 0 };

  const packageSkills = new Set();
  if (existsSync(skillsSrc)) {
    for (const name of readdirSync(skillsSrc)) {
      packageSkills.add(name);
    }
  }
  // aliases도 유효한 스킬로 등록
  for (const { alias } of SKILL_ALIASES) {
    packageSkills.add(alias);
  }

  for (const name of readdirSync(skillsDst)) {
    // tfx- 접두사가 아닌 스킬은 사용자 커스텀 — 건드리지 않음
    if (!name.startsWith("tfx-")) continue;
    if (packageSkills.has(name)) continue;

    // 패키지에 없는 tfx-* 스킬 → 삭제
    const skillDir = join(skillsDst, name);
    try {
      rmSync(skillDir, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // 삭제 실패 시 무시
    }
  }
  return { removed, count: removed.length };
}

function buildAliasedSkillContent(srcContent, { alias, source }) {
  return srcContent
    .replace(/^name:\s*.+$/m, `name: ${alias}`)
    .replaceAll(source, alias)
    .replace(/^#\s+.+$/m, `# ${alias} — Compatibility Alias for ${source}`);
}

function syncAliasedSkillDir(srcDir, dstDir, { alias, source }) {
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

    const rawContent = readFileSync(srcPath, "utf8");
    const nextContent = entry.name === "SKILL.md"
      ? buildAliasedSkillContent(rawContent, { alias, source })
      : rawContent;

    if (!existsSync(dstPath) || readFileSync(dstPath, "utf8") !== nextContent) {
      writeFileSync(dstPath, nextContent, "utf8");
      count++;
    }
  }

  return count;
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
  {
    src: join(PLUGIN_ROOT, "scripts", "mcp-cleanup.ps1"),
    dst: join(CLAUDE_DIR, "scripts", "mcp-cleanup.ps1"),
    label: "mcp-cleanup.ps1",
  },
  {
    src: join(PLUGIN_ROOT, "hud", "hud-qos-status.mjs"),
    dst: join(CLAUDE_DIR, "hud", "hud-qos-status.mjs"),
    label: "hud-qos-status.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "hud", "colors.mjs"),
    dst: join(CLAUDE_DIR, "hud", "colors.mjs"),
    label: "hud/colors.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "hud", "constants.mjs"),
    dst: join(CLAUDE_DIR, "hud", "constants.mjs"),
    label: "hud/constants.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "hud", "terminal.mjs"),
    dst: join(CLAUDE_DIR, "hud", "terminal.mjs"),
    label: "hud/terminal.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "hud", "utils.mjs"),
    dst: join(CLAUDE_DIR, "hud", "utils.mjs"),
    label: "hud/utils.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "hud", "renderers.mjs"),
    dst: join(CLAUDE_DIR, "hud", "renderers.mjs"),
    label: "hud/renderers.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "hud", "providers", "claude.mjs"),
    dst: join(CLAUDE_DIR, "hud", "providers", "claude.mjs"),
    label: "hud/providers/claude.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "hud", "providers", "codex.mjs"),
    dst: join(CLAUDE_DIR, "hud", "providers", "codex.mjs"),
    label: "hud/providers/codex.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "hud", "providers", "gemini.mjs"),
    dst: join(CLAUDE_DIR, "hud", "providers", "gemini.mjs"),
    label: "hud/providers/gemini.mjs",
  },
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
    src: join(PLUGIN_ROOT, "scripts", "lib", "mcp-manifest.mjs"),
    dst: join(CLAUDE_DIR, "scripts", "lib", "mcp-manifest.mjs"),
    label: "lib/mcp-manifest.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "scripts", "lib", "hook-utils.mjs"),
    dst: join(CLAUDE_DIR, "scripts", "lib", "hook-utils.mjs"),
    label: "lib/hook-utils.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "scripts", "psmux-safety-guard.mjs"),
    dst: join(CLAUDE_DIR, "scripts", "psmux-safety-guard.mjs"),
    label: "psmux-safety-guard.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "scripts", "lib", "cross-review-utils.mjs"),
    dst: join(CLAUDE_DIR, "scripts", "lib", "cross-review-utils.mjs"),
    label: "lib/cross-review-utils.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "scripts", "lib", "keyword-rules.mjs"),
    dst: join(CLAUDE_DIR, "scripts", "lib", "keyword-rules.mjs"),
    label: "lib/keyword-rules.mjs",
  },
  {
    src: join(PLUGIN_ROOT, "scripts", "lib", "gemini-profiles.mjs"),
    dst: join(CLAUDE_DIR, "scripts", "lib", "gemini-profiles.mjs"),
    label: "lib/gemini-profiles.mjs",
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    if (process.platform === "win32" && !updated.includes('[windows]')) {
      if (updated.length > 0 && !updated.endsWith("\n")) updated += "\n";
      updated += "\n[windows]\nsandbox = \"elevated\"\n";
      changed++;
    }

    if (changed > 0) {
      writeFileSync(CODEX_CONFIG_PATH, updated, "utf8");
    }

    return { ok: true, changed };
  } catch (error) {
    return { ok: false, changed: 0, message: error.message };
  }
}

const WINDOWS_DEFAULT_NODE_PATH = "C:/Program Files/nodejs/node.exe";
const MANAGED_HOOK_FILENAMES = new Set([
  "safety-guard.mjs",
  "agent-route-guard.mjs",
  "cross-review-tracker.mjs",
  "error-context.mjs",
  "keyword-detector.mjs",
  "pipeline-stop.mjs",
  "subagent-verifier.mjs",
]);

function toForwardPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function quotePath(value) {
  return `"${toForwardPath(value)}"`;
}

function normalizeCommand(value) {
  return toForwardPath(value).replace(/\s+/g, " ").trim();
}

function extractManagedHookFilename(command) {
  if (typeof command !== "string") return null;
  const matches = command.match(/[A-Za-z0-9._-]+\.mjs/g) || [];
  for (const match of matches) {
    const fileName = basename(match);
    if (MANAGED_HOOK_FILENAMES.has(fileName)) return fileName;
  }
  return null;
}

function isValidManagedHookRoot(candidateRoot) {
  if (typeof candidateRoot !== "string" || !candidateRoot.trim()) return false;
  const root = candidateRoot.trim();
  if (!existsSync(join(root, "hooks", "hook-registry.json"))) return false;
  if (!existsSync(join(root, "scripts", "run.cjs"))) return false;
  if (!existsSync(join(root, "scripts", "keyword-detector.mjs"))) return false;

  for (const fileName of MANAGED_HOOK_FILENAMES) {
    if (!existsSync(join(root, "hooks", fileName))) return false;
  }

  return true;
}

function resolveHookPluginRoot() {
  const envRoot = process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT;
  if (isValidManagedHookRoot(envRoot)) {
    return toForwardPath(envRoot.trim());
  }

  try {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const npmGlobalRoot = execFileSync(npmCmd, ["root", "-g"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    const npmPluginRoot = npmGlobalRoot ? join(npmGlobalRoot, "triflux") : "";
    if (isValidManagedHookRoot(npmPluginRoot)) {
      return toForwardPath(npmPluginRoot);
    }
  } catch {
    // npm global root 조회 실패 시 로컬 패키지 루트를 fallback으로 사용
  }

  return toForwardPath(PLUGIN_ROOT);
}

function resolveManagedNodePath() {
  if (process.platform === "win32" && existsSync(WINDOWS_DEFAULT_NODE_PATH)) {
    return toForwardPath(WINDOWS_DEFAULT_NODE_PATH);
  }
  return toForwardPath(process.execPath || "node");
}

function buildManagedHookCommand(fileName, { pluginRoot, nodePath }) {
  if (fileName === "keyword-detector.mjs") {
    const runScript = join(pluginRoot, "scripts", "run.cjs");
    const detectorScript = join(pluginRoot, "scripts", "keyword-detector.mjs");
    return `${quotePath(nodePath)} ${quotePath(runScript)} ${quotePath(detectorScript)}`;
  }
  const hookPath = join(pluginRoot, "hooks", fileName);
  return `${quotePath(nodePath)} ${quotePath(hookPath)}`;
}

function getManagedRegistryHooks(registryPath = join(PLUGIN_ROOT, "hooks", "hook-registry.json")) {
  if (!existsSync(registryPath)) return [];

  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch {
    return [];
  }

  const hooks = [];
  for (const [event, eventEntries] of Object.entries(registry.events || {})) {
    if (!Array.isArray(eventEntries)) continue;

    for (const eventEntry of eventEntries) {
      if (!eventEntry || eventEntry.enabled === false || eventEntry.source !== "triflux") continue;
      const fileName = extractManagedHookFilename(eventEntry.command);
      if (!fileName) continue;

      hooks.push({
        id: String(eventEntry.id || fileName.replace(/\.mjs$/i, "")),
        event: String(event),
        matcher: String(eventEntry.matcher || "*"),
        fileName,
        timeout: Number.isFinite(eventEntry.timeout) ? eventEntry.timeout : undefined,
        blocking: typeof eventEntry.blocking === "boolean" ? eventEntry.blocking : undefined,
        priority: Number.isFinite(eventEntry.priority) ? eventEntry.priority : undefined,
      });
    }
  }

  return hooks;
}

function ensureHooksInSettings({
  settingsPath = join(homedir(), ".claude", "settings.json"),
  registryPath = join(PLUGIN_ROOT, "hooks", "hook-registry.json"),
  pluginRoot = resolveHookPluginRoot(),
  nodePath = resolveManagedNodePath(),
} = {}) {
  const managedHooks = getManagedRegistryHooks(registryPath);
  if (managedHooks.length === 0) {
    return {
      ok: false,
      changed: false,
      total: 0,
      added: [],
      reason: "registry_unavailable",
    };
  }

  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch (error) {
      return {
        ok: false,
        changed: false,
        total: managedHooks.length,
        added: [],
        reason: `settings_parse_failed:${error.message}`,
      };
    }
  }
  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};

  // ── 이중 실행 정리: orchestrator가 있는 이벤트에서 개별 훅 엔트리 제거 ──
  let dedupRemoved = 0;
  for (const [event, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(entries)) continue;
    const hasOrch = entries.some((e) =>
      Array.isArray(e?.hooks) &&
      e.hooks.some((h) => typeof h?.command === "string" && h.command.includes("hook-orchestrator")),
    );
    if (!hasOrch) continue;
    const before = entries.length;
    settings.hooks[event] = entries.filter((e) =>
      Array.isArray(e?.hooks) &&
      e.hooks.some((h) => typeof h?.command === "string" && h.command.includes("hook-orchestrator")),
    );
    dedupRemoved += before - settings.hooks[event].length;
  }

  const added = [];
  for (const hookSpec of managedHooks) {
    if (!Array.isArray(settings.hooks[hookSpec.event])) settings.hooks[hookSpec.event] = [];
    const eventEntries = settings.hooks[hookSpec.event];

    // hook-orchestrator가 이미 등록된 이벤트는 건너뜀.
    // orchestrator가 hook-registry.json에서 체이닝하므로 개별 등록하면 이중 실행됨.
    const hasOrchestrator = eventEntries.some((entry) =>
      Array.isArray(entry.hooks) &&
      entry.hooks.some((hook) =>
        typeof hook?.command === "string" && hook.command.includes("hook-orchestrator"),
      ),
    );
    if (hasOrchestrator) continue;

    const expectedCommand = buildManagedHookCommand(hookSpec.fileName, { pluginRoot, nodePath });
    const expectedNormalizedCommand = normalizeCommand(expectedCommand);

    // 중복 체크: (1) 정확한 command 일치 또는 (2) 같은 파일명의 훅이 이미 등록됨
    const hasSameMatcherAndCommand = eventEntries.some((entry) =>
      entry?.matcher === hookSpec.matcher &&
      Array.isArray(entry.hooks) &&
      entry.hooks.some((hook) => {
        if (normalizeCommand(hook?.command) === expectedNormalizedCommand) return true;
        // pluginRoot가 달라도 같은 훅 파일이면 중복으로 판단
        const existingFileName = extractManagedHookFilename(hook?.command);
        return existingFileName === hookSpec.fileName;
      }),
    );
    if (hasSameMatcherAndCommand) continue;

    const hookEntry = {
      type: "command",
      command: expectedCommand,
    };
    if (Number.isFinite(hookSpec.timeout)) hookEntry.timeout = hookSpec.timeout;
    if (typeof hookSpec.blocking === "boolean") hookEntry.blocking = hookSpec.blocking;
    if (Number.isFinite(hookSpec.priority)) hookEntry.priority = hookSpec.priority;

    const matcherEntry = eventEntries.find(
      (entry) => entry?.matcher === hookSpec.matcher && Array.isArray(entry.hooks),
    );
    if (matcherEntry) {
      matcherEntry.hooks.push(hookEntry);
    } else {
      eventEntries.push({ matcher: hookSpec.matcher, hooks: [hookEntry] });
    }

    added.push({
      id: hookSpec.id,
      event: hookSpec.event,
      matcher: hookSpec.matcher,
      fileName: hookSpec.fileName,
    });
  }

  if (added.length === 0 && dedupRemoved === 0) {
    return {
      ok: true,
      changed: false,
      total: managedHooks.length,
      added: [],
      dedupRemoved: 0,
    };
  }

  // 중복 제거만 발생한 경우에도 저장 필요
  if (added.length === 0 && dedupRemoved > 0) {
    try {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
    } catch (error) {
      return {
        ok: false,
        changed: false,
        total: managedHooks.length,
        added: [],
        dedupRemoved,
        reason: `settings_write_failed:${error.message}`,
      };
    }
    return {
      ok: true,
      changed: true,
      total: managedHooks.length,
      added: [],
      dedupRemoved,
    };
  }

  let backupPath = null;
  try {
    if (existsSync(settingsPath)) {
      backupPath = `${settingsPath}.bak.${Date.now()}`;
      copyFileSync(settingsPath, backupPath);
    } else {
      const settingsDir = dirname(settingsPath);
      if (!existsSync(settingsDir)) mkdirSync(settingsDir, { recursive: true });
    }
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  } catch (error) {
    return {
      ok: false,
      changed: false,
      total: managedHooks.length,
      added,
      backupPath,
      reason: `settings_write_failed:${error.message}`,
    };
  }

  return {
    ok: true,
    changed: true,
    total: managedHooks.length,
    added,
    backupPath,
  };
}

export {
  replaceProfileSection, hasProfileSection, escapeRegExp, detectDevMode,
  SYNC_MAP, BREADCRUMB_PATH, PLUGIN_ROOT, CLAUDE_DIR,
  SKILL_ALIASES, REQUIRED_CODEX_PROFILES,
  DEPRECATED_SKILLS, LEGACY_CODEX_MODELS,
  buildAliasedSkillContent, syncAliasedSkillDir, getVersion, ensureCodexProfiles,
  cleanupStaleSkills, extractManagedHookFilename, getManagedRegistryHooks, ensureHooksInSettings,
};

function runMcpGuardAudit() {
  let registry;
  try {
    registry = loadRegistry();
  } catch (error) {
    return {
      audited: 0,
      modified: 0,
      messages: [`[mcp-guard] registry 로드 실패: ${error.message}`],
    };
  }

  const watchedPaths = Array.isArray(registry?.policies?.watched_paths)
    ? registry.policies.watched_paths
    : [];

  const messages = [];
  let modified = 0;

  for (const watchedPath of watchedPaths) {
    const stdioServers = scanForStdioServers(watchedPath);
    if (stdioServers.length === 0) continue;

    const result = remediate(watchedPath, stdioServers, registry.policies);
    if (result.modified) {
      modified++;
      const serverNames = stdioServers.map((server) => server.name).join(", ");
      messages.push(`[mcp-guard] ${watchedPath}: stdio MCP 자동 정리 (${serverNames})`);
      if (result.replacement?.name && result.replacement?.url) {
        messages.push(`[mcp-guard] ${watchedPath}: ${result.replacement.name} -> ${result.replacement.url}`);
      }
      if (result.backupPath) {
        messages.push(`[mcp-guard] ${watchedPath}: 백업 ${result.backupPath}`);
      }
    }

    for (const warning of result.warnings || []) {
      messages.push(`${warning} (${watchedPath})`);
    }
  }

  return {
    audited: watchedPaths.length,
    modified,
    messages,
  };
}

async function main() {
const isSync = process.argv.includes("--sync");
const isDev = detectDevMode();

if (isDev) {
  console.log("  [dev] \uB85C\uCEEC \uAC1C\uBC1C \uBAA8\uB4DC \uAC10\uC9C0");
}

if (isSync) {
  console.log("  [sync] \uBA85\uC2DC\uC801 \uC7AC\uB3D9\uAE30\uD654 \uC2E4\uD589");
}

let synced = 0;

for (const { src, dst, label } of SYNC_MAP) {
  if (!existsSync(src)) continue;

  const dstDir = dirname(dst);
  if (!existsSync(dstDir)) {
    mkdirSync(dstDir, { recursive: true });
  }

  if (!existsSync(dst)) {
    copyFileSync(src, dst);
    try { chmodSync(dst, 0o755); } catch {}
    synced++;
  } else {
    if (shouldSyncTextFile(src, dst)) {
      copyFileSync(src, dst);
      try { chmodSync(dst, 0o755); } catch {}
      synced++;
    }
  }
}

// ── Worker 의존성 동기화 (MCP SDK + transitive deps) ──

const workerNodeModules = join(CLAUDE_DIR, "scripts", "node_modules");
const mcpSdkPath = join(workerNodeModules, "@modelcontextprotocol", "sdk");
const srcNodeModules = join(PLUGIN_ROOT, "node_modules");

// native 모듈은 제외 (플랫폼 의존적, worker에서 불필요)
const SKIP_PACKAGES = new Set(["better-sqlite3", "prebuild-install", "node-abi", "node-addon-api"]);

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
    if (!existsSync(breadcrumbDir)) mkdirSync(breadcrumbDir, { recursive: true });
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

  for (const { alias, source } of SKILL_ALIASES) {
    const sourceDir = join(skillsSrc, source);
    const sourceSkillMd = join(sourceDir, "SKILL.md");
    if (!existsSync(sourceSkillMd)) continue;
    synced += syncAliasedSkillDir(sourceDir, join(skillsDst, alias), { alias, source });
  }
}

// ── docs 동기화 ──
const docsDirs = ['docs/design', 'docs/research'];
for (const dir of docsDirs) {
  const src = join(PLUGIN_ROOT, dir);
  const dest = join(CLAUDE_DIR, dir);
  if (existsSync(src)) {
    mkdirSync(dest, { recursive: true });
    for (const f of readdirSync(src).filter(f => f.endsWith('.md'))) {
      copyFileSync(join(src, f), join(dest, f));
    }
  }
}

// ── MCP 설정 감사 및 stdio 가드 적용 ──
const mcpAudit = runMcpGuardAudit();
if (mcpAudit.modified > 0) {
  synced += mcpAudit.modified;
}
for (const message of mcpAudit.messages) {
  console.log(`  ${message}`);
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
  if (process.env.TFX_REMOTE_CONTROL !== "1" && !detectDevMode()) return false;
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

  const hasTrifluxHooks = s.hooks.SessionStart.some((entry) =>
    Array.isArray(entry.hooks) &&
    entry.hooks.some((h) => typeof h.command === "string" && h.command.includes("triflux")),
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
          command: `${nodeRef} "${pluginRoot}/scripts/mcp-gateway-ensure.mjs"`,
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

  // ── Stop 훅: MCP 고아 프로세스 정리 (Windows 전용) ──
  if (process.platform === "win32") {
    if (!Array.isArray(s.hooks.Stop)) s.hooks.Stop = [];

    const cleanupScriptPath = join(CLAUDE_DIR, "scripts", "mcp-cleanup.ps1").replace(/\\/g, "/");
    const hasCleanupHook = s.hooks.Stop.some((entry) =>
      Array.isArray(entry.hooks) &&
      entry.hooks.some((h) => typeof h.command === "string" && h.command.includes("mcp-cleanup")),
    );

    if (!hasCleanupHook && existsSync(cleanupScriptPath.replace(/\//g, "\\"))) {
      // 기존 Stop 엔트리가 있으면 거기에 추가, 없으면 새 엔트리 생성
      const existingEntry = s.hooks.Stop.find((entry) => entry.matcher === "*" && Array.isArray(entry.hooks));
      const cleanupHook = {
        type: "command",
        command: `powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${cleanupScriptPath}"`,
        timeout: 8,
      };

      if (existingEntry) {
        existingEntry.hooks.push(cleanupHook);
      } else {
        s.hooks.Stop.push({ matcher: "*", hooks: [cleanupHook] });
      }
      changed = true;
    } else if (hasCleanupHook) {
      for (const entry of s.hooks.Stop) {
        if (!Array.isArray(entry.hooks)) continue;
        for (const h of entry.hooks) {
          if (typeof h.command === "string" && h.command.includes("mcp-cleanup") && !h.command.includes(cleanupScriptPath)) {
            h.command = `powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${cleanupScriptPath}"`;
            changed = true;
          }
        }
      }
    }
  }

  // ── PreToolUse 훅: headless-guard (auto-route) ──
  if (!Array.isArray(s.hooks.PreToolUse)) s.hooks.PreToolUse = [];

  const guardScriptPath = join(CLAUDE_DIR, "scripts", "headless-guard-fast.sh").replace(/\\/g, "/");
  const hasGuardHook = s.hooks.PreToolUse.some((entry) =>
    Array.isArray(entry.hooks) &&
    entry.hooks.some((h) => typeof h.command === "string" && h.command.includes("headless-guard")),
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
        if (typeof h.command === "string" && h.command.includes("headless-guard") && !h.command.includes(guardScriptPath)) {
          h.command = `bash "${guardScriptPath}"`;
          changed = true;
        }
      }
    }
  }

  // ── PreToolUse 훅: tfx-gate-activate (Skill 감지 → A+B gate) ──
  const gateScriptPath = join(CLAUDE_DIR, "scripts", "tfx-gate-activate.mjs").replace(/\\/g, "/");
  const hasGateHook = s.hooks.PreToolUse.some((entry) =>
    Array.isArray(entry.hooks) &&
    entry.hooks.some((h) => typeof h.command === "string" && h.command.includes("tfx-gate-activate")),
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
        if (typeof h.command === "string" && h.command.includes("tfx-gate-activate") && !h.command.includes(gateScriptPath)) {
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
  try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { /* 기존 설정 보존 */ }
}

// 3개 섹션 일괄 수정 (각각 try-catch로 독립 실행)
let settingsChanged = false;
try { if (applyStatusLine(settings)) { settingsChanged = true; synced++; } } catch {}
try { if (applyAgentTeams(settings)) { settingsChanged = true; synced++; } } catch {}
try { if (applyRemoteControl(settings)) { settingsChanged = true; synced++; } } catch {}
try { if (applyHooks(settings)) { settingsChanged = true; synced++; } } catch {}

// 1회 쓰기
if (settingsChanged) {
  try {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  } catch {
    // settings.json 쓰기 실패 시 무시
  }
}

// ── hook-registry 기반 누락 훅 자동 등록 ──
{
  const hookEnsureResult = ensureHooksInSettings();
  if (hookEnsureResult.changed) synced++;
  if (hookEnsureResult.dedupRemoved > 0) {
    console.log(`  ✓ 중복 훅 ${hookEnsureResult.dedupRemoved}개 엔트리 자동 제거 (orchestrator 체이닝)`);
  }
}

// ── Stale PID 파일 정리 (hub 좀비 방지) ──

const HUB_PID_FILE = join(CLAUDE_DIR, "cache", "tfx-hub", "hub.pid");
if (existsSync(HUB_PID_FILE)) {
  try {
    const pidInfo = JSON.parse(readFileSync(HUB_PID_FILE, "utf8"));
    process.kill(pidInfo.pid, 0); // 프로세스 존재 확인 (신호 미전송)
  } catch {
    try { unlinkSync(HUB_PID_FILE); } catch {} // 죽은 프로세스면 PID 파일 삭제
    synced++;
  }
}

// ── psmux 자동 설치 (Windows, headless 모드용) ──
// psmux: Windows용 터미널 멀티플렉서. Codex/Gemini CLI를 병렬 세션으로 실행할 때 필요.
// 없어도 triflux 기본 기능은 동작하지만, headless 멀티모델 오케스트레이션이 비활성화됨.

let psmuxInstalled = false;
if (process.platform === "win32") {
  try {
    execFileSync("where", ["psmux"], { stdio: "ignore" });
    psmuxInstalled = true;
  } catch {
    // psmux 미설치 — winget으로 자동 설치 시도
    console.log("  psmux 미설치 — 자동 설치 시도 중...");
    try {
      execFileSync("winget", ["install", "--id", "marlocarlo.psmux", "--accept-package-agreements", "--accept-source-agreements"], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60000,
      });
      console.log("  \x1b[32m✓\x1b[0m psmux 설치 완료");
      psmuxInstalled = true;
      synced++;
    } catch {
      console.log([
        "  \x1b[33m⚠\x1b[0m psmux 자동 설치 실패 — 수동 설치 방법:",
        "    \x1b[36m옵션 1:\x1b[0m winget install marlocarlo.psmux",
        "    \x1b[36m옵션 2:\x1b[0m scoop install psmux",
        "    \x1b[36m옵션 3:\x1b[0m npm install -g psmux",
        "  \x1b[2m(없어도 기본 기능은 동작합니다 — 멀티모델 병렬 실행만 비활성화)\x1b[0m",
      ].join("\n"));
    }
  }
} else {
  // non-Windows: tmux 사용 (psmux 불필요)
  psmuxInstalled = true;
}

// ── psmux 기본 셸 자동 수정 (cmd.exe → PowerShell) ──
if (psmuxInstalled && process.platform === "win32") {
  try {
    const shellOut = execFileSync("psmux", ["show-options", "-g", "default-shell"], { encoding: "utf8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (!/powershell|pwsh/i.test(shellOut)) {
      // pwsh(7) 우선, powershell.exe(5) fallback
      let pwsh = "";
      try { execFileSync("where", ["pwsh"], { stdio: "ignore" }); pwsh = "pwsh"; } catch {
        try { execFileSync("where", ["powershell.exe"], { stdio: "ignore" }); pwsh = "powershell.exe"; } catch {}
      }
      if (pwsh) {
        execFileSync("psmux", ["set-option", "-g", "default-shell", pwsh], { timeout: 3000, stdio: "ignore" });
        console.log(`  \x1b[32m✓\x1b[0m psmux 기본 셸 → ${pwsh}`);
        synced++;
      }
    }
  } catch {
    // psmux show-options 미지원 또는 서버 미실행 — 무시
  }
}

// ── stale 스킬 정리 (패키지에서 제거된 tfx-* 스킬 삭제) ──
{
  const skillsDst = join(CLAUDE_DIR, "skills");
  const skillsSrc = join(PLUGIN_ROOT, "skills");
  const cleanup = cleanupStaleSkills(skillsDst, skillsSrc);
  if (cleanup.count > 0) {
    console.log(`  \x1b[32m✓\x1b[0m ${cleanup.count}개 구형 스킬 제거: ${cleanup.removed.join(", ")}`);
    synced++;
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
    try { unlinkSync(fp); } catch {}
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
      if (content.includes("APPDATA/npm") || content.includes("APPDATA\\npm")) {
        needsUpdate = false;
      }
    }

    if (needsUpdate) {
      const line = `\n# triflux: Codex/Gemini CLI를 bash에서 사용하기 위한 PATH 설정\n${pathExport}\n`;
      try {
        writeFileSync(bashrcPath, (existsSync(bashrcPath) ? readFileSync(bashrcPath, "utf8") : "") + line, "utf8");
        synced++;
      } catch {}
    }
  }
}

// ── Codex 프로필 자동 보정 ──

const codexProfileResult = ensureCodexProfiles();
if (codexProfileResult.changed > 0) {
  synced++;
}

// ── Gemini 프로필 자동 보정 ──

const geminiProfilesAdded = ensureGeminiProfiles().added;
if (geminiProfilesAdded > 0) {
  synced++;
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

// ── Step 6. 캐시 웜업 Phase 1 ──

try {
  buildCacheWarmup({
    cwd: process.cwd(),
    ttlMs: 5 * 60 * 1000,
  });
} catch {
  // cache-warmup 실패는 setup 전체를 막지 않는다
}

// ── /tmp 임시 파일 자동 정리 (setup 지연 방지: fire-and-forget) ──
cleanupTmpFiles().catch(() => {});

// ── postinstall 배너 (npm install 시에만 출력) ──

if (process.env.npm_lifecycle_event === "postinstall") {
  const G = "\x1b[32m";
  const C = "\x1b[36m";
  const Y = "\x1b[33m";
  const D = "\x1b[2m";
  const B = "\x1b[1m";
  const R = "\x1b[0m";

  const ver = (() => {
    try {
      return JSON.parse(readFileSync(join(PLUGIN_ROOT, "package.json"), "utf8")).version;
    } catch { return "?"; }
  })();

  console.log(`
${B}╔═══════════════════════════════════════════════╗${R}
${B}║${R}  ${C}triflux${R} ${D}v${ver}${R} ${B}— Setup Complete${R}             ${B}║${R}
${B}╚═══════════════════════════════════════════════╝${R}

  ${G}✓${R} tfx-route.sh     → ~/.claude/scripts/
  ${G}✓${R} hud-qos-status   → ~/.claude/hud/
  ${G}✓${R} ${synced > 0 ? synced + " files synced" : "all files up to date"}
  ${G}✓${R} HUD statusLine   → settings.json
  ${psmuxInstalled ? `${G}✓${R} psmux            → headless 멀티모델 오케스트레이션` : `${Y}○${R} psmux 미설치     → ${D}winget install marlocarlo.psmux${R} ${D}(선택)${R}`}

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

  // ── GitHub Star 체크 (비인터랙티브 — postinstall에서는 confirm 불가) ──
  try {
    execFileSync("gh", ["auth", "status"], { timeout: 5000, stdio: ["pipe", "pipe", "pipe"] });
    try {
      execFileSync("gh", ["api", "user/starred/tellang/triflux"], { timeout: 5000, stdio: ["pipe", "pipe", "pipe"] });
      console.log(`  ${G}⭐${R} 이미 함께하고 계시군요.`);
    } catch {
      console.log(`  ${Y}⭐${R} 하나가 큰 차이를 만듭니다. ${D}https://github.com/tellang/triflux${R}`);
    }
  } catch {
    // gh 미설치/미인증 — 무시
  }
}

process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
