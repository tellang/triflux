// hub/team/cli-team-control.mjs — 팀 제어/attach/send 로직
import { spawn } from "node:child_process";

import {
  attachSession,
  resolveAttachCommand,
  killSession,
  closeWtSession,
  sessionExists,
  getSessionAttachedCount,
  listSessions,
  focusPane,
  focusWtPane,
  hasWindowsTerminal,
} from "./session.mjs";
import { injectPrompt, sendKeys } from "./pane.mjs";
import {
  PKG_ROOT,
  DIM,
  RESET,
  WHITE,
  loadTeamState,
  clearTeamState,
  resolveMember,
  publishLeadControl,
  isNativeMode,
  isWtMode,
  isTeamAlive,
  nativeRequest,
  ok,
  warn,
  fail,
} from "./cli-team-common.mjs";

async function launchAttachInWindowsTerminal(sessionName) {
  if (!hasWindowsTerminal()) return false;

  let attachSpec;
  try {
    attachSpec = resolveAttachCommand(sessionName);
  } catch {
    return false;
  }

  const launch = (args) => {
    const child = spawn("wt", args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
  };

  const beforeAttached = getSessionAttachedCount(sessionName);

  try {
    launch(["-w", "0", "split-pane", "-V", "-d", PKG_ROOT, attachSpec.command, ...attachSpec.args]);
    if (beforeAttached == null) {
      return true;
    }

    const deadline = Date.now() + 3500;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 120));
      const nowAttached = getSessionAttachedCount(sessionName);
      if (typeof nowAttached === "number" && nowAttached > beforeAttached) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function buildManualAttachCommand(sessionName) {
  try {
    const spec = resolveAttachCommand(sessionName);
    const quoted = [spec.command, ...spec.args].map((s) => {
      const value = String(s);
      return /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
    });
    return quoted.join(" ");
  } catch {
    return `tmux attach-session -t ${sessionName}`;
  }
}

function wantsWtAttachFallback() {
  return process.argv.includes("--wt")
    || process.argv.includes("--spawn-wt")
    || process.env.TFX_ATTACH_WT_AUTO === "1";
}

export async function teamAttach() {
  const state = loadTeamState();
  if (!state || !isTeamAlive(state)) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  if (isNativeMode(state)) {
    console.log(`\n  ${DIM}in-process 모드는 별도 attach가 없습니다.${RESET}`);
    console.log(`  ${DIM}상태 확인: tfx multi status${RESET}\n`);
    return;
  }

  if (isWtMode(state)) {
    console.log(`\n  ${DIM}wt 모드는 attach 개념이 없습니다 (Windows Terminal pane가 독립 실행됨).${RESET}`);
    console.log(`  ${DIM}재실행/정리는: tfx multi stop${RESET}\n`);
    return;
  }

  try {
    attachSession(state.sessionName);
  } catch (e) {
    const allowWt = wantsWtAttachFallback();
    if (allowWt && await launchAttachInWindowsTerminal(state.sessionName)) {
      warn(`현재 터미널에서 attach 실패: ${e.message}`);
      ok("Windows Terminal split-pane로 attach 재시도 창을 열었습니다.");
      console.log(`  ${DIM}수동 attach 명령: ${buildManualAttachCommand(state.sessionName)}${RESET}`);
      console.log("");
      return;
    }
    fail(`attach 실패: ${e.message}`);
    if (allowWt) {
      fail("WT 분할창 attach 자동 검증 실패 (session_attached 증가 없음)");
    } else {
      warn("자동 WT 분할은 기본 비활성입니다. 필요 시 --wt 옵션으로 실행하세요.");
    }
    console.log(`  ${DIM}수동 attach 명령: ${buildManualAttachCommand(state.sessionName)}${RESET}`);
    console.log("");
  }
}

export async function teamFocus() {
  const state = loadTeamState();
  if (!state || !isTeamAlive(state)) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  if (isNativeMode(state)) {
    console.log(`\n  ${DIM}in-process 모드는 focus/attach 개념이 없습니다.${RESET}`);
    console.log(`  ${DIM}직접 지시: tfx multi send <대상> "메시지"${RESET}\n`);
    return;
  }

  const selector = process.argv[4];
  const member = resolveMember(state, selector);
  if (!member) {
    console.log(`\n  사용법: ${WHITE}tfx multi focus <lead|이름|번호>${RESET}\n`);
    return;
  }

  if (isWtMode(state)) {
    const match = /^wt:(\d+)$/.exec(member.pane || "");
    const paneIndex = match ? parseInt(match[1], 10) : NaN;
    if (!Number.isFinite(paneIndex)) {
      warn(`wt pane 인덱스 파싱 실패: ${member.pane}`);
      console.log("");
      return;
    }
    const focused = focusWtPane(paneIndex, {
      layout: state?.wt?.layout || state?.layout || "1xN",
    });
    if (focused) {
      ok(`${member.name} pane 포커스 이동 (wt)`);
    } else {
      warn("wt pane 포커스 이동 실패 (WT_SESSION/wt.exe 상태 확인 필요)");
    }
    console.log("");
    return;
  }

  focusPane(member.pane, { zoom: false });
  try {
    attachSession(state.sessionName);
  } catch (e) {
    const allowWt = wantsWtAttachFallback();
    if (allowWt && await launchAttachInWindowsTerminal(state.sessionName)) {
      warn(`현재 터미널에서 attach 실패: ${e.message}`);
      ok("Windows Terminal split-pane로 attach 재시도 창을 열었습니다.");
      console.log(`  ${DIM}수동 attach 명령: ${buildManualAttachCommand(state.sessionName)}${RESET}`);
      console.log("");
      return;
    }
    fail(`attach 실패: ${e.message}`);
    if (allowWt) {
      fail("WT 분할창 attach 자동 검증 실패 (session_attached 증가 없음)");
    } else {
      warn("자동 WT 분할은 기본 비활성입니다. 필요 시 --wt 옵션으로 실행하세요.");
    }
    console.log(`  ${DIM}수동 attach 명령: ${buildManualAttachCommand(state.sessionName)}${RESET}`);
    console.log("");
  }
}

export async function teamInterrupt() {
  const state = loadTeamState();
  if (!state || !isTeamAlive(state)) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  const selector = process.argv[4] || "lead";
  const member = resolveMember(state, selector);
  if (!member) {
    console.log(`\n  사용법: ${WHITE}tfx multi interrupt <lead|이름|번호>${RESET}\n`);
    return;
  }

  if (isWtMode(state)) {
    warn("wt 모드에서는 pane stdin 주입이 지원되지 않아 interrupt를 자동 전송할 수 없습니다.");
    console.log(`  ${DIM}수동으로 해당 pane에서 Ctrl+C를 입력하세요.${RESET}`);
    console.log("");
    return;
  }

  if (isNativeMode(state)) {
    const result = await nativeRequest(state, "/interrupt", { member: member.name });
    if (result?.ok) {
      ok(`${member.name} 인터럽트 전송`);
    } else {
      warn(`${member.name} 인터럽트 실패`);
    }
    console.log("");
    return;
  }

  sendKeys(member.pane, "C-c");
  ok(`${member.name} 인터럽트 전송`);
  console.log("");
}

export async function teamControl() {
  const state = loadTeamState();
  if (!state || !isTeamAlive(state)) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  const selector = process.argv[4];
  const command = (process.argv[5] || "").toLowerCase();
  const reason = process.argv.slice(6).join(" ");
  const member = resolveMember(state, selector);
  const allowed = new Set(["interrupt", "stop", "pause", "resume"]);

  if (!member || !allowed.has(command)) {
    console.log(`\n  사용법: ${WHITE}tfx multi control <lead|이름|번호> <interrupt|stop|pause|resume> [사유]${RESET}\n`);
    return;
  }

  if (isWtMode(state)) {
    warn("wt 모드는 Hub direct/control 주입 경로가 비활성입니다.");
    console.log(`  ${DIM}수동 제어: 해당 pane에서 직접 명령/인터럽트를 수행하세요.${RESET}`);
    console.log("");
    return;
  }

  let directOk = false;
  if (isNativeMode(state)) {
    const direct = await nativeRequest(state, "/control", {
      member: member.name,
      command,
      reason,
    });
    directOk = !!direct?.ok;
  } else {
    const controlMsg = `[LEAD CONTROL] command=${command}${reason ? ` reason=${reason}` : ""}`;
    injectPrompt(member.pane, controlMsg);
    if (command === "interrupt") {
      sendKeys(member.pane, "C-c");
    }
    directOk = true;
  }

  const published = await publishLeadControl(state, member, command, reason);

  if (directOk && published) {
    ok(`${member.name} 제어 전송 (${command}, direct + hub)`);
  } else if (directOk) {
    ok(`${member.name} 제어 전송 (${command}, direct only)`);
  } else {
    warn(`${member.name} 제어 전송 실패 (${command})`);
  }
  console.log("");
}

export async function teamStop() {
  const state = loadTeamState();
  if (!state) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  if (isNativeMode(state)) {
    await nativeRequest(state, "/stop", {});
    try {
      process.kill(state.native.supervisorPid, "SIGTERM");
    } catch {}
    ok(`세션 종료: ${state.sessionName}`);
  } else if (isWtMode(state)) {
    const closed = closeWtSession({
      layout: state?.wt?.layout || state?.layout || "1xN",
      paneCount: state?.wt?.paneCount ?? (state.members || []).length,
    });
    ok(`세션 종료: ${state.sessionName}${closed ? ` (${closed} panes closed)` : ""}`);
  } else if (sessionExists(state.sessionName)) {
    killSession(state.sessionName);
    ok(`세션 종료: ${state.sessionName}`);
  } else {
    console.log(`  ${DIM}세션 이미 종료됨${RESET}`);
  }

  clearTeamState();
  console.log("");
}

export async function teamKill() {
  const state = loadTeamState();
  if (state && isNativeMode(state) && isTeamAlive(state)) {
    await nativeRequest(state, "/stop", {});
    try {
      process.kill(state.native.supervisorPid, "SIGTERM");
    } catch {}
    clearTeamState();
    ok(`종료: ${state.sessionName}`);
    console.log("");
    return;
  }

  if (state && isWtMode(state)) {
    const closed = closeWtSession({
      layout: state?.wt?.layout || state?.layout || "1xN",
      paneCount: state?.wt?.paneCount ?? (state.members || []).length,
    });
    clearTeamState();
    ok(`종료: ${state.sessionName}${closed ? ` (${closed} panes closed)` : ""}`);
    console.log("");
    return;
  }

  const sessions = listSessions();
  if (sessions.length === 0) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }
  for (const session of sessions) {
    killSession(session);
    ok(`종료: ${session}`);
  }
  clearTeamState();
  console.log("");
}

export async function teamSend() {
  const state = loadTeamState();
  if (!state || !isTeamAlive(state)) {
    console.log(`\n  ${DIM}활성 팀 세션 없음${RESET}\n`);
    return;
  }

  const selector = process.argv[4];
  const message = process.argv.slice(5).join(" ");
  const member = resolveMember(state, selector);
  if (!member || !message) {
    console.log(`\n  사용법: ${WHITE}tfx multi send <lead|이름|번호> "메시지"${RESET}\n`);
    return;
  }

  if (isWtMode(state)) {
    warn("wt 모드는 pane 프롬프트 자동 주입(send)이 지원되지 않습니다.");
    console.log(`  ${DIM}수동 전달: 선택한 pane에 직접 붙여넣으세요.${RESET}`);
    console.log("");
    return;
  }

  if (isNativeMode(state)) {
    const result = await nativeRequest(state, "/send", { member: member.name, text: message });
    if (result?.ok) {
      ok(`${member.name}에 메시지 주입 완료`);
    } else {
      warn(`${member.name} 메시지 주입 실패`);
    }
    console.log("");
    return;
  }

  injectPrompt(member.pane, message);
  ok(`${member.name}에 메시지 주입 완료`);
  console.log("");
}
