// hub/team/cli-team-start.mjs — 팀 시작 로직
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

import {
  createSession,
  createWtSession,
  attachSession,
  configureTeammateKeybindings,
  detectMultiplexer,
  hasWindowsTerminal,
  hasWindowsTerminalSession,
} from "./session.mjs";
import { buildCliCommand, startCliInPane } from "./pane.mjs";
import { orchestrate, decomposeTask, buildLeadPrompt, buildPrompt } from "./orchestrator.mjs";
import {
  PKG_ROOT,
  HUB_PID_DIR,
  TEAM_PROFILE,
  AMBER,
  GREEN,
  RED,
  DIM,
  BOLD,
  RESET,
  WHITE,
  getHubInfo,
  startHubDaemon,
  getDefaultHubUrl,
  saveTeamState,
  ok,
  warn,
  fail,
} from "./cli-team-common.mjs";

function normalizeTeammateMode(mode = "auto") {
  const raw = String(mode).toLowerCase();
  if (raw === "inline" || raw === "native") return "in-process";
  if (raw === "in-process" || raw === "tmux" || raw === "wt") return raw;
  if (raw === "windows-terminal" || raw === "windows_terminal") return "wt";
  if (raw === "auto") {
    return process.env.TMUX ? "tmux" : "in-process";
  }
  return "in-process";
}

function normalizeLayout(layout = "2x2") {
  const raw = String(layout).toLowerCase();
  if (raw === "2x2" || raw === "grid") return "2x2";
  if (raw === "1xn" || raw === "1x3" || raw === "vertical" || raw === "columns") return "1xN";
  if (raw === "nx1" || raw === "horizontal" || raw === "rows") return "Nx1";
  return "2x2";
}

function parseTeamArgs() {
  const args = process.argv.slice(3);
  let agents = ["codex", "gemini"];
  let lead = "claude";
  let layout = "2x2";
  let teammateMode = "auto";
  const taskParts = [];

  for (let i = 0; i < args.length; i++) {
    const cur = args[i];
    if (cur === "--agents" && args[i + 1]) {
      agents = args[++i].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    } else if (cur === "--lead" && args[i + 1]) {
      lead = args[++i].trim().toLowerCase();
    } else if (cur === "--layout" && args[i + 1]) {
      layout = args[++i];
    } else if ((cur === "--teammate-mode" || cur === "--mode") && args[i + 1]) {
      teammateMode = args[++i];
    } else if (!cur.startsWith("-")) {
      taskParts.push(cur);
    }
  }

  return {
    agents,
    lead,
    layout: normalizeLayout(layout),
    teammateMode: normalizeTeammateMode(teammateMode),
    task: taskParts.join(" ").trim(),
  };
}

function buildTasks(subtasks, workers) {
  return subtasks.map((subtask, i) => ({
    id: `T${i + 1}`,
    title: subtask,
    owner: workers[i]?.name || null,
    status: "pending",
    depends_on: i === 0 ? [] : [`T${i}`],
  }));
}

function ensureTmuxOrExit() {
  const mux = detectMultiplexer();
  if (mux) return;

  console.log(`
  ${RED}${BOLD}tmux 미발견${RESET}

  현재 선택한 모드는 tmux 기반 팀세션이 필요합니다.

  설치:
    WSL2:   ${WHITE}wsl sudo apt install tmux${RESET}
    macOS:  ${WHITE}brew install tmux${RESET}
    Linux:  ${WHITE}apt install tmux${RESET}

  Windows에서는 WSL2를 권장합니다:
    1. ${WHITE}wsl --install${RESET}
    2. ${WHITE}wsl sudo apt install tmux${RESET}
    3. ${WHITE}tfx team "작업"${RESET}
`);
  process.exit(1);
}

function toAgentId(cli, target) {
  const suffix = String(target).split(/[:.]/).pop();
  return `${cli}-${suffix}`;
}

function buildNativeCliCommand(cli) {
  switch (cli) {
    case "codex":
      return "codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen";
    case "gemini":
      return "gemini";
    case "claude":
      return "claude";
    default:
      return buildCliCommand(cli);
  }
}

