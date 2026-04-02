#!/usr/bin/env node
// hooks/hook-orchestrator.mjs — 범용 훅 체이닝 엔진
//
// settings.json에 이벤트당 하나만 등록. stdin JSON에서 이벤트명+툴명을 읽고
// hook-registry.json의 우선순위대로 훅을 순차 실행한다.
//
// 실행 규칙:
//   - priority 낮을수록 먼저 실행 (triflux=0, omc=50, external=100)
//   - blocking:true 훅이 exit 2 반환 → 즉시 중단, 이후 훅 건너뜀
//   - 출력(stdout JSON)은 마지막 유효 출력으로 머지
//   - 훅 실패(exit !0 && !2)는 무시하고 다음 훅 진행
//
// 사용법:
//   settings.json에서:
//   { "type": "command", "command": "node .../hook-orchestrator.mjs", "timeout": 30 }
//
// 환경변수:
//   TRIFLUX_HOOK_REGISTRY — registry 경로 오버라이드
//   CLAUDE_PLUGIN_ROOT    — ${PLUGIN_ROOT} 치환용
//   HOME / USERPROFILE    — ${HOME} 치환용

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { PLUGIN_ROOT } from "./lib/resolve-root.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH =
  process.env.TRIFLUX_HOOK_REGISTRY || join(__dirname, "hook-registry.json");

// ── stdin 읽기 ──────────────────────────────────────────────
function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// ── 레지스트리 로드 ─────────────────────────────────────────
function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) return null;
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  } catch {
    return null;
  }
}

// ── 경로 변수 치환 ──────────────────────────────────────────
function resolveCommand(cmd) {
  const home = process.env.HOME || process.env.USERPROFILE || "";

  return cmd
    .replace(/\$\{PLUGIN_ROOT\}/g, PLUGIN_ROOT)
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, PLUGIN_ROOT)
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$HOME\b/g, home);
}

// ── 매처 매칭 ───────────────────────────────────────────────
function matchesMatcher(hookMatcher, toolName, eventInput) {
  if (!hookMatcher || hookMatcher === "*") return true;
  if (!toolName) return true;

  // 파이프 구분 OR 매칭 (예: "Bash|Agent")
  const patterns = hookMatcher.split("|").map((p) => p.trim());
  return patterns.some((p) => {
    try {
      return new RegExp(`^${p}$`).test(toolName);
    } catch {
      return p === toolName;
    }
  });
}

// ── 단일 훅 실행 ────────────────────────────────────────────
function executeHook(hook, stdinData) {
  const cmd = resolveCommand(hook.command);
  const timeout = (hook.timeout || 10) * 1000;

  // command 파싱: "node script.mjs" → ["node", ["script.mjs"]]
  // "bash script.sh" → ["bash", ["script.sh"]]
  // 따옴표 처리 포함
  const parts = parseCommand(cmd);
  if (parts.length === 0) return { code: 1, stdout: "", stderr: "empty command" };

  const [executable, ...args] = parts;

  try {
    const stdout = execFileSync(executable, args, {
      input: stdinData,
      timeout,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      cwd: process.cwd(),
      env: { ...process.env },
    });
    return { code: 0, stdout: stdout || "", stderr: "" };
  } catch (err) {
    const code = err.status ?? 1;
    return {
      code,
      stdout: err.stdout || "",
      stderr: err.stderr || "",
    };
  }
}

// ── 명령어 파싱 (따옴표 처리) ───────────────────────────────
function parseCommand(cmd) {
  const parts = [];
  let current = "";
  let inQuote = null;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

// ── JSON 출력 머지 ──────────────────────────────────────────
function mergeOutputs(accumulated, newOutput) {
  if (!newOutput) return accumulated;

  try {
    const parsed = JSON.parse(newOutput);
    if (!accumulated) return parsed;

    // hookSpecificOutput는 마지막 것이 이김
    if (parsed.hookSpecificOutput) {
      accumulated.hookSpecificOutput = parsed.hookSpecificOutput;
    }
    // systemMessage는 누적
    if (parsed.systemMessage) {
      accumulated.systemMessage = accumulated.systemMessage
        ? accumulated.systemMessage + "\n" + parsed.systemMessage
        : parsed.systemMessage;
    }
    // additionalContext는 누적
    if (parsed.additionalContext) {
      accumulated.additionalContext = accumulated.additionalContext
        ? accumulated.additionalContext + "\n" + parsed.additionalContext
        : parsed.additionalContext;
    }
    // decision: block이 하나라도 있으면 block
    if (parsed.decision === "block") {
      accumulated.decision = "block";
      accumulated.reason = parsed.reason || accumulated.reason;
    }
    // continue: false가 하나라도 있으면 false
    if (parsed.continue === false) {
      accumulated.continue = false;
      accumulated.stopReason = parsed.stopReason || accumulated.stopReason;
    }

    return accumulated;
  } catch {
    // JSON이 아니면 additionalContext로 취급
    if (!accumulated) accumulated = {};
    accumulated.additionalContext = accumulated.additionalContext
      ? accumulated.additionalContext + "\n" + newOutput.trim()
      : newOutput.trim();
    return accumulated;
  }
}

// ── 메인 ────────────────────────────────────────────────────
function main() {
  const stdinRaw = readStdin();
  const registry = loadRegistry();

  if (!registry) {
    // 레지스트리 없으면 패스스루
    if (stdinRaw.trim()) process.stdout.write(stdinRaw);
    process.exit(0);
  }

  // stdin에서 이벤트명, 툴명 추출
  let eventName = "";
  let toolName = "";
  if (stdinRaw.trim()) {
    try {
      const input = JSON.parse(stdinRaw);
      eventName = input.hook_event_name || "";
      toolName = input.tool_name || "";
    } catch {
      // 파싱 실패 시 그냥 통과
      process.exit(0);
    }
  }

  if (!eventName) process.exit(0);

  // 이벤트에 해당하는 훅 목록
  const hooks = registry.events[eventName];
  if (!hooks || hooks.length === 0) process.exit(0);

  // 우선순위 정렬 (낮을수록 먼저)
  const sorted = [...hooks]
    .filter((h) => h.enabled !== false)
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));

  // 매처 필터링 + 순차 실행
  let mergedOutput = null;
  let blocked = false;

  for (const hook of sorted) {
    // 매처 체크
    if (!matchesMatcher(hook.matcher, toolName)) continue;

    const result = executeHook(hook, stdinRaw);

    if (result.code === 2) {
      // BLOCK — stderr를 에러로 전달하고 즉시 중단
      if (result.stderr) process.stderr.write(result.stderr);
      blocked = true;
      break;
    }

    if (result.code === 0 && result.stdout.trim()) {
      mergedOutput = mergeOutputs(mergedOutput, result.stdout.trim());
    }

    // exit 0이 아닌 다른 코드(1, 3+ 등)는 무시하고 계속
  }

  // 결과 출력
  if (blocked) {
    process.exit(2);
  }

  if (mergedOutput) {
    process.stdout.write(JSON.stringify(mergedOutput));
  }

  process.exit(0);
}

try {
  main();
} catch (err) {
  // 오케스트레이터 자체 실패 → 비차단
  process.stderr.write(`[hook-orchestrator] error: ${err.message}\n`);
  process.exit(0);
}
