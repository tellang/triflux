#!/usr/bin/env node
// triflux CLI — setup, doctor, version
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

const PKG_ROOT = dirname(dirname(new URL(import.meta.url).pathname)).replace(/^\/([A-Z]:)/, "$1");
const CLAUDE_DIR = join(homedir(), ".claude");
const PKG = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));

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
    bash: `bash -c 'command -v ${cmd} 2>/dev/null'`,
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
    warn("bash에서 미발견 — cli-route.sh 실행 불가");
    info('→ ~/.bashrc에 추가: export PATH="$PATH:$APPDATA/npm"');
    return 1;
  }
  return 0;
}

// ── 명령어 ──

function cmdSetup() {
  console.log(`\n${BOLD}triflux setup${RESET}\n`);

  syncFile(
    join(PKG_ROOT, "scripts", "cli-route.sh"),
    join(CLAUDE_DIR, "scripts", "cli-route.sh"),
    "cli-route.sh"
  );

  syncFile(
    join(PKG_ROOT, "hud", "hud-qos-status.mjs"),
    join(CLAUDE_DIR, "hud", "hud-qos-status.mjs"),
    "hud-qos-status.mjs"
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

function cmdDoctor() {
  console.log(`\n  ${AMBER}${BOLD}⬡ triflux doctor${RESET} ${VER}\n`);
  console.log(`  ${LINE}`);
  let issues = 0;

  // 1. cli-route.sh
  section("cli-route.sh");
  const routeSh = join(CLAUDE_DIR, "scripts", "cli-route.sh");
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
  console.log(`\n${BOLD}triflux update${RESET}\n`);

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
        const result = execSync("npm update -g triflux", {
          encoding: "utf8",
          timeout: 60000,
          stdio: ["pipe", "pipe", "ignore"],
        }).trim().split(/\r?\n/)[0];
        ok(`npm update -g — ${result || "완료"}`);
        updated = true;
        break;
      }
      case "npm-local": {
        const result = execSync("npm update triflux", {
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

  // 3. setup 재실행 (cli-route.sh, HUD, 스킬 동기화)
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
  const routeVer = getVersion(join(CLAUDE_DIR, "scripts", "cli-route.sh"));
  const hudVer = getVersion(join(CLAUDE_DIR, "hud", "hud-qos-status.mjs"));
  console.log(`\n  ${AMBER}${BOLD}⬡ triflux${RESET} ${WHITE_BRIGHT}v${PKG.version}${RESET}`);
  if (routeVer) console.log(`  ${GRAY}cli-route${RESET}  v${routeVer}`);
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
    ${WHITE_BRIGHT}tfx update${RESET}     ${GRAY}최신 버전으로 업데이트${RESET}
    ${WHITE_BRIGHT}tfx list${RESET}       ${GRAY}설치된 스킬 목록${RESET}
    ${WHITE_BRIGHT}tfx version${RESET}    ${GRAY}버전 표시${RESET}

  ${BOLD}Skills${RESET} ${GRAY}(Claude Code 슬래시 커맨드)${RESET}

    ${AMBER}/tfx-auto${RESET}       ${GRAY}자동 분류 + 병렬 실행${RESET}
    ${WHITE_BRIGHT}/tfx-codex${RESET}      ${GRAY}Codex 전용 모드${RESET}
    ${BLUE}/tfx-gemini${RESET}     ${GRAY}Gemini 전용 모드${RESET}
    ${AMBER}/tfx-setup${RESET}      ${GRAY}HUD 설정 + 진단${RESET}

  ${LINE}
  ${GRAY}github.com/tellang/triflux${RESET}
`);
}

// ── 메인 ──

const cmd = process.argv[2] || "help";

switch (cmd) {
  case "setup":   cmdSetup(); break;
  case "doctor":  cmdDoctor(); break;
  case "update":  cmdUpdate(); break;
  case "list": case "ls": cmdList(); break;
  case "version": case "--version": case "-v": cmdVersion(); break;
  case "help": case "--help": case "-h": cmdHelp(); break;
  default:
    console.error(`알 수 없는 명령: ${cmd}`);
    cmdHelp();
    process.exit(1);
}
