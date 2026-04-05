export const TEAM_COMMANDS = [
  { name: "status", usage: "tfx multi status", desc: "현재 팀 상태" },
  { name: "debug", usage: "tfx multi debug [--lines 30]", desc: "강화 디버그 출력" },
  { name: "tasks", usage: "tfx multi tasks", desc: "공유 태스크 목록" },
  { name: "task", usage: "tfx multi task <pending|progress|done> <T1>", desc: "태스크 상태 갱신" },
  { name: "attach", usage: "tfx multi attach [--wt]", desc: "세션 재연결" },
  { name: "focus", usage: "tfx multi focus <lead|이름|번호> [--wt]", desc: "특정 팀메이트 포커스" },
  { name: "send", usage: "tfx multi send <lead|이름|번호> \"msg\"", desc: "팀메이트에 메시지 주입" },
  { name: "interrupt", usage: "tfx multi interrupt <대상>", desc: "팀메이트 인터럽트(C-c)" },
  { name: "control", usage: "tfx multi control <대상> <cmd> [사유]", desc: "리드 제어명령 전송" },
  { name: "stop", usage: "tfx multi stop", desc: "graceful 종료" },
  { name: "kill", usage: "tfx multi kill", desc: "모든 팀 세션 강제 종료" },
  { name: "list", usage: "tfx multi list", desc: "활성 세션 목록" },
  { name: "help", usage: "tfx multi help", desc: "도움말" },
  { name: "start", usage: "tfx multi start [options]", desc: "새 팀 세션 시작 (기본 커맨드)" },
];

export const TEAM_COMMAND_ALIASES = new Map([
  ["-h", "help"],
  ["--help", "help"],
]);

export const TEAM_SUBCOMMANDS = new Set(TEAM_COMMANDS.map(({ name }) => name));

export function resolveTeamCommand(raw) {
  if (typeof raw !== "string") return null;
  const command = raw.toLowerCase();
  return TEAM_SUBCOMMANDS.has(command) ? command : (TEAM_COMMAND_ALIASES.get(command) || null);
}
