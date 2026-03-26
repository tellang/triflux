// hub/team/headless.mjs — 헤드리스 CLI 오케스트레이션
// psmux pane에서 CLI를 헤드리스 모드로 실행하고 결과를 수집한다.
// v5.2.0: 기본 headless 엔진 (runHeadless, runHeadlessWithCleanup)
// v6.0.0: Lead-direct 모드 (runHeadlessInteractive, autoAttachTerminal)
// 의존성: psmux.mjs (Node.js 내장 모듈만 사용)
import { join } from "node:path";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createPsmuxSession,
  killPsmuxSession,
  psmuxSessionExists,
  dispatchCommand,
  waitForCompletion,
  capturePsmuxPane,
  startCapture,
  psmuxExec,
} from "./psmux.mjs";
import { HANDOFF_INSTRUCTION, processHandoff } from "./handoff.mjs";

const RESULT_DIR = join(tmpdir(), "tfx-headless");

/** CLI별 브랜드 — 이모지 + 공식 색상 (HUD와 통일) */
const CLI_BRAND = {
  codex:  { emoji: "\u{26AA}", label: "Codex",  ansi: "\x1b[97m" },   // ⚪ bright white (codexWhite)
  gemini: { emoji: "\u{1F535}", label: "Gemini", ansi: "\x1b[38;5;39m" }, // 🔵 geminiBlue
  claude: { emoji: "\u{1F7E0}", label: "Claude", ansi: "\x1b[38;2;232;112;64m" }, // 🟠 claudeOrange
};
const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[2m";

/** 에이전트 역할명 → CLI 타입 매핑 (route_agent() 미러) */
const AGENT_TO_CLI = {
  executor: "codex", "build-fixer": "codex", debugger: "codex", "deep-executor": "codex",
  architect: "codex", planner: "codex", critic: "codex", analyst: "codex",
  "code-reviewer": "codex", "security-reviewer": "codex", "quality-reviewer": "codex",
  scientist: "codex", "scientist-deep": "codex", "document-specialist": "codex",
  spark: "codex",
  designer: "gemini", writer: "gemini",
  explore: "claude", verifier: "claude", "test-engineer": "claude", "qa-tester": "claude",
  codex: "codex", gemini: "gemini", claude: "claude",
};

/**
 * 에이전트 역할명 또는 CLI 이름을 CLI 타입("codex"|"gemini"|"claude")으로 해석한다.
 * route_agent()가 적용되지 않는 headless 경로에서 사용.
 * @param {string} agentOrCli — "executor", "codex", "designer" 등
 * @returns {'codex'|'gemini'|'claude'} CLI 타입
 */
export function resolveCliType(agentOrCli) {
  return AGENT_TO_CLI[agentOrCli] || agentOrCli;
}

/** MCP 프로필별 프롬프트 힌트 (tfx-route.sh resolve_mcp_policy의 경량 미러) */
const MCP_PROFILE_HINTS = {
  implement: "You have full filesystem read/write access. Implement changes directly.",
  analyze:   "Focus on reading and analyzing the codebase. Prefer analysis over modification.",
  review:    "Review the code for quality, security, and correctness.",
  docs:      "Focus on documentation and explanation tasks.",
};

/**
 * CLI별 헤드리스 명령 빌더
 * @param {'codex'|'gemini'|'claude'} cli
 * @param {string} prompt — 실행할 프롬프트
 * @param {string} resultFile — 결과 저장 파일 경로
 * @param {object} [opts]
 * @param {boolean} [opts.handoff=true]
 * @param {string} [opts.mcp] — MCP 프로필 ("implement"|"analyze"|"review"|"docs")
 * @returns {string} PowerShell 명령
 */
export function buildHeadlessCommand(cli, prompt, resultFile, opts = {}) {
  const { handoff = true, mcp } = opts;
  const resolvedCli = resolveCliType(cli);
  const mcpHint = mcp && MCP_PROFILE_HINTS[mcp] ? ` [MCP: ${mcp}] ${MCP_PROFILE_HINTS[mcp]}` : "";
  // HANDOFF 지시는 프롬프트에 삽입하지 않음 — headless 후처리(processHandoff)에서 처리
  // psmux send-keys 줄바꿈 문제 + codex exec "---" 인자 충돌 방지
  const fullPrompt = `${prompt}${mcpHint}`;

  // 보안: 프롬프트를 임시 파일에 쓰고 파일 참조로 전달 (셸 주입 방지)
  if (!existsSync(RESULT_DIR)) mkdirSync(RESULT_DIR, { recursive: true });
  const promptFile = join(RESULT_DIR, "prompt-" + randomUUID().slice(0, 8) + ".txt").replace(/\\/g, "/");
  writeFileSync(promptFile, fullPrompt, "utf8");

  const cls = "Clear-Host; ";

  switch (resolvedCli) {
    case "codex":
      return `${cls}codex exec (Get-Content -Raw '${promptFile}') -o '${resultFile}' --color never`;
    case "gemini":
      return `${cls}gemini -p (Get-Content -Raw '${promptFile}') -o text > '${resultFile}' 2>'${resultFile}.err'`;
    case "claude":
      return `${cls}claude -p (Get-Content -Raw '${promptFile}') --output-format text > '${resultFile}' 2>&1`;
    default:
      throw new Error(`지원하지 않는 CLI: ${resolvedCli} (원본: ${cli})`);
  }
}

/**
 * 결과 파일 읽기 (없으면 capture-pane fallback)
 * @param {string} resultFile
 * @param {string} paneId
 * @returns {string}
 */
function readResult(resultFile, paneId) {
  if (existsSync(resultFile)) {
    return readFileSync(resultFile, "utf8").trim();
  }
  // fallback: capture-pane (paneId = "tfx:0.1" 형태)
  return capturePsmuxPane(paneId, 30);
}

/**
 * 헤드리스 CLI 오케스트레이션 실행
 *
 * @param {string} sessionName — psmux 세션 이름
 * @param {Array<{cli: string, prompt: string, role?: string}>} assignments
 * @param {object} [opts]
 * @param {number} [opts.timeoutSec=300] — 각 워커 타임아웃
 * @param {string} [opts.layout='2x2'] — pane 레이아웃
 * @param {(event: object) => void} [opts.onProgress] — 진행 콜백
 * @param {number} [opts.progressIntervalSec=0] — N초마다 progress 이벤트 발화 (0=비활성)
 * @param {boolean} [opts.progressive=true] — true면 pane을 하나씩 split-window로 추가 (실시간 스플릿)
 * @returns {{ sessionName: string, results: Array<{cli: string, paneName: string, matched: boolean, exitCode: number|null, output: string, sessionDead?: boolean}> }}
 */
export async function runHeadless(sessionName, assignments, opts = {}) {
  const {
    timeoutSec = 300,
    layout = "2x2",
    onProgress,
    progressIntervalSec = 0,
    progressive = true,
    dashboard = false,
  } = opts;

  mkdirSync(RESULT_DIR, { recursive: true });

  // onProgress 예외를 삼켜 실행 흐름 보호 (onPoll과 동일 패턴)
  const safeProgress = onProgress
    ? (event) => { try { onProgress(event); } catch { /* 콜백 예외 삼킴 */ } }
    : null;

  let dispatches;

  if (progressive) {
    // ─── 실시간 스플릿 모드: lead pane만 생성 후, 워커를 하나씩 추가 ───
    const session = createPsmuxSession(sessionName, { layout, paneCount: 1 });
    applyTrifluxTheme(sessionName);
    if (safeProgress) safeProgress({ type: "session_created", sessionName, panes: session.panes });

    // dashboard: 워커 pane을 먼저 생성한 후 pane 0에 대시보드를 실행
    // (listPanes로 워커 감지가 가능하려면 워커 pane이 먼저 존재해야 함)

    dispatches = assignments.map((assignment, i) => {
      const paneName = `worker-${i + 1}`;
      const resolvedCli = resolveCliType(assignment.cli);
      const brand = CLI_BRAND[resolvedCli] || { emoji: "\u{25CF}", label: resolvedCli, ansi: "" };
      const paneTitle = assignment.role
        ? `${brand.emoji} ${resolvedCli} (${assignment.role})`
        : `${brand.emoji} ${resolvedCli}-${i + 1}`;

      let newPaneId;
      if (i === 0) {
        // 첫 번째 워커: 빈 lead pane 사용
        newPaneId = `${sessionName}:0.0`;
      } else {
        // 2번째+: split-window로 추가
        newPaneId = psmuxExec([
          "split-window", "-t", sessionName, "-P", "-F",
          "#{session_name}:#{window_index}.#{pane_index}",
        ]);
      }

      // 타이틀 설정 (이모지 포함)
      try { psmuxExec(["select-pane", "-t", newPaneId, "-T", paneTitle]); } catch { /* 무시 */ }

      if (safeProgress) safeProgress({ type: "worker_added", paneName, cli: assignment.cli, paneTitle });

      // 캡처 시작 + 컬러 배너 + 명령 dispatch
      const resultFile = join(RESULT_DIR, `${sessionName}-${paneName}.txt`).replace(/\\/g, "/");
      const cmd = buildHeadlessCommand(assignment.cli, assignment.prompt, resultFile, { mcp: assignment.mcp });
      startCapture(sessionName, newPaneId);
      // pane 간 pipe-pane EBUSY 방지 — capture 스크립트 파일 잠금 해제 대기
      if (i > 0) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); } catch {} }
      const dispatch = dispatchCommand(sessionName, newPaneId, cmd);

      if (safeProgress) safeProgress({ type: "dispatched", paneName, cli: assignment.cli });

      return { ...dispatch, paneId: newPaneId, paneName, resultFile, cli: assignment.cli, role: assignment.role };
    });

    // 모든 split 완료 후 레이아웃 한 번만 정렬 (깜빡임 방지)
    try { psmuxExec(["select-layout", "-t", sessionName, "tiled"]); } catch { /* 무시 */ }

    // v7.1.3: psmux 내부 대시보드 pane 제거 — WT 스플릿에서 tui-viewer 직접 실행

  } else {
    // ─── 기존 모드: 모든 pane을 한 번에 생성 ───
    const paneCount = assignments.length + 1;
    // A2b fix: 2x2 레이아웃은 최대 4 pane — 초과 시 tiled로 자동 전환
    const effectiveLayout = (layout === "2x2" && paneCount > 4) ? "tiled" : layout;
    const session = createPsmuxSession(sessionName, { layout: effectiveLayout, paneCount });
    applyTrifluxTheme(sessionName);
    if (safeProgress) safeProgress({ type: "session_created", sessionName, panes: session.panes });

    dispatches = assignments.map((assignment, i) => {
      const paneName = `worker-${i + 1}`;
      const resultFile = join(RESULT_DIR, `${sessionName}-${paneName}.txt`).replace(/\\/g, "/");
      const cmd = buildHeadlessCommand(assignment.cli, assignment.prompt, resultFile, { mcp: assignment.mcp });
      const scriptDir = join(RESULT_DIR, sessionName);
      const dispatch = dispatchCommand(sessionName, paneName, cmd, { scriptDir, scriptName: paneName });

      // P1 fix: 비-progressive에서는 pane 리네임 금지 — 캡처 로그 경로가 타이틀 기반이므로
      // 리네임하면 waitForCompletion이 "codex (role).log"를 찾지만 실제는 "worker-N.log"로 불일치
      // progressive 모드에서는 split-window 시 새 pane에 바로 타이틀이 설정되므로 문제없음

      if (safeProgress) safeProgress({ type: "dispatched", paneName, cli: assignment.cli });

      return { ...dispatch, paneName, resultFile, cli: assignment.cli, role: assignment.role };
    });
  }

  // 병렬 대기 (Promise.all — 모든 pane 동시 폴링, 총 시간 = max(개별 시간))
  const results = await Promise.all(dispatches.map(async (d) => {
    // onPoll → onProgress 변환 (throttle by progressIntervalSec)
    const pollOpts = {};
    if (safeProgress && progressIntervalSec > 0) {
      let lastProgressAt = 0;
      const intervalMs = progressIntervalSec * 1000;
      pollOpts.onPoll = ({ content }) => {
        const now = Date.now();
        if (now - lastProgressAt >= intervalMs) {
          lastProgressAt = now;
          safeProgress({
            type: "progress",
            paneName: d.paneName,
            cli: d.cli,
            snapshot: content.split("\n").slice(-15).join("\n"), // 마지막 15줄
          });
        }
      };
    }

    // dispatch 시 확정된 logPath를 전달 — 셸이 pane 타이틀 변경해도 캡처 로그 매칭 유지
    if (d.logPath) pollOpts.logPath = d.logPath;
    const completion = await waitForCompletion(sessionName, d.paneId || d.paneName, d.token, timeoutSec, pollOpts);

    const output = completion.matched
      ? readResult(d.resultFile, d.paneId)
      : "";

    if (safeProgress) {
      safeProgress({
        type: "completed",
        paneName: d.paneName,
        cli: d.cli,
        matched: completion.matched,
        exitCode: completion.exitCode,
        sessionDead: completion.sessionDead || false,
      });
    }

    return { d, completion, output };
  }));

  // B3 fix: git diff를 루프 밖에서 1회만 실행 (워커 수만큼 중복 방지)
  let gitDiffFiles;
  try {
    const diffOut = execSync("git diff --name-only HEAD", { encoding: "utf8", timeout: 5000 });
    gitDiffFiles = diffOut.trim().split("\n").filter(Boolean);
  } catch { /* git 미설치 또는 non-repo — 무시 */ }

  // handoff 파이프라인: parse → validate → format (각 워커 결과에 적용)
  const finalResults = results.map(({ d, completion, output }) => {
    const handoffResult = processHandoff(output, {
      exitCode: completion.exitCode,
      resultFile: d.resultFile,
      cli: d.cli,
      gitDiffFiles,
    });

    return {
      cli: d.cli,
      paneName: d.paneName,
      paneId: d.paneId,
      role: d.role,
      matched: completion.matched,
      exitCode: completion.exitCode,
      output,
      resultFile: d.resultFile,
      sessionDead: completion.sessionDead || false,
      handoff: handoffResult.handoff,
      handoffFormatted: handoffResult.formatted,
      handoffValid: handoffResult.valid,
      handoffFallback: handoffResult.fallback,
    };
  });

  return { sessionName, results: finalResults };
}

