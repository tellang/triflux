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
 * 리드(보통 claude) 초기 프롬프트 생성
 * @param {string} taskDescription
 * @param {object} config
 * @param {string} config.agentId
 * @param {string} config.hubUrl
 * @param {string} config.teammateMode
 * @param {Array<{agentId:string, cli:string, subtask:string}>} config.workers
 * @returns {string}
 */
export function buildLeadPrompt(taskDescription, config) {
  const { agentId, hubUrl, teammateMode = "tmux", workers = [] } = config;

  const roster = workers
    .map((w, i) => `${i + 1}. ${w.agentId} (${w.cli}) — ${w.subtask}`)
    .join("\n") || "- (워커 없음)";

  const workerIds = workers.map((w) => w.agentId).join(", ");

  const bridgePath = "node hub/bridge.mjs";

  return `리드 에이전트: ${agentId}

목표: ${taskDescription}
모드: ${teammateMode}

워커:
${roster}

규칙:
- 가능한 짧고 핵심만 지시/요약(토큰 절약)
- 워커 제어:
  ${bridgePath} result --agent ${agentId} --topic lead.control
- 워커 결과 수집:
  ${bridgePath} context --agent ${agentId} --max 20
- 최종 결과는 topic="task.result"를 모아 통합

워커 ID: ${workerIds || "(없음)"}
지금 즉시 워커를 배정하고 병렬 진행을 관리하라.`;
}

/**
 * 워커 초기 프롬프트 생성
 * @param {string} subtask — 이 에이전트의 서브태스크
 * @param {object} config
 * @param {string} config.cli — codex/gemini/claude
 * @param {string} config.agentId — 에이전트 식별자
 * @param {string} config.hubUrl — Hub URL
 * @returns {string}
 */
export function buildPrompt(subtask, config) {
  const { cli, agentId, hubUrl } = config;

  const _hubBase = hubUrl.replace("/mcp", "");

  const bridgePath = "node hub/bridge.mjs";

  return `워커: ${agentId} (${cli})
작업: ${subtask}

필수 규칙:
1) 간결하게 작업(불필요한 장문 설명 금지)
2) 시작 즉시 등록:
   ${bridgePath} register --agent ${agentId} --cli ${cli} --topics lead.control,task.result
3) 주기적으로 수신함 확인:
   ${bridgePath} context --agent ${agentId} --max 10
4) lead.control 수신 시 즉시 반응 (interrupt/stop/pause/resume)
5) 완료 시 결과 발행:
   ${bridgePath} result --agent ${agentId} --topic task.result --file <출력파일>

지금 작업을 시작하라.`;
}

/**
 * 팀 오케스트레이션 실행 — 각 pane에 프롬프트 주입
 * @param {string} sessionName — tmux 세션 이름
 * @param {Array<{target: string, cli: string, subtask: string}>} assignments
 * @param {object} opts
 * @param {string} opts.hubUrl — Hub URL
 * @param {{target:string, cli:string, task:string}|null} opts.lead
 * @param {string} opts.teammateMode
 * @returns {Promise<void>}
 */
export async function orchestrate(sessionName, assignments, opts = {}) {
  const {
    hubUrl = "http://127.0.0.1:27888/mcp",
    lead = null,
    teammateMode = "tmux",
  } = opts;

  const workers = assignments.map(({ target, cli, subtask }) => ({
    target,
    cli,
    subtask,
    agentId: `${cli}-${target.split(".").pop()}`,
  }));

  if (lead?.target) {
    const leadAgentId = `${lead.cli || "claude"}-${lead.target.split(".").pop()}`;
    const leadPrompt = buildLeadPrompt(lead.task || "팀 작업 조율", {
      agentId: leadAgentId,
      hubUrl,
      teammateMode,
      workers: workers.map((w) => ({ agentId: w.agentId, cli: w.cli, subtask: w.subtask })),
    });
    injectPrompt(lead.target, leadPrompt, { useFileRef: true });
    await new Promise((r) => setTimeout(r, 100));
  }

  for (const worker of workers) {
    const prompt = buildPrompt(worker.subtask, {
      cli: worker.cli,
      agentId: worker.agentId,
      hubUrl,
      sessionName,
    });
    injectPrompt(worker.target, prompt, { useFileRef: true });
    await new Promise((r) => setTimeout(r, 100));
  }
}
