// hub/team/pane.mjs — pane별 CLI 실행 + stdin 주입
// 의존성: child_process, fs, os, path (Node.js 내장)만 사용
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectMultiplexer, tmuxExec } from "./session.mjs";
import { psmuxExec } from "./psmux.mjs";

import { buildExecArgs } from "@triflux/core/hub/codex-adapter.mjs";

function quoteArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

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

  // wsl tmux는 /mnt/c/... 경로를 사용
  if (mux === "wsl-tmux") {
    return `/mnt/${drive}/${rest}`;
  }

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

/**
 * CLI 에이전트 시작 커맨드 생성
 * @param {'codex'|'gemini'|'claude'} cli
 * @param {{ trustMode?: boolean }} [options]
 * @returns {string} 실행할 셸 커맨드
 */
export function buildCliCommand(cli, options = {}) {
  const { trustMode = false } = options;

  switch (cli) {
    case "codex":
      // trust 모드에서는 exec 서브커맨드 기반 명령을 사용
      if (trustMode) {
        return buildExecArgs({});
      }
      return "codex";
    case "gemini":
      // interactive 모드 — MCP는 ~/.gemini/settings.json에 사전 등록
      return "gemini";
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
 * pane에 프롬프트 주입 (load-buffer + paste-buffer 방식)
 * 멀티라인 + 특수문자 안전, 크기 제한 없음
 * @param {string} target — 예: tfx-multi-abc:0.1
 * @param {string} prompt — 주입할 텍스트
 */
/**
 * pane에 프롬프트 주입
 * @param {string} target — 예: tfx-multi-abc:0.1
 * @param {string} prompt — 주입할 텍스트
 * @param {object} [opts]
 * @param {boolean} [opts.useFileRef] — true면 TUI용 @file 참조 방식 (psmux 전용)
 */
export function injectPrompt(target, prompt, { useFileRef = false } = {}) {
  const tmpDir = join(tmpdir(), "tfx-multi");
  mkdirSync(tmpDir, { recursive: true });

  const safeTarget = target.replace(/[:.]/g, "-");
  const tmpFile = join(tmpDir, `prompt-${safeTarget}-${Date.now()}.txt`);

  // psmux + TUI 앱: @file 참조로 주입 (paste-buffer는 TUI와 호환 안 됨)
  if (detectMultiplexer() === "psmux" && useFileRef) {
    writeFileSync(tmpFile, prompt, "utf8");
    const filePath = tmpFile.replace(/\\/g, "/");
    psmuxExec(["select-pane", "-t", target]);
    psmuxExec(["send-keys", "-t", target, "-l", `@${filePath}`]);
    psmuxExec(["send-keys", "-t", target, "Enter"]);
    // TUI가 파일을 읽을 시간을 주고 정리
    setTimeout(() => { try { unlinkSync(tmpFile); } catch {} }, 10000);
    return;
  }

  try {
    writeFileSync(tmpFile, prompt, "utf8");

    if (detectMultiplexer() === "psmux") {
      const sessionName = getPsmuxSessionName(target);
      psmuxExec(["load-buffer", "-t", sessionName, toMuxPath(tmpFile)]);
      psmuxExec(["select-pane", "-t", target]);
      psmuxExec(["paste-buffer", "-t", target]);
      psmuxExec(["send-keys", "-t", target, "Enter"]);
      return;
    }

    // tmux load-buffer → paste-buffer → Enter
    muxExec(`load-buffer ${quoteArg(toMuxPath(tmpFile))}`);
    muxExec(`paste-buffer -t ${target}`);
    muxExec(`send-keys -t ${target} Enter`);
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

/**
 * pane에 키 입력 전송
 * @param {string} target — 예: tfx-multi-abc:0.1
 * @param {string} keys — tmux 키 표현 (예: 'C-c', 'Enter')
 */
export function sendKeys(target, keys) {
  muxExec(`send-keys -t ${target} ${keys}`);
}