/**
 * 헤드리스 실행 + 자동 정리
 * 성공/실패에 관계없이 세션을 정리한다.
 *
 * @param {Array<{cli: string, prompt: string, role?: string}>} assignments
 * @param {object} [opts] — runHeadless opts + sessionPrefix
 * @returns {{ results: Array, sessionName: string }}
 */
export async function runHeadlessWithCleanup(assignments, opts = {}) {
  const { sessionPrefix = "tfx-hl", ...runOpts } = opts;
  const sessionName = `${sessionPrefix}-${Date.now().toString(36).slice(-6)}`;

  try {
    return await runHeadless(sessionName, assignments, runOpts);
  } finally {
    try { killPsmuxSession(sessionName); } catch { /* 무시 */ }
    // WT split pane은 psmux 종료 시 셸이 끝나면서 자동으로 닫힘
    // 수동 close-pane 불필요 (레이스 컨디션으로 WT 에러 발생)
  }
}

// ─── v6.0.0: Theme + Visual ───

/**
 * psmux 세션에 triflux 테마를 적용한다.
 * status bar + pane border 색상 + 브랜딩.
 *
 * @param {string} sessionName
 */
export function applyTrifluxTheme(sessionName) {
  const opts = [
    // Status bar — Catppuccin Mocha 기반
    ["status-style", "bg=#1e1e2e,fg=#cdd6f4"],
    ["status-left", " #[fg=#89b4fa,bold]▲ triflux#[default] "],
    ["status-left-length", "20"],
    ["status-right", " #[fg=#a6adc8]#{pane_title}#[default] │ #[fg=#f9e2af]%H:%M#[default] "],
    ["status-right-length", "40"],
    // Pane border — active/inactive 구분
    ["pane-active-border-style", "fg=#89b4fa"],
    ["pane-border-style", "fg=#45475a"],
    // Status bar 위치
    ["status-position", "bottom"],
    // 셸이 pane 타이틀을 변경하는 것 방지 (캡처 로그 경로 안정성)
    ["allow-rename", "off"],
  ];
  for (const [key, value] of opts) {
    try { psmuxExec(["set-option", "-t", sessionName, key, value]); } catch { /* 무시 */ }
  }
}

