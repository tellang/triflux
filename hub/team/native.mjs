// hub/team/native.mjs — Claude Native Teams 래퍼
// teammate 프롬프트 템플릿 + 팀 설정 빌더
//
// Claude Code 네이티브 Agent Teams (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1)
// 환경에서 teammate를 Codex/Gemini CLI 래퍼로 구성하는 유틸리티.
// SKILL.md가 인라인 프롬프트를 사용하므로, 이 모듈은 CLI(tfx multi --native)에서
// 팀 설정을 프로그래밍적으로 생성할 때 사용한다.

import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROUTE_SCRIPT = "~/.claude/scripts/tfx-route.sh";
export const SLIM_WRAPPER_SUBAGENT_TYPE = "slim-wrapper";
const ROUTE_LOG_RE = /\[tfx-route\]/i;
const ROUTE_COMMAND_RE = /(?:^|[\s"'`])(?:bash\s+)?(?:[^"'`\s]*\/)?tfx-route\.sh\b/i;
const ROUTE_PROMPT_RE = /tfx-route\.sh/i;
const DIRECT_TOOL_BYPASS_RE = /\b(?:Read|Edit|Write)\s*\(/;

function inferWorkerIndex(agentName = "") {
  const match = /(\d+)(?!.*\d)/.exec(agentName);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) && index > 0 ? index : null;
}

function buildRouteEnvPrefix(agentName, workerIndex, searchTool) {
  const effectiveWorkerIndex = Number.isInteger(workerIndex) && workerIndex > 0
    ? workerIndex
    : inferWorkerIndex(agentName);

  let envPrefix = "";
  if (effectiveWorkerIndex) envPrefix += ` TFX_WORKER_INDEX="${effectiveWorkerIndex}"`;
  if (searchTool) envPrefix += ` TFX_SEARCH_TOOL="${searchTool}"`;
  return envPrefix;
}

/**
 * slim-wrapper 커스텀 subagent 사양.
 * Claude Code custom subagent(`.claude/agents/slim-wrapper.md`)와 짝을 이룬다.
 *
 * @param {'codex'|'gemini'} cli
 * @param {object} opts
 * @returns {{name:string, cli:string, subagent_type:string, prompt:string}}
 */
export function buildSlimWrapperAgent(cli, opts = {}) {
  return {
    name: opts.agentName || `${cli}-wrapper`,
    cli,
    subagent_type: SLIM_WRAPPER_SUBAGENT_TYPE,
    prompt: buildSlimWrapperPrompt(cli, opts),
  };
}

/**
 * slim-wrapper 로그에서 tfx-route.sh 경유 흔적을 판정한다.
 * route stderr prefix(`[tfx-route]`) 또는 Bash command trace를 근거로 본다.
 *
 * @param {object} input
 * @param {string} [input.promptText]
 * @param {string} [input.stdoutText]
 * @param {string} [input.stderrText]
 * @returns {{
 *   expectedRouteInvocation: boolean,
 *   promptMentionsRoute: boolean,
 *   sawRouteCommand: boolean,
 *   sawRouteLog: boolean,
 *   sawDirectToolBypass: boolean,
 *   usedRoute: boolean,
 *   abnormal: boolean,
 *   reason: string|null,
 * }}
 */
export function verifySlimWrapperRouteExecution(input = {}) {
  const promptText = String(input.promptText || "");
  const stdoutText = String(input.stdoutText || "");
  const stderrText = String(input.stderrText || "");
  const combinedLogs = `${stdoutText}\n${stderrText}`;
  const promptMentionsRoute = ROUTE_PROMPT_RE.test(promptText);
  const sawRouteCommand = ROUTE_COMMAND_RE.test(combinedLogs);
  const sawRouteLog = ROUTE_LOG_RE.test(combinedLogs);
  const sawDirectToolBypass = DIRECT_TOOL_BYPASS_RE.test(stdoutText);
  const usedRoute = sawRouteCommand || sawRouteLog;
  const expectedRouteInvocation = promptMentionsRoute;
  const abnormal = expectedRouteInvocation && (sawDirectToolBypass || !usedRoute);
  const reason = !abnormal
    ? null
    : sawDirectToolBypass
      ? "direct_tool_bypass_detected"
      : "missing_tfx_route_evidence";

  return {
    expectedRouteInvocation,
    promptMentionsRoute,
    sawRouteCommand,
    sawRouteLog,
    sawDirectToolBypass,
    usedRoute,
    abnormal,
    reason,
  };
}

/**
 * role/mcp_profile별 tfx-route.sh 기본 timeout (초)
 * analyze/review 프로필이나 설계·분석 역할은 더 긴 timeout을 부여한다.
 * @param {string} role — 워커 역할
 * @param {string} mcpProfile — MCP 프로필
 * @returns {number} timeout(초)
 */
function getRouteTimeout(role, mcpProfile) {
  if (mcpProfile === "analyze" || mcpProfile === "review") return 3600;
  if (role === "architect" || role === "analyst") return 3600;
  return 1080; // 기본 18분
}

/**
 * v2.2 슬림 래퍼 프롬프트 생성
 * Agent spawn으로 네비게이션에 등록하되, 실제 작업은 tfx-route.sh가 수행.
 * 프롬프트 ~100 토큰 목표 (v2의 ~500 대비 80% 감소).
 *
 * @param {'codex'|'gemini'} cli — CLI 타입
 * @param {object} opts
 * @param {string} opts.subtask — 서브태스크 설명
 * @param {string} [opts.role] — 역할 (executor, designer, reviewer 등)
 * @param {string} [opts.teamName] — 팀 이름
 * @param {string} [opts.taskId] — Hub task ID
 * @param {string} [opts.agentName] — 워커 표시 이름
 * @param {string} [opts.leadName] — 리드 수신자 이름
 * @param {string} [opts.mcp_profile] — MCP 프로필
 * @param {number} [opts.workerIndex] — 검색 힌트 회전에 사용할 워커 인덱스(1-based)
 * @param {string} [opts.searchTool] — 전용 검색 도구 힌트(brave-search|tavily|exa)
 * @param {number} [opts.bashTimeout] — Bash timeout(ms). 미지정 시 role/profile 기반 자동 산출.
 * @returns {string} 슬림 래퍼 프롬프트
 */
export function buildSlimWrapperPrompt(cli, opts = {}) {
  const {
    subtask,
    role = "executor",
    teamName = "tfx-multi",
    taskId = "",
    agentName = "",
    leadName = "team-lead",
    mcp_profile = "auto",
    workerIndex,
    searchTool = "",
    pipelinePhase = "",
    bashTimeout,
  } = opts;

  // role/profile 기반 timeout 산출 (기본 timeout + 60초 여유, ms 변환)
  const bashTimeoutMs = bashTimeout ?? (getRouteTimeout(role, mcp_profile) + 60) * 1000;

  // 셸 이스케이프
  const escaped = subtask.replace(/'/g, "'\\''");
  const pipelineHint = pipelinePhase
    ? `\n파이프라인 단계: ${pipelinePhase}`
    : '';
  const routeEnvPrefix = buildRouteEnvPrefix(agentName, workerIndex, searchTool);

  return `실행 프로토콜 (subagent_type="${SLIM_WRAPPER_SUBAGENT_TYPE}"):
1. Bash(command, timeout: ${bashTimeoutMs}) — 아래 명령 1회만 실행
2. Bash 종료 후 TaskUpdate + SendMessage로 Claude Code 태스크 동기화
3. 종료${pipelineHint}

[HARD CONSTRAINT] 허용 도구: Bash, TaskUpdate, TaskGet, TaskList, SendMessage만 사용한다.
Read, Edit, Write, Grep, Glob, Agent, WebSearch, WebFetch 등 다른 모든 도구 사용을 금지한다.
코드를 직접 읽거나 수정하면 안 된다. 반드시 아래 Bash 명령(tfx-route.sh)을 통해 Codex/Gemini에 위임하라.
이 규칙을 위반하면 작업 실패로 간주한다.

gemini/codex를 직접 호출하지 마라. 반드시 tfx-route.sh를 거쳐야 한다.
프롬프트를 파일로 저장하지 마라. tfx-route.sh가 인자로 받는다.

Step 1 — Bash 실행:
Bash(command: 'TFX_TEAM_NAME="${teamName}" TFX_TEAM_TASK_ID="${taskId}" TFX_TEAM_AGENT_NAME="${agentName}" TFX_TEAM_LEAD_NAME="${leadName}"${routeEnvPrefix} bash ${ROUTE_SCRIPT} "${role}" '"'"'${escaped}'"'"' ${mcp_profile}', timeout: ${bashTimeoutMs})

Step 2 — Claude Code 태스크 동기화 (Bash 완료 후 반드시 실행):
exit_code=0이면:
  TaskUpdate(taskId: "${taskId}", status: "completed", metadata: {result: "success"})
  SendMessage(type: "message", recipient: "${leadName}", content: "완료: ${agentName}", summary: "task ${taskId} success")
exit_code≠0이면:
  TaskUpdate(taskId: "${taskId}", status: "completed", metadata: {result: "failed", error: "exit_code=N"})
  SendMessage(type: "message", recipient: "${leadName}", content: "실패: ${agentName} (exit=N)", summary: "task ${taskId} failed")
TFX_NEEDS_FALLBACK 출력 감지 시:
  TaskUpdate(taskId: "${taskId}", status: "completed", metadata: {result: "fallback", reason: "claude-native"})
  SendMessage(type: "message", recipient: "${leadName}", content: "fallback 필요: ${agentName} — claude-native 역할은 Claude Agent로 위임 필요", summary: "task ${taskId} fallback")

Step 3 — TaskUpdate + SendMessage 후 즉시 종료. 추가 도구 호출 금지.`;
}

/**
 * v3 하이브리드 래퍼 프롬프트 생성
 * psmux pane 기반 비동기 실행 + polling 패턴.
 * Agent가 idle 상태를 유지하여 인터럽트 수신이 가능하다.
 *
 * @param {'codex'|'gemini'} cli — CLI 타입
 * @param {object} opts
 * @param {string} opts.subtask — 서브태스크 설명
 * @param {string} [opts.role] — 역할
 * @param {string} [opts.teamName] — 팀 이름
 * @param {string} [opts.taskId] — Hub task ID
 * @param {string} [opts.agentName] — 워커 표시 이름
 * @param {string} [opts.leadName] — 리드 수신자 이름
 * @param {string} [opts.mcp_profile] — MCP 프로필
 * @param {number} [opts.workerIndex] — 검색 힌트 회전에 사용할 워커 인덱스(1-based)
 * @param {string} [opts.searchTool] — 전용 검색 도구 힌트(brave-search|tavily|exa)
 * @param {string} [opts.sessionName] — psmux 세션 이름
 * @param {string} [opts.pipelinePhase] — 파이프라인 단계
 * @param {string} [opts.psmuxPath] — psmux.mjs 경로
 * @returns {string} 하이브리드 래퍼 프롬프트
 */
export function buildHybridWrapperPrompt(cli, opts = {}) {
  const {
    subtask,
    role = "executor",
    teamName = "tfx-multi",
    taskId = "",
    agentName = "",
    leadName = "team-lead",
    mcp_profile = "auto",
    workerIndex,
    searchTool = "",
    sessionName = teamName,
    pipelinePhase = "",
    psmuxPath = "hub/team/psmux.mjs",
  } = opts;

  const escaped = subtask.replace(/'/g, "'\\''");
  const pipelineHint = pipelinePhase ? `\n파이프라인 단계: ${pipelinePhase}` : "";
  const taskIdRef = taskId ? `taskId: "${taskId}"` : "";
  const taskIdArg = taskIdRef ? `${taskIdRef}, ` : "";
  const routeEnvPrefix = buildRouteEnvPrefix(agentName, workerIndex, searchTool);

  const routeCmd = `TFX_TEAM_NAME="${teamName}" TFX_TEAM_TASK_ID="${taskId}" TFX_TEAM_AGENT_NAME="${agentName}" TFX_TEAM_LEAD_NAME="${leadName}"${routeEnvPrefix} bash ${ROUTE_SCRIPT} "${role}" '${escaped}' ${mcp_profile}`;

  return `하이브리드 psmux 워커 프로토콜:

1. TaskUpdate(${taskIdArg}status: in_progress) + SendMessage(to: ${leadName}, "작업 시작: ${agentName}")

2. pane 생성 (비동기 실행):
   Bash: node ${psmuxPath} spawn --session "${sessionName}" --name "${agentName}" --cmd "${routeCmd}"

3. 폴링 루프 (10초 간격, idle 유지 → 인터럽트 수신 가능):
   Bash: node ${psmuxPath} status --session "${sessionName}" --name "${agentName}"
   - status: "running" → 10초 대기 후 재확인
   - status: "exited" → 5단계로

4. 인터럽트 수신 시:
   Bash: node ${psmuxPath} kill --session "${sessionName}" --name "${agentName}"
   → SendMessage(to: ${leadName}, "인터럽트 수신, 방향 전환")
   → 새 지시에 따라 2단계부터 재실행

5. 완료 시:
   Bash: node ${psmuxPath} output --session "${sessionName}" --name "${agentName}" --lines 100
   → 결과를 TaskUpdate + SendMessage로 보고
${pipelineHint}
[HARD CONSTRAINT] 너는 Bash, TaskUpdate, TaskGet, TaskList, SendMessage만 사용할 수 있다.
Read, Edit, Write, Grep, Glob, Agent, WebSearch, WebFetch 등 다른 모든 도구 사용을 금지한다.
코드를 직접 읽거나 수정하면 안 된다. 반드시 아래 Bash 명령(tfx-route.sh)을 통해 Codex/Gemini에 위임하라.
이 규칙을 위반하면 작업 실패로 간주한다.

gemini/codex를 직접 호출하지 마라. psmux spawn이 tfx-route.sh를 통해 실행한다.
프롬프트를 파일로 저장하지 마라. psmux spawn --cmd 인자로 전달된다.

성공 → TaskUpdate(${taskIdArg}status: completed, metadata: {result: "success"}) + SendMessage(to: ${leadName}).
실패 → TaskUpdate(${taskIdArg}status: completed, metadata: {result: "failed", error: "에러 요약"}) + SendMessage(to: ${leadName}).

중요: TaskUpdate의 status는 "completed"만 사용. "failed"는 API 미지원.
실패 여부는 metadata.result로 구분. pane 실패 시에도 반드시 TaskUpdate + SendMessage 후 종료.`;
}

/**
 * tfx-route.sh가 남긴 로컬 결과 파일을 폴링해서 완료/대기 태스크를 분리한다.
 * SendMessage 전달 지연이 있더라도 Phase 4에서 파일 기반으로 완료를 빠르게 감지하기 위한 보조 경로다.
 *
 * @param {string} teamName
 * @param {string[]} expectedTaskIds
 * @returns {Promise<{completed:Array<{taskId:string,result:string,summary:string}>, pending:string[]}>}
 */
export async function pollTeamResults(teamName, expectedTaskIds = []) {
  const normalizedTaskIds = Array.from(
    new Set(
      (Array.isArray(expectedTaskIds) ? expectedTaskIds : [])
        .map((taskId) => String(taskId || "").trim())
        .filter(Boolean),
    ),
  );

  if (!normalizedTaskIds.length) {
    return { completed: [], pending: [] };
  }

  const normalizedTeamName = String(teamName || "").trim();
  if (!normalizedTeamName) {
    return { completed: [], pending: normalizedTaskIds };
  }

  const resultDir = path.join(os.homedir(), ".claude", "tfx-results", normalizedTeamName);

  let entries;
  try {
    entries = await fs.readdir(resultDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { completed: [], pending: normalizedTaskIds };
    }
    throw error;
  }

  const availableFiles = new Set(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  );

  const completedCandidates = await Promise.all(
    normalizedTaskIds.map(async (taskId) => {
      const fileName = `${taskId}.json`;
      if (!availableFiles.has(fileName)) return null;

      try {
        const raw = await fs.readFile(path.join(resultDir, fileName), "utf8");
        const parsed = JSON.parse(raw);
        return {
          taskId,
          result: typeof parsed?.result === "string" ? parsed.result : "failed",
          summary: typeof parsed?.summary === "string" ? parsed.summary : "",
        };
      } catch (error) {
        if (error && error.code === "ENOENT") return null;
        return {
          taskId,
          result: "failed",
          summary: "결과 파일 파싱 실패",
        };
      }
    }),
  );

  const completed = completedCandidates.filter(Boolean);
  const completedTaskIds = new Set(completed.map((item) => item.taskId));
  const pending = normalizedTaskIds.filter((taskId) => !completedTaskIds.has(taskId));

  return { completed, pending };
}

/**
 * 폴링 결과를 진행률 한 줄 요약으로 바꾼다.
 *
 * @param {{completed?:Array<{taskId:string,result:string}>, pending?:string[]}} pollResult
 * @returns {string}
 */
export function formatPollReport(pollResult = {}) {
  const completed = Array.isArray(pollResult.completed) ? pollResult.completed : [];
  const pending = Array.isArray(pollResult.pending) ? pollResult.pending : [];
  const total = completed.length + pending.length;

  if (total === 0) return "0/0 완료";

  const detail = completed
    .map(({ taskId, result }) => `${taskId} ${result || "unknown"}`)
    .join(", ");

  return detail
    ? `${completed.length}/${total} 완료 (${detail})`
    : `${completed.length}/${total} 완료`;
}

/**
 * 팀 이름 생성 (타임스탬프 기반)
 * @returns {string}
 */
export function generateTeamName() {
  const ts = Date.now().toString(36).slice(-4);
  const rand = Math.random().toString(36).slice(2, 6);
  return `tfx-${ts}${rand}`;
}
