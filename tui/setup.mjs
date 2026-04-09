#!/usr/bin/env node
// tui/setup.mjs — Interactive triflux setup wizard TUI
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_GEMINI_PROFILES } from "../scripts/lib/gemini-profiles.mjs";
import {
  AMBER,
  BOLD,
  box,
  CYAN,
  clear,
  confirm,
  DIM,
  divider,
  fail,
  GRAY,
  GREEN,
  info,
  ok,
  onExit,
  RESET,
  select,
  showCursor,
  spinner,
  table,
  warn,
  YELLOW,
} from "./core.mjs";

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLAUDE_DIR = join(homedir(), ".claude");
const CODEX_DIR = join(homedir(), ".codex");
const GEMINI_DIR = join(homedir(), ".gemini");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");

// ── Step Definitions ──

const STEPS = [
  {
    id: "sync",
    name: "파일 동기화",
    desc: "스크립트/HUD/스킬을 ~/.claude/에 배포",
  },
  { id: "hud", name: "HUD 설정", desc: "settings.json에 statusLine 등록" },
  { id: "profiles", name: "Codex 프로파일", desc: "필수 프로파일 생성/확인" },
  {
    id: "gemini-profiles",
    name: "Gemini 프로필",
    desc: "triflux-profiles.json 생성/확인",
  },
  { id: "cli", name: "CLI 진단", desc: "Codex/Gemini/Claude CLI 확인" },
  { id: "mcp", name: "MCP 서버 확인", desc: "MCP 서버 인벤토리 점검" },
];

// ── Step Implementations ──