/**
 * Windows Terminal에 triflux 프로필을 자동 생성/갱신한다.
 * 반투명 + 비포커스 시 더 투명 + Catppuccin 테마.
 * @returns {boolean} 성공 여부
 */

/**
 * WT 기본 프로필의 폰트 크기를 읽는다.
 * @returns {number} 기본 폰트 크기 (못 읽으면 12)
 */
function getWtDefaultFontSize() {
  const settingsPaths = [
    join(process.env.LOCALAPPDATA || "", "Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json"),
    join(process.env.LOCALAPPDATA || "", "Microsoft/Windows Terminal/settings.json"),
  ];
  for (const p of settingsPaths) {
    if (!existsSync(p)) continue;
    try {
      const settings = JSON.parse(readFileSync(p, "utf8").replace(/^\s*\/\/.*$/gm, ""));
      // 기본 프로필 or 첫 프로필의 폰트
      const defaultGuid = settings.defaultProfile;
      const profiles = settings.profiles?.list || [];
      const defaultProfile = profiles.find(pr => pr.guid === defaultGuid) || profiles[0];
      return defaultProfile?.font?.size || settings.profiles?.defaults?.font?.size || 12;
    } catch { /* 다음 */ }
  }
  return 12;
}

/**
 * 파일을 원자적으로 쓴다 — 임시 파일에 먼저 기록 후 rename으로 교체.
 * 프로세스가 쓰기 도중 충돌해도 원본 파일이 손상되지 않는다.
 * @param {string} filePath — 대상 파일 경로
 * @param {string} data — 쓸 내용
 */
