#!/usr/bin/env node
// tui/gemini-profile.mjs — Interactive Gemini Profile Manager
// Codex config.toml 대칭 구조 — JSON 기반 프로필 CRUD
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  clear, box, table, divider, label, ok, warn, fail, info,
  select, confirm, input, spinner,
  RESET, DIM, BOLD, CYAN, AMBER, GREEN, RED, YELLOW, WHITE, GRAY,
  onExit, showCursor,
} from "./core.mjs";

const GEMINI_DIR = join(homedir(), ".gemini");
const CONFIG_PATH = join(GEMINI_DIR, "triflux-profiles.json");

const KNOWN_MODELS = [
  { label: "gemini-3.1-pro-preview",   hint: "3.1 Pro — 플래그십" },
  { label: "gemini-3-flash-preview",   hint: "3.0 Flash — 빠른 응답" },
  { label: "gemini-2.5-pro",           hint: "2.5 Pro — 안정" },
  { label: "gemini-2.5-flash",         hint: "2.5 Flash — 경량" },
  { label: "gemini-2.5-flash-lite",    hint: "2.5 Flash Lite — 최경량" },
  { label: "직접 입력",                 hint: "" },
];

const DEFAULT_CONFIG = {
  model: "gemini-3.1-pro-preview",
  profiles: {
    pro31:   { model: "gemini-3.1-pro-preview",   hint: "3.1 Pro — 플래그십 (1M ctx, 멀티모달)" },
    flash3:  { model: "gemini-3-flash-preview",   hint: "3.0 Flash — 빠른 응답, 비용 효율" },
    pro25:   { model: "gemini-2.5-pro",           hint: "2.5 Pro — 안정 (추론 강화)" },
    flash25: { model: "gemini-2.5-flash",         hint: "2.5 Flash — 경량 범용" },
    lite25:  { model: "gemini-2.5-flash-lite",    hint: "2.5 Flash Lite — 최경량" },
  },
};

// ── JSON Config ──

function readConfig() {
  if (!existsSync(CONFIG_PATH)) return structuredClone(DEFAULT_CONFIG);
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    warn("triflux-profiles.json 파싱 실패, 기본값 사용");
    return structuredClone(DEFAULT_CONFIG);
  }
}

function getProfiles(config) {
  return Object.entries(config.profiles || {}).map(([name, p]) => ({
    name,
    model: p.model || config.model,
    hint: p.hint || "",
  }));
}

// ── UI Flows ──

function showStatus(config) {
  const profiles = getProfiles(config);

  console.log();
  label("기본 모델", `${WHITE}${config.model || "미설정"}${RESET}`);
  console.log();

  if (profiles.length === 0) {
    warn("등록된 프로필이 없습니다.");
    return;
  }

  const headers = ["프로필", "모델", "설명"];
  const rows = profiles.map((p) => [
    `${CYAN}${p.name}${RESET}`,
    modelColor(p.model),
    p.hint ? `${DIM}${p.hint}${RESET}` : "",
  ]);

  table(headers, rows);
}

function modelColor(model) {
  if (!model) return `${DIM}inherit${RESET}`;
  if (model.includes("pro")) return `${YELLOW}${model}${RESET}`;
  if (model.includes("flash-lite")) return `${GREEN}${model}${RESET}`;
  if (model.includes("flash")) return `${CYAN}${model}${RESET}`;
  return `${WHITE}${model}${RESET}`;
}

async function pickModel(current) {
  const idx = KNOWN_MODELS.findIndex((m) => m.label === current);
  const choice = await select("모델 선택", KNOWN_MODELS, { initial: Math.max(0, idx) });
  if (!choice) return null;
  if (choice.value.label === "직접 입력") {
    return await input("모델 ID", current || "");
  }
  return choice.value.label;
}

