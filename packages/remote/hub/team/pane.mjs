// hub/team/pane.mjs — pane별 CLI 실행 + stdin 주입
// 의존성: child_process, fs, os, path (Node.js 내장)만 사용
import { unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { privateTmpDir } from "@triflux/core/hub/lib/private-tmp.mjs";
import { psmuxExec } from "./psmux.mjs";
import { detectMultiplexer, tmuxExec } from "./session.mjs";

function getPsmuxSessionName(target) {
  return String(target).split(":")[0]?.trim() || "";
}

/** Windows 경로를 멀티플렉서용 경로로 변환 */
function toMuxPath(p) {
  if (process.platform !== "win32") return p;

  const mux = detectMultiplexer();

  // psmux는 Windows 네이티브 경로 그대로 사용
  if (mux === "psmux") return p;

  const normalized = p.replace(/\\/g, "/");
  const m = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!m) return normalized;

  const drive = m[1].toLowerCase();
  const rest = m[2];

  // Git Bash/MSYS tmux는 /c/... 경로를 사용
  return `/${drive}/${rest}`;
}

/** 멀티플렉서 커맨드 실행 (session.mjs와 동일 패턴) */
function muxExec(args, opts = {}) {
  const exec = detectMultiplexer() === "psmux" ? psmuxExec : tmuxExec;
  return exec(args, {
    encoding: "utf8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...opts,
  });
}

const AGENT_TO_CLI = createRequire(import.meta.url)("./agent-map.json");

// 역할명(designer)과 별칭(agy)을 CLI 종류로 푼다. 실행과 주입 판정이 같은 값을 본다.
export function resolveCli(cli) {
  const name = String(cli || "").toLowerCase();
  return AGENT_TO_CLI[name] ?? name;
}

/**
 * CLI 에이전트 시작 커맨드 생성. 역할명과 별칭은 agent-map 으로 CLI 를 고른다.
 * @param {string} cli — CLI 이름, 별칭(agy) 또는 역할명
 * @returns {string} 실행할 셸 커맨드
 */
export function buildCliCommand(cli) {
  switch (resolveCli(cli)) {
    case "codex":
      return "codex --dangerously-bypass-approvals-and-sandbox";
    case "antigravity":
      // 실행 파일은 agy 다. antigravity 는 셸 별칭이라 비대화형 셸에 없다.
      return "agy";
    case "claude":
      // interactive 모드
      return "claude";
    default:
      return cli; // 커스텀 CLI 허용
  }
}

/**
 * pane에 CLI 시작
 * @param {string} target — 예: tfx-multi-abc:0.1
 * @param {string} command — 실행할 커맨드
 */
export function startCliInPane(target, command) {
  // CLI 시작도 buffer paste를 재사용해 셸/플랫폼별 quoting 차이를 제거한다.
  injectPrompt(target, command);
}

/**
 * psmux `@file` 참조 주입이 가능한 CLI인지 판정한다.
 *
 * Codex TUI의 @path는 파일 검색 팝업을 열어 Enter 제출을 가로막는다.
 * Gemini CLI의 파일 내용 주입은 유지한다.
 *
 * @param {{ multiplexer: string, useFileRef: boolean, cli: string|null }} args
 */
export function shouldUseFileRef({ multiplexer, useFileRef, cli }) {
  return multiplexer === "psmux" && useFileRef && resolveCli(cli) !== "codex";
}

/** 동기 sleep — injectPrompt는 sync 경로라 setTimeout을 쓸 수 없다 */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// paste 직후 Enter가 TUI paste-burst 감지에 개행으로 흡수되는 것을 피하는 정착 지연
const PASTE_SETTLE_MS = 350;
// 제출 확인 재시도 상한
const SUBMIT_RETRY_LIMIT = 3;
// TUI 준비 대기 상한 — 배너/composer 렌더 완료 전 주입은 키 입력이 통째로 유실될 수 있음
const COMPOSER_READY_TIMEOUT_MS = 8000;

