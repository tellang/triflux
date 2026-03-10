#!/usr/bin/env node
// triflux CLI — setup, doctor, version
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, readdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { execSync, spawn } from "child_process";

const PKG_ROOT = dirname(dirname(new URL(import.meta.url).pathname)).replace(/^\/([A-Z]:)/, "$1");
const CLAUDE_DIR = join(homedir(), ".claude");
const CODEX_DIR = join(homedir(), ".codex");
const CODEX_CONFIG_PATH = join(CODEX_DIR, "config.toml");
const PKG = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));

const REQUIRED_CODEX_PROFILES = [
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

// ── 색상 체계 (triflux brand: amber/orange accent) ──
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const AMBER = "\x1b[38;5;214m";
const BLUE = "\x1b[38;5;39m";
const WHITE_BRIGHT = "\x1b[97m";
const GRAY = "\x1b[38;5;245m";
const GREEN_BRIGHT = "\x1b[38;5;82m";
const RED_BRIGHT = "\x1b[38;5;196m";

// ── 브랜드 요소 ──
const BRAND = `${AMBER}${BOLD}triflux${RESET}`;
const VER = `${DIM}v${PKG.version}${RESET}`;
const LINE = `${GRAY}${"─".repeat(48)}${RESET}`;
const DOT = `${GRAY}·${RESET}`;

// ── 유틸리티 ──

function ok(msg) { console.log(`  ${GREEN_BRIGHT}✓${RESET} ${msg}`); }
function warn(msg) { console.log(`  ${YELLOW}⚠${RESET} ${msg}`); }
function fail(msg) { console.log(`  ${RED_BRIGHT}✗${RESET} ${msg}`); }
function info(msg) { console.log(`    ${GRAY}${msg}${RESET}`); }
function section(title) { console.log(`\n  ${AMBER}▸${RESET} ${BOLD}${title}${RESET}`); }

function which(cmd) {
  try {
    const result = execSync(
      process.platform === "win32" ? `where ${cmd} 2>nul` : `which ${cmd} 2>/dev/null`,
      { encoding: "utf8", timeout: 5000 }
    ).trim();
    return result.split(/\r?\n/)[0] || null;
  } catch { return null; }
}

function whichInShell(cmd, shell) {
  const cmds = {
    bash: `bash -c "source ~/.bashrc 2>/dev/null && command -v ${cmd} 2>/dev/null"`,
    cmd: `cmd /c where ${cmd} 2>nul`,
    pwsh: `pwsh -NoProfile -c "(Get-Command ${cmd} -EA SilentlyContinue).Source"`,
  };
  const command = cmds[shell];
  if (!command) return null;
  try {
    const result = execSync(command, {
      encoding: "utf8",
      timeout: 8000,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    return result.split(/\r?\n/)[0] || null;
  } catch { return null; }
}

function checkShellAvailable(shell) {
  const cmds = { bash: "bash --version", cmd: "cmd /c echo ok", pwsh: "pwsh -NoProfile -c echo ok" };
  try {
    execSync(cmds[shell], { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "ignore"] });
    return true;
  } catch { return false; }
}

function getVersion(filePath) {
  try {
    const content = readFileSync(filePath, "utf8");
    const match = content.match(/VERSION\s*=\s*"([^"]+)"/);
    return match ? match[1] : null;
  } catch { return null; }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasProfileSection(tomlContent, profileName) {
  const section = `^\\[profiles\\.${escapeRegExp(profileName)}\\]\\s*$`;
  return new RegExp(section, "m").test(tomlContent);
}

function ensureCodexProfiles() {
  try {
    if (!existsSync(CODEX_DIR)) mkdirSync(CODEX_DIR, { recursive: true });

    const original = existsSync(CODEX_CONFIG_PATH)
      ? readFileSync(CODEX_CONFIG_PATH, "utf8")
      : "";

    let updated = original;
    let added = 0;

    for (const profile of REQUIRED_CODEX_PROFILES) {
      if (hasProfileSection(updated, profile.name)) continue;

      if (updated.length > 0 && !updated.endsWith("\n")) updated += "\n";
      if (updated.trim().length > 0) updated += "\n";
      updated += `[profiles.${profile.name}]\n${profile.lines.join("\n")}\n`;
      added++;
    }

    if (added > 0) {
      writeFileSync(CODEX_CONFIG_PATH, updated, "utf8");
    }

    return { ok: true, added };
  } catch (e) {
    return { ok: false, added: 0, message: e.message };
  }
}

function syncFile(src, dst, label) {
  const dstDir = dirname(dst);
  if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });

  if (!existsSync(src)) {
    fail(`${label}: 소스 파일 없음 (${src})`);
    return false;
  }

  const srcVer = getVersion(src);
  const dstVer = existsSync(dst) ? getVersion(dst) : null;

  if (!existsSync(dst)) {
    copyFileSync(src, dst);
    try { chmodSync(dst, 0o755); } catch {}
    ok(`${label}: 설치됨 ${srcVer ? `(v${srcVer})` : ""}`);
    return true;
  }

  const srcContent = readFileSync(src, "utf8");
  const dstContent = readFileSync(dst, "utf8");
  if (srcContent !== dstContent) {
    copyFileSync(src, dst);
    try { chmodSync(dst, 0o755); } catch {}
    const verInfo = (srcVer && dstVer && srcVer !== dstVer)
      ? `(v${dstVer} → v${srcVer})`
      : srcVer ? `(v${srcVer}, 내용 변경)` : "(내용 변경)";
    ok(`${label}: 업데이트됨 ${verInfo}`);
    return true;
  }

  ok(`${label}: 최신 상태 ${srcVer ? `(v${srcVer})` : ""}`);
  return false;
}

// ── 크로스 셸 진단 ──

