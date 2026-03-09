#!/usr/bin/env node
// hub/team/dashboard.mjs — 실시간 팀 상태 표시
// 실행: watch -n 1 -c 'node hub/team/dashboard.mjs --session tfx-team-xxx'
// 또는: node hub/team/dashboard.mjs --session tfx-team-xxx (단일 출력)
import { get } from "node:http";
import { capturePaneOutput } from "./session.mjs";

// ── 색상 ──
const AMBER = "\x1b[38;5;214m";
const GREEN = "\x1b[38;5;82m";
const RED = "\x1b[38;5;196m";
const GRAY = "\x1b[38;5;245m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/**
 * Hub /status 엔드포인트 조회
 * @param {string} hubUrl — 예: http://127.0.0.1:27888
 * @returns {Promise<object|null>}
 */
function fetchStatus(hubUrl) {
  return new Promise((resolve) => {
    const url = `${hubUrl}/status`;
    const req = get(url, { timeout: 2000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * 진행률 바 생성
 * @param {number} pct — 0~100
 * @param {number} width — 바 너비 (기본 8)
 * @returns {string}
 */
function progressBar(pct, width = 8) {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return `${GREEN}${"█".repeat(filled)}${GRAY}${"░".repeat(empty)}${RESET}`;
}

/**
 * 업타임 포맷
 * @param {number} ms
 * @returns {string}
 */
function formatUptime(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)}초`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}분`;
  return `${Math.round(ms / 3600000)}시간`;
}

/**
 * 대시보드 렌더링
 * @param {string} sessionName — tmux 세션 이름
 * @param {object} opts
 * @param {string} opts.hubUrl — Hub URL (기본 http://127.0.0.1:27888)
 * @param {object} opts.teamState — team-state.json 내용
 */
export async function renderDashboard(sessionName, opts = {}) {
  const { hubUrl = "http://127.0.0.1:27888", teamState = {} } = opts;
  const W = 50;
  const border = "─".repeat(W);

  // Hub 상태 조회
  const status = await fetchStatus(hubUrl);
  const hubOnline = !!status;
  const hubState = hubOnline ? `${GREEN}● online${RESET}` : `${RED}● offline${RESET}`;
  const uptime = status?.hub?.uptime ? formatUptime(status.hub.uptime) : "-";
  const queueSize = status?.hub?.queue_depth ?? 0;

  // 헤더
  console.log(`${AMBER}┌─ ${sessionName} ${GRAY}${"─".repeat(Math.max(0, W - sessionName.length - 3))}${AMBER}┐${RESET}`);
  console.log(`${AMBER}│${RESET} Hub: ${hubState}  Uptime: ${DIM}${uptime}${RESET}  Queue: ${DIM}${queueSize}${RESET}`);
  console.log(`${AMBER}│${RESET}`);

  // 에이전트 상태
  const panes = teamState?.panes || {};
  const paneEntries = Object.entries(panes).filter(([, v]) => v.role !== "dashboard");

  if (paneEntries.length === 0) {
    console.log(`${AMBER}│${RESET}  ${DIM}에이전트 정보 없음${RESET}`);
  } else {
    for (const [paneTarget, paneInfo] of paneEntries) {
      const { cli = "?", agentId = "?", subtask = "" } = paneInfo;
      const label = `[${agentId}]`;
      const cliTag = cli.charAt(0).toUpperCase() + cli.slice(1);

      // Hub에서 에이전트 상태 확인
      const agentStatus = status?.agents?.find?.((a) => a.agent_id === agentId);
      const online = agentStatus ? `${GREEN}● online${RESET}` : `${GRAY}○ -${RESET}`;

      // 진행률 추정 (메시지 기반, 단순 휴리스틱)
      const msgCount = agentStatus?.message_count ?? 0;
      const pct = msgCount === 0 ? 0 : Math.min(100, msgCount * 25);

      console.log(`${AMBER}│${RESET}  ${BOLD}${label}${RESET} ${cliTag}  ${online}  ${progressBar(pct)} ${DIM}${pct}%${RESET}`);

      // pane 미리보기 (마지막 2줄)
      const preview = capturePaneOutput(paneTarget, 2)
        .split("\n")
        .filter(Boolean)
        .slice(-1)[0] || "";
      if (preview) {
        const truncated = preview.length > W - 8 ? preview.slice(0, W - 11) + "..." : preview;
        console.log(`${AMBER}│${RESET}    ${DIM}> ${truncated}${RESET}`);
      }
      console.log(`${AMBER}│${RESET}`);
    }
  }

  // 푸터
  console.log(`${AMBER}└${GRAY}${border}${AMBER}┘${RESET}`);
}

/** team-state.json 로드 */
async function loadTeamState() {
  try {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const statePath = join(homedir(), ".claude", "cache", "tfx-hub", "team-state.json");
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
}

// ── CLI 실행 (자체 갱신 루프 — watch 불필요) ──
if (process.argv[1]?.includes("dashboard.mjs")) {
  const sessionIdx = process.argv.indexOf("--session");
  const sessionName = sessionIdx !== -1 ? process.argv[sessionIdx + 1] : null;
  const intervalSec = parseInt(process.argv[process.argv.indexOf("--interval") + 1] || "2", 10);

  if (!sessionName) {
    console.error("사용법: node dashboard.mjs --session <세션이름> [--interval 2]");
    process.exit(1);
  }

  // Ctrl+C로 종료
  process.on("SIGINT", () => process.exit(0));

  // 갱신 루프
  while (true) {
    const teamState = await loadTeamState();
    // 화면 클리어 (ANSI)
    process.stdout.write("\x1b[2J\x1b[H");
    await renderDashboard(sessionName, { teamState });
    console.log(`${DIM}  ${intervalSec}초 간격 갱신 | Ctrl+C로 종료${RESET}`);
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}