function capturePaneText(target) {
  try {
    if (detectMultiplexer() === "psmux") {
      return String(
        psmuxExec(["capture-pane", "-t", target, "-p"], { encoding: "utf8" }) ??
          "",
      );
    }
    return String(muxExec(["capture-pane", "-t", target, "-p"]) ?? "");
  } catch {
    return "";
  }
}

/**
 * TUI가 그리기를 마칠 때까지 대기: pane 내용이 비어 있지 않고 연속 두 번의
 * capture가 동일(정적)해질 때까지 폴링한다. CLI 종류와 무관한 준비 신호이며
 * 시간 초과 시 그냥 진행한다 (기존 고정-대기 동작으로 degrade).
 */
function waitForComposerReady(target) {
  const deadline = Date.now() + COMPOSER_READY_TIMEOUT_MS;
  let prev = null;
  while (Date.now() < deadline) {
    const text = capturePaneText(target);
    if (text.trim() && prev !== null && text === prev) return;
    prev = text;
    sleepMs(400);
  }
}

/**
 * 주입한 프롬프트가 실제 제출됐는지 확인하고, 안 됐으면 Enter를 재전송한다.
 *
 * TUI는 연속 키 입력을 paste burst로 묶으므로 paste 직후의 Enter가 제출 대신
 * composer 개행으로 흡수될 수 있다. transcript의 과거 prompt가 아니라 마지막
 * composer line에서 현재 prompt가 사라졌을 때만 제출로 판정한다. Antigravity는
 * capture 불가 또는 재시도 소진을 성공으로 숨기지 않고 오류로 반환한다.
 */
function isAntigravityCli(cli) {
  return resolveCli(cli) === "antigravity";
}

