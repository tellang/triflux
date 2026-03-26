#!/usr/bin/env node
/**
 * headless-guard.mjs — PreToolUse 훅 (상시 활성 auto-route)
 *
 * psmux가 설치된 환경에서 Bash(tfx-route.sh) 개별 호출을
 * 자동으로 headless 명령으로 변환한다.
 *
 * v2: 마커 파일 의존 제거. psmux 설치 여부만으로 판단.
 *     Opus가 SKILL.md를 무시해도 auto-route가 작동한다.
 *
 * 동작:
 * - psmux 설치 + Bash(tfx-route.sh) → updatedInput: tfx multi --headless --assign
 * - psmux 설치 + Bash(codex exec / gemini -p) → deny
 * - psmux 설치 + Agent(codex/gemini CLI 래핑) → deny
 * - psmux 미설치 → 전부 통과
 *
 * 성능: psmux 감지 결과를 5분간 캐시 ($TMPDIR/tfx-psmux-check.json)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CACHE_FILE = join(tmpdir(), "tfx-psmux-check.json");
const CACHE_TTL_MS = 5 * 60 * 1000; // 5분

function isPsmuxInstalled() {
  // 캐시 확인
  try {
    if (existsSync(CACHE_FILE)) {
      const cache = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
      if (Date.now() - cache.ts < CACHE_TTL_MS) return cache.ok;
    }
  } catch { /* cache miss */ }

  // psmux -V 실행
  let ok = false;
  try {
    execFileSync("psmux", ["-V"], { timeout: 2000, stdio: "ignore" });
    ok = true;
  } catch { /* not installed */ }

  // 캐시 저장
  try {
    writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), ok }));
  } catch { /* ignore */ }

  return ok;
}

/**
 * tfx-route.sh 명령에서 agent, prompt, mcp, 추가 플래그를 파싱한다.
 * v3: 손실 없는 파싱 — 원본 명령의 모든 플래그를 보존.
 */
function parseRouteCommand(cmd) {
  const MCP_PROFILES = ["implement", "analyze", "review", "docs"];

  const agentMatch = cmd.match(/tfx-route\.sh\s+(\S+)\s+/);
  if (!agentMatch) return null;

  const agent = agentMatch[1];
  const afterAgent = cmd.slice(agentMatch.index + agentMatch[0].length);

  let mcp = "";
  let promptRaw = afterAgent;
  for (const profile of MCP_PROFILES) {
    const profileIdx = afterAgent.lastIndexOf(` ${profile}`);
    if (profileIdx >= 0) {
      mcp = profile;
      promptRaw = afterAgent.slice(0, profileIdx);
      break;
    }
  }

  const prompt = promptRaw
    .replace(/^['"]/, "")
    .replace(/['"]$/, "")
    .replace(/'\\''/g, "'")
    .replace(/'"'"'/g, "'")
    .trim();

  // v3: 원본 명령에서 추가 플래그 추출
  const flags = {};
  const afterPrompt = cmd.replace(/'.+?'/gs, "").replace(/".+?"/gs, "");
  const timeoutMatch = afterPrompt.match(/(?:^|\s)(\d{2,4})(?:\s|$)/);  // 4번째 인자 (timeout)
  if (timeoutMatch) flags.timeout = parseInt(timeoutMatch[1], 10);

  // 환경변수 기반 글로벌 플래그
  if (process.env.TFX_DASHBOARD === "1") flags.dashboard = true;
  if (process.env.TFX_VERBOSE === "1") flags.verbose = true;
  if (process.env.TFX_NO_AUTO_ATTACH === "1") flags.noAutoAttach = true;

  return { agent, prompt, mcp, flags };
}

function autoRoute(updatedCommand, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { command: updatedCommand },
      additionalContext: reason,
    },
  }));
  process.exit(0);
}

function deny(reason) {
  process.stderr.write(reason);
  process.exit(2);
}

async function main() {
  // psmux 미설치 → 전부 통과
  if (!isPsmuxInstalled()) process.exit(0);

  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const toolName = input.tool_name || "";
  const toolInput = input.tool_input || {};

  // ── Bash ──
  if (toolName === "Bash") {
    const cmd = toolInput.command || "";

    // headless 명령은 통과
    if (cmd.includes("tfx multi") || cmd.includes("triflux.mjs multi")) {
      process.exit(0);
    }

    // psmux send-keys / capture-pane은 통과 (pane 내 간접 실행)
    if (/psmux\s+(send-keys|capture-pane|list-panes|split-window|select-pane)/.test(cmd)) {
      process.exit(0);
    }

    // codex/gemini 직접 CLI 호출 → deny
    if (/\bcodex\s+exec\b/.test(cmd) || /\bgemini\s+(-p|--prompt)\b/.test(cmd)) {
      deny(
        "[headless-guard] codex/gemini 직접 호출 대신 headless를 사용하세요. " +
        'Bash("tfx multi --teammate-mode headless --assign \'codex:prompt:role\' ...")',
      );
    }

    // tfx-route.sh 실행만 감지: 명령이 bash로 시작할 때만 (커밋 메시지/echo 등 무시)
    if (/^\s*bash\s+.*tfx-route\.sh\s/.test(cmd)) {
      // --async, --job-status, --job-result, --job-wait는 tfx-route.sh 내부 플래그 → 통과
      if (/tfx-route\.sh\s+--(async|job-status|job-result|job-wait)\b/.test(cmd)) {
        process.exit(0);
      }

      const parsed = parseRouteCommand(cmd);
      if (parsed) {
        const safePrompt = parsed.prompt.replace(/'/g, "'\\''");
        const VALID_MCP = new Set(["implement", "analyze", "review", "docs"]);
        const f = parsed.flags || {};

        // v3: 플래그 빌더 — 하드코딩 제거, 원본 의도 보존
        const parts = ["tfx multi --teammate-mode headless"];
        if (process.env.TFX_AUTO_ATTACH === "1" || !process.env.TFX_NO_AUTO_ATTACH) parts.push("--auto-attach");
        if (f.dashboard) parts.push("--dashboard");
        if (f.verbose) parts.push("--verbose");
        parts.push(`--assign '${parsed.agent}:${safePrompt}:${parsed.agent}'`);
        if (parsed.mcp && VALID_MCP.has(parsed.mcp)) parts.push(`--mcp-profile ${parsed.mcp}`);
        parts.push(`--timeout ${f.timeout || 600}`);

        const builtCmd = parts.join(" ");
        autoRoute(
          builtCmd,
          `[headless-guard] auto-route: tfx-route.sh ${parsed.agent} → headless. mcp=${parsed.mcp} dashboard=${!!f.dashboard}`,
        );
      }
      deny(
        "[headless-guard] tfx-route.sh를 headless로 변환 실패. " +
        'Bash("tfx multi --teammate-mode headless --assign \'cli:prompt:role\' ...") 형식을 사용하세요.',
      );
    }
  }

  // ── Agent: CLI 워커 래핑 → deny ──
  if (toolName === "Agent") {
    const combined = `${(toolInput.prompt || "").toLowerCase()} ${(toolInput.description || "").toLowerCase()}`;

    const cliPatterns = [
      /codex\s+(exec|run|실행)/,
      /gemini\s+(-p|run|실행)/,
      /tfx-route/,
      /bash.*codex/,
      /bash.*gemini/,
    ];

    if (cliPatterns.some((p) => p.test(combined))) {
      deny(
        "[headless-guard] Codex/Gemini를 Agent()로 래핑하지 마세요. " +
        'Bash("tfx multi --teammate-mode headless --assign \'codex:prompt:role\' ...")',
      );
    }
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
