import { AMBER, BOLD, DIM, GRAY, RESET, WHITE } from "../shared.mjs";

export function renderTeamHelp() {
  console.log(`
  ${AMBER}${BOLD}⬡ tfx multi${RESET} ${DIM}멀티-CLI 팀 모드 (Lead + Teammates)${RESET}

  ${BOLD}시작${RESET}
    ${WHITE}tfx multi "작업 설명"${RESET}
    ${WHITE}tfx multi --agents codex,gemini --lead claude "작업"${RESET}
    ${WHITE}tfx multi --teammate-mode tmux "작업"${RESET}
    ${WHITE}tfx multi --teammate-mode wt "작업"${RESET}   ${DIM}(Windows Terminal split-pane)${RESET}
    ${WHITE}tfx multi --layout 1xN "작업"${RESET}               ${DIM}(세로 분할 컬럼)${RESET}
    ${WHITE}tfx multi --layout Nx1 "작업"${RESET}               ${DIM}(가로 분할 스택)${RESET}
    ${WHITE}tfx multi --dashboard-layout lite "작업"${RESET}    ${DIM}(dashboard-lite 기본 뷰)${RESET}
    ${WHITE}tfx multi --dashboard-layout auto "작업"${RESET}    ${DIM}(dashboard viewer 레이아웃 자동 결정)${RESET}
    ${WHITE}tfx multi --dashboard-size 0.4 "작업"${RESET}      ${DIM}(대시보드 분할 비율 0.2~0.8, 기본 0.50)${RESET}
    ${WHITE}tfx multi --dashboard-anchor window "작업"${RESET} ${DIM}(대시보드 고정 위치: window|tab, 기본 window)${RESET}
    ${WHITE}tfx multi --teammate-mode in-process "작업"${RESET} ${DIM}(tmux 불필요)${RESET}

  ${BOLD}제어${RESET}
    ${WHITE}tfx multi status${RESET}                      ${GRAY}현재 팀 상태${RESET}
    ${WHITE}tfx multi debug${RESET} ${DIM}[--lines 30]${RESET}          ${GRAY}강화 디버그 출력(환경/세션/pane tail)${RESET}
    ${WHITE}tfx multi tasks${RESET}                       ${GRAY}공유 태스크 목록${RESET}
    ${WHITE}tfx multi task${RESET} ${DIM}<pending|progress|done> <T1>${RESET} ${GRAY}태스크 상태 갱신${RESET}
    ${WHITE}tfx multi attach${RESET} ${DIM}[--wt]${RESET}               ${GRAY}세션 재연결 (WT 분할은 opt-in)${RESET}
    ${WHITE}tfx multi focus${RESET} ${DIM}<lead|이름|번호> [--wt]${RESET} ${GRAY}특정 팀메이트 포커스${RESET}
    ${WHITE}tfx multi send${RESET} ${DIM}<lead|이름|번호> "msg"${RESET} ${GRAY}팀메이트에 메시지 주입${RESET}
    ${WHITE}tfx multi interrupt${RESET} ${DIM}<대상>${RESET}            ${GRAY}팀메이트 인터럽트(C-c)${RESET}
    ${WHITE}tfx multi control${RESET} ${DIM}<대상> <cmd>${RESET}        ${GRAY}리드 제어명령(interrupt|stop|pause|resume)${RESET}
    ${WHITE}tfx multi stop${RESET}                        ${GRAY}graceful 종료${RESET}
    ${WHITE}tfx multi kill${RESET}                        ${GRAY}모든 팀 세션 강제 종료${RESET}
    ${WHITE}tfx multi list${RESET}                        ${GRAY}활성 세션 목록${RESET}

  ${BOLD}키 조작(Claude teammate 스타일, tmux 모드)${RESET}
    ${WHITE}Shift+Down${RESET}  ${GRAY}다음 팀메이트${RESET}
    ${WHITE}Shift+Tab${RESET}   ${GRAY}이전 팀메이트 (권장)${RESET}
    ${WHITE}Shift+Left${RESET}  ${GRAY}이전 팀메이트 (대체)${RESET}
    ${WHITE}Shift+Up${RESET}    ${GRAY}미지원 (Claude Code가 캡처 불가, scroll-up 충돌)${RESET}
    ${WHITE}Escape${RESET}      ${GRAY}현재 팀메이트 인터럽트${RESET}
    ${WHITE}Ctrl+T${RESET}      ${GRAY}태스크 목록 토글${RESET}
`);
}