function checkCliCrossShell(cmd, installHint) {
  const shells = process.platform === "win32" ? ["bash", "cmd", "pwsh"] : ["bash"];
  let anyFound = false;
  let bashMissing = false;

  for (const shell of shells) {
    if (!checkShellAvailable(shell)) {
      info(`${shell}: ${DIM}셸 없음 (건너뜀)${RESET}`);
      continue;
    }
    const p = whichInShell(cmd, shell);
    if (p) {
      ok(`${shell}:  ${p}`);
      anyFound = true;
    } else {
      fail(`${shell}:  미발견`);
      if (shell === "bash") bashMissing = true;
    }
  }

  if (!anyFound) {
    info(`미설치 (선택사항) — ${installHint}`);
    info("없으면 Claude 네이티브 에이전트로 fallback");
    return 1;
  }
  if (bashMissing) {
    warn("bash에서 미발견 — tfx-route.sh 실행 불가");
    info('→ ~/.bashrc에 추가: export PATH="$PATH:$APPDATA/npm"');
    return 1;
  }
  return 0;
}

// ── 명령어 ──

function cmdSetup() {
  console.log(`\n${BOLD}triflux setup${RESET}\n`);

  syncFile(
    join(PKG_ROOT, "scripts", "tfx-route.sh"),
    join(CLAUDE_DIR, "scripts", "tfx-route.sh"),
    "tfx-route.sh"
  );

  syncFile(
    join(PKG_ROOT, "hud", "hud-qos-status.mjs"),
    join(CLAUDE_DIR, "hud", "hud-qos-status.mjs"),
    "hud-qos-status.mjs"
  );

  syncFile(
    join(PKG_ROOT, "scripts", "notion-read.mjs"),
    join(CLAUDE_DIR, "scripts", "notion-read.mjs"),
    "notion-read.mjs"
  );

  syncFile(
    join(PKG_ROOT, "scripts", "tfx-route-post.mjs"),
    join(CLAUDE_DIR, "scripts", "tfx-route-post.mjs"),
    "tfx-route-post.mjs"
  );

  syncFile(
    join(PKG_ROOT, "scripts", "tfx-batch-stats.mjs"),
    join(CLAUDE_DIR, "scripts", "tfx-batch-stats.mjs"),
    "tfx-batch-stats.mjs"
  );

  // 스킬 동기화 (~/.claude/skills/{name}/SKILL.md)
  const skillsSrc = join(PKG_ROOT, "skills");
  const skillsDst = join(CLAUDE_DIR, "skills");
  if (existsSync(skillsSrc)) {
    let skillCount = 0;
    let skillTotal = 0;
    for (const name of readdirSync(skillsSrc)) {
      const src = join(skillsSrc, name, "SKILL.md");
      const dst = join(skillsDst, name, "SKILL.md");
      if (!existsSync(src)) continue;
      skillTotal++;

      const dstDir = dirname(dst);
      if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });

      if (!existsSync(dst)) {
        copyFileSync(src, dst);
        skillCount++;
      } else {
        const srcContent = readFileSync(src, "utf8");
        const dstContent = readFileSync(dst, "utf8");
        if (srcContent !== dstContent) {
          copyFileSync(src, dst);
          skillCount++;
        }
      }
    }
    if (skillCount > 0) {
      ok(`스킬: ${skillCount}/${skillTotal}개 업데이트됨`);
    } else {
      ok(`스킬: ${skillTotal}개 최신 상태`);
    }
  }

  const codexProfileResult = ensureCodexProfiles();
  if (!codexProfileResult.ok) {
    warn(`Codex profiles 설정 실패: ${codexProfileResult.message}`);
  } else if (codexProfileResult.added > 0) {
    ok(`Codex profiles: ${codexProfileResult.added}개 추가됨 (~/.codex/config.toml)`);
  } else {
    ok("Codex profiles: 이미 준비됨");
  }

  // hub MCP 사전 등록 (서버 미실행이어도 설정만 등록 — hub start 시 즉시 사용 가능)
  if (existsSync(join(PKG_ROOT, "hub", "server.mjs"))) {
    const defaultHubUrl = `http://127.0.0.1:${process.env.TFX_HUB_PORT || "27888"}/mcp`;
    autoRegisterMcp(defaultHubUrl);
    console.log("");
  }

  // HUD statusLine 설정
  console.log(`${CYAN}[HUD 설정]${RESET}`);
  const settingsPath = join(CLAUDE_DIR, "settings.json");
  const hudPath = join(CLAUDE_DIR, "hud", "hud-qos-status.mjs");

  if (existsSync(hudPath)) {
    try {
      let settings = {};
      if (existsSync(settingsPath)) {
        settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      }

      const currentCmd = settings.statusLine?.command || "";
      if (currentCmd.includes("hud-qos-status.mjs")) {
        ok("statusLine 이미 설정됨");
      } else {
        const nodePath = process.execPath.replace(/\\/g, "/");
        const hudForward = hudPath.replace(/\\/g, "/");
        const nodeRef = nodePath.includes(" ") ? `"${nodePath}"` : nodePath;
        const hudRef = hudForward.includes(" ") ? `"${hudForward}"` : hudForward;

        if (currentCmd) {
          warn(`기존 statusLine 덮어쓰기: ${currentCmd}`);
        }

        settings.statusLine = {
          type: "command",
          command: `${nodeRef} ${hudRef}`,
        };

        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
        ok("statusLine 설정 완료 — 세션 재시작 후 HUD 표시");
      }
    } catch (e) {
      fail(`settings.json 처리 실패: ${e.message}`);
    }
  } else {
    warn("HUD 파일 없음 — 먼저 파일 동기화 필요");
  }

  console.log(`\n${DIM}설치 위치: ${CLAUDE_DIR}${RESET}\n`);
}

