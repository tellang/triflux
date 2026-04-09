#!/usr/bin/env node
// tui/codex-profile.mjs — Interactive Codex Profile Manager
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BOLD,
  box,
  CYAN,
  clear,
  confirm,
  DIM,
  divider,
  fail,
  GREEN,
  info,
  input,
  label,
  ok,
  onExit,
  RED,
  RESET,
  select,
  showCursor,
  table,
  WHITE,
  warn,
  YELLOW,
} from "./core.mjs";

const CODEX_DIR = join(homedir(), ".codex");
const CONFIG_PATH = join(CODEX_DIR, "config.toml");

const KNOWN_MODELS = [
  { label: "gpt-5.4", hint: "최신 플래그십" },
  { label: "gpt-5.3-codex", hint: "코딩 특화" },
  { label: "gpt-5.1-codex-mini", hint: "경량 Spark" },
  { label: "o3", hint: "추론 특화" },
  { label: "o4-mini", hint: "추론 경량" },
  { label: "직접 입력", hint: "" },
];

const EFFORT_LEVELS = [
  { label: "low", hint: "빠른 응답, 최소 추론" },
  { label: "medium", hint: "균형 잡힌 추론" },
  { label: "high", hint: "깊은 추론" },
  { label: "xhigh", hint: "최대 추론 (느림)" },
];

// ── TOML Parsing ──

function readConfig() {
  if (!existsSync(CONFIG_PATH)) return { raw: "", defaults: {}, profiles: [] };
  const raw = readFileSync(CONFIG_PATH, "utf8");
  return { raw, ...parseConfig(raw) };
}

function parseConfig(raw) {
  const lines = raw.split("\n");
  const defaults = {};
  const profiles = [];
  let currentSection = null;
  let currentProfile = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      const name = sectionMatch[1];
      const profileMatch = name.match(/^profiles\.(\w+)$/);
      if (profileMatch) {
        currentSection = "profile";
        currentProfile = { name: profileMatch[1] };
        profiles.push(currentProfile);
      } else {
        currentSection = name;
        currentProfile = null;
      }
      continue;
    }

    const kvMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
    if (kvMatch) {
      const [, key, rawVal] = kvMatch;
      const value = rawVal.replace(/^["']|["']$/g, "").trim();
      if (currentSection === "profile" && currentProfile) {
        currentProfile[key] = value;
      } else if (!currentSection) {
        defaults[key] = value;
      }
    }
  }

  return { defaults, profiles };
}

function writeProfile(raw, profileName, props) {
  const lines = raw.split("\n");
  const sectionRe = new RegExp(`^\\[profiles\\.${escRe(profileName)}\\]\\s*$`);
  let inSection = false;
  let sectionStart = -1;
  let sectionEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    if (sectionRe.test(lines[i].trim())) {
      inSection = true;
      sectionStart = i;
      continue;
    }
    if (inSection && lines[i].trim().startsWith("[")) {
      sectionEnd = i;
      break;
    }
  }

  if (sectionStart === -1) {
    // Append new profile section
    const newLines = [`[profiles.${profileName}]`];
    for (const [k, v] of Object.entries(props)) {
      newLines.push(`${k} = "${v}"`);
    }
    return raw.trimEnd() + "\n" + newLines.join("\n") + "\n";
  }

  // Replace existing section body
  const newBody = [];
  for (const [k, v] of Object.entries(props)) {
    newBody.push(`${k} = "${v}"`);
  }
  lines.splice(sectionStart + 1, sectionEnd - sectionStart - 1, ...newBody);
  return lines.join("\n");
}

function deleteProfile(raw, profileName) {
  const lines = raw.split("\n");
  const sectionRe = new RegExp(`^\\[profiles\\.${escRe(profileName)}\\]\\s*$`);
  let inSection = false;
  let start = -1;
  let end = lines.length;

  for (let i = 0; i < lines.length; i++) {
    if (sectionRe.test(lines[i].trim())) {
      inSection = true;
      start = i;
      continue;
    }
    if (inSection && lines[i].trim().startsWith("[")) {
      end = i;
      break;
    }
  }

  if (start === -1) return raw;
  // Remove trailing blank lines too
  while (end < lines.length && lines[end].trim() === "") end++;
  lines.splice(start, end - start);
  return lines.join("\n");
}

