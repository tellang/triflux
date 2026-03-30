#!/usr/bin/env node
// scripts/cache-buildup.mjs — Phase 1 캐시 빌드업
// setup.mjs에서 백그라운드 스폰. CWD의 .omc/cache/ 및 .omc/state/에 기록.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, basename } from "node:path";
import { homedir } from "node:os";

import { readPreflightCache } from "./preflight-cache.mjs";
import { SEARCH_SERVER_ORDER, MCP_SERVER_DOMAIN_TAGS } from "./lib/mcp-server-catalog.mjs";

const CWD = process.cwd();
const CACHE_DIR = join(CWD, ".omc", "cache");
const STATE_DIR = join(CWD, ".omc", "state");
const HOME = homedir();

function ensureDirs() {
  mkdirSync(CACHE_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
}

function writeJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

// ── 1. Codex 스킬 스캔 (Task D: 일반화된 발견) ──

const ROLE_KEYWORDS = {
  plan: ["plan", "계획", "decompos", "strategy", "설계"],
  auto: ["autonomous", "자율", "auto-execute", "autopilot", "full auto"],
  persist: ["loop", "반복", "completion", "persist", "until", "끝까지"],
  investigate: ["investigate", "research", "조사", "분석", "analysis"],
  review: ["review", "리뷰", "inspect", "검수"],
};

function classifyRole(description) {
  const lower = (description || "").toLowerCase();
  for (const [role, keywords] of Object.entries(ROLE_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) return role;
  }
  return "general";
}

function parseSkillFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;

  const fm = match[1];
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() || null;
  const desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() || null;
  return name ? { name, description: desc } : null;
}

