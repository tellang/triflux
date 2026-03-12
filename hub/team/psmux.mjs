// hub/team/psmux.mjs — Windows psmux 세션/키바인딩/캡처 관리
// 의존성: child_process (Node.js 내장)만 사용
import { execSync, spawnSync } from "node:child_process";

const PSMUX_BIN = process.env.PSMUX_BIN || "psmux";

function quoteArg(value) {
  const str = String(value);
  if (!/[\s"]/u.test(str)) return str;
  return `"${str.replace(/"/g, '\\"')}"`;
}

function toPaneTitle(index) {
  return index === 0 ? "lead" : `worker-${index}`;
}

function parsePaneList(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [indexText, target] = line.split("\t");
      return {
        index: parseInt(indexText, 10),
        target: target?.trim() || "",
      };
    })
    .filter((entry) => Number.isFinite(entry.index) && entry.target)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.target);
}

function parseSessionSummaries(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const colonIndex = line.indexOf(":");
      if (colonIndex === -1) {
        return null;
      }

      const sessionName = line.slice(0, colonIndex).trim();
      const flags = [...line.matchAll(/\(([^)]*)\)/g)].map((match) => match[1]).join(", ");
      const attachedMatch = flags.match(/(\d+)\s+attached/);
      const attachedCount = attachedMatch
        ? parseInt(attachedMatch[1], 10)
        : /\battached\b/.test(flags)
          ? 1
          : 0;

      return sessionName
        ? { sessionName, attachedCount }
        : null;
    })
    .filter(Boolean);
}

function collectSessionPanes(sessionName) {
  const output = psmuxExec(
    `list-panes -t ${quoteArg(`${sessionName}:0`)} -F "#{pane_index}\t#{session_name}:#{window_index}.#{pane_index}"`
  );
  return parsePaneList(output);
}

function psmux(args, opts = {}) {
  if (Array.isArray(args)) {
    const result = spawnSync(PSMUX_BIN, args.map((arg) => String(arg)), {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...opts,
    });
    if ((result.status ?? 1) !== 0) {
      const error = new Error((result.stderr || result.stdout || "psmux command failed").trim());
      error.status = result.status;
      throw error;
    }
    return (result.stdout || "").trim();
  }

  const result = execSync(`${quoteArg(PSMUX_BIN)} ${args}`, {
    encoding: "utf8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...opts,
  });
  return result != null ? result.trim() : "";
}

