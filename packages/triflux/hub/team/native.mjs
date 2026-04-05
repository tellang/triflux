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
/** scout 역할 기본 설정 — read-only 탐색 전용 */
export const SCOUT_ROLE_CONFIG = {
  cli: "codex",
  role: "scientist",
  mcp_profile: "analyze",
  maxIterations: 2,
  readOnly: true,
};
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
 *   slopDetected: boolean,
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
  const slopDetected = detectSlop(stdoutText);

  return {
    expectedRouteInvocation,
    promptMentionsRoute,
    sawRouteCommand,
    sawRouteLog,
    sawDirectToolBypass,
    usedRoute,
    abnormal,
    reason,
    slopDetected,
  };
}

/**
 * role/mcp_profile별 tfx-route.sh 기본 timeout (초)
 * analyze/review 프로필이나 설계·분석 역할은 더 긴 timeout을 부여한다.
 * @param {string} role — 워커 역할
 * @param {string} mcpProfile — MCP 프로필
 * @returns {number} timeout(초)
 */
function getRouteTimeout(role, _mcpProfile) {
  // tfx-route.sh route_agent()의 DEFAULT_TIMEOUT 기반, 최소 1080초(18분) 보장.
  // Bash timeout = 이 값 + 60초 여유. 짧은 역할도 네트워크/스케줄 지연 대비.
  const TIMEOUTS = {
    'build-fixer': 1080, debugger: 1080, executor: 1080,
    'deep-executor': 3600, architect: 3600, planner: 3600,
    critic: 3600, analyst: 3600, scientist: 1800,
    'scientist-deep': 3600, 'document-specialist': 1800,
    'code-reviewer': 1800, 'security-reviewer': 1800,
    'quality-reviewer': 1800, verifier: 1800,
    designer: 1080, writer: 1080,
    explore: 1080, 'test-engineer': 1080, 'qa-tester': 1080,
    spark: 600,
  };
  return TIMEOUTS[role] || 1080;
}