function atomicWriteSync(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmpPath, data, "utf8");
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { writeFileSync(tmpPath.replace(/\.tmp$/, ".tmp.del"), ""); } catch { /* 무시 */ }
    throw err;
  }
}

export function ensureWtProfile(workerCount = 2) {
  const settingsPaths = [
    join(process.env.LOCALAPPDATA || "", "Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json"),
    join(process.env.LOCALAPPDATA || "", "Microsoft/Windows Terminal/settings.json"),
  ];

  for (const settingsPath of settingsPaths) {
    if (!existsSync(settingsPath)) continue;
    try {
      const raw = readFileSync(settingsPath, "utf8");
      // JSON with comments — 간단한 strip (// 주석만)
      const cleaned = raw.replace(/^\s*\/\/.*$/gm, "");
      const settings = JSON.parse(cleaned);
      if (!settings.profiles?.list) continue;

      const existing = settings.profiles.list.findIndex(p => p.name === "triflux");
      const profile = {
        name: "triflux",
        commandline: "psmux",
        icon: "\u{1F53A}", // 🔺
        tabTitle: "triflux",
        suppressApplicationTitle: true,
        opacity: 40,
        useAcrylic: true,
        unfocusedAppearance: { opacity: 20 },
        colorScheme: "One Half Dark",
        font: { size: Math.max(6, getWtDefaultFontSize() - 1 - Math.floor(workerCount / 2)) },
        hidden: true, // 프로필 목록에는 숨김 (triflux에서만 사용)
      };

      if (existing >= 0) {
        settings.profiles.list[existing] = { ...settings.profiles.list[existing], ...profile };
      } else {
        settings.profiles.list.push(profile);
      }

      atomicWriteSync(settingsPath, JSON.stringify(settings, null, 2));
      return true;
    } catch { /* 파싱 실패 — 다음 경로 */ }
  }
  return false;
}