function cmdDoctor(options = {}) {
  const { fix = false, reset = false } = options;
  const modeLabel = reset ? ` ${RED}--reset${RESET}` : fix ? ` ${YELLOW}--fix${RESET}` : "";
  console.log(`\n  ${AMBER}${BOLD}⬡ triflux doctor${RESET} ${VER}${modeLabel}\n`);
  console.log(`  ${LINE}`);

  // ── reset 모드: 캐시 전체 초기화 ──
  if (reset) {
    section("Cache Reset");
    const cacheDir = join(CLAUDE_DIR, "cache");
    const resetFiles = [
      "claude-usage-cache.json",
      ".claude-refresh-lock",
      "codex-rate-limits-cache.json",
      "gemini-quota-cache.json",
      "gemini-project-id.json",
      "gemini-session-cache.json",
      "gemini-rpm-tracker.json",
      "sv-accumulator.json",
      "mcp-inventory.json",
      "cli-issues.jsonl",
      "triflux-update-check.json",
    ];
    let cleared = 0;
    for (const name of resetFiles) {
      const fp = join(cacheDir, name);
      if (existsSync(fp)) {
        try { unlinkSync(fp); cleared++; ok(`삭제됨: ${name}`); }
        catch (e) { fail(`삭제 실패: ${name} — ${e.message}`); }
      }
    }
    if (cleared === 0) {
      ok("삭제할 캐시 파일 없음 (이미 깨끗함)");
    } else {
      console.log("");
      ok(`${BOLD}${cleared}개${RESET} 캐시 파일 초기화 완료`);
    }
    // 캐시 즉시 재생성
    console.log("");
    section("Cache Rebuild");
    const mcpCheck = join(PKG_ROOT, "scripts", "mcp-check.mjs");
    if (existsSync(mcpCheck)) {
      try {
        execSync(`"${process.execPath}" "${mcpCheck}"`, { timeout: 15000, stdio: "ignore" });
        ok("MCP 인벤토리 재생성됨");
      } catch { warn("MCP 인벤토리 재생성 실패 — 다음 세션에서 자동 재시도"); }
    }
    const hudScript = join(CLAUDE_DIR, "hud", "hud-qos-status.mjs");
    if (existsSync(hudScript)) {
      try {
        execSync(`"${process.execPath}" "${hudScript}" --refresh-claude-usage`, { timeout: 20000, stdio: "ignore" });
        ok("Claude 사용량 캐시 재생성됨");
      } catch { warn("Claude 사용량 캐시 재생성 실패 — 다음 API 호출 시 자동 생성"); }
      try {
        execSync(`"${process.execPath}" "${hudScript}" --refresh-codex-rate-limits`, { timeout: 15000, stdio: "ignore" });
        ok("Codex 레이트 리밋 캐시 재생성됨");
      } catch { warn("Codex 레이트 리밋 캐시 재생성 실패"); }
      try {
        execSync(`"${process.execPath}" "${hudScript}" --refresh-gemini-quota`, { timeout: 15000, stdio: "ignore" });
        ok("Gemini 쿼터 캐시 재생성됨");
      } catch { warn("Gemini 쿼터 캐시 재생성 실패"); }
    }
    console.log(`\n  ${LINE}`);
    console.log(`  ${GREEN_BRIGHT}${BOLD}✓ 캐시 초기화 + 재생성 완료${RESET}\n`);
    return;
  }

  // ── fix 모드: 파일 동기화 + 캐시 정리 후 진단 ──
  if (fix) {
    section("Auto Fix");
    syncFile(
      join(PKG_ROOT, "scripts", "tfx-route.sh"),
      join(CLAUDE_DIR, "scripts", "tfx-route.sh"),
      "tfx-route.sh"
    );
    syncFile(
      join(PKG_ROOT, "hud", "hud-qos-status.mjs"),
      join(CLAUDE_DIR, "hud", "hud-qos-status.mjs"),
      "hud-qos-status.mjs"
    );
    syncFile(
      join(PKG_ROOT, "scripts", "notion-read.mjs"),
      join(CLAUDE_DIR, "scripts", "notion-read.mjs"),
      "notion-read.mjs"
    );
    // 스킬 동기화
    const fSkillsSrc = join(PKG_ROOT, "skills");
    const fSkillsDst = join(CLAUDE_DIR, "skills");
    if (existsSync(fSkillsSrc)) {
      let sc = 0, st = 0;
      for (const name of readdirSync(fSkillsSrc)) {
        const src = join(fSkillsSrc, name, "SKILL.md");
        const dst = join(fSkillsDst, name, "SKILL.md");
        if (!existsSync(src)) continue;
        st++;
        const dstDir = dirname(dst);
        if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });
        if (!existsSync(dst)) { copyFileSync(src, dst); sc++; }
        else if (readFileSync(src, "utf8") !== readFileSync(dst, "utf8")) { copyFileSync(src, dst); sc++; }
      }
      if (sc > 0) ok(`스킬: ${sc}/${st}개 업데이트됨`);
      else ok(`스킬: ${st}개 최신 상태`);
    }
    // 에러/스테일 캐시 정리
    const fCacheDir = join(CLAUDE_DIR, "cache");
    const staleNames = ["claude-usage-cache.json", ".claude-refresh-lock", "codex-rate-limits-cache.json"];
    let cleaned = 0;
    for (const name of staleNames) {
      const fp = join(fCacheDir, name);
      if (!existsSync(fp)) continue;
      try {
        const parsed = JSON.parse(readFileSync(fp, "utf8"));
        if (parsed.error || name.startsWith(".")) { unlinkSync(fp); cleaned++; ok(`에러 캐시 정리: ${name}`); }
      } catch { try { unlinkSync(fp); cleaned++; ok(`손상된 캐시 정리: ${name}`); } catch {} }
    }
    if (cleaned === 0) info("에러 캐시 없음");
    console.log(`\n  ${LINE}`);
    info("수정 완료 — 아래 진단 결과를 확인하세요");
    console.log("");
  }

  let issues = 0;

  // 1. tfx-route.sh
  section("tfx-route.sh");
  const routeSh = join(CLAUDE_DIR, "scripts", "tfx-route.sh");
  if (existsSync(routeSh)) {
    const ver = getVersion(routeSh);
    ok(`설치됨 ${ver ? `${DIM}v${ver}${RESET}` : ""}`);
  } else {
    fail("미설치 — tfx setup 실행 필요");
    issues++;
  }

  // 2. HUD
  section("HUD");
  const hud = join(CLAUDE_DIR, "hud", "hud-qos-status.mjs");
  if (existsSync(hud)) {
    ok("설치됨");
  } else {
    warn("미설치 ${GRAY}(선택사항)${RESET}");
  }

  // 3. Codex CLI
  section(`Codex CLI ${WHITE_BRIGHT}●${RESET}`);
  issues += checkCliCrossShell("codex", "npm install -g @openai/codex");
  if (which("codex")) {
    if (process.env.OPENAI_API_KEY) {
      ok("OPENAI_API_KEY 설정됨");
    } else {
      warn(`OPENAI_API_KEY 미설정 ${GRAY}(Pro 구독이면 불필요)${RESET}`);
    }
  }

  // 4. Gemini CLI
  section(`Gemini CLI ${BLUE}●${RESET}`);
  issues += checkCliCrossShell("gemini", "npm install -g @google/gemini-cli");
  if (which("gemini")) {
    if (process.env.GEMINI_API_KEY) {
      ok("GEMINI_API_KEY 설정됨");
    } else {
      warn(`GEMINI_API_KEY 미설정 ${GRAY}(gemini auth login)${RESET}`);
    }
  }

  // 5. Claude Code
  section(`Claude Code ${AMBER}●${RESET}`);
  const claudePath = which("claude");
  if (claudePath) {
    ok("설치됨");
  } else {
    fail("미설치 (필수)");
    issues++;
  }

  // 6. 스킬 설치 상태
  section("Skills");
  const skillsSrc = join(PKG_ROOT, "skills");
  const skillsDst = join(CLAUDE_DIR, "skills");
  if (existsSync(skillsSrc)) {
    let installed = 0;
    let total = 0;
    const missing = [];
    for (const name of readdirSync(skillsSrc)) {
      if (!existsSync(join(skillsSrc, name, "SKILL.md"))) continue;
      total++;
      if (existsSync(join(skillsDst, name, "SKILL.md"))) {
        installed++;
      } else {
        missing.push(name);
      }
    }
    if (installed === total) {
      ok(`${installed}/${total}개 설치됨`);
    } else {
      warn(`${installed}/${total}개 설치됨 — 미설치: ${missing.join(", ")}`);
      info("triflux setup으로 동기화 가능");
      issues++;
    }
  }

  // 7. 플러그인 등록
  section("Plugin");
  const pluginsFile = join(CLAUDE_DIR, "plugins", "installed_plugins.json");
  if (existsSync(pluginsFile)) {
    const content = readFileSync(pluginsFile, "utf8");
    if (content.includes("triflux")) {
      ok("triflux 플러그인 등록됨");
    } else {
      warn("triflux 플러그인 미등록 — npm 단독 사용 중");
      info("플러그인 등록: /plugin marketplace add <repo-url>");
    }
  } else {
    info("플러그인 시스템 감지 안 됨 — npm 단독 사용");
  }

  // 8. MCP 인벤토리
  section("MCP Inventory");
  const mcpCache = join(CLAUDE_DIR, "cache", "mcp-inventory.json");
  if (existsSync(mcpCache)) {
    try {
      const inv = JSON.parse(readFileSync(mcpCache, "utf8"));
      ok(`캐시 존재 (${inv.timestamp})`);
      if (inv.codex?.servers?.length) {
        const names = inv.codex.servers.map(s => s.name).join(", ");
        info(`Codex: ${inv.codex.servers.length}개 서버 (${names})`);
      }
      if (inv.gemini?.servers?.length) {
        const names = inv.gemini.servers.map(s => s.name).join(", ");
        info(`Gemini: ${inv.gemini.servers.length}개 서버 (${names})`);
      }
    } catch {
      warn("캐시 파일 파싱 실패");
    }
  } else {
    warn("캐시 없음 — 다음 세션 시작 시 자동 생성");
    info(`수동: node ${join(PKG_ROOT, "scripts", "mcp-check.mjs")}`);
  }

  // 9. CLI 이슈 트래커
  section("CLI Issues");
  const issuesFile = join(CLAUDE_DIR, "cache", "cli-issues.jsonl");
  if (existsSync(issuesFile)) {
    try {
      const lines = readFileSync(issuesFile, "utf8").trim().split("\n").filter(Boolean);
      const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const unresolved = entries.filter(e => !e.resolved);

      if (unresolved.length === 0) {
        ok("미해결 이슈 없음");
      } else {
        // 패턴별 그룹핑
        const groups = {};
        for (const e of unresolved) {
          const key = `${e.cli}:${e.pattern}`;
          if (!groups[key]) groups[key] = { ...e, count: 0 };
          groups[key].count++;
          if (e.ts > groups[key].ts) { groups[key].ts = e.ts; groups[key].snippet = e.snippet; }
        }

        // 알려진 해결 버전 (패턴별 수정된 triflux 버전)
        const KNOWN_FIXES = {
          "gemini:deprecated_flag": "1.8.9",  // -p → --prompt
        };

        const currentVer = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version;
        let cleaned = 0;

        for (const [key, g] of Object.entries(groups)) {
          const fixVer = KNOWN_FIXES[key];
          if (fixVer && currentVer >= fixVer) {
            // 해결된 이슈 — 자동 정리
            cleaned += g.count;
            continue;
          }
          const age = Date.now() - g.ts;
          const ago = age < 3600000 ? `${Math.round(age / 60000)}분 전` :
            age < 86400000 ? `${Math.round(age / 3600000)}시간 전` :
            `${Math.round(age / 86400000)}일 전`;
          const sev = g.severity === "error" ? `${RED}ERROR${RESET}` : `${YELLOW}WARN${RESET}`;
          warn(`[${sev}] ${g.cli}/${g.pattern} x${g.count} (최근: ${ago})`);
          if (g.snippet) info(`  ${g.snippet.substring(0, 120)}`);
          if (fixVer) info(`  해결: triflux >= v${fixVer} (npm update -g triflux)`);
          issues++;
        }

        // 해결된 이슈 자동 정리
        if (cleaned > 0) {
          const remaining = entries.filter(e => {
            const key = `${e.cli}:${e.pattern}`;
            const fixVer = KNOWN_FIXES[key];
            return !(fixVer && currentVer >= fixVer);
          });
          writeFileSync(issuesFile, remaining.map(e => JSON.stringify(e)).join("\n") + (remaining.length ? "\n" : ""));
          ok(`${cleaned}개 해결된 이슈 자동 정리됨`);
        }
      }
    } catch (e) {
      warn(`이슈 파일 읽기 실패: ${e.message}`);
    }
  } else {
    ok("이슈 로그 없음 (정상)");
  }

  // 결과
  console.log(`\n  ${LINE}`);
  if (issues === 0) {
    console.log(`  ${GREEN_BRIGHT}${BOLD}✓ 모든 검사 통과${RESET}\n`);
  } else {
    console.log(`  ${YELLOW}${BOLD}⚠ ${issues}개 항목 확인 필요${RESET}\n`);
  }
}

