import { spawn } from "node:child_process";
import readline from "node:readline";

import { fetchHubStatus, pollAgents } from "./monitor-data.mjs";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const ORANGE = "\x1b[38;5;208m";
const BLUE = "\x1b[38;5;39m";
const WHITE = "\x1b[37m";
const GRAY = "\x1b[38;5;245m";
const FALLBACK_COLUMNS = 100;

function colorCli(cli) {
  if (cli === "claude") return ORANGE;
  if (cli === "gemini") return BLUE;
  return WHITE;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function pad(text, width) {
  const value = String(text ?? "");
  return value.length >= width
    ? value
    : value + " ".repeat(width - value.length);
}

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0)
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function progressBar(value, width = 16) {
  const safe = clamp(Number(value) || 0, 0, 1);
  const filled = Math.round(safe * width);
  return `[${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}]`;
}

function escapePs(value) {
  return String(value || "").replace(/'/g, "''");
}

function sanitizeTitle(value, fallback = "agent") {
  const safe = String(value || "")
    .replace(/[\r\n<>:"/\\|?*\x00-\x1f]/g, " ")
    .trim();
  return safe || fallback;
}

function stripUnsafeText(value) {
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
}

function buildOpenCommand(agent) {
  const sessionName = escapePs(agent.agent || "");
  const pid = Number(agent.pid) || 0;
  const processInfo =
    pid > 0
      ? `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Format-List Id,ProcessName,StartTime`
      : "Write-Host 'PID 정보가 없습니다.'";
  return [
    "$ErrorActionPreference = 'Continue'",
    `if (Get-Command psmux -ErrorAction SilentlyContinue) { try { psmux attach-session -t '${sessionName}' } catch { Write-Host 'psmux attach 실패:' $_.Exception.Message } }`,
    "else { Write-Host 'psmux 미설치 환경입니다.' }",
    processInfo,
  ].join("; ");
}

function resolveRatio(agent, maxElapsed) {
  if (maxElapsed <= 0) return 1;
  return clamp(agent.elapsed / maxElapsed, 0, 1);
}

export function createMonitor(opts = {}) {
  const stream = opts.stream || process.stdout;
  const input = opts.input || process.stdin;
  const refreshMs = Number.isFinite(opts.refreshMs)
    ? Math.max(0, opts.refreshMs)
    : 1000;
  const deps = {
    pollAgents,
    fetchHubStatus,
    emitKeypressEvents: readline.emitKeypressEvents,
    importModule: (specifier) => import(specifier),
    setIntervalFn: setInterval,
    clearIntervalFn: clearInterval,
    spawn,
    ...opts._deps,
  };

  let timer = null;
  let started = false;
  let agents = [];
  let cursor = 0;
  let helpVisible = false;
  let hubStatus = { online: false };
  let statusMessage = "";

  const write = (chunk) => stream.write(String(chunk));

  function viewportWidth() {
    return Math.max(60, Number(stream?.columns) || FALLBACK_COLUMNS);
  }

  function syncCursor() {
    cursor = agents.length === 0 ? 0 : clamp(cursor, 0, agents.length - 1);
  }

  async function openSelectedAgent() {
    const agent = agents[cursor];
    if (!agent) {
      statusMessage = `${RED}선택된 에이전트가 없습니다.${RESET}`;
      return false;
    }

    const title = sanitizeTitle(
      `tfx ${agent.agent || agent.cli || agent.pid}`,
      "tfx-agent",
    );
    const command = buildOpenCommand(agent);

    try {
      if (process.platform === "win32") {
        try {
          const { createWtManager } = await deps.importModule(
            "../hub/team/wt-manager.mjs",
          );
          const manager = createWtManager();
          await manager.createTab({
            title,
            command,
            cwd: process.cwd(),
            profile: "triflux",
          });
        } catch (wtErr) {
          statusMessage = `${RED}WT 탭 열기 실패: ${stripUnsafeText(wtErr?.message || "unknown")}${RESET}`;
          return false;
        }
      } else {
        try {
          const { execSync } = await deps.importModule("node:child_process");
          execSync(`tmux new-window -n "${title}" "${command}"`, {
            timeout: 5000,
            stdio: "ignore",
          });
        } catch (tmuxErr) {
          statusMessage = `${RED}tmux 새 창 열기 실패: ${stripUnsafeText(tmuxErr?.message || "unknown")}${RESET}`;
          return false;
        }
      }
      statusMessage = `${GREEN}${stripUnsafeText(agent.agent || "agent")} 열기 시도 완료${RESET}`;
      return true;
    } catch (error) {
      statusMessage = `${RED}열기 실패: ${stripUnsafeText(error?.message || "unknown error")}${RESET}`;
      return false;
    }
  }

  async function renderFrame() {
    const [nextAgents, nextHubStatus] = await Promise.all([
      Promise.resolve(deps.pollAgents()),
      Promise.resolve(deps.fetchHubStatus(opts.hubUrl)),
    ]);

    agents = Array.isArray(nextAgents) ? nextAgents : [];
    hubStatus =
      nextHubStatus && typeof nextHubStatus === "object"
        ? nextHubStatus
        : { online: false };
    syncCursor();

    const width = viewportWidth();
    const maxElapsed = agents.reduce(
      (max, agent) => Math.max(max, Number(agent.elapsed) || 0),
      0,
    );
    const hubLabel = hubStatus.online
      ? `${GREEN}online${RESET}`
      : `${RED}offline${RESET}`;
    const header = `${BOLD}triflux monitor${RESET}  hub ${hubLabel}`;
    const summary = hubStatus.online
      ? `${DIM}queue ${hubStatus.queueDepth ?? "-"} · agents ${hubStatus.agents ?? agents.length}${RESET}`
      : `${DIM}허브 연결 없음${RESET}`;

    const lines = [pad(header, width), pad(summary, width), ""];

    if (agents.length === 0) {
      lines.push(`${DIM}에이전트 없음${RESET}`);
    } else {
      lines.push(`${BOLD}Agents${RESET}`);
      for (const [index, agent] of agents.entries()) {
        const selected = index === cursor;
        const marker = selected ? `${GREEN}▶${RESET}` : " ";
        const cli = stripUnsafeText(agent.cli || "unknown");
        const name = stripUnsafeText(agent.agent || `pid:${agent.pid || "?"}`);
        const elapsed = formatElapsed(agent.elapsed);
        const alive = agent.alive
          ? `${GREEN}alive${RESET}`
          : `${RED}dead${RESET}`;
        const left = `${marker} ${colorCli(cli)}${cli}${RESET} ${BOLD}${name}${RESET} ${GRAY}${elapsed}${RESET}`;
        if (hubStatus.online) {
          lines.push(
            `${left} ${BLUE}${progressBar(resolveRatio(agent, maxElapsed))}${RESET}`,
          );
        } else {
          lines.push(`${left} ${alive}`);
        }
      }
    }

    if (helpVisible) {
      lines.push("", `${BOLD}Help${RESET}`);
      lines.push("  j / ↓ : 아래 이동");
      lines.push("  k / ↑ : 위로 이동");
      lines.push("  Enter : 선택 에이전트 열기");
      lines.push("  r : 즉시 새로고침");
      lines.push("  h : 도움말 토글");
      lines.push("  q / Ctrl+C : 종료");
    }

    if (statusMessage) lines.push("", statusMessage);
    lines.push(
      "",
      `${DIM}[Enter] open [j/k] select [r] refresh [h] help [q] quit${RESET}`,
    );

    write("\x1b[H");
    write(lines.join("\n"));
    write("\x1b[J");
    return { agents, hubStatus };
  }

  async function handleKey(str, key = {}) {
    const name = key?.name || "";
    if (str === "j" || name === "down") {
      syncCursor();
      cursor =
        agents.length === 0 ? 0 : Math.min(cursor + 1, agents.length - 1);
      await renderFrame();
      return;
    }
    if (str === "k" || name === "up") {
      syncCursor();
      cursor = agents.length === 0 ? 0 : Math.max(cursor - 1, 0);
      await renderFrame();
      return;
    }
    if (name === "return" || name === "enter") {
      await openSelectedAgent();
      await renderFrame();
      return;
    }
    if (str === "r") {
      await renderFrame();
      return;
    }
    if (str === "h") {
      helpVisible = !helpVisible;
      await renderFrame();
      return;
    }
    if (str === "q" || (key?.ctrl && name === "c")) {
      stop();
    }
  }

  async function start() {
    if (started) return;
    started = true;
    write("\x1b[?1049h");
    write("\x1b[?25l");
    if (typeof input?.setRawMode === "function") input.setRawMode(true);
    deps.emitKeypressEvents(input);
    if (typeof input?.resume === "function") input.resume();
    input?.on?.("keypress", handleKey);
    if (refreshMs > 0) {
      timer = deps.setIntervalFn(() => {
        void renderFrame();
      }, refreshMs);
      timer?.unref?.();
    }
    await renderFrame();
  }

  function stop() {
    if (!started) return;
    started = false;
    if (timer) {
      deps.clearIntervalFn(timer);
      timer = null;
    }
    input?.removeListener?.("keypress", handleKey);
    if (typeof input?.setRawMode === "function") input.setRawMode(false);
    write("\x1b[?25h");
    write("\x1b[?1049l");
  }

  function destroy() {
    stop();
  }

  return {
    start,
    stop,
    destroy,
    renderFrame,
    handleKey,
    openSelectedAgent,
    getState() {
      return {
        cursor,
        helpVisible,
        hubStatus: { ...hubStatus },
        agents: agents.map((agent) => ({ ...agent })),
        started,
        statusMessage,
      };
    },
  };
}
