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
 * v3: A(gate) + B(nudge) — OMC 패턴 도입
 *     A: tfx-multi 활성 시 headless dispatch 전까지 Agent 작업 위임 차단
 *     B: dispatch 후 네이티브 드리프트 감지 시 nudge
 *     상태: $TMPDIR/tfx-multi-state.json (tfx-multi-activate.mjs가 생성)
 *
 * 동작:
 * - psmux 설치 + Bash(tfx-route.sh) → updatedInput: tfx multi --headless --assign
 * - psmux 설치 + Bash(codex exec / gemini --prompt) → deny
 * - psmux 설치 + Agent(codex/gemini CLI 래핑) → deny
 * - psmux 미설치 → 전부 통과
 * - tfx-multi 활성 + Agent(work) before dispatch → deny (A: gate)
 * - tfx-multi 활성 + Agent(work) after dispatch → nudge (B: nudge)
 *
 * 성능: psmux 감지 결과를 5분간 캐시 ($TMPDIR/tfx-psmux-check.json)
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CACHE_FILE = join(tmpdir(), "tfx-psmux-check.json");
const CACHE_TTL_MS = 5 * 60 * 1000; // 5분

// ── tfx-multi 상태 관리 (A+B) ──
const MULTI_STATE_FILE = join(tmpdir(), "tfx-multi-state.json");
const MULTI_EXPIRE_MS = 30 * 60 * 1000; // 30분 자동 만료
const GATE_THRESHOLD = 2;   // A: dispatch 전 허용할 Agent 호출 수
const NUDGE_THRESHOLD = 4;  // B: dispatch 후 nudge 트리거 횟수

function readMultiState() {
  try {
    if (!existsSync(MULTI_STATE_FILE)) return null;
    const state = JSON.parse(readFileSync(MULTI_STATE_FILE, "utf8"));
    if (!state.active) return null;
    // 자동 만료
    if (Date.now() - state.activatedAt > MULTI_EXPIRE_MS) {
      try { unlinkSync(MULTI_STATE_FILE); } catch { /* ignore */ }
      return null;
    }
    return state;
  } catch { return null; }
}

function writeMultiState(state) {
  try {
    writeFileSync(MULTI_STATE_FILE, JSON.stringify(state));
  } catch { /* ignore */ }
}

function nudge(message) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: message,
    },
  }));
  process.exit(0);
}

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

const HEADLESS_FALLBACK_COMMAND =
  'Bash("tfx multi --teammate-mode headless --assign \'codex:prompt:role\' ...")';
const DIRECT_CLI_BYPASS_HINT =
  "로컬 디버깅이 목적이면 TFX_ALLOW_DIRECT_CLI=1로 일시 우회할 수 있습니다.";