/** psmux 실행 가능 여부 확인 */
export function hasPsmux() {
  try {
    execSync(`${quoteArg(PSMUX_BIN)} -V`, {
      stdio: "ignore",
      timeout: 3000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * psmux 커맨드 실행 래퍼
 * @param {string|string[]} args
 * @param {object} opts
 * @returns {string}
 */
export function psmuxExec(args, opts = {}) {
  return psmux(args, opts);
}

/**
 * psmux 세션 생성 + 레이아웃 분할
 * @param {string} sessionName
 * @param {object} opts
 * @param {'2x2'|'1xN'|'Nx1'} opts.layout
 * @param {number} opts.paneCount
 * @returns {{ sessionName: string, panes: string[] }}
 */
export function createPsmuxSession(sessionName, opts = {}) {
  const layout = opts.layout === "1xN" || opts.layout === "Nx1" ? opts.layout : "2x2";
  const paneCount = Math.max(
    1,
    Number.isFinite(opts.paneCount) ? Math.trunc(opts.paneCount) : 4
  );
  const limitedPaneCount = layout === "2x2" ? Math.min(paneCount, 4) : paneCount;
  const sessionTarget = `${sessionName}:0`;

  const leadPane = psmuxExec(
    `new-session -d -P -F "#{session_name}:#{window_index}.#{pane_index}" -s ${quoteArg(sessionName)} -x 220 -y 55`
  );

  if (layout === "2x2" && limitedPaneCount >= 3) {
    const rightPane = psmuxExec(
      `split-window -h -P -F "#{session_name}:#{window_index}.#{pane_index}" -t ${quoteArg(leadPane)}`
    );
    psmuxExec(
      `split-window -v -P -F "#{session_name}:#{window_index}.#{pane_index}" -t ${quoteArg(rightPane)}`
    );
    if (limitedPaneCount >= 4) {
      psmuxExec(
        `split-window -v -P -F "#{session_name}:#{window_index}.#{pane_index}" -t ${quoteArg(leadPane)}`
      );
    }
    psmuxExec(`select-layout -t ${quoteArg(sessionTarget)} tiled`);
  } else if (layout === "1xN") {
    for (let i = 1; i < limitedPaneCount; i++) {
      psmuxExec(`split-window -h -t ${quoteArg(sessionTarget)}`);
    }
    psmuxExec(`select-layout -t ${quoteArg(sessionTarget)} even-horizontal`);
  } else {
    for (let i = 1; i < limitedPaneCount; i++) {
      psmuxExec(`split-window -v -t ${quoteArg(sessionTarget)}`);
    }
    psmuxExec(`select-layout -t ${quoteArg(sessionTarget)} even-vertical`);
  }

  psmuxExec(`select-pane -t ${quoteArg(leadPane)}`);

  const panes = collectSessionPanes(sessionName).slice(0, limitedPaneCount);
  panes.forEach((pane, index) => {
    psmuxExec(`select-pane -t ${quoteArg(pane)} -T ${quoteArg(toPaneTitle(index))}`);
  });

  return { sessionName, panes };
}

/**
 * psmux 세션 종료
 * @param {string} sessionName
 */
export function killPsmuxSession(sessionName) {
  try {
    psmuxExec(`kill-session -t ${quoteArg(sessionName)}`, { stdio: "ignore" });
  } catch {
    // 이미 종료된 세션 — 무시
  }
}

/**
 * psmux 세션 존재 확인
 * @param {string} sessionName
 * @returns {boolean}
 */
export function psmuxSessionExists(sessionName) {
  try {
    psmuxExec(`has-session -t ${quoteArg(sessionName)}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * tfx-multi- 접두사 psmux 세션 목록
 * @returns {string[]}
 */
export function listPsmuxSessions() {
  try {
    return parseSessionSummaries(psmuxExec("list-sessions"))
      .map((session) => session.sessionName)
      .filter((sessionName) => sessionName.startsWith("tfx-multi-"));
  } catch {
    return [];
  }
}

/**
 * pane 마지막 N줄 캡처
 * @param {string} target
 * @param {number} lines
 * @returns {string}
 */
export function capturePsmuxPane(target, lines = 5) {
  try {
    const full = psmuxExec(`capture-pane -t ${quoteArg(target)} -p`);
    const nonEmpty = full.split("\n").filter((line) => line.trim() !== "");
    return nonEmpty.slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/**
 * psmux 세션 연결
 * @param {string} sessionName
 */
export function attachPsmuxSession(sessionName) {
  const result = spawnSync(PSMUX_BIN, ["attach-session", "-t", sessionName], {
    stdio: "inherit",
    timeout: 0,
    windowsHide: false,
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`psmux attach 실패 (exit=${result.status})`);
  }
}

/**
 * 세션 attach client 수 조회
 * @param {string} sessionName
 * @returns {number|null}
 */
export function getPsmuxSessionAttachedCount(sessionName) {
  try {
    const session = parseSessionSummaries(psmuxExec("list-sessions"))
      .find((entry) => entry.sessionName === sessionName);
    return session ? session.attachedCount : null;
  } catch {
    return null;
  }
}

/**
 * 팀메이트 조작 키 바인딩 설정
 * @param {string} sessionName
 * @param {object} opts
 * @param {boolean} opts.inProcess
 * @param {string} opts.taskListCommand
 */
export function configurePsmuxKeybindings(sessionName, opts = {}) {
  const { inProcess = false, taskListCommand = "" } = opts;
  const cond = `#{==:#{session_name},${sessionName}}`;
  const target = `${sessionName}:0`;
  const bindNext = inProcess
    ? `'select-pane -t :.+ \\; resize-pane -Z'`
    : `'select-pane -t :.+'`;
  const bindPrev = inProcess
    ? `'select-pane -t :.- \\; resize-pane -Z'`
    : `'select-pane -t :.-'`;

  // psmux는 세션별 서버이므로 -t target으로 세션 컨텍스트를 전달해야 한다
  const bindSafe = (cmd) => {
    try { psmuxExec(`-t ${quoteArg(target)} ${cmd}`); } catch { /* 미지원 시 무시 */ }
  };

  bindSafe(`bind-key -T root -n S-Down if-shell -F '${cond}' ${bindNext} 'send-keys S-Down'`);
  bindSafe(`bind-key -T root -n S-Up if-shell -F '${cond}' ${bindPrev} 'send-keys S-Up'`);
  bindSafe(`bind-key -T root -n S-Right if-shell -F '${cond}' ${bindNext} 'send-keys S-Right'`);
  bindSafe(`bind-key -T root -n S-Left if-shell -F '${cond}' ${bindPrev} 'send-keys S-Left'`);
  bindSafe(`bind-key -T root -n BTab if-shell -F '${cond}' ${bindPrev} 'send-keys BTab'`);
  bindSafe(`bind-key -T root -n Escape if-shell -F '${cond}' 'send-keys C-c' 'send-keys Escape'`);

  if (taskListCommand) {
    const escaped = taskListCommand.replace(/'/g, "'\\''");
    bindSafe(
      `bind-key -T root -n C-t if-shell -F '${cond}' "display-popup -E '${escaped}'" "send-keys C-t"`
    );
  }
}

// ─── 하이브리드 모드 워커 관리 함수 ───

/**
 * psmux 세션의 새 pane에서 워커 실행
 * @param {string} sessionName - 대상 psmux 세션 이름
 * @param {string} workerName - 워커 식별용 pane 타이틀
 * @param {string} cmd - 실행할 커맨드
 * @returns {{ paneId: string, workerName: string }}
 */
export function spawnWorker(sessionName, workerName, cmd) {
  if (!hasPsmux()) {
    throw new Error("psmux가 설치되어 있지 않습니다. psmux를 먼저 설치하세요.");
  }
  try {
    // 세션 컨텍스트 포함 타겟 반환 (psmux는 세션별 서버 모델)
    const paneTarget = psmuxExec(
      `split-window -t ${quoteArg(sessionName)} -P -F "#{session_name}:#{window_index}.#{pane_index}" ${quoteArg(cmd)}`
    );
    psmuxExec(`select-pane -t ${quoteArg(paneTarget)} -T ${quoteArg(workerName)}`);
    return { paneId: paneTarget, workerName };
  } catch (err) {
    throw new Error(`워커 생성 실패 (session=${sessionName}, worker=${workerName}): ${err.message}`);
  }
}

/**
 * 워커 pane 실행 상태 확인
 * @param {string} sessionName - 대상 psmux 세션 이름
 * @param {string} workerName - 워커 pane 타이틀
 * @returns {{ status: "running"|"exited", exitCode: number|null, paneId: string }}
 */
export function getWorkerStatus(sessionName, workerName) {
  if (!hasPsmux()) {
    throw new Error("psmux가 설치되어 있지 않습니다.");
  }
  try {
    const output = psmuxExec(
      `list-panes -t ${quoteArg(sessionName)} -F "#{pane_title}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_dead}\t#{pane_dead_status}"`
    );
    const lines = output.split("\n").filter(Boolean);
    for (const line of lines) {
      const [title, paneId, dead, deadStatus] = line.split("\t");
      if (title === workerName) {
        const isDead = dead === "1";
        return {
          status: isDead ? "exited" : "running",
          exitCode: isDead ? parseInt(deadStatus, 10) || 0 : null,
          paneId,
        };
      }
    }
    throw new Error(`워커를 찾을 수 없습니다: ${workerName}`);
  } catch (err) {
    if (err.message.includes("워커를 찾을 수 없습니다")) throw err;
    throw new Error(`워커 상태 조회 실패 (session=${sessionName}, worker=${workerName}): ${err.message}`);
  }
}

/**
 * 워커 pane 프로세스 강제 종료
 * @param {string} sessionName - 대상 psmux 세션 이름
 * @param {string} workerName - 워커 pane 타이틀
 * @returns {{ killed: boolean }}
 */
export function killWorker(sessionName, workerName) {
  if (!hasPsmux()) {
    throw new Error("psmux가 설치되어 있지 않습니다.");
  }
  try {
    // paneId 찾기
    const { paneId } = getWorkerStatus(sessionName, workerName);
    // C-c로 우아한 종료 시도
    try {
      psmuxExec(`send-keys -t ${quoteArg(paneId)} C-c`);
    } catch {
      // send-keys 실패 무시
    }
    // 1초 대기 후 pane 강제 종료
    spawnSync("sleep", ["1"], { stdio: "ignore", windowsHide: true });
    try {
      psmuxExec(`kill-pane -t ${quoteArg(paneId)}`);
    } catch {
      // 이미 종료된 pane — 무시
    }
    return { killed: true };
  } catch (err) {
    if (err.message.includes("워커를 찾을 수 없습니다")) {
      return { killed: false };
    }
    throw new Error(`워커 종료 실패 (session=${sessionName}, worker=${workerName}): ${err.message}`);
  }
}

/**
 * 워커 pane 출력 마지막 N줄 캡처
 * @param {string} sessionName - 대상 psmux 세션 이름
 * @param {string} workerName - 워커 pane 타이틀
 * @param {number} lines - 캡처할 줄 수 (기본 50)
 * @returns {string} 캡처된 출력
 */
export function captureWorkerOutput(sessionName, workerName, lines = 50) {
  if (!hasPsmux()) {
    throw new Error("psmux가 설치되어 있지 않습니다.");
  }
  try {
    const { paneId } = getWorkerStatus(sessionName, workerName);
    return psmuxExec(`capture-pane -t ${quoteArg(paneId)} -p -S -${lines}`);
  } catch (err) {
    if (err.message.includes("워커를 찾을 수 없습니다")) throw err;
    throw new Error(`출력 캡처 실패 (session=${sessionName}, worker=${workerName}): ${err.message}`);
  }
}

// ─── CLI 진입점 ───

if (process.argv[1] && process.argv[1].endsWith("psmux.mjs")) {
  const [,, cmd, ...args] = process.argv;

  // CLI 인자 파싱 헬퍼
  function getArg(name) {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  }

  try {
    switch (cmd) {
      case "spawn": {
        const session = getArg("session");
        const name = getArg("name");
        const workerCmd = getArg("cmd");
        if (!session || !name || !workerCmd) {
          console.error("사용법: node psmux.mjs spawn --session <세션> --name <워커명> --cmd <커맨드>");
          process.exit(1);
        }
        const result = spawnWorker(session, name, workerCmd);
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case "status": {
        const session = getArg("session");
        const name = getArg("name");
        if (!session || !name) {
          console.error("사용법: node psmux.mjs status --session <세션> --name <워커명>");
          process.exit(1);
        }
        const result = getWorkerStatus(session, name);
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case "kill": {
        const session = getArg("session");
        const name = getArg("name");
        if (!session || !name) {
          console.error("사용법: node psmux.mjs kill --session <세션> --name <워커명>");
          process.exit(1);
        }
        const result = killWorker(session, name);
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case "output": {
        const session = getArg("session");
        const name = getArg("name");
        const lines = parseInt(getArg("lines") || "50", 10);
        if (!session || !name) {
          console.error("사용법: node psmux.mjs output --session <세션> --name <워커명> [--lines <줄수>]");
          process.exit(1);
        }
        console.log(captureWorkerOutput(session, name, lines));
        break;
      }
      default:
        console.error("사용법: node psmux.mjs spawn|status|kill|output [args]");
        console.error("");
        console.error("  spawn   --session <세션> --name <워커명> --cmd <커맨드>");
        console.error("  status  --session <세션> --name <워커명>");
        console.error("  kill    --session <세션> --name <워커명>");
        console.error("  output  --session <세션> --name <워커명> [--lines <줄수>]");
        process.exit(1);
    }
  } catch (err) {
    console.error(`오류: ${err.message}`);
    process.exit(1);
  }
}