// ─── v6.0.0: Lead-Direct Interactive Mode ───

/**
 * Windows Terminal에서 psmux 세션을 자동 attach한다.
 * 별도 창이 열리며 사용자가 실시간으로 CLI 출력을 볼 수 있다.
 *
 * @param {string} sessionName — attach할 psmux 세션 이름
 * @param {object} [opts]
 * @param {string} [opts.position] — "right" | "left" | 없으면 기본 위치
 * @returns {boolean} 성공 여부
 */
export function autoAttachTerminal(sessionName, opts = {}, workerCount = 2) {
  // 보안: sessionName 셸 주입 방지 — 영숫자, 하이픈, 언더스코어만 허용
  const safeName = String(sessionName).replace(/[^a-zA-Z0-9_\-]/g, "");
  sessionName = safeName || "tfx-session";
  try {
    execSync("where wt.exe", { stdio: "ignore" });
  } catch {
    return false;
  }

  ensureWtProfile(workerCount);

  const mode = opts.mode || "auto";

  if (mode === "split" && process.env.WT_SESSION) {
    // inner split — 같은 WT 창에서 가로 분할. psmux를 직접 실행 (pwsh 불필요).
    try {
      const child = spawn("wt.exe", [
        "-w", "0", "sp", "-H", "-s", "0.50",
        "--profile", "triflux", "--title", "triflux",
        "--", "psmux", "attach", "-t", sessionName,
      ], { detached: true, stdio: "ignore" });
      child.unref();
      try { spawn("wt.exe", ["-w", "0", "mf", "up"], { detached: true, stdio: "ignore" }).unref(); } catch { /* 무시 */ }
      return true;
    } catch { /* fallthrough to window */ }
  }

  // v6.1.0: 읽기전용 뷰어 + 포커스 복원 + 윈도우 배치
  const logDir = join(tmpdir(), "psmux-steering", sessionName).replace(/\\/g, "/");
  const cols = opts.cols || Math.max(100, 60 + workerCount * 15);
  const rows = opts.rows || Math.max(25, 15 + workerCount * 4);

  // 읽기전용 뷰어 스크립트 생성
  const viewerScript = join(tmpdir(), "tfx-viewer-" + sessionName + ".ps1").replace(/\\/g, "/");
  writeFileSync(viewerScript, [
    "$Host.UI.RawUI.WindowTitle = '" + sessionName + "'",
    "Write-Host \"`e[38;5;214m⬡ triflux viewer (read-only)`e[0m — " + sessionName + "\"",
    "Write-Host 'Log: " + logDir + "'",
    "Write-Host '---'",
    "for ($i=0; $i -lt 30; $i++) { if ((Get-ChildItem '" + logDir + "' -Filter *.log -ErrorAction SilentlyContinue).Count -gt 0) { break }; Start-Sleep 1 }",
    "if (-not (Get-ChildItem '" + logDir + "' -Filter *.log -ErrorAction SilentlyContinue)) { Write-Host 'No log files found after 30s'; exit 1 }",
    "Get-Content -Path '" + logDir + "\\*.log' -Wait -Tail 50",
  ].join("\n"), "utf8");

  // T1 fix: 현재 HWND를 먼저 저장 → 탭 추가 → 즉시 원래 탭으로 복귀
  // 2단계 포커스 복원: (1) 탭 추가 전 HWND 캡처 (2) 탭 추가 후 150ms+SendKeys
  const saveHwndScript = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$before = [System.Windows.Forms.Form]::ActiveForm",
    // 150ms로 단축 (300ms → 150ms) — WT 탭 생성은 ~100ms
    "Start-Sleep -Milliseconds 150",
    "[System.Windows.Forms.SendKeys]::SendWait('^+{TAB}')",
  ].join("; ");

  // WT new-tab은 --size 미지원 (window-level only). 기존 창(-w 0)에 탭 추가만.
  const wtArgs = ["-w", "0", "nt", "--profile", "triflux", "--title", sessionName];
  wtArgs.push("--", "pwsh.exe", "-NoProfile", "-NoLogo", "-File", viewerScript);

  try {
    const child = spawn("wt.exe", wtArgs, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    return false;
  }

  // T1: 포커스 복원 (150ms — 기존 300ms에서 단축)
  for (const shell of ["pwsh.exe", "powershell.exe"]) {
    try {
      spawn(shell, ["-NoProfile", "-NonInteractive", "-Command", saveHwndScript], {
        detached: true, stdio: "ignore",
      }).unref();
      break;
    } catch { /* 다음 shell */ }
  }
  return true;
}

