// hub/team/native.mjs — Claude Native Teams 래퍼
// teammate 프롬프트 템플릿 + 팀 설정 빌더
//
// Claude Code 네이티브 Agent Teams (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1)
// 환경에서 teammate를 Codex/Gemini CLI 래퍼로 구성하는 유틸리티.
// SKILL.md가 인라인 프롬프트를 사용하므로, 이 모듈은 CLI(tfx team --native)에서
// 팀 설정을 프로그래밍적으로 생성할 때 사용한다.

const ROUTE_SCRIPT = "~/.claude/scripts/tfx-route.sh";

/**
 * CLI 타입별 teammate 프롬프트 생성
 * @param {'codex'|'gemini'|'claude'} cli — CLI 타입
 * @param {object} opts
 * @param {string} opts.subtask — 서브태스크 설명
 * @param {string} [opts.role] — 역할 (executor, designer, reviewer 등)
 * @param {string} [opts.teamName] — 팀 이름
 * @returns {string} teammate 프롬프트
 */
export function buildTeammatePrompt(cli, opts = {}) {
  const { subtask, role = "executor", teamName = "tfx-team" } = opts;

  if (cli === "claude") {
    return `너는 ${teamName}의 Claude 워커이다.

[작업] ${subtask}

[실행]
1. TaskList에서 pending 작업을 확인하고 claim (TaskUpdate: in_progress)
2. Glob, Grep, Read, Bash 등 도구로 직접 수행
3. 완료 시 TaskUpdate(status: completed) + SendMessage로 리드에게 보고
4. 추가 작업이 있으면 반복

에러 시 TaskUpdate(status: failed) + SendMessage로 보고.`;
  }

  const label = cli === "codex" ? "Codex" : "Gemini";
  const escaped = subtask.replace(/'/g, "'\\''");

  return `너는 ${teamName}의 ${label} 워커이다.

[작업] ${subtask}

[실행]
1. TaskList에서 pending 작업을 확인하고 claim (TaskUpdate: in_progress)
2. Bash("bash ${ROUTE_SCRIPT} ${role} '${escaped}' auto")로 실행
3. 결과 확인 후 TaskUpdate(status: completed) + SendMessage로 리드에게 보고
4. 추가 pending 작업이 있으면 반복

[규칙]
- 실제 구현은 ${label} CLI가 수행 — 너는 실행+보고 역할
- 에러 시 TaskUpdate(status: failed) + SendMessage로 보고`;
}

/**
 * teammate 이름 생성
 * @param {'codex'|'gemini'|'claude'} cli
 * @param {number} index — 0-based
 * @returns {string}
 */
export function buildTeammateName(cli, index) {
  return `${cli}-worker-${index + 1}`;
}

/**
 * 트리아지 결과에서 팀 멤버 설정 생성
 * @param {string} teamName — 팀 이름
 * @param {Array<{cli: string, subtask: string, role?: string}>} assignments
 * @returns {{ name: string, members: Array<{name: string, cli: string, prompt: string}> }}
 */
export function buildTeamConfig(teamName, assignments) {
  return {
    name: teamName,
    members: assignments.map((a, i) => ({
      name: buildTeammateName(a.cli, i),
      cli: a.cli,
      prompt: buildTeammatePrompt(a.cli, {
        subtask: a.subtask,
        role: a.role || "executor",
        teamName,
      }),
    })),
  };
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
 * @returns {string} 슬림 래퍼 프롬프트
 */
export function buildSlimWrapperPrompt(cli, opts = {}) {
  const {
    subtask,
    role = "executor",
    teamName = "tfx-team",
    taskId = "",
    agentName = "",
    leadName = "team-lead",
    mcp_profile = "auto",
  } = opts;

  // 셸 이스케이프
  const escaped = subtask.replace(/'/g, "'\\''");

  return `Bash 1회 실행 후 종료.

TFX_TEAM_NAME=${teamName} TFX_TEAM_TASK_ID=${taskId} TFX_TEAM_AGENT_NAME=${agentName} TFX_TEAM_LEAD_NAME=${leadName} bash ${ROUTE_SCRIPT} ${role} '${escaped}' ${mcp_profile}

완료 → TaskUpdate(status: completed) + SendMessage(to: ${leadName}).
실패 → TaskUpdate(status: failed) + SendMessage(to: ${leadName}).`;
}

/**
 * 팀 이름 생성 (타임스탬프 기반)
 * @returns {string}
 */
export function generateTeamName() {
  return `tfx-${Date.now().toString(36).slice(-6)}`;
}
