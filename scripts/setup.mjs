#!/usr/bin/env node
// triflux 세션 시작 시 자동 설정 스크립트
// - tfx-route.sh를 ~/.claude/scripts/에 동기화
// - hud-qos-status.mjs를 ~/.claude/hud/에 동기화
// - skills/를 ~/.claude/skills/에 동기화

import { copyFileSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, chmodSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLAUDE_DIR = join(homedir(), ".claude");
const CODEX_DIR = join(homedir(), ".codex");
const CODEX_CONFIG_PATH = join(CODEX_DIR, "config.toml");

const REQUIRED_CODEX_PROFILES = [
  {
    name: "high",
    lines: [
      'model = "gpt-5.3-codex"',
      'model_reasoning_effort = "high"',
    ],
  },
  {
    name: "xhigh",
    lines: [
      'model = "gpt-5.3-codex"',
      'model_reasoning_effort = "xhigh"',
    ],
  },
  {
    name: "spark_fast",
    lines: [
      'model = "gpt-5.1-codex-mini"',
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
    `^\\[profiles\\.${escapeRegExp(profileName)}\\]\\s*\\n(?:(?!\\[)[^\\n]*\\n?)*`,
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

    if (changed > 0) {
      writeFileSync(CODEX_CONFIG_PATH, updated, "utf8");
    }

    return changed;
  } catch {
    return 0;
  }
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
{
  const breadcrumbPath = join(CLAUDE_DIR, "scripts", ".tfx-pkg-root");
  const pkgRootForward = PLUGIN_ROOT.replace(/\\/g, "/");
  const currentBreadcrumb = existsSync(breadcrumbPath)
    ? readFileSync(breadcrumbPath, "utf8").trim()
    : "";
  if (currentBreadcrumb !== pkgRootForward) {
    const breadcrumbDir = dirname(breadcrumbPath);
    if (!existsSync(breadcrumbDir)) mkdirSync(breadcrumbDir, { recursive: true });
    writeFileSync(breadcrumbPath, pkgRootForward + "\n", "utf8");
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

const skillsSrc = join(PLUGIN_ROOT, "skills");
const skillsDst = join(CLAUDE_DIR, "skills");

if (existsSync(skillsSrc)) {
  for (const name of readdirSync(skillsSrc)) {
    const src = join(skillsSrc, name, "SKILL.md");
    if (!existsSync(src)) continue;

    const dstDir = join(skillsDst, name);
    const dst = join(dstDir, "SKILL.md");

    if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });

    if (!existsSync(dst)) {
      copyFileSync(src, dst);
      synced++;
    } else {
      const srcContent = readFileSync(src, "utf8");
      const dstContent = readFileSync(dst, "utf8");
      if (srcContent !== dstContent) {
        copyFileSync(src, dst);
        synced++;
      }
    }
  }
}

// ── settings.json statusLine 자동 설정 ──

const settingsPath = join(CLAUDE_DIR, "settings.json");
const hudPath = join(CLAUDE_DIR, "hud", "hud-qos-status.mjs");

if (existsSync(hudPath)) {
  try {
    let settings = {};
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    }

    // statusLine이 없거나 hud-qos-status.mjs를 가리키지 않는 경우에만 설정
    const currentCmd = settings.statusLine?.command || "";
    if (!currentCmd.includes("hud-qos-status.mjs")) {
      const nodePath = process.execPath.replace(/\\/g, "/");
      const hudForward = hudPath.replace(/\\/g, "/");

      // Windows: 경로에 공백이 있으면 큰따옴표 감싸기
      const nodeRef = nodePath.includes(" ") ? `"${nodePath}"` : nodePath;
      const hudRef = hudForward.includes(" ") ? `"${hudForward}"` : hudForward;

      settings.statusLine = {
        type: "command",
        command: `${nodeRef} ${hudRef}`,
      };

      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
      synced++;
    }
  } catch {
    // settings.json 파싱 실패 시 무시 — 기존 설정 보존
  }
}

// ── Agent Teams 환경변수 자동 설정 ──

try {
  let agentSettings = {};
  if (existsSync(settingsPath)) {
    agentSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
  }

  if (!agentSettings.env) agentSettings.env = {};
  let agentSettingsChanged = false;

  if (agentSettings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS !== "1") {
    agentSettings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
    agentSettingsChanged = true;
  }

  // teammateMode: auto (tmux 밖이면 in-process, 안이면 split-pane)
  if (!agentSettings.teammateMode) {
    agentSettings.teammateMode = "auto";
    agentSettingsChanged = true;
  }

  if (agentSettingsChanged) {
    writeFileSync(settingsPath, JSON.stringify(agentSettings, null, 2) + "\n", "utf8");
    synced++;
  }
} catch {
  // settings.json 파싱 실패 시 무시 — 기존 설정 보존
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

// ── SessionStart 훅 자동 등록 (settings.json) ──
// .claude-plugin/ 개발 플러그인의 SessionStart 훅은 플러그인 로드 시점 문제로
// 실행되지 않을 수 있으므로, settings.json에 직접 등록한다.
// hub-ensure.mjs는 settings.json 훅으로만 실행 (이중 spawn 방지).

try {
  let hookSettings = {};
  if (existsSync(settingsPath)) {
    hookSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
  }

  if (!hookSettings.hooks) hookSettings.hooks = {};
  if (!Array.isArray(hookSettings.hooks.SessionStart)) {
    hookSettings.hooks.SessionStart = [];
  }

  const existingHooks = hookSettings.hooks.SessionStart;
  const hasTrifluxHooks = existingHooks.some((entry) =>
    Array.isArray(entry.hooks) &&
    entry.hooks.some((h) => typeof h.command === "string" && h.command.includes("triflux")),
  );

  if (!hasTrifluxHooks) {
    const nodePath = process.execPath.replace(/\\/g, "/");
    const nodeRef = nodePath.includes(" ") ? `"${nodePath}"` : nodePath;
    const pluginRoot = PLUGIN_ROOT.replace(/\\/g, "/");

    const trifluxHookEntry = {
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
    };

    hookSettings.hooks.SessionStart.push(trifluxHookEntry);
    writeFileSync(settingsPath, JSON.stringify(hookSettings, null, 2) + "\n", "utf8");
    synced++;
  }
} catch {
  // settings.json 파싱 실패 시 무시 — 기존 설정 보존
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