function setDefault(raw, key, value) {
  const lines = raw.split("\n");
  const keyRe = new RegExp(`^${escRe(key)}\\s*=`);

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith("[")) break; // hit first section
    if (keyRe.test(lines[i].trim())) {
      lines[i] = `${key} = "${value}"`;
      return lines.join("\n");
    }
  }

  // Key not found — insert before first section
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith("[")) {
      lines.splice(i, 0, `${key} = "${value}"`);
      return lines.join("\n");
    }
  }

  return raw + `\n${key} = "${value}"\n`;
}

function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── UI Flows ──

function showStatus(config) {
  const { defaults, profiles } = config;

  console.log();
  label("기본 모델", `${WHITE}${defaults.model || "미설정"}${RESET}`);
  label(
    "기본 Effort",
    `${WHITE}${defaults.model_reasoning_effort || "미설정"}${RESET}`,
  );
  console.log();

  if (profiles.length === 0) {
    warn("등록된 프로파일이 없습니다.");
    return;
  }

  const headers = ["프로파일", "모델", "Effort", "기타"];
  const rows = profiles.map((p) => {
    const extras = Object.entries(p)
      .filter(([k]) => !["name", "model", "model_reasoning_effort"].includes(k))
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    return [
      `${CYAN}${p.name}${RESET}`,
      p.model || DIM + "inherit" + RESET,
      effortColor(p.model_reasoning_effort),
      extras ? `${DIM}${extras}${RESET}` : "",
    ];
  });

  table(headers, rows);
}

function effortColor(effort) {
  if (!effort) return `${DIM}inherit${RESET}`;
  const colors = { low: GREEN, medium: CYAN, high: YELLOW, xhigh: RED };
  return `${colors[effort] || ""}${effort}${RESET}`;
}

async function pickModel(current) {
  const idx = KNOWN_MODELS.findIndex((m) => m.label === current);
  const choice = await select("모델 선택", KNOWN_MODELS, {
    initial: Math.max(0, idx),
  });
  if (!choice) return null;
  if (choice.value.label === "직접 입력") {
    return await input("모델 ID", current || "");
  }
  return choice.value.label;
}

async function pickEffort(current) {
  const idx = EFFORT_LEVELS.findIndex((e) => e.label === current);
  const choice = await select("Reasoning Effort 선택", EFFORT_LEVELS, {
    initial: Math.max(0, idx),
  });
  if (!choice) return null;
  return choice.value.label;
}

async function editProfile(config) {
  const { profiles } = config;
  if (profiles.length === 0) {
    warn("편집할 프로파일이 없습니다.");
    return config;
  }

  const options = profiles.map((p) => ({
    label: p.name,
    hint: `${DIM}${p.model || "inherit"} / ${p.model_reasoning_effort || "inherit"}${RESET}`,
  }));

  const picked = await select("편집할 프로파일", options);
  if (!picked) return config;

  const profile = profiles[picked.index];
  console.log();
  info(
    `현재: ${BOLD}${profile.name}${RESET} → ${profile.model} / ${profile.model_reasoning_effort}`,
  );

  const newModel = await pickModel(profile.model);
  if (newModel === null) return config;

  const newEffort = await pickEffort(profile.model_reasoning_effort);
  if (newEffort === null) return config;

  console.log();
  info(
    `변경: ${profile.model} → ${BOLD}${newModel}${RESET}, ${profile.model_reasoning_effort} → ${BOLD}${newEffort}${RESET}`,
  );

  if (!(await confirm("저장하시겠습니까?"))) return config;

  const props = { model: newModel, model_reasoning_effort: newEffort };
  // Preserve extra props (like model_temperature)
  for (const [k, v] of Object.entries(profile)) {
    if (!["name", "model", "model_reasoning_effort"].includes(k)) props[k] = v;
  }

  const raw = writeProfile(config.raw, profile.name, props);
  save(raw);
  ok(`${profile.name} 프로파일 저장 완료`);
  return readConfig();
}

