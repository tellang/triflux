import * as childProcess from "../lib/spawn-trace.mjs";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { platform as osPlatform, tmpdir } from "node:os";
import { join } from "node:path";

import { sendKeysToPane } from "./psmux.mjs";

const DEFAULT_WINDOW_NAME = "triflux";
const DEFAULT_MAX_TABS = 8;
const DEFAULT_TAB_CREATE_DELAY_MS = 500;
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const DEFAULT_WAIT_POLL_MS = 300;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function resolvePositiveInteger(...values) {
  for (const value of values) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function sanitizeTitleForPidFile(title) {
  const sanitized = [...String(title).trim()]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || '<>:"/\\|?*'.includes(character) ? "_" : character;
    })
    .join("");

  return (
    sanitized
      .replace(/\s+/gu, "-")
      .replace(/_+/gu, "_")
      .replace(/-+/gu, "-")
      .replace(/^[-_]+|[-_]+$/gu, "") || "wt-tab"
  );
}

function escapePowerShellSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

function buildPidFilePath(pidDir, title) {
  return join(pidDir, `${sanitizeTitleForPidFile(title)}.pid`);
}

function buildWrappedCommand(pidFile, command) {
  const escapedPidFile = escapePowerShellSingleQuoted(pidFile);
  const pidWrite = `$PID | Set-Content '${escapedPidFile}'`;
  return command ? `${pidWrite}; ${command}` : pidWrite;
}

/**
 * PowerShell -EncodedCommand용 Base64 인코딩.
 * CreateProcess 이중 쿼팅 문제를 완전히 회피한다.
 */
function encodeForPowerShell(script) {
  const buf = Buffer.from(script, "utf16le");
  return buf.toString("base64");
}

function matchesTitlePattern(title, pattern) {
  if (!pattern) return true;
  if (pattern instanceof RegExp) return pattern.test(title);
  return String(title).includes(String(pattern));
}

