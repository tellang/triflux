// hub/team/cli.mjs — team CLI UI/네비게이션 진입점
// bin/triflux.mjs에서 import하여 사용
import { AMBER, GRAY, DIM, BOLD, RESET, WHITE } from "./shared.mjs";
import { TEAM_SUBCOMMANDS } from "./cli-team-common.mjs";
import { teamStart } from "./cli-team-start.mjs";
import { teamStatus, teamTasks, teamTaskUpdate, teamDebug, teamList } from "./cli-team-status.mjs";
import {
  teamAttach,
  teamFocus,
  teamInterrupt,
  teamControl,
  teamStop,
  teamKill,
  teamSend,
} from "./cli-team-control.mjs";

function teamHelp() {
  console.log(`
  ${AMBER}${BOLD}⬡ tfx team${RESET} ${DIM}멀티-CLI 팀 모드 (Lead + Teammates)${RESET}

  ${BOLD}시작${RESET}
    ${WHITE}tfx team "작업 설명"${RESET}
    ${WHITE}tfx team --agents codex,gemini --lead claude "작업"${RESET}
    ${WHITE}tfx team --teammate-mode tmux "작업"${RESET}
    ${WHITE}tfx team --teammate-mode wt "작업"${RESET}   ${DIM}(Windows Terminal split-pane)${RESET}
    ${WHITE}tfx team --layout 1xN "작업"${RESET}               ${DIM}(세로 분할 컬럼)${RESET}
    ${WHITE}tfx team --layout Nx1 "작업"${RESET}               ${DIM}(가로 분할 스택)${RESET}
    ${WHITE}tfx team --teammate-mode in-process "작업"${RESET} ${DIM}(tmux 불필요)${RESET}

  ${BOLD}제어${RESET}
    ${WHITE}tfx team status${RESET}                      ${GRAY}현재 팀 상태${RESET}
    ${WHITE}tfx team debug${RESET} ${DIM}[--lines 30]${RESET}          ${GRAY}강화 디버그 출력(환경/세션/pane tail)${RESET}
    ${WHITE}tfx team tasks${RESET}                       ${GRAY}공유 태스크 목록${RESET}
    ${WHITE}tfx team task${RESET} ${DIM}<pending|progress|done> <T1>${RESET} ${GRAY}태스크 상태 갱신${RESET}
    ${WHITE}tfx team attach${RESET} ${DIM}[--wt]${RESET}               ${GRAY}세션 재연결 (WT 분할은 opt-in)${RESET}
    ${WHITE}tfx team focus${RESET} ${DIM}<lead|이름|번호> [--wt]${RESET} ${GRAY}특정 팀메이트 포커스${RESET}
    ${WHITE}tfx team send${RESET} ${DIM}<lead|이름|번호> "msg"${RESET} ${GRAY}팀메이트에 메시지 주입${RESET}
    ${WHITE}tfx team interrupt${RESET} ${DIM}<대상>${RESET}            ${GRAY}팀메이트 인터럽트(C-c)${RESET}
    ${WHITE}tfx team control${RESET} ${DIM}<대상> <cmd>${RESET}        ${GRAY}리드 제어명령(interrupt|stop|pause|resume)${RESET}
    ${WHITE}tfx team stop${RESET}                        ${GRAY}graceful 종료${RESET}
    ${WHITE}tfx team kill${RESET}                        ${GRAY}모든 팀 세션 강제 종료${RESET}
    ${WHITE}tfx team list${RESET}                        ${GRAY}활성 세션 목록${RESET}

  ${BOLD}키 조작(Claude teammate 스타일, tmux 모드)${RESET}
    ${WHITE}Shift+Down${RESET}  ${GRAY}다음 팀메이트${RESET}
    ${WHITE}Shift+Tab${RESET}   ${GRAY}이전 팀메이트 (권장)${RESET}
    ${WHITE}Shift+Left${RESET}  ${GRAY}이전 팀메이트 (대체)${RESET}
    ${WHITE}Shift+Up${RESET}    ${GRAY}미지원 (Claude Code가 캡처 불가, scroll-up 충돌)${RESET}
    ${WHITE}Escape${RESET}      ${GRAY}현재 팀메이트 인터럽트${RESET}
    ${WHITE}Ctrl+T${RESET}      ${GRAY}태스크 목록 토글${RESET}
`);
}

/**
 * tfx team 서브커맨드 라우터
 * bin/triflux.mjs에서 호출
 */
export async function cmdTeam() {
  const rawSub = process.argv[3];
  const sub = typeof rawSub === "string" ? rawSub.toLowerCase() : rawSub;

  switch (sub) {
    case "status":
      return teamStatus();
    case "debug":
      return teamDebug();
    case "tasks":
      return teamTasks();
    case "task":
      return teamTaskUpdate();
    case "attach":
      return teamAttach();
    case "focus":
      return teamFocus();
    case "interrupt":
      return teamInterrupt();
    case "control":
      return teamControl();
    case "stop":
      return teamStop();
    case "kill":
      return teamKill();
    case "send":
      return teamSend();
    case "list":
      return teamList();
    case "help":
    case "--help":
    case "-h":
      return teamHelp();
    case undefined:
      return teamHelp();
    default:
      if (typeof sub === "string" && !sub.startsWith("-") && TEAM_SUBCOMMANDS.has(sub)) {
        return teamHelp();
      }
      return teamStart();
  }
}