async function main() {
  // P0: TFX_ALLOW_DIRECT_CLI 환경변수 바이패스 — psmux 세션 생성 불가 시 수동 활성화
  if (process.env.TFX_ALLOW_DIRECT_CLI === "1") {
    nudge("[headless-guard] direct CLI mode (TFX_ALLOW_DIRECT_CLI=1)");
  }

  // psmux 미설치 → 전부 통과
  if (!isPsmuxInstalled()) process.exit(0);

  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

  if (!raw || !raw.trim()) {
    console.error('[headless-guard] stdin이 비어있습니다 — 기본 허용');
    process.exit(0);
  }

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

    // headless 명령은 통과 + dispatch 감지 (A: gate 해제)
    if (cmd.includes("tfx multi") || cmd.includes("triflux.mjs multi")) {
      const multiState = readMultiState();
      if (multiState && cmd.includes("--assign")) {
        multiState.dispatched = true;
        multiState.nativeWorkCallsSinceDispatch = 0;
        writeMultiState(multiState);
      }
      process.exit(0);
    }

    // psmux send-keys / capture-pane은 통과 (pane 내 간접 실행)
    if (/psmux\s+(send-keys|capture-pane|list-panes|split-window|select-pane)/.test(cmd)) {
      process.exit(0);
    }

    // codex/gemini 직접 CLI 호출 → deny
    if (/\bcodex\s+exec\b/.test(cmd) || /\bgemini\s+(-p|--prompt)\b/.test(cmd)) {
      deny(
        "[headless-guard] codex/gemini 직접 호출은 spawn-session에서 차단됩니다. " +
        `승인된 경로: ${HEADLESS_FALLBACK_COMMAND}. ` +
        DIRECT_CLI_BYPASS_HINT,
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
        // P1a: 단일 워커는 headless 변환 건너뛰기 (직접 실행이 523~1173ms 절약)
        // TFX_FORCE_HEADLESS=1이면 단일이어도 headless 변환 강제
        if (!process.env.TFX_FORCE_HEADLESS) {
          const isMultiWorker = /\s--(multi|parallel)\b/.test(cmd);
          if (!isMultiWorker) {
            process.exit(0);  // 원본 tfx-route.sh 명령 그대로 통과
          }
        }

        const safePrompt = parsed.prompt.replace(/'/g, "'\\''");
        const VALID_MCP = new Set(["implement", "analyze", "review", "docs"]);
        const f = parsed.flags || {};

        // v3: 플래그 빌더 — 하드코딩 제거, 원본 의도 보존
        const parts = ["tfx multi --teammate-mode headless"];
        if (!f.noAutoAttach) parts.push("--auto-attach");
        if (!f.noAutoAttach) parts.push("--dashboard");  // 워커 요약 스플릿이 기본
        if (f.verbose) parts.push("--verbose");
        parts.push(`--assign '${parsed.agent}:${safePrompt}:${parsed.agent}'`);
        if (parsed.mcp && VALID_MCP.has(parsed.mcp)) parts.push(`--mcp-profile ${parsed.mcp}`);
        parts.push(`--timeout ${f.timeout || 600}`);

        const builtCmd = parts.join(" ");
        autoRoute(
          builtCmd,
          `[headless-guard] auto-route: tfx-route.sh ${parsed.agent} → headless. mcp=${parsed.mcp} dashboard=${!f.noAutoAttach}`,
        );
      }
      deny(
        "[headless-guard] tfx-route.sh를 headless로 변환 실패. " +
        'Bash("tfx multi --teammate-mode headless --assign \'cli:prompt:role\' ...") 형식을 사용하세요.',
      );
    }
  }

  // ── Agent: A(gate) + B(nudge) + CLI 래핑 deny ──
  if (toolName === "Agent") {
    const subType = (toolInput.subagent_type || "").toLowerCase();
    const NATIVE_TYPES = new Set(["explore", "plan", "general-purpose", ""]);
    const isNative = NATIVE_TYPES.has(subType) || subType.startsWith("oh-my-claudecode:");

    // ── A+B: tfx-multi 상태 기반 처리 ──
    const multiState = readMultiState();
    if (multiState && multiState.active && isNative) {
      if (!multiState.dispatched) {
        // ── A: gate — dispatch 전, Agent 작업 위임 제한 ──
        multiState.nativeWorkCalls = (multiState.nativeWorkCalls || 0) + 1;
        writeMultiState(multiState);

        if (multiState.nativeWorkCalls > GATE_THRESHOLD) {
          deny(
            `[headless-guard] tfx-multi gate: Agent(${subType || "default"}) 호출 ${multiState.nativeWorkCalls}회 — headless에 먼저 dispatch하세요.\n` +
            'Bash("tfx multi --teammate-mode headless --auto-attach --dashboard --assign \'codex:프롬프트:역할\' --timeout 600")',
          );
        }
        // 허용 범위 내 → 경고 + 통과
        nudge(
          `[headless-guard] tfx-multi 활성 (${multiState.nativeWorkCalls}/${GATE_THRESHOLD}). ` +
          "headless dispatch 후 작업을 시작하세요.",
        );
      } else {
        // ── B: nudge — dispatch 후, 네이티브 드리프트 감지 ──
        multiState.nativeWorkCallsSinceDispatch = (multiState.nativeWorkCallsSinceDispatch || 0) + 1;
        writeMultiState(multiState);

        if (multiState.nativeWorkCallsSinceDispatch >= NUDGE_THRESHOLD) {
          multiState.nativeWorkCallsSinceDispatch = 0;
          writeMultiState(multiState);
          nudge(
            "[headless-guard] nudge: headless 워커가 실행 중입니다. " +
            "결과를 기다리거나 추가 --assign으로 위임하세요.",
          );
        }
      }
      // native → 통과 (gate deny 안 걸린 경우)
      process.exit(0);
    }

    // native → 통과 (tfx-multi 비활성)
    if (isNative) process.exit(0);

    // ── CLI 래핑 체크 (기존) ──
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
        `승인된 경로: ${HEADLESS_FALLBACK_COMMAND}. ` +
        DIRECT_CLI_BYPASS_HINT,
      );
    }
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