function cmdUpdate() {
  const isDev = process.argv.includes("--dev");
  const tagLabel = isDev ? ` ${YELLOW}@dev${RESET}` : "";
  console.log(`\n${BOLD}triflux update${RESET}${tagLabel}\n`);

  // 1. 설치 방식 감지
  const pluginsFile = join(CLAUDE_DIR, "plugins", "installed_plugins.json");
  let installMode = "unknown";
  let pluginPath = null;

  // 플러그인 모드 감지
  if (existsSync(pluginsFile)) {
    try {
      const plugins = JSON.parse(readFileSync(pluginsFile, "utf8"));
      for (const [key, entries] of Object.entries(plugins.plugins || {})) {
        if (key.startsWith("triflux")) {
          pluginPath = entries[0]?.installPath;
          installMode = "plugin";
          break;
        }
      }
    } catch {}
  }

  // PKG_ROOT가 플러그인 캐시 내에 있으면 플러그인 모드
  if (installMode === "unknown" && PKG_ROOT.includes(join(".claude", "plugins"))) {
    installMode = "plugin";
    pluginPath = PKG_ROOT;
  }

  // npm global 감지
  if (installMode === "unknown") {
    try {
      const npmList = execSync("npm list -g triflux --depth=0", {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "ignore"],
      });
      if (npmList.includes("triflux")) installMode = "npm-global";
    } catch {}
  }

  // npm local 감지
  if (installMode === "unknown") {
    const localPkg = join(process.cwd(), "node_modules", "triflux");
    if (existsSync(localPkg)) installMode = "npm-local";
  }

  // git 저장소 직접 사용
  if (installMode === "unknown" && existsSync(join(PKG_ROOT, ".git"))) {
    installMode = "git-local";
  }

  info(`검색: ${installMode === "plugin" ? "플러그인" : installMode === "npm-global" ? "npm global" : installMode === "npm-local" ? "npm local" : installMode === "git-local" ? "git 로컬 저장소" : "알 수 없음"} 설치 감지`);

  // 2. 설치 방식에 따라 업데이트
  const oldVer = PKG.version;
  let updated = false;

  try {
    switch (installMode) {
      case "plugin": {
        const gitDir = pluginPath || PKG_ROOT;
        const result = execSync("git pull", {
          encoding: "utf8",
          timeout: 30000,
          cwd: gitDir,
        }).trim();
        ok(`git pull — ${result}`);
        updated = true;
        break;
      }
      case "npm-global": {
        const npmCmd = isDev ? "npm install -g triflux@dev" : "npm update -g triflux";
        const result = execSync(npmCmd, {
          encoding: "utf8",
          timeout: 60000,
          stdio: ["pipe", "pipe", "ignore"],
        }).trim().split(/\r?\n/)[0];
        ok(`${isDev ? "npm install -g @dev" : "npm update -g"} — ${result || "완료"}`);
        updated = true;
        break;
      }
      case "npm-local": {
        const npmLocalCmd = isDev ? "npm install triflux@dev" : "npm update triflux";
        const result = execSync(npmLocalCmd, {
          encoding: "utf8",
          timeout: 60000,
          cwd: process.cwd(),
          stdio: ["pipe", "pipe", "ignore"],
        }).trim().split(/\r?\n/)[0];
        ok(`npm update — ${result || "완료"}`);
        updated = true;
        break;
      }
      case "git-local": {
        const result = execSync("git pull", {
          encoding: "utf8",
          timeout: 30000,
          cwd: PKG_ROOT,
        }).trim();
        ok(`git pull — ${result}`);
        updated = true;
        break;
      }
      default:
        fail("설치 방식을 감지할 수 없음");
        info("수동 업데이트: cd <triflux-dir> && git pull");
        return;
    }
  } catch (e) {
    fail(`업데이트 실패: ${e.message}`);
    return;
  }

  // 3. setup 재실행 (tfx-route.sh, HUD, 스킬 동기화)
  if (updated) {
    console.log("");
    // 업데이트 후 새 버전 읽기
    let newVer = oldVer;
    try {
      const newPkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
      newVer = newPkg.version;
    } catch {}

    if (newVer !== oldVer) {
      ok(`버전: v${oldVer} → v${newVer}`);
    } else {
      ok(`버전: v${oldVer} (이미 최신)`);
    }

    // setup 재실행
    console.log("");
    info("setup 재실행 중...");
    cmdSetup();
  }

  console.log(`${GREEN}${BOLD}업데이트 완료${RESET}\n`);
}