async function startNativeSupervisor({ sessionId, task, lead, agents, subtasks, hubUrl }) {
  const nativeConfigPath = join(HUB_PID_DIR, `team-native-${sessionId}.config.json`);
  const nativeRuntimePath = join(HUB_PID_DIR, `team-native-${sessionId}.runtime.json`);
  const logsDir = join(HUB_PID_DIR, "team-logs", sessionId);
  mkdirSync(logsDir, { recursive: true });

  const leadMember = {
    role: "lead",
    name: "lead",
    cli: lead,
    agentId: `${lead}-lead`,
    command: buildNativeCliCommand(lead),
  };

  const workers = agents.map((cli, i) => ({
    role: "worker",
    name: `${cli}-${i + 1}`,
    cli,
    agentId: `${cli}-w${i + 1}`,
    command: buildNativeCliCommand(cli),
    subtask: subtasks[i],
  }));

  const leadPrompt = buildLeadPrompt(task, {
    agentId: leadMember.agentId,
    hubUrl,
    teammateMode: "in-process",
    workers: workers.map((w) => ({ agentId: w.agentId, cli: w.cli, subtask: w.subtask })),
  });

  const members = [
    { ...leadMember, prompt: leadPrompt },
    ...workers.map((w) => ({
      ...w,
      prompt: buildPrompt(w.subtask, { cli: w.cli, agentId: w.agentId, hubUrl }),
    })),
  ];

  const config = {
    sessionName: sessionId,
    hubUrl,
    startupDelayMs: 3000,
    logsDir,
    runtimeFile: nativeRuntimePath,
    members,
  };
  writeFileSync(nativeConfigPath, JSON.stringify(config, null, 2) + "\n");

  const supervisorPath = join(PKG_ROOT, "hub", "team", "native-supervisor.mjs");
  const child = spawn(process.execPath, [supervisorPath, "--config", nativeConfigPath], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(nativeRuntimePath)) {
      try {
        const runtime = JSON.parse(readFileSync(nativeRuntimePath, "utf8"));
        return { runtime, members };
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return { runtime: null, members };
}

export async function teamStart() {
  const { agents, lead, layout, teammateMode, task } = parseTeamArgs();
  if (!task) {
    console.log(`\n  ${AMBER}${BOLD}⬡ tfx team${RESET}\n`);
    console.log(`  사용법: ${WHITE}tfx team "작업 설명"${RESET}`);
    console.log(`          ${WHITE}tfx team --agents codex,gemini --lead claude "작업"${RESET}`);
    console.log(`          ${WHITE}tfx team --teammate-mode wt "작업"${RESET} ${DIM}(Windows Terminal split-pane)${RESET}`);
    console.log(`          ${WHITE}tfx team --teammate-mode in-process "작업"${RESET} ${DIM}(tmux 불필요)${RESET}\n`);
    return;
  }

  console.log(`\n  ${AMBER}${BOLD}⬡ tfx team${RESET}\n`);

  let hub = await getHubInfo();
  if (!hub) {
    process.stdout.write("  Hub 시작 중...");
    hub = await startHubDaemon();
    if (hub) {
      console.log(` ${GREEN}✓${RESET}`);
    } else {
      console.log(` ${RED}✗${RESET}`);
      warn("Hub 시작 실패 — 수동으로 실행: tfx hub start");
    }
  } else {
    ok(`Hub: ${DIM}${hub.url}${RESET}`);
  }

  const sessionId = `tfx-team-${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`;
  const subtasks = decomposeTask(task, agents.length);
  const hubUrl = hub?.url || getDefaultHubUrl();
  let effectiveTeammateMode = teammateMode;

  if (teammateMode === "wt") {
    if (!hasWindowsTerminal()) {
      warn("wt.exe 미발견 — in-process 모드로 자동 fallback");
      effectiveTeammateMode = "in-process";
    } else if (!hasWindowsTerminalSession()) {
      warn("WT_SESSION 미감지(Windows Terminal 외부) — in-process 모드로 자동 fallback");
      effectiveTeammateMode = "in-process";
    }
  }

  console.log(`  세션:  ${WHITE}${sessionId}${RESET}`);
  console.log(`  모드:  ${effectiveTeammateMode}`);
  console.log(`  리드:  ${AMBER}${lead}${RESET}`);
  console.log(`  워커:  ${agents.map((a) => `${AMBER}${a}${RESET}`).join(", ")}`);

  if (effectiveTeammateMode === "in-process") {
    for (let i = 0; i < subtasks.length; i++) {
      const preview = subtasks[i].length > 44 ? subtasks[i].slice(0, 44) + "…" : subtasks[i];
      console.log(`    ${DIM}[${agents[i]}-${i + 1}] ${preview}${RESET}`);
    }
    console.log("");

    const { runtime, members } = await startNativeSupervisor({
      sessionId,
      task,
      lead,
      agents,
      subtasks,
      hubUrl,
    });

    if (!runtime?.controlUrl) {
      fail("in-process supervisor 시작 실패");
      return;
    }

    const tasks = buildTasks(subtasks, members.filter((m) => m.role === "worker"));

    saveTeamState({
      sessionName: sessionId,
      task,
      lead,
      agents,
      layout: "native",
      teammateMode: effectiveTeammateMode,
      startedAt: Date.now(),
      hubUrl,
      members: members.map((m, idx) => ({
        role: m.role,
        name: m.name,
        cli: m.cli,
        agentId: m.agentId,
        pane: `native:${idx}`,
        subtask: m.subtask || null,
      })),
      panes: {},
      tasks,
      native: {
        controlUrl: runtime.controlUrl,
        supervisorPid: runtime.supervisorPid,
      },
    });

    ok("네이티브 in-process 팀 시작 완료");
    console.log(`  ${DIM}tmux 없이 실행됨 (직접 CLI 프로세스)${RESET}`);
    console.log(`  ${DIM}제어: tfx team send/control/tasks/status${RESET}\n`);
    return;
  }

  if (effectiveTeammateMode === "wt") {
    const paneCount = agents.length + 1;
    const effectiveLayout = layout === "Nx1" ? "Nx1" : "1xN";
    if (layout !== effectiveLayout) {
      warn(`wt 모드에서 ${layout} 레이아웃은 미지원 — ${effectiveLayout}로 대체`);
    }
    console.log(`  레이아웃: ${effectiveLayout} (${paneCount} panes)`);

    const paneCommands = [
      {
        title: `${sessionId}-lead`,
        command: buildCliCommand(lead),
        cwd: PKG_ROOT,
      },
      ...agents.map((cli, i) => ({
        title: `${sessionId}-${cli}-${i + 1}`,
        command: buildCliCommand(cli),
        cwd: PKG_ROOT,
      })),
    ];

    const session = createWtSession(sessionId, {
      layout: effectiveLayout,
      paneCommands,
    });

    const members = [
      {
        role: "lead",
        name: "lead",
        cli: lead,
        pane: session.panes[0] || "wt:0",
        agentId: toAgentId(lead, session.panes[0] || "wt:0"),
      },
    ];

    for (let i = 0; i < agents.length; i++) {
      const cli = agents[i];
      const target = session.panes[i + 1] || `wt:${i + 1}`;
      members.push({
        role: "worker",
        name: `${cli}-${i + 1}`,
        cli,
        pane: target,
        subtask: subtasks[i],
        agentId: toAgentId(cli, target),
      });
    }

    for (const worker of members.filter((m) => m.role === "worker")) {
      const preview = worker.subtask.length > 44 ? worker.subtask.slice(0, 44) + "…" : worker.subtask;
      console.log(`    ${DIM}[${worker.name}] ${preview}${RESET}`);
    }
    console.log("");

    const tasks = buildTasks(subtasks, members.filter((m) => m.role === "worker"));
    const panes = {};
    for (const m of members) {
      panes[m.pane] = {
        role: m.role,
        name: m.name,
        cli: m.cli,
        agentId: m.agentId,
        subtask: m.subtask || null,
      };
    }

    saveTeamState({
      sessionName: sessionId,
      task,
      lead,
      agents,
      layout: effectiveLayout,
      teammateMode: effectiveTeammateMode,
      startedAt: Date.now(),
      hubUrl,
      members,
      panes,
      tasks,
      wt: {
        windowId: 0,
        layout: effectiveLayout,
        paneCount: session.paneCount,
      },
    });

    ok("Windows Terminal wt 팀 시작 완료");
    console.log(`  ${DIM}현재 pane 기준으로 ${effectiveLayout} 분할 생성됨${RESET}`);
    console.log(`  ${DIM}wt 모드는 자동 프롬프트 주입/Hub direct 제어(send/control)가 제한됩니다.${RESET}\n`);
    return;
  }

  ensureTmuxOrExit();

  const paneCount = agents.length + 1;
  const effectiveLayout = paneCount <= 4 ? layout : (layout === "Nx1" ? "Nx1" : "1xN");
  console.log(`  레이아웃: ${effectiveLayout} (${paneCount} panes)`);

  const session = createSession(sessionId, {
    layout: effectiveLayout,
    paneCount,
  });

  const leadTarget = session.panes[0];
  startCliInPane(leadTarget, buildCliCommand(lead));

  const assignments = [];
  const members = [
    {
      role: "lead",
      name: "lead",
      cli: lead,
      pane: leadTarget,
      agentId: toAgentId(lead, leadTarget),
    },
  ];

  for (let i = 0; i < agents.length; i++) {
    const cli = agents[i];
    const target = session.panes[i + 1];
    startCliInPane(target, buildCliCommand(cli));

    const worker = {
      role: "worker",
      name: `${cli}-${i + 1}`,
      cli,
      pane: target,
      subtask: subtasks[i],
      agentId: toAgentId(cli, target),
    };

    members.push(worker);
    assignments.push({ target, cli, subtask: subtasks[i] });
  }

  for (const worker of members.filter((m) => m.role === "worker")) {
    const preview = worker.subtask.length > 44 ? worker.subtask.slice(0, 44) + "…" : worker.subtask;
    console.log(`    ${DIM}[${worker.name}] ${preview}${RESET}`);
  }
  console.log("");

  ok("CLI 초기화 대기 (3초)...");
  await new Promise((r) => setTimeout(r, 3000));

  await orchestrate(sessionId, assignments, {
    hubUrl,
    teammateMode: effectiveTeammateMode,
    lead: {
      target: leadTarget,
      cli: lead,
      task,
    },
  });
  ok("리드/워커 프롬프트 주입 완료");

  const tasks = buildTasks(subtasks, members.filter((m) => m.role === "worker"));
  const panes = {};
  for (const m of members) {
    panes[m.pane] = {
      role: m.role,
      name: m.name,
      cli: m.cli,
      agentId: m.agentId,
      subtask: m.subtask || null,
    };
  }

  saveTeamState({
    sessionName: sessionId,
    task,
    lead,
    agents,
    layout: effectiveLayout,
    teammateMode: effectiveTeammateMode,
    startedAt: Date.now(),
    hubUrl,
    members,
    panes,
    tasks,
  });

  const profilePrefix = TEAM_PROFILE === "team" ? "" : `TFX_TEAM_PROFILE=${TEAM_PROFILE} `;
  const taskListCommand = `${profilePrefix}${process.execPath} ${join(PKG_ROOT, "bin", "triflux.mjs")} team tasks`;
  configureTeammateKeybindings(sessionId, {
    inProcess: false,
    taskListCommand,
  });

  console.log(`\n  ${GREEN}${BOLD}팀 세션 준비 완료${RESET}`);
  console.log(`  ${DIM}Shift+Down: 다음 팀메이트 전환${RESET}`);
  console.log(`  ${DIM}Shift+Tab / Shift+Left: 이전 팀메이트 전환${RESET}`);
  console.log(`  ${DIM}Escape: 현재 팀메이트 인터럽트${RESET}`);
  console.log(`  ${DIM}Ctrl+T: 태스크 목록${RESET}`);
  console.log(`  ${DIM}참고: Shift+Up은 Claude Code 미지원 (scroll-up 충돌). Shift+Tab 사용${RESET}`);
  console.log(`  ${DIM}Ctrl+B → D: 세션 분리 (백그라운드)${RESET}\n`);

  if (process.stdout.isTTY && process.stdin.isTTY) {
    attachSession(sessionId);
  } else {
    warn("TTY 미지원 환경이라 자동 attach를 생략함");
    console.log(`  ${DIM}수동 연결: tfx team attach${RESET}\n`);
  }
}

