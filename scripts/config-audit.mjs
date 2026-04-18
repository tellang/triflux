#!/usr/bin/env node
// scripts/config-audit.mjs — 설정 정적 보안/성능 감사
//
// triflux doctor --audit 또는 단독 실행.
// settings.json, CLAUDE.md, MCP, 훅 설정을 스캔하여 위험/성능 이슈 탐지.
//
// 출력: JSON (--json) 또는 마크다운 테이블

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");
const JSON_OUTPUT = process.argv.includes("--json");

// ── 결과 수집 ──
const findings = [];

function addFinding(category, severity, message, detail = "") {
  findings.push({ category, severity, message, detail });
}

// ── 1. settings.json 감사 ──
function auditSettings() {
  const settingsPath = join(CLAUDE_DIR, "settings.json");
  if (!existsSync(settingsPath)) {
    addFinding("settings", "info", "settings.json 없음", settingsPath);
    return;
  }

  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    addFinding("settings", "warn", "settings.json 파싱 실패", settingsPath);
    return;
  }

  // 권한 모드
  const mode = settings.permissions?.defaultMode;
  if (mode === "bypassPermissions" || mode === "acceptEdits") {
    addFinding(
      "settings",
      "warn",
      `defaultMode: "${mode}" — 도구 승인 없이 실행됨`,
      "보안 리뷰 시 주의",
    );
  }

  // 환경 변수 내 시크릿 패턴
  const env = settings.env || {};
  const SECRET_PATTERNS = [
    /(?:api[_-]?key|secret|token|password|credential)s?\s*[:=]/i,
    /(?:sk-|ghp_|gho_|github_pat_|xoxb-|xoxp-)/i,
    /ANTHROPIC_API_KEY/i,
    /OPENAI_API_KEY/i,
  ];
  for (const [key, value] of Object.entries(env)) {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(key) || pattern.test(String(value))) {
        addFinding(
          "settings",
          "critical",
          `env에 시크릿 패턴 감지: ${key}`,
          "환경변수로 분리 권장",
        );
        break;
      }
    }
  }

  // 훅 timeout 검사
  const hooks = settings.hooks || {};
  let totalHooks = 0;
  let _longTimeouts = 0;
  for (const [event, matchers] of Object.entries(hooks)) {
    for (const matcher of Array.isArray(matchers) ? matchers : []) {
      for (const hook of matcher.hooks || []) {
        totalHooks++;
        if (hook.timeout && hook.timeout > 15) {
          _longTimeouts++;
          addFinding(
            "hooks",
            "warn",
            `${event} 훅 timeout ${hook.timeout}s (>15s)`,
            hook.command?.slice(0, 80),
          );
        }
      }
    }
  }
  if (totalHooks > 10) {
    addFinding(
      "hooks",
      "info",
      `settings.json에 훅 ${totalHooks}개 등록`,
      "SessionStart 성능에 영향 가능",
    );
  }
}

