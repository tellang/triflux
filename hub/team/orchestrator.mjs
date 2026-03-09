// hub/team/orchestrator.mjs — 작업 분배 + 프롬프트 구성
// 의존성: pane.mjs만 사용
import { injectPrompt } from "./pane.mjs";

/**
 * 작업 분해 (LLM 없이 구분자 기반)
 * @param {string} taskDescription — 전체 작업 설명
 * @param {number} agentCount — 에이전트 수
 * @returns {string[]} 각 에이전트의 서브태스크
 */
export function decomposeTask(taskDescription, agentCount) {
  if (agentCount <= 0) return [];
  if (agentCount === 1) return [taskDescription];

  // '+', ',', '\n' 기준으로 분리
  const parts = taskDescription
    .split(/[+,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length === 0) return [taskDescription];

  // 에이전트보다 서브태스크가 적으면 마지막 에이전트에 전체 태스크 부여
  if (parts.length < agentCount) {
    const result = [...parts];
    while (result.length < agentCount) {
      result.push(taskDescription);
    }
    return result;
  }

  // 에이전트보다 서브태스크가 많으면 앞에서부터 N개, 나머지는 마지막에 합침
  if (parts.length > agentCount) {
    const result = parts.slice(0, agentCount - 1);
    result.push(parts.slice(agentCount - 1).join(" + "));
    return result;
  }

  return parts;
}

/**
 * 에이전트별 초기 프롬프트 생성
 * @param {string} subtask — 이 에이전트의 서브태스크
 * @param {object} config
 * @param {string} config.cli — codex/gemini/claude
 * @param {string} config.agentId — 에이전트 식별자
 * @param {string} config.hubUrl — Hub URL
 * @param {string} config.sessionName — tmux 세션 이름
 * @returns {string}
 */
export function buildPrompt(subtask, config) {
  const { cli, agentId, hubUrl } = config;

  // Hub MCP 도구 사용 안내 (CLI별 차이 없이 공통)
  const hubInstructions = `
[Hub 메시지 도구]
tfx-hub MCP 서버(${hubUrl})가 연결되어 있다면 아래 도구를 사용할 수 있다:
- register: 에이전트 등록 (agent_id: "${agentId}", cli: "${cli}")
- publish: 결과 발행 (topic: "task.result")
- poll_messages: 다른 에이전트 메시지 수신
- ask: 다른 에이전트에게 질문

MCP 도구가 없으면 REST API 사용:
  curl -s -X POST ${hubUrl.replace("/mcp", "")}/bridge/register -H 'Content-Type: application/json' -d '{"agent_id":"${agentId}","cli":"${cli}","timeout_sec":600}'
  curl -s -X POST ${hubUrl.replace("/mcp", "")}/bridge/result -H 'Content-Type: application/json' -d '{"agent_id":"${agentId}","topic":"task.result","payload":{"summary":"결과 요약"}}'
`.trim();

  return `너는 tfx-hub 팀의 에이전트 ${agentId}이다.

[작업]
${subtask}

[규칙]
- 작업 완료 후 반드시 결과를 Hub에 발행하라
- 에이전트 ID: ${agentId}
- 다른 에이전트 결과가 필요하면 poll_messages로 확인

${hubInstructions}

작업을 시작하라.`;
}

/**
 * 팀 오케스트레이션 실행 — 각 pane에 프롬프트 주입
 * @param {string} sessionName — tmux 세션 이름
 * @param {Array<{target: string, cli: string, subtask: string}>} assignments
 * @param {object} opts
 * @param {string} opts.hubUrl — Hub URL
 * @returns {Promise<void>}
 */
export async function orchestrate(sessionName, assignments, opts = {}) {
  const { hubUrl = "http://127.0.0.1:27888/mcp" } = opts;

  for (const { target, cli, subtask } of assignments) {
    const agentId = `${cli}-${target.split(".").pop()}`;
    const prompt = buildPrompt(subtask, { cli, agentId, hubUrl, sessionName });
    injectPrompt(target, prompt);
    // pane 간 100ms 간격 (안정성)
    await new Promise((r) => setTimeout(r, 100));
  }
}