function promptComposerNeedle(prompt) {
  const firstContentLine = String(prompt || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  return (firstContentLine || "").slice(0, 16);
}

function isComposerPromptLine(line) {
  return /^\s*(?:[│┃]\s*)?[›❯▶▸>]\s*/u.test(String(line || ""));
}

function composerPromptState(text, needle) {
  const composerLines = String(text || "")
    .split("\n")
    .filter(isComposerPromptLine);
  if (composerLines.length === 0) return "unknown";
  return composerLines.at(-1).includes(needle) ? "present" : "absent";
}

function hasBusyMarkerOutsideComposer(text) {
  return String(text || "")
    .split("\n")
    .some(
      (line) =>
        !isComposerPromptLine(line) &&
        /esc to (?:interrupt|cancel)/iu.test(line),
    );
}

/**
 * paste된 prompt가 실제 제출될 때까지 Enter를 bounded retry한다.
 * Antigravity는 capture로 성공을 확인하지 못하면 조용히 idle 상태로 남기지 않고
 * caller에 명확한 오류를 반환한다.
 */
export function submitPromptWithVerification({
  cli,
  prompt,
  capture,
  sendEnter,
  sleep = sleepMs,
  settleMs = PASTE_SETTLE_MS,
  retryLimit = SUBMIT_RETRY_LIMIT,
} = {}) {
  if (typeof capture !== "function" || typeof sendEnter !== "function") {
    throw new TypeError("capture and sendEnter are required");
  }

  const strictVerification = isAntigravityCli(cli);
  const needle = promptComposerNeedle(prompt);
  sleep(settleMs);

  if (!needle) {
    sendEnter();
    return;
  }

  for (let attempt = 1; attempt <= retryLimit; attempt++) {
    sendEnter();
    sleep(400 * attempt);
    const text = String(capture() ?? "");
    if (!text) {
      if (strictVerification) continue;
      return;
    }
    if (hasBusyMarkerOutsideComposer(text)) return;
    const composerState = composerPromptState(text, needle);
    if (composerState === "absent") return;
    if (composerState === "unknown" && !strictVerification) return;
  }

  if (strictVerification) {
    throw new Error(
      `Antigravity prompt submission failed after ${retryLimit} attempts: prompt remains in composer or submission could not be verified`,
    );
  }
}

function confirmSubmit(target, prompt, cli, sendEnter) {
  submitPromptWithVerification({
    cli,
    prompt,
    capture: () => capturePaneText(target),
    sendEnter,
  });
}

/**
 * pane에 프롬프트 주입
 * @param {string} target — 예: tfx-multi-abc:0.1
 * @param {string} prompt — 주입할 텍스트
 * @param {object} [opts]
 * @param {boolean} [opts.useFileRef] — true면 TUI용 @file 참조 방식 요청 (psmux 전용). Codex에서는 자동으로 paste-buffer 경로로 fallback.
 * @param {'codex'|'antigravity'|'claude'|null} [opts.cli]: 대상 CLI. Codex일 때 @ intercept를 회피하기 위해 paste-buffer 경로를 강제한다.
 */
export function injectPrompt(
  target,
  prompt,
  { useFileRef = false, cli = null } = {},
) {
  const tmpDir = privateTmpDir("tfx-multi");

  const safeTarget = target.replace(/[:.]/g, "-");
  const tmpFile = join(tmpDir, `prompt-${safeTarget}-${Date.now()}.txt`);

  const multiplexer = detectMultiplexer();

  // psmux + TUI + CLI별 @file 지원: @path를 literal paste하고 Enter로 확정.
  // Codex는 @가 file search popup을 intercept하므로 paste-buffer 경로로 fallback.
  if (shouldUseFileRef({ multiplexer, useFileRef, cli })) {
    writeFileSync(tmpFile, prompt, "utf8");
    const filePath = tmpFile.replace(/\\/g, "/");
    let cleanupScheduled = false;
    try {
      waitForComposerReady(target);
      psmuxExec(["select-pane", "-t", target]);
      psmuxExec(["send-keys", "-t", target, "-l", `@${filePath}`]);
      confirmSubmit(target, `@${filePath}`, cli, () =>
        psmuxExec(["send-keys", "-t", target, "Enter"]),
      );
      // TUI가 파일을 읽을 시간을 주고 정리
      setTimeout(() => {
        try {
          unlinkSync(tmpFile);
        } catch {}
      }, 10000);
      cleanupScheduled = true;
      return;
    } finally {
      if (!cleanupScheduled) {
        try {
          unlinkSync(tmpFile);
        } catch {}
      }
    }
  }

  try {
    writeFileSync(tmpFile, prompt, "utf8");

    if (detectMultiplexer() === "psmux") {
      const sessionName = getPsmuxSessionName(target);
      waitForComposerReady(target);
      psmuxExec(["load-buffer", "-t", sessionName, toMuxPath(tmpFile)]);
      psmuxExec(["select-pane", "-t", target]);
      psmuxExec(["paste-buffer", "-t", target]);
      confirmSubmit(target, prompt, cli, () =>
        psmuxExec(["send-keys", "-t", target, "Enter"]),
      );
      return;
    }

    // tmux load-buffer → paste-buffer → (정착 지연 + 제출 확인) Enter
    waitForComposerReady(target);
    muxExec(["load-buffer", toMuxPath(tmpFile)]);
    // -p 가 없으면 줄바꿈이 CR(Enter)로 들어가 여러 줄 지시문이 줄마다 제출된다.
    muxExec(["paste-buffer", "-p", "-t", target]);
    confirmSubmit(target, prompt, cli, () =>
      muxExec(["send-keys", "-t", target, "Enter"]),
    );
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {}
  }
}

/**
 * pane에 키 입력 전송
 * @param {string} target — 예: tfx-multi-abc:0.1
 * @param {string} keys — tmux 키 표현 (예: 'C-c', 'Enter')
 */
export function sendKeys(target, keys) {
  muxExec([
    "send-keys",
    "-t",
    target,
    ...String(keys).split(/\s+/u).filter(Boolean),
  ]);
}
