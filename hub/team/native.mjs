// hub/team/native.mjs — Claude Native Teams 래퍼
// teammate 프롬프트 템플릿 + 팀 설정 빌더
//
// Claude Code 네이티브 Agent Teams (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1)
// 환경에서 teammate를 Codex/Gemini CLI 래퍼로 구성하는 유틸리티.
// SKILL.md가 인라인 프롬프트를 사용하므로, 이 모듈은 CLI(tfx multi --native)에서
// 팀 설정을 프로그래밍적으로 생성할 때 사용한다.

const ROUTE_SCRIPT = "~/.claude/scripts/tfx-route.sh";

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
  } = opts;

  // 셸 이스케이프
  const escaped = subtask.replace(/'/g, "'\\''");
  const pipelineHint = pipelinePhase
    ? `\n파이프라인 단계: ${pipelinePhase}`
    : '';

  return `Bash 1회 실행 후 반드시 종료하라. 어떤 경우에도 hang하지 마라.${pipelineHint}
gemini/codex를 직접 호출하지 마라. 반드시 tfx-route.sh를 거쳐야 한다.
프롬프트를 파일로 저장하지 마라. tfx-route.sh가 인자로 받는다.

TFX_TEAM_NAME="${teamName}" TFX_TEAM_TASK_ID="${taskId}" TFX_TEAM_AGENT_NAME="${agentName}" TFX_TEAM_LEAD_NAME="${leadName}" bash ${ROUTE_SCRIPT} "${role}" '${escaped}' ${mcp_profile}

성공 → TaskUpdate(status: completed, metadata: {result: "success"}) + SendMessage(to: ${leadName}).
실패 → TaskUpdate(status: completed, metadata: {result: "failed", error: "에러 요약"}) + SendMessage(to: ${leadName}).

중요: TaskUpdate의 status는 "completed"만 사용. "failed"는 API 미지원.
실패 여부는 metadata.result로 구분. Bash 실패 시에도 반드시 TaskUpdate + SendMessage 후 종료.`;
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
