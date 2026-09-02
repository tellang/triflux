// hub/team/launcher-template.mjs — 결정론적 런처 생성
// 기존 codex-adapter와 Antigravity stdin 계약을 소비하여
// 동일 입력 → 동일 args 배열을 보장한다.
// F1 해결: codex adapter가 --dangerously-bypass-approvals-and-sandbox 자동 추가
// F4 해결: codex exec "prompt" 인라인 (파이프/리다이렉트 아님)
// F5 해결: 동일 입력 → 동일 args 배열 (런타임 분기 없음)

import {
  buildDisabledCliError,
  normalizeCliName,
  resolveCliPolicy,
} from "../../scripts/lib/machine-profile.mjs";
import { buildExecArgs as buildCodexArgs } from "../codex-adapter.mjs";

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function buildAntigravityArgs(opts = {}) {
  const prompt = typeof opts.prompt === "string" ? opts.prompt : "";
  const command = `printf %s ${shellSingleQuote(prompt)} | agy --print --dangerously-skip-permissions`;
  if (opts.resultFile) {
    return `${command} > ${shellSingleQuote(opts.resultFile)} 2>${shellSingleQuote(`${opts.resultFile}.err`)}`;
  }
  return command;
}

/** CLI별 adapter 레지스트리 */
const ADAPTERS = Object.freeze({
  codex: {
    bin: "codex",
    buildArgs: buildCodexArgs,
    env: (profile) => (profile ? { CODEX_PROFILE: profile } : {}),
  },
  gemini: {
    bin: "agy",
    buildArgs: buildAntigravityArgs,
    env: () => ({}),
  },
  antigravity: {
    bin: "agy",
    buildArgs: buildAntigravityArgs,
    env: () => ({}),
  },
  agy: {
    bin: "agy",
    buildArgs: buildAntigravityArgs,
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
 * @param {'codex'|'gemini'|'antigravity'|'agy'|'claude'} agent
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
 * @param {'codex'|'gemini'|'antigravity'|'agy'|'claude'} opts.agent — CLI 타입
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

  // TFX_DISABLE_* SSOT 집행. 이 런처는 tfx-route.sh 를 거치지 않고 codex/agy
  // 바이너리를 직접 실행하는 경로라서 같은 정책을 여기서 다시 확인한다. 정책
  // 판독 시임은 opts.cliPolicy(계산된 정책)와 opts.policyEnv(env 객체)뿐이다.
  // claude 처럼 정책 대상이 아닌 CLI 는 프로파일 파일을 읽지 않는다.
  if (normalizeCliName(agent)) {
    const cliPolicy =
      opts.cliPolicy ?? resolveCliPolicy(opts.policyEnv ?? process.env);
    const blockedCli = buildDisabledCliError(agent, cliPolicy);
    if (blockedCli) throw blockedCli;
  }

  const adapter = getAdapter(agent);

  const command = adapter.buildArgs({
    prompt,
    profile,
    model,
    resultFile,
    workdir,
    cwd: workdir,
    mcpServers,
    // launcher 는 동일 입력 → 동일 명령 (F5 결정론 보장). buildExecCommand 의
    // stdin redirect 모드는 timestamp/pid/counter 가 들어가 비결정적이라
    // launcher path 에서는 argv-inline 모드로 강제. headless 워커 spawn 은
    // backend.mjs → buildExecArgs (stdinPrompt 미명시) 로 default stdin on.
    stdinPrompt: false,
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