export function scanCodexSkills() {
  const codexSkillsDir = join(HOME, ".codex", "skills");
  const skills = [];

  // 1) OMX/커스텀 스킬 (~/.codex/skills/*)
  if (existsSync(codexSkillsDir)) {
    for (const entry of readdirSync(codexSkillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMd = join(codexSkillsDir, entry.name, "SKILL.md");
      if (!existsSync(skillMd)) continue;

      try {
        const content = readFileSync(skillMd, "utf8");
        const fm = parseSkillFrontmatter(content);
        const name = fm?.name || entry.name;
        const description = fm?.description || "";
        skills.push({
          name,
          role: classifyRole(description),
          description: description.slice(0, 200),
          source: "custom",
          path: skillMd,
        });
      } catch {
        skills.push({ name: entry.name, role: "general", description: "", source: "custom", path: skillMd });
      }
    }
  }

  // 2) OpenAI 빌트인 스킬 (codex에 내장된 /명령들)
  const BUILTIN_SKILLS = [
    { name: "web-clone", role: "general", description: "Clone and analyze web pages" },
    { name: "help", role: "general", description: "Show available commands" },
    { name: "note", role: "general", description: "Save notes during session" },
    { name: "worker", role: "auto", description: "Spawn background worker for tasks" },
  ];

  for (const builtin of BUILTIN_SKILLS) {
    // 이미 커스텀으로 오버라이드된 경우 스킵
    if (skills.some((s) => s.name === builtin.name)) continue;
    // 실제 디렉토리 존재 확인
    if (existsSync(join(codexSkillsDir, builtin.name))) continue;
    skills.push({ ...builtin, source: "builtin" });
  }

  return {
    scanned_at: new Date().toISOString(),
    codex_skills_dir: codexSkillsDir,
    total: skills.length,
    skills,
  };
}

// ── 2. Tier 환경 프로브 ──

export function probeTierEnvironment() {
  const preflight = readPreflightCache();
  const checks = {
    psmux: false,
    hub: false,
    codex: preflight?.codex?.ok || false,
    gemini: preflight?.gemini?.ok || false,
    wt: false,
  };

  // psmux
  try {
    execSync("psmux --version", { stdio: "ignore", timeout: 3000, windowsHide: true });
    checks.psmux = true;
  } catch {}

  // hub (preflight에서 가져오거나 직접 확인)
  if (preflight?.hub?.ok) {
    checks.hub = true;
  } else {
    try {
      execSync("curl -sf http://127.0.0.1:27888/status", { stdio: "ignore", timeout: 2000, windowsHide: true });
      checks.hub = true;
    } catch {}
  }

  // Windows Terminal
  if (process.platform === "win32") {
    try {
      execSync("where wt.exe", { stdio: "ignore", timeout: 2000, windowsHide: true });
      checks.wt = true;
    } catch {}
  }

  // Tier 분류
  let tier = "minimal"; // claude-only
  if (checks.codex || checks.gemini) tier = "standard"; // multi-cli
  if (checks.psmux && checks.hub && (checks.codex || checks.gemini)) tier = "full"; // orchestration-ready

  const agents = [];
  agents.push("claude");
  if (checks.codex) agents.push("codex");
  if (checks.gemini) agents.push("gemini");

  return {
    probed_at: new Date().toISOString(),
    tier,
    checks,
    available_agents: agents,
    codex_plan: preflight?.codex_plan || { plan: "unknown" },
  };
}

// ── 3. 프로젝트 메타 추출 ──

export function extractProjectMeta() {
  let name = basename(CWD);
  let description = "";
  let lang = "unknown";
  let testCmd = null;
  let isGit = false;

  // git
  try {
    const toplevel = execSync("git rev-parse --show-toplevel", {
      encoding: "utf8", timeout: 3000, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    name = basename(toplevel);
    isGit = true;
  } catch {}

  // package.json
  const pkgPath = join(CWD, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      description = pkg.description || "";
      testCmd = pkg.scripts?.test || null;
      lang = "JavaScript/ESM (Node.js)";
    } catch {}
  } else if (existsSync(join(CWD, "pyproject.toml")) || existsSync(join(CWD, "setup.py"))) {
    lang = "Python";
  } else if (existsSync(join(CWD, "Cargo.toml"))) {
    lang = "Rust";
  } else if (existsSync(join(CWD, "go.mod"))) {
    lang = "Go";
  }

  return {
    extracted_at: new Date().toISOString(),
    name,
    description: description.slice(0, 300),
    lang,
    test_cmd: testCmd,
    is_git: isGit,
  };
}

// ── 4. 검색 엔진 확인 ──

function loadMcpInventory() {
  const invPath = join(HOME, ".claude", "cache", "mcp-inventory.json");
  try {
    return JSON.parse(readFileSync(invPath, "utf8"));
  } catch {
    return null;
  }
}

function loadMcpConfigs() {
  const servers = {};
  // Claude 설정 파일들에서 MCP 서버 읽기
  const configPaths = [
    join(HOME, ".claude", "settings.json"),
    join(HOME, ".claude", "settings.local.json"),
    join(CWD, ".mcp.json"),
    join(CWD, ".claude", ".mcp.json"),
  ];

  for (const cfgPath of configPaths) {
    try {
      const data = JSON.parse(readFileSync(cfgPath, "utf8"));
      const mcpServers = data.mcpServers || {};
      for (const [name, config] of Object.entries(mcpServers)) {
        servers[name] = { configured: true, source: basename(cfgPath), ...config };
      }
    } catch {}
  }
  return servers;
}

export function checkSearchEngines() {
  const inventory = loadMcpInventory();
  const configuredServers = loadMcpConfigs();
  const engines = [];

  // 알려진 검색 서버 (우선순위순)
  const KNOWN_SEARCH_SERVERS = [...SEARCH_SERVER_ORDER, "context7"];

  // MCP 인벤토리에서 검색 가능 서버 탐지
  const allServerNames = new Set(KNOWN_SEARCH_SERVERS);

  // 인벤토리의 Claude MCP 서버들도 확인
  if (inventory) {
    for (const scope of ["codex", "gemini", "claude"]) {
      const scopeData = inventory[scope];
      if (!scopeData?.servers) continue;
      for (const srv of scopeData.servers) {
        const tags = srv.domain_tags || MCP_SERVER_DOMAIN_TAGS[srv.name] || [];
        if (tags.includes("search") || tags.includes("web") || tags.includes("research")) {
          allServerNames.add(srv.name);
        }
      }
    }
  }

  // 설정된 서버도 추가
  for (const name of Object.keys(configuredServers)) {
    const tags = MCP_SERVER_DOMAIN_TAGS[name] || [];
    if (tags.includes("search") || tags.includes("web") || KNOWN_SEARCH_SERVERS.includes(name)) {
      allServerNames.add(name);
    }
  }

  // 각 검색 서버의 상태 판정
  for (const name of allServerNames) {
    const configured = !!configuredServers[name];
    const tags = MCP_SERVER_DOMAIN_TAGS[name] || [];

    // 인벤토리에서 실제 활성 상태 확인
    let inventoryStatus = null;
    if (inventory) {
      for (const scope of ["codex", "gemini", "claude"]) {
        const srv = inventory[scope]?.servers?.find((s) => s.name === name);
        if (srv) {
          inventoryStatus = { scope, status: srv.status, tool_count: srv.tool_count };
          break;
        }
      }
    }

    let status = "unavailable";
    if (inventoryStatus?.status === "enabled" || inventoryStatus?.status === "configured") {
      status = "available";
    } else if (configured) {
      status = "configured"; // 설정은 있지만 인벤토리 미확인
    }

    engines.push({
      name,
      status,
      domain_tags: tags,
      configured,
      inventory: inventoryStatus,
      source: configuredServers[name]?.source || null,
    });
  }

  // 우선순위순 정렬: SEARCH_SERVER_ORDER 먼저, 나머지 알파벳순
  engines.sort((a, b) => {
    const ai = SEARCH_SERVER_ORDER.indexOf(a.name);
    const bi = SEARCH_SERVER_ORDER.indexOf(b.name);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.name.localeCompare(b.name);
  });

  const available = engines.filter((e) => e.status === "available");
  const primary = available[0]?.name || null;

  return {
    checked_at: new Date().toISOString(),
    primary_engine: primary,
    available_count: available.length,
    total_count: engines.length,
    engines,
  };
}

// ── 메인 실행 ──

function main() {
  ensureDirs();

  const results = {};

  try {
    const skills = scanCodexSkills();
    writeJSON(join(CACHE_DIR, "codex-skills.json"), skills);
    results.codex_skills = { ok: true, count: skills.total };
  } catch (e) {
    results.codex_skills = { ok: false, error: e.message };
  }

  try {
    const tier = probeTierEnvironment();
    writeJSON(join(STATE_DIR, "tier-environment.json"), tier);
    results.tier = { ok: true, tier: tier.tier };
  } catch (e) {
    results.tier = { ok: false, error: e.message };
  }

  try {
    const meta = extractProjectMeta();
    writeJSON(join(CACHE_DIR, "project-meta.json"), meta);
    results.project_meta = { ok: true, name: meta.name };
  } catch (e) {
    results.project_meta = { ok: false, error: e.message };
  }

  try {
    const search = checkSearchEngines();
    writeJSON(join(STATE_DIR, "search-engines.json"), search);
    results.search_engines = { ok: true, primary: search.primary_engine, available: search.available_count };
  } catch (e) {
    results.search_engines = { ok: false, error: e.message };
  }

  // 간결 stdout (hook/로그용)
  const ok = Object.values(results).every((r) => r.ok);
  const summary = ok ? "cache-buildup: ok" : "cache-buildup: partial";
  const details = [];
  if (results.codex_skills?.ok) details.push(`skills:${results.codex_skills.count}`);
  if (results.tier?.ok) details.push(`tier:${results.tier.tier}`);
  if (results.search_engines?.ok) details.push(`search:${results.search_engines.primary || "none"}(${results.search_engines.available})`);
  console.log(details.length ? `${summary} (${details.join(", ")})` : summary);
}

if (process.argv[1]?.endsWith("cache-buildup.mjs")) {
  main();
}