/**
 * v7.0: psmux 세션을 WT 탭에 attach (대시보드 + 워커 전체 뷰)
 * @param {string} sessionName
 * @param {number} workerCount
 * @returns {boolean}
 */
export function attachDashboardTab(sessionName, workerCount = 2) {
  try { execSync("where wt.exe", { stdio: "ignore" }); } catch { return false; }
  ensureWtProfile(workerCount);

  // v7.1.3: 대시보드만 스플릿 (psmux attach 대신 tui-viewer 직접 실행)
  // raw CLI 출력은 사용자에게 불필요 — 대시보드 로그만 표시
  const viewerPath = join(import.meta.dirname, "tui-viewer.mjs").replace(/\\/g, "/");
  try {
    const child = spawn("wt.exe", [
      "-w", "0", "sp", "-H", "-s", "0.30",
      "--profile", "triflux",
      "--title", `▲ ${sessionName}`,
      "--", "node", viewerPath, "--session", sessionName,
    ], { detached: true, stdio: "ignore" });
    child.unref();
    try { spawn("wt.exe", ["-w", "0", "mf", "up"], { detached: true, stdio: "ignore" }).unref(); } catch {}
    return true;
  } catch { return false; }
}

/**
 * 모든 워커 pane의 현재 스냅샷을 수집한다.
 *
 * @param {string} sessionName
 * @param {Array<{paneId: string, paneName: string, cli: string}>} dispatches
 * @param {number} [lines=15] — 각 pane에서 캡처할 줄 수
 * @returns {Array<{paneName: string, cli: string, snapshot: string}>}
 */