/**
 * v3 슬림 래퍼 프롬프트 생성 (async 모드)
 * --async로 즉시 시작 → --job-wait로 내부 폴링 → --job-result로 결과 수집.
 * Claude Code Bash 도구 600초 제한을 우회하여 scientist(24분), scientist-deep(60분) 등
 * 장시간 워커를 안정적으로 실행한다.
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
 * @param {number} [opts.bashTimeout] — (deprecated, async에서는 무시됨)
 * @param {number} [opts.maxIterations=3] — 피드백 루프 최대 반복 횟수
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
    maxIterations = 3,
  } = opts;

  const routeTimeoutSec = getRouteTimeout(role, mcp_profile);
  const escaped = subtask.replace(/'/g, "'\\''");
  const pipelineHint = pipelinePhase
    ? `\n파이프라인 단계: ${pipelinePhase}`
    : '';
  const routeEnvPrefix = buildRouteEnvPrefix(agentName, workerIndex, searchTool);
  const scoutConstraint = (role === "scout" || role === "scientist")
    ? "\n이 워커는 scout(탐색 전용)이다. 코드를 수정하거나 파일을 생성하지 마라. 기존 코드를 읽고 분석하여 보고만 하라."
    : "";

  // Bash 도구 timeout (모두 600초 이내)
  const launchTimeoutMs = 15000;   // Step 1: fork + job_id 반환
  const waitTimeoutMs = 570000;    // Step 2: 내부 폴링 (540초 대기 + 여유)
  const resultTimeoutMs = 30000;   // Step 3: 결과 읽기

  return `실행 프로토콜 (subagent_type="${SLIM_WRAPPER_SUBAGENT_TYPE}", async + feedback):
MAX_ITERATIONS = ${maxIterations}
ITERATION = 0${pipelineHint}

Step 0 — 시작 보고 (턴 경계 생성):
TaskUpdate(taskId: "${taskId}", status: "in_progress")
SendMessage(type: "message", recipient: "${leadName}", content: "작업 시작: ${agentName}", summary: "task ${taskId} started")

[HARD CONSTRAINT] 허용 도구: Bash, TaskUpdate, TaskGet, TaskList, SendMessage만 사용한다.
Read, Edit, Write, Grep, Glob, Agent, WebSearch, WebFetch 등 다른 모든 도구 사용을 금지한다.
코드를 직접 읽거나 수정하면 안 된다. 반드시 아래 Bash 명령(tfx-route.sh)을 통해 Codex/Gemini에 위임하라.
이 규칙을 위반하면 작업 실패로 간주한다.${scoutConstraint}

gemini/codex를 직접 호출하지 마라. 반드시 tfx-route.sh를 거쳐야 한다.
프롬프트를 파일로 저장하지 마라. tfx-route.sh가 인자로 받는다.

Step 1 — Async 시작 (즉시 리턴, <1초):
Bash(command: 'TFX_TEAM_NAME="${teamName}" TFX_TEAM_TASK_ID="${taskId}" TFX_TEAM_AGENT_NAME="${agentName}" TFX_TEAM_LEAD_NAME="${leadName}"${routeEnvPrefix} bash ${ROUTE_SCRIPT} --async "${role}" '"'"'${escaped}'"'"' ${mcp_profile} ${routeTimeoutSec}', timeout: ${launchTimeoutMs})
→ 출력 한 줄이 JOB_ID이다. 반드시 기억하라.

Step 2 — 완료 대기 (내부 폴링, 최대 540초):
Bash(command: 'bash ${ROUTE_SCRIPT} --job-wait JOB_ID 540', timeout: ${waitTimeoutMs})
→ 주기적 "waiting elapsed=Ns progress=NB" 출력 후 최종 상태:
  "done" → Step 3으로
  "timeout" 또는 "failed ..." → Step 4로 (실패 상태로)
  "still_running ..." → Step 2 반복 (같은 명령 재실행)

Step 3 — 결과 수집:
Bash(command: 'bash ${ROUTE_SCRIPT} --job-result JOB_ID', timeout: ${resultTimeoutMs})
→ RESULT에 저장.

Step 4 — 결과 보고 (턴 경계 생성, TaskUpdate 하지 않음):
"done"이면:
  SendMessage(type: "message", recipient: "${leadName}", content: "결과 (iteration ITERATION): ${agentName} 성공\\n{결과 요약}", summary: "task ${taskId} iteration ITERATION done")
"timeout" 또는 "failed"이면:
  SendMessage(type: "message", recipient: "${leadName}", content: "결과 (iteration ITERATION): ${agentName} 실패\\n{에러 요약}", summary: "task ${taskId} iteration ITERATION failed")
TFX_NEEDS_FALLBACK 출력 감지 시:
  → Step 6으로 즉시 이동 (fallback은 재실행 불가)

Step 5 — 피드백 대기:
SendMessage 후 너는 IDLE 상태가 된다. 리드의 응답을 기다려라.
수신 메시지에 따라:
  - "재실행:" 포함 → ITERATION++ → ITERATION < MAX_ITERATIONS이면 메시지의 지시를 반영하여 Step 1로. ITERATION >= MAX_ITERATIONS이면 Step 6으로 (반복 한도 초과)
  - "승인" 또는 기타 → Step 6으로
  - 메시지 없이 팀이 삭제되면 자동 종료 (처리 불필요)

Step 6 — 최종 종료 (반드시 실행):
TaskUpdate(taskId: "${taskId}", status: "completed", metadata: {result: "success"|"failed"|"fallback", iterations: ITERATION})
SendMessage(type: "message", recipient: "${leadName}", content: "최종 완료: ${agentName} (ITERATION회 실행)", summary: "task ${taskId} final")
→ 종료. 이후 추가 도구 호출 금지.`;
}

/**
 * scout 파견용 프롬프트 생성
 * @param {object} opts
 * @param {string} opts.question — 탐색 질문
 * @param {string} [opts.scope] — 탐색 범위 힌트 (파일 패턴)
 * @param {string} [opts.teamName] — 팀 이름
 * @param {string} [opts.taskId] — 태스크 ID
 * @param {string} [opts.agentName] — 에이전트 이름
 * @param {string} [opts.leadName] — 리드 이름
 * @returns {string} slim wrapper 프롬프트
 */