function cmdList() {
  console.log(`\n  ${AMBER}${BOLD}⬡ triflux list${RESET} ${VER}\n`);
  console.log(`  ${LINE}`);

  const pluginSkills = join(PKG_ROOT, "skills");
  const installedSkills = join(CLAUDE_DIR, "skills");

  section("패키지 스킬");
  if (existsSync(pluginSkills)) {
    for (const name of readdirSync(pluginSkills).sort()) {
      const src = join(pluginSkills, name, "SKILL.md");
      if (!existsSync(src)) continue;
      const dst = join(installedSkills, name, "SKILL.md");
      const installed = existsSync(dst);
      if (installed) {
        console.log(`    ${GREEN_BRIGHT}✓${RESET} ${BOLD}${name}${RESET}`);
      } else {
        console.log(`    ${RED_BRIGHT}✗${RESET} ${DIM}${name}${RESET} ${GRAY}(미설치)${RESET}`);
      }
    }
  }

  section("사용자 스킬");
  const pkgNames = new Set(existsSync(pluginSkills) ? readdirSync(pluginSkills) : []);
  let userCount = 0;
  if (existsSync(installedSkills)) {
    for (const name of readdirSync(installedSkills).sort()) {
      if (pkgNames.has(name)) continue;
      const skill = join(installedSkills, name, "SKILL.md");
      if (!existsSync(skill)) continue;
      console.log(`    ${AMBER}◆${RESET} ${name}`);
      userCount++;
    }
  }
  if (userCount === 0) console.log(`    ${GRAY}없음${RESET}`);

  console.log(`\n  ${LINE}`);
  console.log(`  ${GRAY}${installedSkills}${RESET}\n`);
}

