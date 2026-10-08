// hub/team/agents-row.mjs: 워커 tmux pane 을 `claude agents` 행으로 노출한다.
// 행의 백킹 job 은 공식 `claude --bg --exec` 로 띄운 tmux attach client 다.
// Enter 를 누르면 그 PTY, 곧 워커가 도는 tmux 방이 열린다(ADR-0026).

import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getMultiplexerType, psmuxExec } from "./psmux.mjs";

const execFileAsync = promisify(execFile);
const ATTACH_HELPER = join(
  dirname(fileURLToPath(import.meta.url)),
  "agents-row-attach.py",
);
const READ_ONLY_SUFFIX = " [read-only]";

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// daemon 이 띄운 셸의 PATH 는 호출자와 다를 수 있어 절대 경로로 넘긴다.
export function resolveExecutable(name, envPath = process.env.PATH || "") {
  if (isAbsolute(name)) return name;
  for (const dir of envPath.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* 다음 후보 */
    }
  }
  return "";
}

/** tmux target 을 서버 안에서 유일한 socket/session/pane ID 로 고정한다. */
export function resolveTmuxPane(target, { tmux = psmuxExec } = {}) {
  const out = tmux([
    "display-message",
    "-p",
    "-t",
    String(target),
    "#{socket_path}\t#{session_id}\t#{pane_id}\t#{session_name}",
  ]);
  const [socketPath, sessionId, paneId, sessionName] = String(out)
    .trim()
    .split("\t");
  if (!socketPath || !/^\$\d+$/u.test(sessionId) || !/^%\d+$/u.test(paneId)) {
    throw new Error(`tmux pane을 확인할 수 없습니다: ${target}`);
  }
  return { socketPath, sessionId, paneId, sessionName };
}

/**
 * 행의 백킹 명령. pane 이 등록한 세션에 그대로 있는 동안 attach 를 반복하고,
 * 방이 사라지면 자기 행을 지운다. 대화형은 python3 중계로 터미널 응답 누수를 걸러 내고,
 * 그 밖에는 읽기 전용 attach 로 입력 자체를 막는다.
 */
export function buildAgentsRowCommand({
  tmuxBin,
  claudeBin = "claude",
  pane,
  interactive = false,
  python = "",
}) {
  const q = shellQuote;
  const tmux = `${q(tmuxBin)} -S ${q(pane.socketPath)}`;
  const readOnly = !(interactive && python);
  const attach = [
    ...(readOnly ? [] : [q(python), q(ATTACH_HELPER), "--"]),
    "env -u TMUX -u TMUX_PANE",
    tmux,
    `attach-session -t ${q(pane.paneId)}`,
    // -r 은 read-only,ignore-size 와 같고 tmux 3.2 이전에도 있다.
    ...(readOnly ? ["-r"] : []),
  ].join(" ");
  // 같은 번호의 다른 방에 붙지 않도록 pane 의 세션 ID 를 매번 대조한다.
  const alive = `[ "$(${tmux} display-message -p -t ${q(pane.paneId)} '#{session_id}' 2>/dev/null)" = ${q(pane.sessionId)} ]`;
  // CLAUDE_JOB_DIR 의 끝이 이 job 의 short id 다. job 이 끝난 뒤 지우도록 nohup 으로 띄운다.
  const removeSelf = `nohup sh -c 'sleep 1; exec "$0" rm "\${CLAUDE_JOB_DIR##*/}"' ${q(claudeBin)} >/dev/null 2>&1 &`;
  // attach 가 바로 끝나기를 5번 연달아 반복하면 고칠 수 없는 실패로 보고 멈춘다.
  const loop = `n=0; while ${alive}; do t=$(date +%s); ${attach}; if [ $(($(date +%s) - t)) -lt 2 ]; then n=$((n + 1)); else n=0; fi; [ "$n" -ge 5 ] && break; sleep 1; done`;
  return { readOnly, command: `${loop}; ${removeSelf}` };
}

