#!/usr/bin/env node
// hub/team/dashboard.mjs — 실시간 팀 상태 표시 (v2.2)
// tmux 의존 제거 — Hub task-list + native-supervisor 기반
//
// 실행:
//   node hub/team/dashboard.mjs --session <세션이름> [--interval 2]
//   node hub/team/dashboard.mjs --team <팀이름> [--interval 2]
import { get } from "node:http";
import { AMBER, GREEN, RED, GRAY, DIM, BOLD, RESET } from "./shared.mjs";

/**
 * HTTP GET JSON
 * @param {string} url
 * @returns {Promise<object|null>}
 */
function fetchJson(url) {
  return new Promise((resolve) => {
    const req = get(url, { timeout: 2000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

/**
 * HTTP POST JSON (Hub bridge 용)
 * @param {string} url
 * @param {object} body
 * @returns {Promise<object|null>}
 */
async function fetchPost(url, body = {}) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
    return await res.json();
  } catch {
    return null;
  }
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
 * task 상태 아이콘
 * @param {string} status
 * @returns {string}
 */
function statusIcon(status) {
  switch (status) {
    case "completed": return `${GREEN}✓${RESET}`;
    case "in_progress": return `${AMBER}●${RESET}`;
    case "failed": return `${RED}✗${RESET}`;
    default: return `${GRAY}○${RESET}`;
  }
}

/**
 * 멤버 목록 구성: Hub tasks + supervisor + teamState 통합
 * @param {Array} hubTasks — Hub bridge task-list 결과
 * @param {Array} supervisorMembers — native-supervisor 멤버 상태
 * @param {object} teamState — team-state.json 내용
 * @returns {Array<{name: string, cli: string, status: string, subject: string, preview: string}>}
 */
function buildMemberList(hubTasks, supervisorMembers, teamState) {
  const members = [];
  const supervisorByName = new Map(supervisorMembers.map((m) => [m.name, m]));

  // Hub tasks가 있으면 주 데이터 소스
  if (hubTasks.length > 0) {
    for (const task of hubTasks) {
      const owner = task.owner || task.subject || "";
      const sup = supervisorByName.get(owner);
      members.push({
        name: owner,
        cli: task.metadata?.cli || sup?.cli || "",
        status: task.status || "pending",
        subject: task.subject || "",
        preview: sup?.lastPreview || task.description?.slice(0, 80) || "",
      });
    }
    return members;
  }

  // Supervisor 데이터 폴백
  if (supervisorMembers.length > 0) {
    for (const m of supervisorMembers) {
      if (m.role === "lead") continue;
      members.push({
        name: m.name,
        cli: m.cli || "",
        status: m.status === "running" ? "in_progress" : m.status === "exited" ? "completed" : m.status,
        subject: "",
        preview: m.lastPreview || "",
      });
    }
    return members;
  }

  // teamState 폴백 (하위 호환)
  const panes = teamState?.panes || {};
  for (const [, paneInfo] of Object.entries(panes).filter(([, v]) => v.role !== "dashboard" && v.role !== "lead")) {
    members.push({
      name: paneInfo.agentId || paneInfo.name || "?",
      cli: paneInfo.cli || "",
      status: "unknown",
      subject: paneInfo.subtask || "",
      preview: "",
    });
  }
  return members;
}

/**
 * 대시보드 렌더링 (v2.2: Hub/supervisor 기반)
 * @param {string} sessionName — 세션 또는 팀 이름
 * @param {object} opts
 * @param {string} opts.hubUrl — Hub URL (기본 http://127.0.0.1:27888)
 * @param {string} [opts.teamName] — Hub task-list 조회용 팀 이름
 * @param {string} [opts.supervisorUrl] — native-supervisor 제어 URL
 * @param {object} [opts.teamState] — team-state.json 내용 (하위 호환)
 */
export async function renderDashboard(sessionName, opts = {}) {
  const {
    hubUrl = "http://127.0.0.1:27888",
    teamName,
    supervisorUrl,
    teamState = {},
  } = opts;
  const W = 50;
  const border = "─".repeat(W);

  // 데이터 수집 (병렬)
  const [hubStatus, taskListRes, supervisorRes] = await Promise.all([
    fetchJson(`${hubUrl}/status`),
    teamName ? fetchPost(`${hubUrl}/bridge/team/task-list`, { team_name: teamName }) : null,
    supervisorUrl ? fetchJson(`${supervisorUrl}/status`) : null,
  ]);

  const hubOnline = !!hubStatus;
  const hubState = hubOnline ? `${GREEN}● online${RESET}` : `${RED}● offline${RESET}`;
  const uptime = hubStatus?.hub?.uptime ? formatUptime(hubStatus.hub.uptime) : "-";
  const queueSize = hubStatus?.hub?.queue_depth ?? 0;

  // Hub task 데이터
  const hubTasks = taskListRes?.ok ? (taskListRes.data?.tasks || []) : [];
  const completedCount = hubTasks.filter((t) => t.status === "completed").length;
  const totalCount = hubTasks.length;

  // Supervisor 멤버 데이터
  const supervisorMembers = supervisorRes?.ok ? (supervisorRes.data?.members || []) : [];

  // 헤더
  const progress = totalCount > 0 ? ` ${completedCount}/${totalCount}` : "";
  console.log(`${AMBER}┌─ ${sessionName}${progress} ${GRAY}${"─".repeat(Math.max(0, W - sessionName.length - progress.length - 3))}${AMBER}┐${RESET}`);
  console.log(`${AMBER}│${RESET} Hub: ${hubState}  Uptime: ${DIM}${uptime}${RESET}  Queue: ${DIM}${queueSize}${RESET}`);
  console.log(`${AMBER}│${RESET}`);

  // 멤버/워커 렌더링
  const members = buildMemberList(hubTasks, supervisorMembers, teamState);

  if (members.length === 0) {
    console.log(`${AMBER}│${RESET}  ${DIM}에이전트 정보 없음${RESET}`);
  } else {
    for (const m of members) {
      const icon = statusIcon(m.status);
      const label = `[${m.name}]`;
      const cliTag = m.cli ? m.cli.charAt(0).toUpperCase() + m.cli.slice(1) : "";

      // 진행률 추정
      const pct = m.status === "completed" ? 100
        : m.status === "in_progress" ? 50
        : m.status === "failed" ? 100
        : 0;

      console.log(`${AMBER}│${RESET}  ${BOLD}${label}${RESET} ${cliTag}  ${icon} ${m.status || "pending"}  ${progressBar(pct)}`);

      // 미리보기: supervisor lastPreview > task subject
      const preview = m.preview || m.subject || "";
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

/** team-state.json 로드 (세션별 파일 우선, fallback: team-state.json) */
async function loadTeamState() {
  try {
    const { existsSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const hubDir = join(homedir(), ".claude", "cache", "tfx-hub");
    const sessionId = process.env.CLAUDE_SESSION_ID;
    if (sessionId) {
      const sessionPath = join(hubDir, `team-state-${sessionId}.json`);
      if (existsSync(sessionPath)) return JSON.parse(readFileSync(sessionPath, "utf8"));
    }
    const legacyPath = join(hubDir, "team-state.json");
    if (existsSync(legacyPath)) return JSON.parse(readFileSync(legacyPath, "utf8"));
    return {};
  } catch {
    return {};
  }
}

// ── CLI 실행 ──
if (process.argv[1]?.includes("dashboard.mjs")) {
  const sessionIdx = process.argv.indexOf("--session");
  const teamIdx = process.argv.indexOf("--team");
  const sessionName = sessionIdx !== -1 ? process.argv[sessionIdx + 1] : null;
  const teamName = teamIdx !== -1 ? process.argv[teamIdx + 1] : null;
  const intervalSec = parseInt(process.argv[process.argv.indexOf("--interval") + 1] || "2", 10);

  const displayName = sessionName || teamName;
  if (!displayName) {
    console.error("사용법: node dashboard.mjs --session <세션이름> [--team <팀이름>] [--interval 2]");
    process.exit(1);
  }

  // Ctrl+C로 종료
  process.on("SIGINT", () => process.exit(0));

  // 갱신 루프
  while (true) {
    const teamState = await loadTeamState();
    const effectiveTeamName = teamName || null;
    const supervisorUrl = teamState?.native?.controlUrl || null;

    // 화면 클리어 (ANSI)
    process.stdout.write("\x1b[2J\x1b[H");
    await renderDashboard(displayName, {
      teamName: effectiveTeamName,
      supervisorUrl,
      teamState,
    });
    console.log(`${DIM}  ${intervalSec}초 간격 갱신 | Ctrl+C로 종료${RESET}`);
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}
