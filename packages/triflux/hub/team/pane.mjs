// hub/team/pane.mjs — pane별 CLI 실행 + stdin 주입
// 의존성: child_process, fs, os, path (Node.js 내장)만 사용
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExecArgs } from "../codex-adapter.mjs";
import { psmuxExec } from "./psmux.mjs";
import { detectMultiplexer, tmuxExec } from "./session.mjs";

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
 * psmux `@file` 참조 주입이 가능한 CLI인지 판정한다.
 *
 * Codex TUI는 `@` 입력이 있으면 sync_file_search_popup 경로로 FileSearchPopup을
 * 활성화한다 (call-site `codex-rs/tui/src/bottom_pane/chat_composer.rs:3082`;
 * 본체 L3271-3313 에서 `ActivePopup::File(popup)` 분기; 빈 query 상태는
 * `file_search_popup.rs:54-63` 의 `set_empty_prompt()` 가 정의). 팝업이 떠 있는
 * 동안의 Enter 처리는 같은 파일 composer의 Enter handler (`chat_composer.rs:1585-1645`
 * 기준) 에서 popup 선택 path insert 또는 dismiss 로 분기하므로 prompt submit 으로
 * 전달되지 않는다. Gemini CLI의 `@path`는 공식 client-side file-content inject
 * 이므로 유지. Codex TUI에서 `@path` 선택은 path 문자열만 textarea에 insert할
 * 뿐 Gemini처럼 파일 내용을 inject하지 않으며, 별도 file-injection slash
 * command 도 존재하지 않음 (slash_commands / prompt_args / skill_popup /
 * command_popup 소스 전수 grep 결과 0건, 2026-04-19 검증 — absence-based).
 *
 * @param {{ multiplexer: string, useFileRef: boolean, cli: string|null }} args
 */
export function shouldUseFileRef({ multiplexer, useFileRef, cli }) {
  return multiplexer === "psmux" && useFileRef && cli !== "codex";
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
    return String(muxExec(`capture-pane -t ${target} -p`) ?? "");
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
 * Codex TUI는 연속 키 입력을 paste burst로 묶으므로 paste 직후의 Enter가
 * 제출이 아니라 개행으로 composer에 삽입될 수 있다 (텍스트만 남고 미제출).
 * busy 마커가 보이거나 프롬프트 꼬리가 화면에서 사라지면 제출로 판정한다.
 * capture 불가 환경이면 첫 Enter 후 판정을 포기한다 (기존 동작 수준).
 * 제출 후 transcript에 프롬프트가 에코돼 꼬리가 남아 있어도 빈 composer에
 * 대한 추가 Enter는 no-op이라 안전하다.
 */
function confirmSubmit(target, prompt, sendEnter) {
  const lastLine =
    String(prompt).trim().split("\n").filter(Boolean).pop() || "";
  const tail = lastLine.slice(-20);
  sleepMs(PASTE_SETTLE_MS);
  for (let attempt = 1; attempt <= SUBMIT_RETRY_LIMIT; attempt++) {
    sendEnter();
    sleepMs(400 * attempt);
    const text = capturePaneText(target);
    if (!text || !tail) return;
    if (/to interrupt|working|thinking/i.test(text)) return; // busy = 제출됨
    if (!text.includes(tail)) return; // 화면에서 사라짐 = 제출됨
  }
}

/**
 * pane에 프롬프트 주입
 * @param {string} target — 예: tfx-multi-abc:0.1
 * @param {string} prompt — 주입할 텍스트
 * @param {object} [opts]
 * @param {boolean} [opts.useFileRef] — true면 TUI용 @file 참조 방식 요청 (psmux 전용). Codex에서는 자동으로 paste-buffer 경로로 fallback.
 * @param {'codex'|'gemini'|'claude'|null} [opts.cli] — 대상 CLI. Codex일 때 @ intercept를 회피하기 위해 paste-buffer 경로를 강제한다.
 */
export function injectPrompt(
  target,
  prompt,
  { useFileRef = false, cli = null } = {},
) {
  const tmpDir = join(tmpdir(), "tfx-multi");
  mkdirSync(tmpDir, { recursive: true });

  const safeTarget = target.replace(/[:.]/g, "-");
  const tmpFile = join(tmpDir, `prompt-${safeTarget}-${Date.now()}.txt`);

  const multiplexer = detectMultiplexer();

  // psmux + TUI + CLI별 @file 지원: @path를 literal paste하고 Enter로 확정.
  // Codex는 @가 file search popup을 intercept하므로 paste-buffer 경로로 fallback.
  if (shouldUseFileRef({ multiplexer, useFileRef, cli })) {
    writeFileSync(tmpFile, prompt, "utf8");
    const filePath = tmpFile.replace(/\\/g, "/");
    waitForComposerReady(target);
    psmuxExec(["select-pane", "-t", target]);
    psmuxExec(["send-keys", "-t", target, "-l", `@${filePath}`]);
    confirmSubmit(target, `@${filePath}`, () =>
      psmuxExec(["send-keys", "-t", target, "Enter"]),
    );
    // TUI가 파일을 읽을 시간을 주고 정리
    setTimeout(() => {
      try {
        unlinkSync(tmpFile);
      } catch {}
    }, 10000);
    return;
  }

  try {
    writeFileSync(tmpFile, prompt, "utf8");

    if (detectMultiplexer() === "psmux") {
      const sessionName = getPsmuxSessionName(target);
      waitForComposerReady(target);
      psmuxExec(["load-buffer", "-t", sessionName, toMuxPath(tmpFile)]);
      psmuxExec(["select-pane", "-t", target]);
      psmuxExec(["paste-buffer", "-t", target]);
      confirmSubmit(target, prompt, () =>
        psmuxExec(["send-keys", "-t", target, "Enter"]),
      );
      return;
    }

    // tmux load-buffer → paste-buffer → (정착 지연 + 제출 확인) Enter
    waitForComposerReady(target);
    muxExec(`load-buffer ${quoteArg(toMuxPath(tmpFile))}`);
    muxExec(`paste-buffer -t ${target}`);
    confirmSubmit(target, prompt, () =>
      muxExec(`send-keys -t ${target} Enter`),
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
  muxExec(`send-keys -t ${target} ${keys}`);
}