export function getProgressSnapshots(sessionName, dispatches, lines = 15) {
  if (!psmuxSessionExists(sessionName)) return [];
  return dispatches.map((d) => {
    try {
      const snapshot = capturePsmuxPane(d.paneId, lines);
      return { paneName: d.paneName, cli: d.cli, snapshot };
    } catch {
      return { paneName: d.paneName, cli: d.cli, snapshot: "(캡처 실패)" };
    }
  });
}

/**
 * Lead-Direct Interactive 헤드리스 실행.
 * 세션을 유지하면서 결과 수집 후에도 추가 명령을 dispatch할 수 있다.
 * 반환된 handle의 kill()을 반드시 호출하여 세션을 정리해야 한다.
 *
 * @param {string} sessionName — psmux 세션 이름
 * @param {Array<{cli: string, prompt: string, role?: string}>} assignments
 * @param {object} [opts]
 * @param {number} [opts.timeoutSec=300]
 * @param {string} [opts.layout='2x2']
 * @param {(event: object) => void} [opts.onProgress]
 * @param {number} [opts.progressIntervalSec=0]
 * @param {boolean} [opts.autoAttach=false] — Windows Terminal 자동 attach
 * @param {AbortSignal} [opts.signal] — abort 시 자동 세션 정리
 * @param {number} [opts.maxIdleSec=0] — 유휴 시 자동 정리 (0=비활성)
 * @returns {Promise<{
 *   sessionName: string,
 *   results: Array,
 *   dispatches: Array,
 *   dispatch: (paneName: string, command: string) => {paneId: string, paneName: string, token: string},
 *   capture: (paneName: string, lines?: number) => string,
 *   snapshots: (lines?: number) => Array,
 *   waitFor: (paneName: string, token: string, timeoutSec?: number, opts?: object) => Promise,
 *   alive: () => boolean,
 *   kill: () => void,
 * }>}
 */
