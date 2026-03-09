// hub/team/session.mjs — tmux 세션 생명주기 관리
// 의존성: child_process (Node.js 내장)만 사용
import { execSync } from "node:child_process";

/** tmux 실행 가능 여부 확인 */
function hasTmux() {
  try {
    execSync("tmux -V", { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** WSL2 내 tmux 사용 가능 여부 (Windows 전용) */
function hasWslTmux() {
  try {
    execSync("wsl tmux -V", { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 터미널 멀티플렉서 감지
 * @returns {'tmux'|'wsl-tmux'|null}
 */
export function detectMultiplexer() {
  if (hasTmux()) return "tmux";
  if (process.platform === "win32" && hasWslTmux()) return "wsl-tmux";
  return null;
}

/**
 * tmux 커맨드 실행 (wsl-tmux 투명 지원)
 * @param {string} args — tmux 서브커맨드 + 인자
 * @param {object} opts — execSync 옵션
 * @returns {string} stdout
 */
function tmux(args, opts = {}) {
  const mux = detectMultiplexer();
  if (!mux) {
    throw new Error(
      "tmux 미발견.\n\n" +
      "tfx team은 tmux가 필요합니다:\n" +
      "  WSL2:   wsl sudo apt install tmux\n" +
      "  macOS:  brew install tmux\n" +
      "  Linux:  apt install tmux\n\n" +
      "Windows에서는 WSL2를 권장합니다:\n" +
      "  1. wsl --install\n" +
      "  2. wsl sudo apt install tmux\n" +
      "  3. tfx team \"작업\"  (자동으로 WSL tmux 사용)"
    );
  }
  const prefix = mux === "wsl-tmux" ? "wsl tmux" : "tmux";
  const result = execSync(`${prefix} ${args}`, {
    encoding: "utf8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
    ...opts,
  });
  // stdio: "ignore" 시 execSync가 null 반환 — 안전 처리
  return result != null ? result.trim() : "";
}

/**
 * tmux 세션 생성 + 레이아웃 분할
 * @param {string} sessionName — 세션 이름
 * @param {object} opts
 * @param {'2x2'|'1xN'} opts.layout — 레이아웃 (기본 2x2)
 * @param {number} opts.paneCount — pane 수 (기본 4)
 * @returns {{ sessionName: string, panes: string[] }}
 */
export function createSession(sessionName, opts = {}) {
  const { layout = "2x2", paneCount = 4 } = opts;

  // 기존 세션 정리
  if (sessionExists(sessionName)) {
    killSession(sessionName);
  }

  // 새 세션 생성 (detached)
  tmux(`new-session -d -s ${sessionName} -x 220 -y 55`);

  const panes = [`${sessionName}:0.0`];

  if (layout === "2x2" && paneCount >= 3) {
    // 2x2 그리드: 좌|우 → 좌상/좌하 → 우상/우하
    tmux(`split-window -h -t ${sessionName}:0`);
    tmux(`split-window -v -t ${sessionName}:0.0`);
    if (paneCount >= 4) {
      tmux(`split-window -v -t ${sessionName}:0.2`);
    }
    // pane ID 재수집
    panes.length = 0;
    for (let i = 0; i < Math.min(paneCount, 4); i++) {
      panes.push(`${sessionName}:0.${i}`);
    }
  } else {
    // 1xN 수직 분할
    for (let i = 1; i < paneCount; i++) {
      tmux(`split-window -v -t ${sessionName}:0`);
    }
    // even-vertical 레이아웃 적용
    tmux(`select-layout -t ${sessionName}:0 even-vertical`);
    panes.length = 0;
    for (let i = 0; i < paneCount; i++) {
      panes.push(`${sessionName}:0.${i}`);
    }
  }

  return { sessionName, panes };
}

/**
 * tmux 세션 연결 (포그라운드 전환)
 * @param {string} sessionName
 */
export function attachSession(sessionName) {
  const mux = detectMultiplexer();
  const prefix = mux === "wsl-tmux" ? "wsl tmux" : "tmux";
  // stdio: inherit로 사용자에게 제어권 반환
  execSync(`${prefix} attach-session -t ${sessionName}`, {
    stdio: "inherit",
    timeout: 0, // 타임아웃 없음 (사용자가 detach할 때까지)
  });
}

/**
 * tmux 세션 존재 확인
 * @param {string} sessionName
 * @returns {boolean}
 */
export function sessionExists(sessionName) {
  try {
    tmux(`has-session -t ${sessionName}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * tmux 세션 종료
 * @param {string} sessionName
 */
export function killSession(sessionName) {
  try {
    tmux(`kill-session -t ${sessionName}`, { stdio: "ignore" });
  } catch {
    // 이미 종료된 세션 — 무시
  }
}

/**
 * tfx-team- 접두사 세션 목록
 * @returns {string[]}
 */
export function listSessions() {
  try {
    const output = tmux('list-sessions -F "#{session_name}"');
    return output
      .split("\n")
      .filter((s) => s.startsWith("tfx-team-"));
  } catch {
    return [];
  }
}

/**
 * pane 마지막 N줄 캡처
 * @param {string} target — 예: tfx-team-abc:0.1
 * @param {number} lines — 캡처할 줄 수 (기본 5)
 * @returns {string}
 */
export function capturePaneOutput(target, lines = 5) {
  try {
    // -l 플래그는 일부 tmux 빌드(MSYS2)에서 미지원 → 전체 캡처 후 JS에서 절삭
    const full = tmux(`capture-pane -t ${target} -p`);
    const nonEmpty = full.split("\n").filter((l) => l.trim() !== "");
    return nonEmpty.slice(-lines).join("\n");
  } catch {
    return "";
  }
}