async function editDefault(config) {
  const { defaults } = config;
  info(`현재 기본 모델: ${BOLD}${defaults.model || "미설정"}${RESET}`);
  info(
    `현재 기본 Effort: ${BOLD}${defaults.model_reasoning_effort || "미설정"}${RESET}`,
  );

  const newModel = await pickModel(defaults.model);
  if (newModel === null) return config;

  const newEffort = await pickEffort(defaults.model_reasoning_effort);
  if (newEffort === null) return config;

  console.log();
  info(
    `변경: ${defaults.model} → ${BOLD}${newModel}${RESET}, ${defaults.model_reasoning_effort} → ${BOLD}${newEffort}${RESET}`,
  );

  if (!(await confirm("저장하시겠습니까?"))) return config;

  let raw = setDefault(config.raw, "model", newModel);
  raw = setDefault(raw, "model_reasoning_effort", newEffort);
  save(raw);
  ok("기본 설정 저장 완료");
  return readConfig();
}

async function addProfile(config) {
  const name = await input("새 프로파일 이름");
  if (!name) return config;

  if (config.profiles.some((p) => p.name === name)) {
    fail(`'${name}' 프로파일이 이미 존재합니다.`);
    return config;
  }

  const model = await pickModel("");
  if (!model) return config;

  const effort = await pickEffort("");
  if (!effort) return config;

  console.log();
  info(`추가: ${BOLD}${name}${RESET} → ${model} / ${effort}`);
  if (!(await confirm("저장하시겠습니까?"))) return config;

  const raw = writeProfile(config.raw, name, {
    model,
    model_reasoning_effort: effort,
  });
  save(raw);
  ok(`${name} 프로파일 추가 완료`);
  return readConfig();
}

async function removeProfile(config) {
  const { profiles } = config;
  if (profiles.length === 0) {
    warn("삭제할 프로파일이 없습니다.");
    return config;
  }

  const options = profiles.map((p) => ({ label: p.name, hint: `${p.model}` }));
  const picked = await select("삭제할 프로파일", options);
  if (!picked) return config;

  const name = profiles[picked.index].name;
  if (
    !(await confirm(
      `${RED}${name}${RESET} 프로파일을 삭제하시겠습니까?`,
      false,
    ))
  ) {
    return config;
  }

  const raw = deleteProfile(config.raw, name);
  save(raw);
  ok(`${name} 프로파일 삭제 완료`);
  return readConfig();
}

function save(content) {
  if (!existsSync(CODEX_DIR)) mkdirSync(CODEX_DIR, { recursive: true });

  // Backup before write
  if (existsSync(CONFIG_PATH)) {
    const backupPath = CONFIG_PATH + ".bak";
    copyFileSync(CONFIG_PATH, backupPath);
  }

  writeFileSync(CONFIG_PATH, content, "utf8");
}

// ── Main Loop ──

const MENU = [
  { label: "프로파일 모델 변경", hint: "모델/effort 수정" },
  { label: "기본 모델 변경", hint: "top-level default" },
  { label: "프로파일 추가", hint: "새 프로파일 생성" },
  { label: "프로파일 삭제", hint: "기존 프로파일 제거" },
  { label: "종료", hint: "Ctrl+C" },
];

async function main() {
  onExit(() => {});
  clear();

  let config = readConfig();

  if (!existsSync(CONFIG_PATH)) {
    fail(`config.toml 미존재: ${CONFIG_PATH}`);
    info("codex를 먼저 설치하거나 /tfx-setup을 실행하세요.");
    process.exit(1);
  }

  while (true) {
    box("Codex Profile Manager", 46);
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
      case 0:
        config = await editProfile(config);
        break;
      case 1:
        config = await editDefault(config);
        break;
      case 2:
        config = await addProfile(config);
        break;
      case 3:
        config = await removeProfile(config);
        break;
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
