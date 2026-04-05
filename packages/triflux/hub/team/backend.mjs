// hub/team/backend.mjs — CLI 백엔드 추상화 레이어
// 각 CLI(codex/gemini/claude)의 명령 빌드 로직을 클래스로 캡슐화한다.
// v7.2.2
import { createRequire } from "node:module";

import { buildExecArgs } from "../codex-adapter.mjs";

const _require = createRequire(import.meta.url);

// ── 백엔드 클래스 ──────────────────────────────────────────────────────────

export class CodexBackend {
  name() { return "codex"; }
  command() { return "codex"; }

  /**
   * @param {string} prompt — 프롬프트 (프롬프트 파일 경로가 아닌 PowerShell 표현식)
   * @param {string} resultFile — 결과 저장 경로
   * @param {object} [opts]
   * @returns {string} PowerShell 명령 (cls 제외)
   */
  buildArgs(prompt, resultFile, opts = {}) {
    return buildExecArgs({ prompt, resultFile, ...opts });
  }

  env() { return {}; }
}

export class GeminiBackend {
  name() { return "gemini"; }
  command() { return "gemini"; }

  buildArgs(prompt, resultFile, opts = {}) {
    return `gemini --prompt ${prompt} --output-format text > '${resultFile}' 2>'${resultFile}.err'`;
  }

  env() { return {}; }
}

export class ClaudeBackend {
  name() { return "claude"; }
  command() { return "claude"; }

  buildArgs(prompt, resultFile, opts = {}) {
    return `claude --print ${prompt} --output-format text > '${resultFile}' 2>&1`;
  }

  env() { return {}; }
}

// ── 레지스트리 ─────────────────────────────────────────────────────────────

/** @type {Map<string, CodexBackend|GeminiBackend|ClaudeBackend>} */
const backends = new Map([
  ["codex",  new CodexBackend()],
  ["gemini", new GeminiBackend()],
  ["claude", new ClaudeBackend()],
]);

/**
 * 백엔드 이름으로 조회한다.
 * @param {string} name — "codex" | "gemini" | "claude"
 * @returns {CodexBackend|GeminiBackend|ClaudeBackend}
 * @throws {Error} 등록되지 않은 이름
 */
export function getBackend(name) {
  const b = backends.get(name);
  if (!b) throw new Error(`지원하지 않는 CLI: ${name}`);
  return b;
}

/**
 * 에이전트명 또는 CLI명을 Backend로 해석한다.
 * agent-map.json을 통해 에이전트명 → CLI명으로 변환 후 레지스트리에서 조회한다.
 * @param {string} agentOrCli — "executor", "codex", "designer" 등
 * @returns {CodexBackend|GeminiBackend|ClaudeBackend}
 */
export function getBackendForAgent(agentOrCli) {
  const agentMap = _require("./agent-map.json");
  const cliName = agentMap[agentOrCli] || agentOrCli;
  return getBackend(cliName);
}

/**
 * 등록된 모든 백엔드를 반환한다.
 * @returns {Array<CodexBackend|GeminiBackend|ClaudeBackend>}
 */
export function listBackends() {
  return Array.from(backends.values());
}