function cmdVersion() {
  const routeVer = getVersion(join(CLAUDE_DIR, "scripts", "tfx-route.sh"));
  const hudVer = getVersion(join(CLAUDE_DIR, "hud", "hud-qos-status.mjs"));
  console.log(`\n  ${AMBER}${BOLD}⬡ triflux${RESET} ${WHITE_BRIGHT}v${PKG.version}${RESET}`);
  if (routeVer) console.log(`  ${GRAY}tfx-route${RESET}  v${routeVer}`);
  if (hudVer) console.log(`  ${GRAY}hud${RESET}        v${hudVer}`);
  console.log("");
}

function checkForUpdate() {
  const cacheFile = join(CLAUDE_DIR, "cache", "triflux-update-check.json");
  const cacheDir = dirname(cacheFile);

  // 캐시 확인 (1시간 이내면 캐시 사용)
  try {
    if (existsSync(cacheFile)) {
      const cache = JSON.parse(readFileSync(cacheFile, "utf8"));
      if (Date.now() - cache.timestamp < 3600000) {
        return cache.latest !== PKG.version ? cache.latest : null;
      }
    }
  } catch {}

  // npm registry 조회
  try {
    const result = execSync("npm view triflux version", {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ latest: result, timestamp: Date.now() }));

    return result !== PKG.version ? result : null;
  } catch {
    return null;
  }
}

function cmdHelp() {
  const latestVer = checkForUpdate();
  const updateNotice = latestVer
    ? `\n  ${YELLOW}${BOLD}↑ v${latestVer} 사용 가능${RESET}  ${GRAY}npm update -g triflux${RESET}\n`
    : "";

  console.log(`
  ${AMBER}${BOLD}⬡ triflux${RESET} ${DIM}v${PKG.version}${RESET}
  ${GRAY}CLI-first multi-model orchestrator for Claude Code${RESET}
${updateNotice}
  ${LINE}

  ${BOLD}Commands${RESET}

    ${WHITE_BRIGHT}tfx setup${RESET}      ${GRAY}파일 동기화 + HUD 설정${RESET}
    ${WHITE_BRIGHT}tfx doctor${RESET}     ${GRAY}CLI 진단 + 이슈 확인${RESET}
    ${DIM}  --fix${RESET}        ${GRAY}진단 + 자동 수정${RESET}
    ${DIM}  --reset${RESET}      ${GRAY}캐시 전체 초기화${RESET}
    ${WHITE_BRIGHT}tfx update${RESET}     ${GRAY}최신 버전으로 업데이트${RESET}
    ${DIM}  --dev${RESET}         ${GRAY}dev 태그로 업데이트${RESET}
    ${WHITE_BRIGHT}tfx list${RESET}       ${GRAY}설치된 스킬 목록${RESET}
    ${WHITE_BRIGHT}tfx hub${RESET}        ${GRAY}MCP 메시지 버스 관리 (start/stop/status)${RESET}
    ${WHITE_BRIGHT}tfx team${RESET}       ${GRAY}멀티-CLI 팀 모드 (tmux + Hub)${RESET}
    ${WHITE_BRIGHT}tfx codex-team${RESET} ${GRAY}Codex 전용 팀 모드 (기본 lead/agents: codex)${RESET}
    ${WHITE_BRIGHT}tfx notion-read${RESET} ${GRAY}Notion 페이지 → 마크다운 (Codex/Gemini MCP)${RESET}
    ${WHITE_BRIGHT}tfx version${RESET}    ${GRAY}버전 표시${RESET}

  ${BOLD}Skills${RESET} ${GRAY}(Claude Code 슬래시 커맨드)${RESET}

    ${AMBER}/tfx-auto${RESET}       ${GRAY}자동 분류 + 병렬 실행${RESET}
    ${WHITE_BRIGHT}/tfx-codex${RESET}      ${GRAY}Codex 전용 모드${RESET}
    ${BLUE}/tfx-gemini${RESET}     ${GRAY}Gemini 전용 모드${RESET}
    ${AMBER}/tfx-setup${RESET}      ${GRAY}HUD 설정 + 진단${RESET}
    ${YELLOW}/tfx-doctor${RESET}     ${GRAY}진단 + 수리 + 캐시 초기화${RESET}

  ${LINE}
  ${GRAY}github.com/tellang/triflux${RESET}
`);
}