async function editProfile(config) {
  const profiles = getProfiles(config);
  if (profiles.length === 0) {
    warn("편집할 프로필이 없습니다.");
    return config;
  }

  const options = profiles.map((p) => ({
    label: p.name,
    hint: `${DIM}${p.model}${RESET}`,
  }));

  const picked = await select("편집할 프로필", options);
  if (!picked) return config;

  const profile = profiles[picked.index];
  console.log();
  info(`현재: ${BOLD}${profile.name}${RESET} → ${profile.model}`);

  const newModel = await pickModel(profile.model);
  if (newModel === null) return config;

  const hint = await input("설명 (Enter로 유지)", profile.hint);

  console.log();
  info(`변경: ${profile.model} → ${BOLD}${newModel}${RESET}`);

  if (!(await confirm("저장하시겠습니까?"))) return config;

  config.profiles[profile.name] = { model: newModel, hint: hint || profile.hint };
  save(config);
  ok(`${profile.name} 프로필 저장 완료`);
  return readConfig();
}

async function editDefault(config) {
  info(`현재 기본 모델: ${BOLD}${config.model || "미설정"}${RESET}`);

  const newModel = await pickModel(config.model);
  if (newModel === null) return config;

  console.log();
  info(`변경: ${config.model} → ${BOLD}${newModel}${RESET}`);

  if (!(await confirm("저장하시겠습니까?"))) return config;

  config.model = newModel;
  save(config);
  ok("기본 모델 저장 완료");
  return readConfig();
}

async function addProfile(config) {
  const name = await input("새 프로필 이름");
  if (!name) return config;

  if (config.profiles[name]) {
    fail(`'${name}' 프로필이 이미 존재합니다.`);
    return config;
  }

  const model = await pickModel("");
  if (!model) return config;

  const hint = await input("설명 (선택)", "");

  console.log();
  info(`추가: ${BOLD}${name}${RESET} → ${model}`);
  if (!(await confirm("저장하시겠습니까?"))) return config;

  config.profiles[name] = { model, hint };
  save(config);
  ok(`${name} 프로필 추가 완료`);
  return readConfig();
}

async function removeProfile(config) {
  const profiles = getProfiles(config);
  if (profiles.length === 0) {
    warn("삭제할 프로필이 없습니다.");
    return config;
  }

  const options = profiles.map((p) => ({ label: p.name, hint: p.model }));
  const picked = await select("삭제할 프로필", options);
  if (!picked) return config;

  const name = profiles[picked.index].name;
  if (!(await confirm(`${RED}${name}${RESET} 프로필을 삭제하시겠습니까?`, false))) {
    return config;
  }

  delete config.profiles[name];
  save(config);
  ok(`${name} 프로필 삭제 완료`);
  return readConfig();
}

function save(config) {
  if (!existsSync(GEMINI_DIR)) mkdirSync(GEMINI_DIR, { recursive: true });

  // Backup before write
  if (existsSync(CONFIG_PATH)) {
    copyFileSync(CONFIG_PATH, CONFIG_PATH + ".bak");
  }

  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
}

// ── Main Loop ──

const MENU = [
  { label: "프로필 모델 변경",   hint: "모델 수정" },
  { label: "기본 모델 변경",     hint: "top-level default" },
  { label: "프로필 추가",        hint: "새 프로필 생성" },
  { label: "프로필 삭제",        hint: "기존 프로필 제거" },
  { label: "종료",              hint: "Ctrl+C" },
];

async function main() {
  onExit(() => {});
  clear();

  let config = readConfig();

  while (true) {
    box("Gemini Profile Manager", 46);
    showStatus(config);
    console.log();

    const choice = await select("작업 선택", MENU);
    if (!choice || choice.index === 4) {
      console.log();
      info("종료합니다.");
      showCursor();
      break;
    }

    console.log();
    switch (choice.index) {
      case 0: config = await editProfile(config); break;
      case 1: config = await editDefault(config); break;
      case 2: config = await addProfile(config); break;
      case 3: config = await removeProfile(config); break;
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