// macOS 에는 CLT 설치 안내만 띄우는 /usr/bin/python3 스텁이 있어 실제로 한 번 돌려 본다.
async function usablePython(resolve, run) {
  const python = resolve("python3");
  if (!python) return "";
  try {
    await run(python, ["-c", "import pty"], { timeout: 5_000 });
    return python;
  } catch {
    return "";
  }
}

export function parseBackgroundShort(stdout) {
  const match = /backgrounded · ([0-9a-f]{6,}) ·/u.exec(String(stdout));
  return match ? match[1] : "";
}

/**
 * 워커 pane 하나를 `claude agents` 행으로 연다.
 * @returns {Promise<{short:string, name:string, readOnly:boolean, pane:object}>}
 */
export async function openAgentsRow({
  name,
  target,
  cwd = process.cwd(),
  interactive = false,
  _deps = {},
} = {}) {
  if (!name) throw new Error("name is required");
  const tmux = _deps.tmux || psmuxExec;
  const run = _deps.execFile || execFileAsync;
  const resolve = _deps.resolveExecutable || resolveExecutable;
  const pane = resolveTmuxPane(target, { tmux });
  const tmuxBin = resolve(getMultiplexerType()) || getMultiplexerType();
  const claudeBin = _deps.claudeBin || resolve("claude") || "claude";
  const python = interactive ? await usablePython(resolve, run) : "";
  const { command, readOnly } = buildAgentsRowCommand({
    tmuxBin,
    claudeBin,
    pane,
    interactive,
    python,
  });
  // 대화형인데 읽기 전용으로 떨어졌으면 행 이름에서 바로 보이게 한다.
  const rowName = interactive && readOnly ? `${name}${READ_ONLY_SUFFIX}` : name;
  const { stdout = "", stderr = "" } = await run(
    claudeBin,
    ["--bg", "--name", rowName, "--exec", command],
    { cwd, timeout: 20_000, encoding: "utf8" },
  );
  const short = parseBackgroundShort(`${stdout}\n${stderr}`);
  if (!short) {
    throw new Error(`claude --bg 출력에서 id를 찾지 못했습니다: ${stdout}`);
  }
  return { short, name: rowName, readOnly, pane };
}

/** 행을 지운다. rm 은 실행 중인 job 도 멈춘다. 워커 tmux 방은 건드리지 않는다. */
export async function closeAgentsRow(short, { _deps = {} } = {}) {
  if (!short) return;
  const run = _deps.execFile || execFileAsync;
  await run(_deps.claudeBin || "claude", ["rm", short], {
    timeout: 10_000,
  }).catch(() => {});
}

/** 실행이 연 행만 정확히 한 번 닫는다. */
export function createAgentsRowOwnership(close = closeAgentsRow) {
  const shorts = new Set();
  return {
    get size() {
      return shorts.size;
    },
    add(short) {
      if (short) shorts.add(short);
    },
    async release() {
      const owned = [...shorts];
      shorts.clear();
      await Promise.all(owned.map((short) => close(short)));
    },
  };
}

/**
 * tfx-live start 가 띄운 Claude 외 CLI 세션을 대화형 행으로 노출한다.
 * Claude 세션은 원래 목록에 뜨므로 건너뛴다. 실패해도 start 는 성공으로 두고 경고만 돌려준다.
 */
export async function exposeLiveSession(
  { cli, session, name, cwd, remote, ready },
  _deps,
) {
  if (process.env.TFX_AGENTS_ROW === "0") return {};
  if (remote || cli === "claude" || !ready) return {};
  try {
    const row = await openAgentsRow({
      name: name || session,
      target: session,
      cwd,
      interactive: true,
      _deps,
    });
    return {
      agentsRow: row.short,
      ...(row.readOnly
        ? { agentsRowWarning: "python3 not found; row is read-only" }
        : {}),
    };
  } catch (error) {
    return { agentsRowWarning: error?.message || String(error) };
  }
}