async function cmdCodexTeam() {
  const args = process.argv.slice(3);
  const sub = String(args[0] || "").toLowerCase();
  const passthrough = new Set([
    "status", "attach", "stop", "kill", "send", "list", "help", "--help", "-h",
    "tasks", "task", "focus", "interrupt", "control", "debug",
  ]);

  if (sub === "help" || sub === "--help" || sub === "-h") {
    console.log(`
  ${AMBER}${BOLD}⬡ tfx codex-team${RESET}

    ${WHITE_BRIGHT}tfx codex-team "작업"${RESET}         ${GRAY}Codex 리드 + 워커 2개로 팀 시작${RESET}
    ${WHITE_BRIGHT}tfx codex-team --layout 1xN "작업"${RESET}   ${GRAY}(세로 분할 컬럼)${RESET}
    ${WHITE_BRIGHT}tfx codex-team --layout Nx1 "작업"${RESET}   ${GRAY}(가로 분할 스택)${RESET}
    ${WHITE_BRIGHT}tfx codex-team status${RESET}
    ${WHITE_BRIGHT}tfx codex-team debug --lines 30${RESET}
    ${WHITE_BRIGHT}tfx codex-team send N "msg"${RESET}

  ${DIM}내부적으로 tfx team을 호출하며, 시작 시 --lead codex --agents codex,codex를 기본 주입합니다.${RESET}
`);
    return;
  }

  const hasAgents = args.includes("--agents");
  const hasLead = args.includes("--lead");
  const hasLayout = args.includes("--layout");
  const isControl = passthrough.has(sub);
  const inject = [];
  if (!isControl && !hasLead) inject.push("--lead", "codex");
  if (!isControl && !hasAgents) inject.push("--agents", "codex,codex");
  if (!isControl && !hasLayout) inject.push("--layout", "1xN");
  const forwarded = isControl ? args : [...inject, ...args];

  const { pathToFileURL } = await import("node:url");
  const { cmdTeam } = await import(pathToFileURL(join(PKG_ROOT, "hub", "team", "cli.mjs")).href);

  const prevArgv = process.argv;
  process.argv = [prevArgv[0], prevArgv[1], "team", ...forwarded];
  try {
    await cmdTeam();
  } finally {
    process.argv = prevArgv;
  }
}

// ── hub 서브커맨드 ──

const HUB_PID_DIR = join(homedir(), ".claude", "cache", "tfx-hub");
const HUB_PID_FILE = join(HUB_PID_DIR, "hub.pid");

// 설치된 CLI에 tfx-hub MCP 서버 자동 등록 (1회 설정, 이후 재실행 불필요)
function autoRegisterMcp(mcpUrl) {
  section("MCP 자동 등록");

  // Codex — codex mcp add
  if (which("codex")) {
    try {
      // 이미 등록됐는지 확인
      const list = execSync("codex mcp list 2>&1", { encoding: "utf8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] });
      if (list.includes("tfx-hub")) {
        ok("Codex: 이미 등록됨");
      } else {
        execSync(`codex mcp add tfx-hub --url ${mcpUrl}`, { timeout: 10000, stdio: "ignore" });
        ok("Codex: MCP 등록 완료");
      }
    } catch {
      // mcp list/add 미지원 → 설정 파일 직접 수정
      try {
        const codexDir = join(homedir(), ".codex");
        const configFile = join(codexDir, "config.json");
        let config = {};
        if (existsSync(configFile)) config = JSON.parse(readFileSync(configFile, "utf8"));
        if (!config.mcpServers) config.mcpServers = {};
        if (!config.mcpServers["tfx-hub"]) {
          config.mcpServers["tfx-hub"] = { url: mcpUrl };
          if (!existsSync(codexDir)) mkdirSync(codexDir, { recursive: true });
          writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
          ok("Codex: config.json에 등록 완료");
        } else {
          ok("Codex: 이미 등록됨");
        }
      } catch (e) { warn(`Codex 등록 실패: ${e.message}`); }
    }
  } else {
    info("Codex: 미설치 (건너뜀)");
  }

  // Gemini — settings.json 직접 수정
  if (which("gemini")) {
    try {
      const geminiDir = join(homedir(), ".gemini");
      const settingsFile = join(geminiDir, "settings.json");
      let settings = {};
      if (existsSync(settingsFile)) settings = JSON.parse(readFileSync(settingsFile, "utf8"));
      if (!settings.mcpServers) settings.mcpServers = {};
      if (!settings.mcpServers["tfx-hub"]) {
        settings.mcpServers["tfx-hub"] = { url: mcpUrl };
        if (!existsSync(geminiDir)) mkdirSync(geminiDir, { recursive: true });
        writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
        ok("Gemini: settings.json에 등록 완료");
      } else {
        ok("Gemini: 이미 등록됨");
      }
    } catch (e) { warn(`Gemini 등록 실패: ${e.message}`); }
  } else {
    info("Gemini: 미설치 (건너뜀)");
  }

  // Claude — 프로젝트 .mcp.json에 등록 (오케스트레이터용)
  try {
    const mcpJsonPath = join(PKG_ROOT, ".mcp.json");
    let mcpJson = {};
    if (existsSync(mcpJsonPath)) mcpJson = JSON.parse(readFileSync(mcpJsonPath, "utf8"));
    if (!mcpJson.mcpServers) mcpJson.mcpServers = {};
    if (!mcpJson.mcpServers["tfx-hub"]) {
      mcpJson.mcpServers["tfx-hub"] = { type: "url", url: mcpUrl };
      writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2) + "\n");
      ok("Claude: .mcp.json에 등록 완료");
    } else {
      ok("Claude: 이미 등록됨");
    }
  } catch (e) { warn(`Claude 등록 실패: ${e.message}`); }
}