// ── 2. CLAUDE.md 시크릿 스캔 ──
function auditClaudeMd() {
  const candidates = [
    join(process.cwd(), "CLAUDE.md"),
    join(CLAUDE_DIR, "CLAUDE.md"),
  ];

  for (const mdPath of candidates) {
    if (!existsSync(mdPath)) continue;
    let content;
    try {
      content = readFileSync(mdPath, "utf8");
    } catch {
      continue;
    }

    const SECRET_LINE_PATTERNS = [
      /(?:api[_-]?key|secret|password)\s*[:=]\s*["']?\S{8,}/i,
      /(?:^|[\s"'=:])(?:sk-|ghp_|gho_|github_pat_|xoxb-|xoxp-)[A-Za-z0-9_-]{10,}/,
      /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
    ];

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const pattern of SECRET_LINE_PATTERNS) {
        if (pattern.test(lines[i])) {
          addFinding(
            "claude-md",
            "critical",
            `CLAUDE.md:${i + 1} 시크릿 패턴 감지`,
            basename(mdPath),
          );
          break;
        }
      }
    }

    // 길이 경고
    const tokenEstimate = Math.ceil(Buffer.byteLength(content, "utf8") / 4);
    if (tokenEstimate > 3000) {
      addFinding(
        "claude-md",
        "warn",
        `CLAUDE.md ~${tokenEstimate} 토큰 (>3000)`,
        `${basename(mdPath)} — 컨텍스트 로트 위험`,
      );
    }
  }
}

// ── 3. MCP 설정 감사 ──
function auditMcp() {
  const mcpPaths = [
    join(CLAUDE_DIR, "mcp_servers.json"),
    join(CLAUDE_DIR, ".mcp.json"),
    join(process.cwd(), ".mcp.json"),
  ];

  let totalServers = 0;
  let stdioCount = 0;

  for (const mcpPath of mcpPaths) {
    if (!existsSync(mcpPath)) continue;
    let config;
    try {
      config = JSON.parse(readFileSync(mcpPath, "utf8"));
    } catch {
      continue;
    }

    const servers = config.mcpServers || config.servers || config;
    for (const [name, def] of Object.entries(servers)) {
      if (!def || typeof def !== "object") continue;
      totalServers++;

      if (def.type === "stdio" || def.command) {
        stdioCount++;
      }

      // 위험 패턴: 쉘 실행, eval, 알 수 없는 npx 패키지
      const cmd = String(def.command || "");
      if (/\beval\b|\bexec\b.*sh\b|\bcurl\b.*\|\s*(?:bash|sh)\b/i.test(cmd)) {
        addFinding(
          "mcp",
          "critical",
          `MCP "${name}": 위험한 명령 패턴`,
          cmd.slice(0, 100),
        );
      }
    }
  }

  if (totalServers > 10) {
    addFinding(
      "mcp",
      "warn",
      `MCP 서버 ${totalServers}개 등록 (>10)`,
      "컨텍스트 윈도우 압박 가능",
    );
  }
  if (stdioCount > 5) {
    addFinding(
      "mcp",
      "info",
      `stdio MCP ${stdioCount}개 — 프로세스 spawn 부하`,
      "불필요한 서버 비활성화 권장",
    );
  }
}

// ── 4. 훅 레지스트리 감사 ──
function auditHookRegistry() {
  const registryPath = join(process.cwd(), "hooks", "hook-registry.json");
  if (!existsSync(registryPath)) return;

  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch {
    return;
  }

  const events = registry.events || {};
  let blockingCount = 0;
  let externalCount = 0;

  for (const [_event, hooks] of Object.entries(events)) {
    for (const hook of hooks) {
      if (hook.blocking) blockingCount++;
      if (hook.source !== "triflux" && hook.source !== "omc") externalCount++;

      // 외부 훅의 명령에 위험 패턴
      if (hook.source !== "triflux") {
        const cmd = String(hook.command || "");
        if (/\brm\b|\bdel\b|\bformat\b|\bgit\s+push\b/i.test(cmd)) {
          addFinding(
            "hooks",
            "warn",
            `외부 훅 "${hook.id}": 위험 명령 패턴`,
            cmd.slice(0, 80),
          );
        }
      }
    }
  }

  if (blockingCount > 5) {
    addFinding(
      "hooks",
      "info",
      `blocking 훅 ${blockingCount}개 — 도구 실행 지연 가능`,
      "불필요한 blocking 해제 검토",
    );
  }
  if (externalCount > 0) {
    addFinding(
      "hooks",
      "info",
      `외부 훅 ${externalCount}개 등록`,
      "출처 확인 권장",
    );
  }
}

// ── 실행 ──
auditSettings();
auditClaudeMd();
auditMcp();
auditHookRegistry();

// ── 출력 ──
const summary = {
  total: findings.length,
  critical: findings.filter((f) => f.severity === "critical").length,
  warn: findings.filter((f) => f.severity === "warn").length,
  info: findings.filter((f) => f.severity === "info").length,
};

if (JSON_OUTPUT) {
  console.log(JSON.stringify({ summary, findings }, null, 2));
} else {
  const SEVERITY_ICON = { critical: "🔴", warn: "🟡", info: "🔵" };
  console.log("\n  ⬡ triflux config audit\n");
  if (findings.length === 0) {
    console.log("  ✅ 이슈 없음\n");
  } else {
    console.log(`  | 심각도 | 카테고리 | 이슈 | 상세 |`);
    console.log(`  |--------|----------|------|------|`);
    for (const f of findings) {
      console.log(
        `  | ${SEVERITY_ICON[f.severity] || "⚪"} ${f.severity} | ${f.category} | ${f.message} | ${f.detail} |`,
      );
    }
    console.log(
      `\n  합계: critical=${summary.critical} warn=${summary.warn} info=${summary.info}\n`,
    );
  }
}

process.exit(summary.critical > 0 ? 1 : 0);
