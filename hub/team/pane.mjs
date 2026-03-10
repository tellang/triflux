// hub/team/pane.mjs — pane별 CLI 실행 + stdin 주입
// 의존성: child_process, fs, os, path (Node.js 내장)만 사용
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectMultiplexer, tmuxExec } from "./session.mjs";

/** Windows 경로를 MSYS2/Git Bash tmux용 POSIX 경로로 변환 */
function toTmuxPath(p) {
  if (process.platform !== "win32") return p;

  const normalized = p.replace(/\\/g, "/");
  const m = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!m) return normalized;

  const drive = m[1].toLowerCase();
  const rest = m[2];
  const mux = detectMultiplexer();

  // wsl tmux는 /mnt/c/... 경로를 사용
  if (mux === "wsl-tmux") {
    return `/mnt/${drive}/${rest}`;
  }

  // Git Bash/MSYS tmux는 /c/... 경로를 사용
  return `/${drive}/${rest}`;
}

/** tmux 커맨드 실행 (session.mjs와 동일 패턴) */
function tmux(args, opts = {}) {
  return tmuxExec(args, {
    encoding: "utf8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
    ...opts,
  });
}

/**
 * CLI 에이전트 시작 커맨드 생성
 * @param {'codex'|'gemini'|'claude'} cli
 * @returns {string} 실행할 셸 커맨드
 */
export function buildCliCommand(cli) {
  switch (cli) {
    case "codex":
      // interactive REPL 진입 — MCP는 ~/.codex/config.json에 사전 등록
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
 * tmux pane에 CLI 시작
 * @param {string} target — 예: tfx-team-abc:0.1
 * @param {string} command — 실행할 커맨드
 */
export function startCliInPane(target, command) {
  // 특수문자 이스케이프: 작은따옴표 내부에서 안전하도록
  const escaped = command.replace(/'/g, "'\\''");
  tmux(`send-keys -t ${target} '${escaped}' Enter`);
}

/**
 * pane에 프롬프트 주입 (load-buffer + paste-buffer 방식)
 * 멀티라인 + 특수문자 안전, 크기 제한 없음
 * @param {string} target — 예: tfx-team-abc:0.1
 * @param {string} prompt — 주입할 텍스트
 */
export function injectPrompt(target, prompt) {
  // 임시 파일에 프롬프트 저장
  const tmpDir = join(tmpdir(), "tfx-team");
  mkdirSync(tmpDir, { recursive: true });

  // pane ID를 파일명에 포함 (충돌 방지)
  const safeTarget = target.replace(/[:.]/g, "-");
  const tmpFile = join(tmpDir, `prompt-${safeTarget}-${Date.now()}.txt`);

  try {
    writeFileSync(tmpFile, prompt, "utf8");

    // tmux load-buffer → paste-buffer → Enter (Windows 경로 변환 필요)
    tmux(`load-buffer ${toTmuxPath(tmpFile)}`);
    tmux(`paste-buffer -t ${target}`);
    tmux(`send-keys -t ${target} Enter`);
  } finally {
    // 임시 파일 정리
    try {
      unlinkSync(tmpFile);
    } catch {
      // 정리 실패 무시
    }
  }
}

/**
 * pane에 키 입력 전송
 * @param {string} target — 예: tfx-team-abc:0.1
 * @param {string} keys — tmux 키 표현 (예: 'C-c', 'Enter')
 */
export function sendKeys(target, keys) {
  tmux(`send-keys -t ${target} ${keys}`);
}