function cmdHub() {
  const sub = process.argv[3] || "status";

  switch (sub) {
    case "start": {
      // 이미 실행 중인지 확인
      if (existsSync(HUB_PID_FILE)) {
        try {
          const info = JSON.parse(readFileSync(HUB_PID_FILE, "utf8"));
          process.kill(info.pid, 0); // 프로세스 존재 확인
          console.log(`\n  ${YELLOW}⚠${RESET} hub 이미 실행 중 (PID ${info.pid}, ${info.url})\n`);
          return;
        } catch {
          // PID 파일 있지만 프로세스 없음 — 정리
          try { unlinkSync(HUB_PID_FILE); } catch {}
        }
      }

      const portArg = process.argv.indexOf("--port");
      const port = portArg !== -1 ? process.argv[portArg + 1] : "27888";
      const serverPath = join(PKG_ROOT, "hub", "server.mjs");

      if (!existsSync(serverPath)) {
        fail("hub/server.mjs 없음 — hub 모듈이 설치되지 않음");
        return;
      }

      const child = spawn(process.execPath, [serverPath], {
        env: { ...process.env, TFX_HUB_PORT: port },
        stdio: "ignore",
        detached: true,
      });
      child.unref();

      // PID 파일 확인 (최대 3초 대기, 100ms 폴링)
      let started = false;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (existsSync(HUB_PID_FILE)) { started = true; break; }
        execSync("node -e \"setTimeout(()=>{},100)\"", { stdio: "ignore", timeout: 500 });
      }

      if (started) {
        const hubInfo = JSON.parse(readFileSync(HUB_PID_FILE, "utf8"));
        console.log(`\n  ${GREEN_BRIGHT}✓${RESET} ${BOLD}tfx-hub 시작${RESET}`);
        console.log(`    URL:  ${AMBER}${hubInfo.url}${RESET}`);
        console.log(`    PID:  ${hubInfo.pid}`);
        console.log(`    DB:   ${DIM}${HUB_PID_DIR}/state.db${RESET}`);
        console.log("");
        autoRegisterMcp(hubInfo.url);
        console.log("");
      } else {
        // 직접 포그라운드 모드로 안내
        console.log(`\n  ${YELLOW}⚠${RESET} 백그라운드 시작 실패 — 포그라운드로 실행:`);
        console.log(`    ${DIM}TFX_HUB_PORT=${port} node ${serverPath}${RESET}\n`);
      }
      break;
    }

    case "stop": {
      if (!existsSync(HUB_PID_FILE)) {
        console.log(`\n  ${DIM}hub 미실행${RESET}\n`);
        return;
      }
      try {
        const info = JSON.parse(readFileSync(HUB_PID_FILE, "utf8"));
        process.kill(info.pid, "SIGTERM");
        try { unlinkSync(HUB_PID_FILE); } catch {}
        console.log(`\n  ${GREEN_BRIGHT}✓${RESET} hub 종료됨 (PID ${info.pid})\n`);
      } catch (e) {
        try { unlinkSync(HUB_PID_FILE); } catch {}
        console.log(`\n  ${DIM}hub 프로세스 없음 — PID 파일 정리됨${RESET}\n`);
      }
      break;
    }

    case "status": {
      if (!existsSync(HUB_PID_FILE)) {
        console.log(`\n  ${AMBER}${BOLD}⬡ tfx-hub${RESET} ${RED}offline${RESET}\n`);
        return;
      }
      try {
        const info = JSON.parse(readFileSync(HUB_PID_FILE, "utf8"));
        process.kill(info.pid, 0); // 생존 확인
        const uptime = Date.now() - info.started;
        const uptimeStr = uptime < 60000 ? `${Math.round(uptime / 1000)}초`
          : uptime < 3600000 ? `${Math.round(uptime / 60000)}분`
          : `${Math.round(uptime / 3600000)}시간`;

        console.log(`\n  ${AMBER}${BOLD}⬡ tfx-hub${RESET} ${GREEN_BRIGHT}online${RESET}`);
        console.log(`    URL:     ${info.url}`);
        console.log(`    PID:     ${info.pid}`);
        console.log(`    Uptime:  ${uptimeStr}`);

        // HTTP 상태 조회 시도
        try {
          const statusUrl = info.url.replace("/mcp", "/status");
          const result = execSync(`curl -s "${statusUrl}"`, { encoding: "utf8", timeout: 3000, stdio: ["pipe", "pipe", "ignore"] });
          const data = JSON.parse(result);
          if (data.hub) {
            console.log(`    State:   ${data.hub.state}`);
          }
          if (data.sessions !== undefined) {
            console.log(`    Sessions: ${data.sessions}`);
          }
        } catch {}

        console.log("");
      } catch {
        try { unlinkSync(HUB_PID_FILE); } catch {}
        console.log(`\n  ${AMBER}${BOLD}⬡ tfx-hub${RESET} ${RED}offline${RESET} ${DIM}(stale PID 정리됨)${RESET}\n`);
      }
      break;
    }

    default:
      console.log(`\n  ${AMBER}${BOLD}⬡ tfx-hub${RESET}\n`);
      console.log(`    ${WHITE_BRIGHT}tfx hub start${RESET}   ${GRAY}허브 데몬 시작${RESET}`);
      console.log(`    ${DIM}  --port N${RESET}      ${GRAY}포트 지정 (기본 27888)${RESET}`);
      console.log(`    ${WHITE_BRIGHT}tfx hub stop${RESET}    ${GRAY}허브 중지${RESET}`);
      console.log(`    ${WHITE_BRIGHT}tfx hub status${RESET}  ${GRAY}상태 확인${RESET}\n`);
  }
}

// ── 메인 ──

const cmd = process.argv[2] || "help";

switch (cmd) {
  case "setup":   cmdSetup(); break;
  case "doctor": {
    const fix = process.argv.includes("--fix");
    const reset = process.argv.includes("--reset");
    cmdDoctor({ fix, reset });
    break;
  }
  case "update":  cmdUpdate(); break;
  case "list": case "ls": cmdList(); break;
  case "hub":     cmdHub(); break;
  case "team": {
    const { pathToFileURL } = await import("node:url");
    const { cmdTeam } = await import(pathToFileURL(join(PKG_ROOT, "hub", "team", "cli.mjs")).href);
    await cmdTeam();
    break;
  }
  case "codex-team":
    await cmdCodexTeam();
    break;
  case "notion-read": case "nr": {
    const scriptPath = join(PKG_ROOT, "scripts", "notion-read.mjs");
    const nrArgs = process.argv.slice(3).map(a => `"${a}"`).join(" ");
    try {
      execSync(`"${process.execPath}" "${scriptPath}" ${nrArgs}`, { stdio: "inherit", timeout: 660000 });
    } catch (e) { process.exit(e.status || 1); }
    break;
  }
  case "version": case "--version": case "-v": cmdVersion(); break;
  case "help": case "--help": case "-h": cmdHelp(); break;
  default:
    console.error(`알 수 없는 명령: ${cmd}`);
    cmdHelp();
    process.exit(1);
}