export async function runHeadlessInteractive(sessionName, assignments, opts = {}) {
  const {
    autoAttach = false,
    dashboard = false,
    signal,
    maxIdleSec = 0,
    ...runOpts
  } = opts;

  // dashboard 옵션을 runHeadless에 전달
  if (dashboard) runOpts.dashboard = true;

  // autoAttach를 session_created 시점에 트리거 (CLI 실행 전에 터미널 열림)
  const userOnProgress = runOpts.onProgress;
  let terminalAttached = false;
  runOpts.onProgress = (event) => {
    if (autoAttach && event.type === "session_created" && !terminalAttached) {
      terminalAttached = true;
      if (dashboard) {
        // v7.0: psmux attach로 대시보드+워커 전체 세션을 WT 탭에 표시
        attachDashboardTab(sessionName, assignments.length);
      } else {
        autoAttachTerminal(sessionName, { mode: "window" }, assignments.length);
      }
    }
    if (userOnProgress) userOnProgress(event);
  };

  // Phase 1: 세션 생성 → 즉시 터미널 팝업 → dispatch → 대기 → 결과 수집
  const { results } = await runHeadless(sessionName, assignments, runOpts);

  // Phase 2: 세션을 유지하고 interactive handle 반환
  // Fix P2: paneId를 dispatches에 포함 (snapshots에서 필요)
  const dispatches = results.map((r, i) => ({
    paneName: r.paneName,
    paneId: r.paneId || "",
    cli: r.cli,
    role: r.role,
  }));

  // Fix P2: maxIdleSec 리셋을 위한 타이머 관리
  let idleTimer = null;
  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    if (maxIdleSec > 0) {
      idleTimer = setTimeout(() => handle.kill(), maxIdleSec * 1000);
      if (idleTimer.unref) idleTimer.unref();
    }
  }

  const handle = {
    sessionName,
    results,
    dispatches,
    _killed: false,

    /** 특정 pane에 후속 명령 dispatch (캡처 자동 재시작) */
    dispatch(paneName, command) {
      if (this._killed) throw new Error("세션이 이미 종료되었습니다.");
      try { startCapture(sessionName, paneName); } catch { /* 이미 활성 — 무시 */ }
      resetIdleTimer();
      return dispatchCommand(sessionName, paneName, command);
    },

    /** 특정 pane의 현재 출력 캡처 */
    capture(paneName, lines = 30) {
      if (this._killed) return "";
      try {
        // Fix P2: paneName으로 resolvePane을 경유하여 정확한 paneId 획득
        return capturePsmuxPane(paneName, lines);
      } catch {
        return "(캡처 실패)";
      }
    },

    /** 모든 pane 스냅샷 */
    snapshots(lines = 15) {
      if (this._killed) return [];
      return getProgressSnapshots(sessionName, dispatches, lines);
    },

    /** 특정 pane에서 완료 대기 */
    async waitFor(paneName, token, timeoutSec = 300, waitOpts = {}) {
      if (this._killed) return { matched: false, sessionDead: true };
      resetIdleTimer();
      return waitForCompletion(sessionName, paneName, token, timeoutSec, waitOpts);
    },

    /** 세션 생존 확인 */
    alive() {
      if (this._killed) return false;
      return psmuxSessionExists(sessionName);
    },

    /** 세션 종료 — WT pane은 psmux 종료 시 자동으로 닫힘 */
    kill() {
      if (this._killed) return;
      this._killed = true;
      try { killPsmuxSession(sessionName); } catch { /* 무시 */ }
      // WT split pane은 psmux 종료 → 셸 종료 → 자동 닫힘
      // 수동 close-pane 불필요 (레이스 컨디션으로 WT 0x80070002 에러 발생)
    },
  };

  // AbortController signal로 자동 정리
  if (signal) {
    if (signal.aborted) {
      handle.kill();
    } else {
      signal.addEventListener("abort", () => handle.kill(), { once: true });
    }
  }

  // 유휴 타임아웃 자동 정리 (resetIdleTimer 단일 경로 사용)
  resetIdleTimer();

  // 프로세스 종료 시 safety net
  const exitHandler = () => handle.kill();
  process.on("exit", exitHandler);
  // kill() 후 리스너 제거를 위해 참조 보관
  const originalKill = handle.kill.bind(handle);
  handle.kill = function () {
    originalKill();
    process.removeListener("exit", exitHandler);
  };

  return handle;
}