function stepSync() {
  try {
    const _out = execFileSync(
      process.execPath,
      [join(PKG_ROOT, "bin", "triflux.mjs"), "setup", "--json"],
      { timeout: 30000, encoding: "utf8", windowsHide: true },
    );
    return { ok: true, detail: "파일 동기화 완료" };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

function stepHud() {
  try {
    if (!existsSync(SETTINGS_PATH)) {
      return { ok: false, detail: "settings.json 미존재", action: "create" };
    }

    const raw = readFileSync(SETTINGS_PATH, "utf8");
    let settings;
    try {
      settings = JSON.parse(raw);
    } catch {
      return { ok: false, detail: "settings.json 파싱 실패", action: "fix" };
    }

    const hudScript = join(CLAUDE_DIR, "hud", "hud-qos-status.mjs");
    const nodePath = process.execPath;

    // Check if statusLine already configured correctly
    if (settings.statusLine?.command?.includes("hud-qos-status")) {
      return {
        ok: true,
        detail: "statusLine 이미 설정됨",
        current: settings.statusLine,
      };
    }

    return {
      ok: false,
      detail: settings.statusLine
        ? "statusLine이 다른 HUD를 가리킴"
        : "statusLine 미설정",
      action: "configure",
      current: settings.statusLine || null,
      target: {
        type: "command",
        command: `"${nodePath}" "${hudScript}"`,
      },
    };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

function stepProfiles() {
  const configPath = join(CODEX_DIR, "config.toml");
  if (!existsSync(configPath)) {
    return { ok: false, detail: "config.toml 미존재", action: "skip" };
  }

  const content = readFileSync(configPath, "utf8");
  const required = ["codex53_high", "codex53_xhigh", "spark53_low"];
  const missing = required.filter((name) => {
    const re = new RegExp(`^\\[profiles\\.${name}\\]`, "m");
    return !re.test(content);
  });

  if (missing.length === 0) {
    return { ok: true, detail: `필수 프로파일 ${required.length}개 확인됨` };
  }

  return {
    ok: false,
    detail: `누락: ${missing.join(", ")}`,
    missing,
    action: "create",
  };
}

function stepGeminiProfiles() {
  const configPath = join(GEMINI_DIR, "triflux-profiles.json");
  if (!existsSync(configPath)) {
    if (!existsSync(GEMINI_DIR)) mkdirSync(GEMINI_DIR, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify(DEFAULT_GEMINI_PROFILES, null, 2) + "\n",
      "utf8",
    );
    return {
      ok: true,
      detail: `기본 프로필 ${Object.keys(DEFAULT_GEMINI_PROFILES.profiles).length}개 자동 생성됨`,
      action: "created",
    };
  }

  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    const required = ["pro31", "flash3"];
    const missing = required.filter((name) => !cfg.profiles?.[name]);
    if (missing.length === 0) {
      const count = Object.keys(cfg.profiles || {}).length;
      return { ok: true, detail: `프로필 ${count}개 확인됨` };
    }
    return {
      ok: false,
      detail: `누락: ${missing.join(", ")}`,
      action: "update",
    };
  } catch {
    return {
      ok: false,
      detail: "triflux-profiles.json 파싱 실패",
      action: "recreate",
    };
  }
}

function stepCli() {
  const results = [];
  for (const [name, installCmd] of [
    ["codex", "npm i -g @openai/codex"],
    ["gemini", "npm i -g @google/gemini-cli"],
    ["claude", "Claude Code 설치"],
  ]) {
    try {
      execFileSync(process.platform === "win32" ? "where" : "which", [name], {
        timeout: 5000,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      results.push({ name, found: true });
    } catch {
      results.push({ name, found: false, install: installCmd });
    }
  }
  const allFound = results.every((r) => r.found);
  return {
    ok: allFound,
    results,
    detail: allFound ? "모든 CLI 확인됨" : "일부 CLI 미설치",
  };
}

function stepMcp() {
  const inventoryPath = join(CLAUDE_DIR, "cache", "mcp-inventory.json");
  if (!existsSync(inventoryPath)) {
    return { ok: false, detail: "MCP 인벤토리 미존재", action: "rebuild" };
  }
  try {
    const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
    const count = Object.keys(inventory.servers || inventory).length;
    return { ok: true, detail: `${count}개 MCP 서버 등록됨` };
  } catch {
    return { ok: false, detail: "MCP 인벤토리 파싱 실패", action: "rebuild" };
  }
}

const STEP_RUNNERS = {
  sync: stepSync,
  hud: stepHud,
  profiles: stepProfiles,
  "gemini-profiles": stepGeminiProfiles,
  cli: stepCli,
  mcp: stepMcp,
};

// ── UI ──

function showStepResult(step, result) {
  if (result.ok) {
    ok(`${step.name}: ${result.detail}`);
  } else {
    warn(`${step.name}: ${result.detail}`);
  }
}

async function runWizard() {
  console.log();
  info(`${STEPS.length}개 단계를 순서대로 실행합니다.`);
  console.log();

  const results = {};

  for (let i = 0; i < STEPS.length; i++) {
    const step = STEPS[i];
    const progress = `${DIM}[${i + 1}/${STEPS.length}]${RESET}`;

    console.log(
      `  ${progress} ${BOLD}${step.name}${RESET} ${DIM}— ${step.desc}${RESET}`,
    );

    const spin = spinner(`${step.name} 실행 중...`);
    const result = STEP_RUNNERS[step.id]();
    spin.stop();

    showStepResult(step, result);
    results[step.id] = result;

    // Handle fixable issues
    if (!result.ok && result.action) {
      await handleStepFix(step, result);
    }

    console.log();
  }

  return results;
}

async function handleStepFix(step, result) {
  switch (step.id) {
    case "hud": {
      if (result.action === "configure") {
        if (result.current) {
          warn(`현재 statusLine: ${JSON.stringify(result.current)}`);
          if (!(await confirm("triflux HUD로 덮어쓰시겠습니까?", false)))
            return;
        } else {
          if (!(await confirm("statusLine을 설정하시겠습니까?"))) return;
        }
        try {
          const raw = readFileSync(SETTINGS_PATH, "utf8");
          const settings = JSON.parse(raw);
          settings.statusLine = result.target;
          writeFileSync(
            SETTINGS_PATH,
            JSON.stringify(settings, null, 2),
            "utf8",
          );
          ok("statusLine 설정 완료");
        } catch (e) {
          fail(`설정 실패: ${e.message}`);
        }
      }
      break;
    }

    case "profiles": {
      if (result.action === "create" && result.missing) {
        if (
          await confirm(
            `누락된 프로파일 ${result.missing.length}개를 생성하시겠습니까?`,
          )
        ) {
          try {
            execFileSync(
              process.execPath,
              [join(PKG_ROOT, "bin", "triflux.mjs"), "setup"],
              { timeout: 15000, stdio: "ignore", windowsHide: true },
            );
            ok("프로파일 생성 완료");
          } catch {
            warn("프로파일 생성 실패 — triflux setup으로 재시도");
          }
        }
      }
      break;
    }

    case "mcp": {
      if (result.action === "rebuild") {
        if (await confirm("MCP 인벤토리를 재생성하시겠습니까?")) {
          const mcpCheck = join(PKG_ROOT, "scripts", "mcp-check.mjs");
          if (existsSync(mcpCheck)) {
            try {
              execFileSync(process.execPath, [mcpCheck], {
                timeout: 15000,
                stdio: "ignore",
                windowsHide: true,
              });
              ok("MCP 인벤토리 재생성 완료");
            } catch {
              warn("MCP 인벤토리 재생성 실패 — 다음 세션에서 자동 재시도");
            }
          }
        }
      }
      break;
    }
  }
}

async function runSelective() {
  const options = STEPS.map((s) => ({
    label: s.name,
    hint: s.desc,
  }));

  const picked = await select("실행할 단계", options);
  if (!picked) return;

  const step = STEPS[picked.index];
  console.log();
  const spin = spinner(`${step.name} 실행 중...`);
  const result = STEP_RUNNERS[step.id]();
  spin.stop();

  showStepResult(step, result);

  if (!result.ok && result.action) {
    await handleStepFix(step, result);
  }

  // CLI step has extra detail
  if (step.id === "cli" && result.results) {
    console.log();
    for (const r of result.results) {
      if (r.found) ok(`${r.name}: 설치됨`);
      else warn(`${r.name}: 미설치 → ${DIM}${r.install}${RESET}`);
    }
  }
}

function showSummary(results) {
  console.log();
  divider(46);
  box("Setup 완료", 46);
  console.log();

  const headers = ["항목", "상태"];
  const rows = STEPS.map((s) => {
    const r = results[s.id];
    if (!r) return [s.name, `${GRAY}건너뜀${RESET}`];
    return [
      s.name,
      r.ok ? `${GREEN}✓ 정상${RESET}` : `${YELLOW}⚠ ${r.detail}${RESET}`,
    ];
  });

  table(headers, rows);

  const issues = Object.values(results).filter((r) => r && !r.ok).length;
  console.log();
  if (issues === 0) {
    ok(`${BOLD}모든 항목 정상${RESET} — 세션을 재시작하면 적용됩니다`);
  } else {
    warn(`${issues}개 항목에 주의가 필요합니다`);
    info("/tfx-doctor --fix 로 자동 수정을 시도하세요");
  }
}

// ── Star Request ──

async function starRequest() {
  let ghOk = false;
  try {
    execFileSync("gh", ["auth", "status"], {
      timeout: 5000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    ghOk = true;
  } catch {}

  if (!ghOk) {
    console.log();
    info(
      `${AMBER}⭐${RESET} 하나가 큰 차이를 만듭니다. ${CYAN}https://github.com/tellang/triflux${RESET}`,
    );
    console.log();
    return;
  }

  // gh 인증됨 — 스타 여부 확인
  let alreadyStarred = false;
  try {
    execFileSync("gh", ["api", "user/starred/tellang/triflux"], {
      timeout: 5000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    alreadyStarred = true;
  } catch {}

  console.log();

  if (alreadyStarred) {
    ok(`이미 함께하고 계시군요. ${AMBER}⭐${RESET}`);
    console.log();
    return;
  }

  if (await confirm(`${AMBER}⭐${RESET} 하나가 큰 차이를 만듭니다.`, false)) {
    try {
      execFileSync(
        "gh",
        ["api", "-X", "PUT", "/user/starred/tellang/triflux"],
        {
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      ok(`함께해 주셔서 감사합니다. ${AMBER}⭐${RESET}`);
    } catch {
      info(`${CYAN}https://github.com/tellang/triflux${RESET}`);
    }
  } else {
    console.log(`     ${DIM}${CYAN}https://github.com/tellang/triflux${RESET}`);
  }
  console.log();
}

// ── Main Menu ──

const MENU = [
  { label: "전체 설정 (Full Setup)", hint: "6단계 순서 실행" },
  { label: "단계별 선택 (Selective)", hint: "특정 단계만 실행" },
  { label: "현재 상태 확인 (Status)", hint: "설정 없이 진단만" },
  { label: "종료", hint: "Ctrl+C" },
];

async function main() {
  onExit(() => {});
  clear();

  while (true) {
    box("triflux Setup Wizard", 46);
    console.log();

    const choice = await select("작업 선택", MENU);
    if (!choice || choice.index === 3) {
      console.log();
      info("종료합니다.");
      showCursor();
      break;
    }

    console.log();

    switch (choice.index) {
      case 0: {
        const results = await runWizard();
        showSummary(results);
        await starRequest();
        break;
      }

      case 1: {
        await runSelective();
        break;
      }

      case 2: {
        info("현재 상태를 확인합니다...");
        console.log();
        const results = {};
        for (const step of STEPS) {
          if (step.id === "sync") continue; // sync는 상태 확인 불가
          const result = STEP_RUNNERS[step.id]();
          showStepResult(step, result);
          results[step.id] = result;
          if (step.id === "cli" && result.results) {
            for (const r of result.results) {
              if (r.found) ok(`  ${r.name}: 설치됨`);
              else warn(`  ${r.name}: 미설치`);
            }
          }
        }
        break;
      }
    }

    console.log();
    divider(46);
  }
}

main().catch((e) => {
  showCursor();
  console.error(e);
  process.exit(1);
});
