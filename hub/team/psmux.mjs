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
 * tfx-team- 접두사 psmux 세션 목록
 * @returns {string[]}
 */
export function listPsmuxSessions() {
  try {
    return parseSessionSummaries(psmuxExec("list-sessions"))
      .map((session) => session.sessionName)
      .filter((sessionName) => sessionName.startsWith("tfx-team-"));
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
  const bindNext = inProcess
    ? `'select-pane -t :.+ \\; resize-pane -Z'`
    : `'select-pane -t :.+'`;
  const bindPrev = inProcess
    ? `'select-pane -t :.- \\; resize-pane -Z'`
    : `'select-pane -t :.-'`;

  psmuxExec(`bind-key -T root -n S-Down if-shell -F '${cond}' ${bindNext} 'send-keys S-Down'`);
  psmuxExec(`bind-key -T root -n S-Up if-shell -F '${cond}' ${bindPrev} 'send-keys S-Up'`);
  psmuxExec(`bind-key -T root -n S-Right if-shell -F '${cond}' ${bindNext} 'send-keys S-Right'`);
  psmuxExec(`bind-key -T root -n S-Left if-shell -F '${cond}' ${bindPrev} 'send-keys S-Left'`);
  psmuxExec(`bind-key -T root -n BTab if-shell -F '${cond}' ${bindPrev} 'send-keys BTab'`);
  psmuxExec(`bind-key -T root -n Escape if-shell -F '${cond}' 'send-keys C-c' 'send-keys Escape'`);

  if (taskListCommand) {
    const escaped = taskListCommand.replace(/'/g, "'\\''");
    try {
      psmuxExec(
        `bind-key -T root -n C-t if-shell -F '${cond}' "display-popup -E '${escaped}'" "send-keys C-t"`
      );
    } catch {
      psmuxExec(
        `bind-key -T root -n C-t if-shell -F '${cond}' 'display-message "tfx team tasks 명령으로 태스크 확인"' 'send-keys C-t'`
      );
    }
  }
}