function defaultIsPidAlive(pid, execFileSyncFn = childProcess.execFileSync) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // tasklist fallback — process.kill(..., 0)이 권한/플랫폼 차이로 실패할 수 있음.
  }

  try {
    const output = execFileSyncFn(
      "tasklist",
      ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
      {
        encoding: "utf8",
        timeout: 3_000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    return (
      !/No tasks are running/u.test(String(output)) &&
      String(output).includes(`"${pid}"`)
    );
  } catch {
    return false;
  }
}

/**
 * Windows Terminal 탭/세션 라이프사이클 관리자.
 *
 * @param {object} [opts]
 * @param {string} [opts.windowName='triflux']
 * @param {number} [opts.maxTabs=8]
 * @param {string} [opts.pidDir=os.tmpdir()/wt-manager-pids]
 * @param {number} [opts.tabCreateDelayMs=500]
 * @param {object} [opts.deps] — 테스트용 의존성 주입
 */
export function createWtManager(opts = {}) {
  const deps = opts.deps || {};
  const platform = deps.platform || osPlatform;

  if (platform() !== "win32") {
    throw new Error("wt-manager.mjs is Windows-only");
  }

  const now = deps.now || Date.now;
  const sleepFn = deps.sleep || sleep;
  const spawnFn = deps.spawn || childProcess.spawn;
  const execFileSyncFn = deps.execFileSync || childProcess.execFileSync;
  const killFn = deps.kill || ((pid) => process.kill(pid));
  const sendKeysFn = deps.sendKeysToPane || sendKeysToPane;
  const isPidAlive =
    deps.isPidAlive || ((pid) => defaultIsPidAlive(pid, execFileSyncFn));
  const ensureDir =
    deps.ensureDir || ((dir) => mkdirSync(dir, { recursive: true }));
  const exists = deps.exists || existsSync;
  const readText =
    deps.readText || ((filePath) => readFileSync(filePath, "utf8"));
  const removeFile =
    deps.removeFile || ((filePath) => rmSync(filePath, { force: true }));

  const windowName = String(opts.windowName || DEFAULT_WINDOW_NAME);
  const maxTabs =
    resolvePositiveInteger(
      opts.maxTabs,
      process.env.WTM_MAX_TABS,
      DEFAULT_MAX_TABS,
    ) || DEFAULT_MAX_TABS;
  const pidDir = String(opts.pidDir || join(tmpdir(), "wt-manager-pids"));
  const tabCreateDelayMs =
    resolvePositiveInteger(
      opts.tabCreateDelayMs,
      DEFAULT_TAB_CREATE_DELAY_MS,
    ) || DEFAULT_TAB_CREATE_DELAY_MS;

  ensureDir(pidDir);

  /** @type {Map<string, { pid: number, createdAt: number, pidFile: string }>} */
  const tabs = new Map();
  let lastTabCreateAt = null;

  function forgetTab(title) {
    const entry = tabs.get(title);
    if (entry) {
      tabs.delete(title);
      try {
        removeFile(entry.pidFile);
      } catch {
        /* ignore */
      }
    }
  }

  function pruneDeadTabs() {
    for (const [title, entry] of tabs.entries()) {
      if (!isPidAlive(entry.pid)) {
        forgetTab(title);
      }
    }
  }

  async function throttleTabCreate() {
    if (lastTabCreateAt == null) return;
    const elapsed = now() - lastTabCreateAt;
    if (elapsed < tabCreateDelayMs) {
      await sleepFn(tabCreateDelayMs - elapsed);
    }
  }

  async function waitTabReady(title, pidFile) {
    const deadline = now() + DEFAULT_WAIT_TIMEOUT_MS;

    while (now() <= deadline) {
      if (exists(pidFile)) {
        const pid = Number.parseInt(String(readText(pidFile)).trim(), 10);
        if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) {
          return pid;
        }
      }

      const remaining = deadline - now();
      if (remaining <= 0) break;
      await sleepFn(Math.min(DEFAULT_WAIT_POLL_MS, remaining));
    }

    throw new Error(`WT tab ready timeout: ${title}`);
  }

  async function createTab(tab = {}) {
    const title = String(tab.title || "").trim();
    if (!title) {
      throw new Error("title is required");
    }

    pruneDeadTabs();

    if (tabs.has(title)) {
      throw new Error(`WT tab already exists: ${title}`);
    }

    if (tabs.size >= maxTabs) {
      throw new Error(`WT max tabs exceeded (${maxTabs})`);
    }

    await throttleTabCreate();

    const pidFile = buildPidFilePath(pidDir, title);
    try {
      removeFile(pidFile);
    } catch {
      /* ignore */
    }

    const args = ["-w", windowName, "nt", "--title", title];
    if (tab.profile) {
      args.push("--profile", String(tab.profile));
    }
    if (tab.cwd) {
      args.push("-d", String(tab.cwd));
    }
    const script = buildWrappedCommand(pidFile, tab.command);
    args.push(
      "--",
      "powershell.exe",
      "-NoExit",
      "-EncodedCommand",
      encodeForPowerShell(script),
    );

    const child = spawnFn("wt.exe", args, {
      detached: true,
      stdio: "ignore",
    });
    child?.unref?.();

    lastTabCreateAt = now();
    const pid = await waitTabReady(title, pidFile);
    const entry = Object.freeze({
      pid,
      createdAt: now(),
      pidFile,
    });
    tabs.set(title, entry);
  }

  async function closeTab(title) {
    const normalizedTitle = String(title || "").trim();
    if (!normalizedTitle) return;

    const entry = tabs.get(normalizedTitle);
    if (!entry) return;

    try {
      killFn(entry.pid);
    } catch {
      // 이미 종료된 PID는 map 정리만 수행한다.
    }

    forgetTab(normalizedTitle);
  }

  function listTabs() {
    pruneDeadTabs();
    return [...tabs.entries()].map(([title, entry]) =>
      Object.freeze({
        title,
        pid: entry.pid,
        createdAt: entry.createdAt,
      }),
    );
  }

  async function closeStale(closeOpts = {}) {
    pruneDeadTabs();

    const olderThanMs = Number.isFinite(closeOpts.olderThanMs)
      ? Math.max(0, Math.trunc(closeOpts.olderThanMs))
      : 0;
    const titlePattern = closeOpts.titlePattern;
    const snapshot = [...tabs.entries()];
    let closed = 0;

    for (const [title, entry] of snapshot) {
      const ageMs = now() - entry.createdAt;
      if (ageMs < olderThanMs) continue;
      if (!matchesTitlePattern(title, titlePattern)) continue;
      await closeTab(title);
      closed += 1;
    }

    return closed;
  }

  /**
   * 현재 탭을 split-pane으로 분할.
   * @param {object} opts
   * @param {'H'|'V'} [opts.direction='V'] — H=좌우, V=상하
   * @param {string} [opts.title]
   * @param {string} [opts.profile]
   * @param {string} [opts.cwd]
   * @param {string} [opts.command] — pane에서 실행할 명령
   * @param {number} [opts.size] — 퍼센트 (0-100)
   */
  async function splitPane(opts = {}) {
    const direction = opts.direction === "H" ? "-H" : "-V";
    const args = ["-w", windowName, "sp", direction];

    if (opts.title) {
      args.push("--title", String(opts.title));
    }
    if (opts.profile) {
      args.push("--profile", String(opts.profile));
    }
    if (opts.size && Number.isFinite(opts.size)) {
      args.push("-s", String(opts.size / 100));
    }
    if (opts.cwd) {
      args.push("-d", String(opts.cwd));
    }
    if (opts.command) {
      const script = opts.command;
      args.push(
        "--",
        "powershell.exe",
        "-NoExit",
        "-EncodedCommand",
        encodeForPowerShell(script),
      );
    }

    const child = spawnFn("wt.exe", args, {
      detached: true,
      stdio: "ignore",
    });
    child?.unref?.();

    // split-pane은 기존 탭 안에서 분할하므로 throttle 적용
    await sleepFn(tabCreateDelayMs);
  }

  /**
   * 여러 세션을 split-pane 레이아웃으로 한번에 배치.
   * @param {Array<{title: string, command: string, direction?: 'H'|'V', size?: number}>} panes
   */
  async function applySplitLayout(panes) {
    if (!panes || panes.length === 0) return;

    // 첫 번째는 새 탭으로 생성
    const first = panes[0];
    await createTab({
      title: first.title,
      command: first.command,
      profile: first.profile,
    });

    // 나머지는 split-pane으로 분할
    for (let i = 1; i < panes.length; i++) {
      await splitPane({
        direction: panes[i].direction || "V",
        title: panes[i].title,
        command: panes[i].command,
        profile: panes[i].profile,
        size: panes[i].size,
      });
    }
  }

  async function createSession(sessionOpts = {}) {
    const tab =
      typeof sessionOpts.tab === "string"
        ? { title: sessionOpts.tab }
        : sessionOpts.tab;

    if (!tab || typeof tab !== "object") {
      throw new Error("tab is required");
    }
    if (!sessionOpts.pane) {
      throw new Error("pane is required");
    }
    if (!sessionOpts.command) {
      throw new Error("command is required");
    }

    await createTab(tab);
    sendKeysFn(String(sessionOpts.pane), String(sessionOpts.command), true);
  }

  function getTabCount() {
    pruneDeadTabs();
    return tabs.size;
  }

  return Object.freeze({
    createTab,
    closeTab,
    listTabs,
    closeStale,
    createSession,
    splitPane,
    applySplitLayout,
    getTabCount,
  });
}
