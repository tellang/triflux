#!/usr/bin/env node
// triflux 세션 시작 시 자동 설정 스크립트
// - cli-route.sh를 ~/.claude/scripts/에 동기화
// - hud-qos-status.mjs를 ~/.claude/hud/에 동기화
// - skills/를 ~/.claude/skills/에 동기화

import { copyFileSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, chmodSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const PLUGIN_ROOT = dirname(dirname(new URL(import.meta.url).pathname)).replace(/^\/([A-Z]:)/, "$1");
const CLAUDE_DIR = join(homedir(), ".claude");

// ── 파일 동기화 ──

const SYNC_MAP = [
  {
    src: join(PLUGIN_ROOT, "scripts", "cli-route.sh"),
    dst: join(CLAUDE_DIR, "scripts", "cli-route.sh"),
    label: "cli-route.sh",
  },
  {
    src: join(PLUGIN_ROOT, "hud", "hud-qos-status.mjs"),
    dst: join(CLAUDE_DIR, "hud", "hud-qos-status.mjs"),
    label: "hud-qos-status.mjs",
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
    const srcVersion = getVersion(src);
    const dstVersion = getVersion(dst);
    if (srcVersion && dstVersion && srcVersion !== dstVersion) {
      copyFileSync(src, dst);
      try { chmodSync(dst, 0o755); } catch {}
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

// ── MCP 인벤토리 백그라운드 갱신 ──

import { spawn } from "child_process";

const mcpCheck = join(PLUGIN_ROOT, "scripts", "mcp-check.mjs");
if (existsSync(mcpCheck)) {
  const child = spawn(process.execPath, [mcpCheck], {
    detached: true,
    stdio: "ignore",
  });
  child.unref(); // 부모 프로세스와 분리 — 비동기 실행
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

  ${G}✓${R} cli-route.sh     → ~/.claude/scripts/
  ${G}✓${R} hud-qos-status   → ~/.claude/hud/
  ${G}✓${R} ${synced > 0 ? synced + " files synced" : "all files up to date"}
  ${G}✓${R} HUD statusLine   → settings.json

${B}Commands:${R}
  ${C}triflux${R} setup     파일 동기화 + HUD 설정
  ${C}triflux${R} doctor    CLI 진단 (Codex/Gemini 확인)
  ${C}triflux${R} list      설치된 스킬 목록
  ${C}triflux${R} update    최신 버전으로 업데이트

${B}Shortcuts:${R}
  ${C}tfx${R}                 triflux 축약
  ${C}tfx-setup${R}            triflux setup
  ${C}tfx-doctor${R}           triflux doctor

${B}Skills (Claude Code):${R}
  ${C}/tfx-auto${R}   "작업"   자동 분류 + 병렬 실행
  ${C}/tfx-codex${R}  "작업"   Codex 전용 모드
  ${C}/tfx-gemini${R} "작업"   Gemini 전용 모드
  ${C}/tfx-setup${R}           HUD 설정 + 진단

${Y}!${R} 세션 재시작 후 스킬이 활성화됩니다
${D}https://github.com/tellang/triflux${R}
`);
}

process.exit(0);
