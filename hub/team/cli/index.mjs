import { renderTeamHelp } from "./help.mjs";
import { resolveTeamCommand } from "./manifest.mjs";
import { teamAttach } from "./commands/attach.mjs";
import { teamControl } from "./commands/control.mjs";
import { teamDebug } from "./commands/debug.mjs";
import { teamFocus } from "./commands/focus.mjs";
import { teamInterrupt } from "./commands/interrupt.mjs";
import { teamKill } from "./commands/kill.mjs";
import { teamList } from "./commands/list.mjs";
import { teamSend } from "./commands/send.mjs";
import { teamStart } from "./commands/start/index.mjs";
import { teamStatus } from "./commands/status.mjs";
import { teamStop } from "./commands/stop.mjs";
import { teamTaskUpdate } from "./commands/task.mjs";
import { teamTasks } from "./commands/tasks.mjs";

const handlers = {
  attach: teamAttach,
  control: teamControl,
  debug: teamDebug,
  focus: teamFocus,
  help: renderTeamHelp,
  interrupt: teamInterrupt,
  kill: teamKill,
  list: teamList,
  send: teamSend,
  start: teamStart,
  status: teamStatus,
  stop: teamStop,
  task: teamTaskUpdate,
  tasks: teamTasks,
};

export async function cmdTeam() {
  const args = process.argv.slice(3);
  const command = resolveTeamCommand(args[0]);
  if (!args.length) return renderTeamHelp();
  // 미등록 커맨드는 teamStart로 fallthrough (팀 생성 기본값)
  if (!command) return teamStart(args);
  return handlers[command](args.slice(1));
}
