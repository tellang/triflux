// hub/team/native.mjs — Claude Native Teams 래퍼
// teammate 프롬프트 템플릿 + 팀 설정 빌더
//
// Claude Code 네이티브 Agent Teams (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1)
// 환경에서 teammate를 Codex/Gemini CLI 래퍼로 구성하는 유틸리티.
// SKILL.md가 인라인 프롬프트를 사용하므로, 이 모듈은 CLI(tfx multi --native)에서
// 팀 설정을 프로그래밍적으로 생성할 때 사용한다.

const ROUTE_SCRIPT = "~/.claude/scripts/tfx-route.sh";

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

  const taskIdRef = taskId ? `taskId: "${taskId}"` : "";

  return `인터럽트 프로토콜:
1. TaskUpdate(${taskIdRef ? `${taskIdRef}, ` : ""}status: in_progress) — task claim
2. SendMessage(to: ${leadName}, "작업 시작: ${agentName}") — 시작 보고 (턴 경계 생성)
3. Bash(command, timeout: ${bashTimeoutMs}) — 아래 명령 1회 실행
4. 결과 보고 후 반드시 종료${pipelineHint}

gemini/codex를 직접 호출하지 마라. 반드시 tfx-route.sh를 거쳐야 한다.
프롬프트를 파일로 저장하지 마라. tfx-route.sh가 인자로 받는다.

Bash(command: 'TFX_TEAM_NAME="${teamName}" TFX_TEAM_TASK_ID="${taskId}" TFX_TEAM_AGENT_NAME="${agentName}" TFX_TEAM_LEAD_NAME="${leadName}" bash ${ROUTE_SCRIPT} "${role}" '"'"'${escaped}'"'"' ${mcp_profile}', timeout: ${bashTimeoutMs})

성공 → TaskUpdate(${taskIdRef ? `${taskIdRef}, ` : ""}status: completed, metadata: {result: "success"}) + SendMessage(to: ${leadName}).
실패 → TaskUpdate(${taskIdRef ? `${taskIdRef}, ` : ""}status: completed, metadata: {result: "failed", error: "에러 요약"}) + SendMessage(to: ${leadName}).

중요: TaskUpdate의 status는 "completed"만 사용. "failed"는 API 미지원.
실패 여부는 metadata.result로 구분. Bash 실패 시에도 반드시 TaskUpdate + SendMessage 후 종료.`;
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
    sessionName = teamName,
    pipelinePhase = "",
    psmuxPath = "hub/team/psmux.mjs",
  } = opts;

  const escaped = subtask.replace(/'/g, "'\\''");
  const pipelineHint = pipelinePhase ? `\n파이프라인 단계: ${pipelinePhase}` : "";
  const taskIdRef = taskId ? `taskId: "${taskId}"` : "";
  const taskIdArg = taskIdRef ? `${taskIdRef}, ` : "";

  const routeCmd = `TFX_TEAM_NAME="${teamName}" TFX_TEAM_TASK_ID="${taskId}" TFX_TEAM_AGENT_NAME="${agentName}" TFX_TEAM_LEAD_NAME="${leadName}" bash ${ROUTE_SCRIPT} "${role}" '${escaped}' ${mcp_profile}`;

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
gemini/codex를 직접 호출하지 마라. psmux spawn이 tfx-route.sh를 통해 실행한다.
프롬프트를 파일로 저장하지 마라. psmux spawn --cmd 인자로 전달된다.

성공 → TaskUpdate(${taskIdArg}status: completed, metadata: {result: "success"}) + SendMessage(to: ${leadName}).
실패 → TaskUpdate(${taskIdArg}status: completed, metadata: {result: "failed", error: "에러 요약"}) + SendMessage(to: ${leadName}).

중요: TaskUpdate의 status는 "completed"만 사용. "failed"는 API 미지원.
실패 여부는 metadata.result로 구분. pane 실패 시에도 반드시 TaskUpdate + SendMessage 후 종료.`;
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
