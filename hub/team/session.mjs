// hub/team/session.mjs — tmux 세션 생명주기 관리
// 의존성: child_process (Node.js 내장)만 사용
import { execSync, spawnSync } from "node:child_process";

const GIT_BASH_CANDIDATES = [
  "C:/Program Files/Git/bin/bash.exe",
  "C:/Program Files/Git/usr/bin/bash.exe",
];

function findGitBashExe() {
  for (const p of GIT_BASH_CANDIDATES) {
    try {
      execSync(`"${p}" --version`, { stdio: "ignore", timeout: 3000 });
      return p;
    } catch {
      // 다음 후보
    }
  }
  return null;
}

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

/** Git Bash 내 tmux 사용 가능 여부 (Windows 전용) */
function hasGitBashTmux() {
  const bash = findGitBashExe();
  if (!bash) return false;
  try {
    const r = spawnSync(bash, ["-lc", "tmux -V"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return (r.status ?? 1) === 0;
  } catch {
    return false;
  }
}

/**
 * 터미널 멀티플렉서 감지
 * @returns {'tmux'|'git-bash-tmux'|'wsl-tmux'|null}
 */
export function detectMultiplexer() {
  if (hasTmux()) return "tmux";
  if (process.platform === "win32" && hasGitBashTmux()) return "git-bash-tmux";
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
  if (mux === "git-bash-tmux") {
    const bash = findGitBashExe();
    if (!bash) throw new Error("git-bash-tmux 감지 실패");
    const r = spawnSync(bash, ["-lc", `tmux ${args}`], {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
      ...opts,
    });
    if ((r.status ?? 1) !== 0) {
      const e = new Error(r.stderr || "tmux command failed");
      e.status = r.status;
      throw e;
    }
    return (r.stdout || "").trim();
  }

  const prefix = mux === "wsl-tmux" ? "wsl tmux" : "tmux";
  const result = execSync(`${prefix} ${args}`, {
    encoding: "utf8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
    ...opts,
  });
  return result != null ? result.trim() : "";
}

/**
 * tmux 명령 직접 실행 (고수준 모듈에서 재사용)
 * @param {string} args
 * @param {object} opts
 * @returns {string}
 */
export function tmuxExec(args, opts = {}) {
  return tmux(args, opts);
}

/**
 * 현재 멀티플렉서 환경에 맞는 attach 실행 스펙 반환
 * @param {string} sessionName
 * @returns {{ command: string, args: string[] }}
 */
export function resolveAttachCommand(sessionName) {
  const mux = detectMultiplexer();
  if (!mux) {
    throw new Error("tmux 미발견");
  }

  if (mux === "git-bash-tmux") {
    const bash = findGitBashExe();
    if (!bash) throw new Error("git-bash-tmux 감지 실패");
    return {
      command: bash,
      args: ["-lc", `tmux attach-session -t ${sessionName}`],
    };
  }

  if (mux === "wsl-tmux") {
    return {
      command: "wsl",
      args: ["tmux", "attach-session", "-t", sessionName],
    };
  }

  return {
    command: "tmux",
    args: ["attach-session", "-t", sessionName],
  };
}

/**
 * tmux 세션 생성 + 레이아웃 분할
 * @param {string} sessionName — 세션 이름
 * @param {object} opts
 * @param {'2x2'|'1xN'|'Nx1'} opts.layout — 레이아웃 (기본 2x2)
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
    // 3-pane 기본: lead 왼쪽, workers 오른쪽 상/하
    // 4-pane: 좌/우 각각 상/하(균등 2x2)
    tmux(`split-window -h -t ${sessionName}:0.0`);
    tmux(`split-window -v -t ${sessionName}:0.1`);
    if (paneCount >= 4) {
      tmux(`split-window -v -t ${sessionName}:0.0`);
    }
    // pane ID 재수집
    panes.length = 0;
    for (let i = 0; i < Math.min(paneCount, 4); i++) {
      panes.push(`${sessionName}:0.${i}`);
    }
  } else if (layout === "1xN") {
    // 세로 분할(좌/우 컬럼 확장)
    for (let i = 1; i < paneCount; i++) {
      tmux(`split-window -h -t ${sessionName}:0`);
    }
    tmux(`select-layout -t ${sessionName}:0 even-horizontal`);
    panes.length = 0;
    for (let i = 0; i < paneCount; i++) {
      panes.push(`${sessionName}:0.${i}`);
    }
  } else {
    // Nx1 가로 분할(상/하 스택)
    for (let i = 1; i < paneCount; i++) {
      tmux(`split-window -v -t ${sessionName}:0`);
    }
    tmux(`select-layout -t ${sessionName}:0 even-vertical`);
    panes.length = 0;
    for (let i = 0; i < paneCount; i++) {
      panes.push(`${sessionName}:0.${i}`);
    }
  }

  return { sessionName, panes };
}

/**
 * pane 포커스 이동
 * @param {string} target
 * @param {object} opts
 * @param {boolean} opts.zoom
 */
export function focusPane(target, opts = {}) {
  const { zoom = false } = opts;
  tmux(`select-pane -t ${target}`);
  if (zoom) {
    try { tmux(`resize-pane -t ${target} -Z`); } catch {}
  }
}

/**
 * 팀메이트 조작 키 바인딩 설정
 * - Shift+Down: 다음 팀메이트
 * - Shift+Up: 이전 팀메이트
 * - Escape: 현재 팀메이트 인터럽트(C-c)
 * - Ctrl+T: 태스크 목록 표시
 * @param {string} sessionName
 * @param {object} opts
 * @param {boolean} opts.inProcess
 * @param {string} opts.taskListCommand
 */
export function configureTeammateKeybindings(sessionName, opts = {}) {
  const { inProcess = false, taskListCommand = "" } = opts;
  const cond = `#{==:#{session_name},${sessionName}}`;

  if (inProcess) {
    // 단일 뷰(zoom) 상태에서 팀메이트 순환
    tmux(`bind-key -T root -n S-Down if-shell -F '${cond}' 'select-pane -t :.+ \\; resize-pane -Z' 'send-keys S-Down'`);
    tmux(`bind-key -T root -n S-Up if-shell -F '${cond}' 'select-pane -t :.- \\; resize-pane -Z' 'send-keys S-Up'`);
  } else {
    // 분할 뷰에서 팀메이트 순환
    tmux(`bind-key -T root -n S-Down if-shell -F '${cond}' 'select-pane -t :.+' 'send-keys S-Down'`);
    tmux(`bind-key -T root -n S-Up if-shell -F '${cond}' 'select-pane -t :.-' 'send-keys S-Up'`);
  }

  // 현재 활성 pane 인터럽트
  tmux(`bind-key -T root -n Escape if-shell -F '${cond}' 'send-keys C-c' 'send-keys Escape'`);

  // 태스크 목록 토글 (tmux 3.2+ popup 우선, 실패 시 안내 메시지)
  if (taskListCommand) {
    const escaped = taskListCommand.replace(/'/g, "'\\''");
    try {
      tmux(`bind-key -T root -n C-t if-shell -F '${cond}' \"display-popup -E '${escaped}'\" \"send-keys C-t\"`);
    } catch {
      tmux(`bind-key -T root -n C-t if-shell -F '${cond}' 'display-message "tfx team tasks 명령으로 태스크 확인"' 'send-keys C-t'`);
    }
  }
}

/**
 * tmux 세션 연결 (포그라운드 전환)
 * @param {string} sessionName
 */
export function attachSession(sessionName) {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error("현재 터미널은 tmux attach를 지원하지 않음 (non-TTY)");
  }

  const { command, args } = resolveAttachCommand(sessionName);
  const r = spawnSync(command, args, {
    stdio: "inherit",
    timeout: 0, // 타임아웃 없음 (사용자가 detach할 때까지)
  });
  if ((r.status ?? 1) !== 0) {
    throw new Error(`tmux attach 실패 (exit=${r.status})`);
  }
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