export function buildScoutDispatchPrompt(opts = {}) {
  const { question, scope = "", teamName, taskId, agentName, leadName } = opts;
  const subtask = scope
    ? `${question} 탐색 범위: ${scope}`
    : question;
  return buildSlimWrapperPrompt("codex", {
    subtask,
    role: "scientist",
    teamName,
    taskId,
    agentName,
    leadName,
    mcp_profile: "analyze",
    maxIterations: SCOUT_ROLE_CONFIG.maxIterations,
  });
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

// ── Anti-slop 필터링 ────────────────────────────────────────────

/**
 * 문자열을 정규화: 소문자 변환 + 연속 공백을 단일 공백으로 + trim
 * @param {string} s
 * @returns {string}
 */
function normalizeText(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * 두 문자열의 단어 집합 Jaccard 유사도를 계산한다.
 * @param {string} a — 정규화된 문자열
 * @param {string} b — 정규화된 문자열
 * @returns {number} 0.0–1.0
 */
function jaccardSimilarity(a, b) {
  const setA = new Set(a.split(" ").filter(Boolean));
  const setB = new Set(b.split(" ").filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * findings 배열에서 중복을 제거한다.
 * 정규화 후 description의 Jaccard 유사도 >= 0.8이면 중복으로 판정.
 * 동일 file+line인 경우도 중복 후보로 취급.
 *
 * @param {Array<{description:string, file?:string, line?:number, severity?:string}>} findings
 * @returns {Array<{description:string, file?:string, line?:number, severity?:string, occurrences:number}>}
 */
export function deduplicateFindings(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return [];

  const groups = []; // [{canonical, items:[]}]

  for (const f of findings) {
    const norm = normalizeText(f.description);
    let merged = false;
    for (const g of groups) {
      if (jaccardSimilarity(norm, g.norm) >= 0.8) {
        g.items.push(f);
        merged = true;
        break;
      }
    }
    if (!merged) {
      groups.push({ norm, canonical: f, items: [f] });
    }
  }

  return groups.map((g) => ({
    description: g.canonical.description,
    ...(g.canonical.file != null ? { file: g.canonical.file } : {}),
    ...(g.canonical.line != null ? { line: g.canonical.line } : {}),
    ...(g.canonical.severity != null ? { severity: g.canonical.severity } : {}),
    occurrences: g.items.length,
  }));
}

/**
 * scout 보고서 원문을 핵심 발견 사항만 추출하여 압축한다.
 * 파일:라인 + 한줄 요약 형태로 변환하며 최대 ~500토큰(2000자) 이하로 제한.
 *
 * @param {string} rawReport — 자유형 텍스트
 * @returns {{findings: Array<{file:string, line:string, summary:string}>, summary:string, tokenEstimate:number}}
 */
export function compressScoutReport(rawReport) {
  const MAX_CHARS = 2000;
  const text = String(rawReport || "");

  // 파일:라인 패턴 추출 (path/to/file.ext:123 형태 + 뒤따르는 설명)
  const fileLineRe = /([a-zA-Z0-9_./-]+\.[a-zA-Z]{1,10}):(\d+)\s*[:\-–—]?\s*(.+)/g;
  const findings = [];
  let match;
  while ((match = fileLineRe.exec(text)) !== null) {
    findings.push({
      file: match[1],
      line: match[2],
      summary: match[3].trim().slice(0, 120),
    });
  }

  // 문장 단위로 핵심 요약 구성
  const sentences = text
    .split(/[.\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);
  let summary = sentences.slice(0, 5).join(". ");

  // 토큰 추정: ~4자 = 1토큰
  const estimateTokens = (s) => Math.ceil(s.length / 4);

  // findings를 먼저 계산하고, 남은 공간에 맞춰 summary를 자른다
  const findingsJson = JSON.stringify(findings);
  const findingsBudget = Math.min(findingsJson.length, Math.floor(MAX_CHARS * 0.3));

  let trimmedFindings = findings;
  if (findingsJson.length > findingsBudget && findings.length > 0) {
    trimmedFindings = [];
    let used = 2; // []
    for (const f of findings) {
      const entryLen = JSON.stringify(f).length + 1;
      if (used + entryLen > findingsBudget) break;
      trimmedFindings.push(f);
      used += entryLen;
    }
  }

  const summaryBudget = MAX_CHARS - JSON.stringify(trimmedFindings).length;
  if (summary.length > summaryBudget) {
    summary = summary.slice(0, Math.max(0, summaryBudget - 3)) + "...";
  }

  return {
    findings: trimmedFindings,
    summary,
    tokenEstimate: estimateTokens(summary + JSON.stringify(trimmedFindings)),
  };
}

/**
 * 여러 scout 보고서의 발견 사항을 종합하여 가중 신뢰도를 계산한다.
 * 동일 발견이 여러 scout에서 보고되면 신뢰도가 높다.
 *
 * @param {Array<{agentName:string, findings:Array<{description:string}>}>} scoutReports
 * @returns {Array<{description:string, confidence:number, reporters:string[]}>}
 */
export function weightedConsensus(scoutReports) {
  if (!Array.isArray(scoutReports) || scoutReports.length === 0) return [];

  const totalScouts = scoutReports.length;
  // {normDesc -> {description, reporters: Set}}
  const consensusMap = new Map();

  for (const report of scoutReports) {
    const agent = String(report.agentName || "unknown");
    const findings = Array.isArray(report.findings) ? report.findings : [];
    for (const f of findings) {
      const norm = normalizeText(f.description);
      let matched = false;
      for (const [key, entry] of consensusMap) {
        if (jaccardSimilarity(norm, key) >= 0.8) {
          entry.reporters.add(agent);
          matched = true;
          break;
        }
      }
      if (!matched) {
        consensusMap.set(norm, {
          description: f.description,
          reporters: new Set([agent]),
        });
      }
    }
  }

  return Array.from(consensusMap.values()).map((entry) => ({
    description: entry.description,
    confidence: Math.round((entry.reporters.size / totalScouts) * 100) / 100,
    reporters: Array.from(entry.reporters),
  }));
}

// ── Slop detection helper ───────────────────────────────────────

const SLOP_REPEAT_THRESHOLD = 3;

/**
 * 텍스트에서 동일 패턴이 SLOP_REPEAT_THRESHOLD회 이상 반복되는지 판정한다.
 * 줄 단위로 정규화하여 비교.
 * @param {string} text
 * @returns {boolean}
 */
function detectSlop(text) {
  const lines = String(text || "")
    .split("\n")
    .map(normalizeText)
    .filter((l) => l.length > 15); // 너무 짧은 줄은 무시
  const counts = new Map();
  for (const line of lines) {
    counts.set(line, (counts.get(line) || 0) + 1);
    if (counts.get(line) >= SLOP_REPEAT_THRESHOLD) return true;
  }
  return false;
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
