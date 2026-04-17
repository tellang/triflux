// hub/team/launcher-template.mjs — 결정론적 런처 생성
// 기존 codex-adapter/gemini-adapter의 buildExecArgs를 소비하여
// 동일 입력 → 동일 args 배열을 보장한다.
// F1 해결: codex adapter가 --dangerously-bypass-approvals-and-sandbox 자동 추가
// F4 해결: codex exec "prompt" 인라인 (파이프/리다이렉트 아님)
// F5 해결: 동일 입력 → 동일 args 배열 (런타임 분기 없음)

import { buildExecArgs as buildCodexArgs } from "../codex-adapter.mjs";
import { buildExecArgs as buildGeminiArgs } from "../gemini-adapter.mjs";

/** CLI별 adapter 레지스트리 */
const ADAPTERS = Object.freeze({
  codex: {
    bin: "codex",
    buildArgs: buildCodexArgs,
    env: (profile) => (profile ? { CODEX_PROFILE: profile } : {}),
  },
  gemini: {
    bin: "gemini",
    buildArgs: buildGeminiArgs,
    env: () => ({}),
  },
  claude: {
    bin: "claude",
    buildArgs: (opts = {}) => {
      const parts = ["claude"];
      if (opts.model) parts.push("--model", opts.model);
      parts.push("-p", JSON.stringify(opts.prompt || ""));
      return parts.join(" ");
    },
    env: () => ({}),
  },
});

/**
 * CLI adapter 조회.
 * @param {'codex'|'gemini'|'claude'} agent
 * @returns {object} adapter — { bin, buildArgs, env }
 * @throws {Error} 알 수 없는 agent
 */
export function getAdapter(agent) {
  const adapter = ADAPTERS[agent];
  if (!adapter) {
    throw new Error(
      `Unknown agent: "${agent}". Supported: ${Object.keys(ADAPTERS).join(", ")}`,
    );
  }
  return adapter;
}

/**
 * 결정론적 런처 생성.
 * 동일 입력이면 항상 동일한 { bin, command, env } 반환.
 *
 * @param {object} opts
 * @param {'codex'|'gemini'|'claude'} opts.agent — CLI 타입
 * @param {string} [opts.profile] — CLI 프로파일
 * @param {string} opts.prompt — 실행할 프롬프트
 * @param {string} [opts.workdir] — 작업 디렉토리
 * @param {string} [opts.model] — 모델 오버라이드
 * @param {string} [opts.resultFile] — 결과 저장 경로
 * @returns {{ bin: string, command: string, env: object, agent: string }}
 */
export function buildLauncher(opts) {
  const { agent, profile, prompt, workdir, model, resultFile, mcpServers } =
    opts;

  if (!agent) throw new Error("agent is required");
  if (!prompt && prompt !== "") throw new Error("prompt is required");

  const adapter = getAdapter(agent);

  const command = adapter.buildArgs({
    prompt,
    profile,
    model,
    resultFile,
    workdir,
    cwd: workdir,
    mcpServers,
  });

  const env = adapter.env(profile);

  return Object.freeze({
    bin: adapter.bin,
    command,
    env,
    agent,
    cwd: workdir || null,
  });
}

/**
 * 지원되는 agent 목록.
 * @returns {string[]}
 */
export function listAgents() {
  return Object.keys(ADAPTERS);
}
