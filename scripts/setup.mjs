#!/usr/bin/env node
// triflux 세션 시작 시 자동 설정 스크립트
// - tfx-route.sh를 ~/.claude/scripts/에 동기화
// - hud-qos-status.mjs를 ~/.claude/hud/에 동기화
// - skills/를 ~/.claude/skills/에 동기화

import { copyFileSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, chmodSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { spawn, execFileSync } from "child_process";
import { fileURLToPath } from "url";
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
  },
];

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
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, "package.json"), "utf8")).version;
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
  writeFileSync(SETUP_MARKER_PATH, JSON.stringify(marker, null, 2) + "\n", "utf8");
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

    return changed;
  } catch {
    return 0;
  }
}

export {
  replaceProfileSection,
  hasProfileSection,
  detectDevMode,
  SYNC_MAP,
  BREADCRUMB_PATH,
  PLUGIN_ROOT,
  CLAUDE_DIR,
  SETUP_MARKER_PATH,
  readMarker,
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
  console.log("  [sync] \uBA85\uC2DC\uC801 \uC7AC\uB3D9\uAE30\uD654 \uC2E4\uD589");
}

const pkgVersion = getPackageVersion();
const marker = readMarker();
if (pkgVersion && marker?.version === pkgVersion && !isForce) {
  console.log(`setup: skip (v${pkgVersion} already synced)`);
  process.exit(0);
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
          command: `${nodeRef} "${pluginRoot}/scripts/preflight-cache.mjs"`,
          timeout: 5,
        },
      ],
    });
    changed = true;
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

if (process.platform === "win32") {
  try {
    execFileSync("where", ["psmux"], { stdio: "ignore" });
  } catch {
    // psmux 미설치 — winget으로 자동 설치 시도
    console.log("  psmux 미설치 — winget으로 설치 중...");
    try {
      execFileSync("winget", ["install", "--id", "marlocarlo.psmux", "--accept-package-agreements", "--accept-source-agreements"], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60000,
      });
      console.log("  \x1b[32m✓\x1b[0m psmux 설치 완료");
      synced++;
    } catch {
      console.log("  \x1b[33m⚠\x1b[0m psmux 자동 설치 실패 — 수동 설치: winget install psmux");
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

const codexProfilesAdded = ensureCodexProfiles();
if (codexProfilesAdded > 0) {
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

// ── /tmp 임시 파일 자동 정리 (setup 지연 방지: fire-and-forget) ──
cleanupTmpFiles().catch(() => {});

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
