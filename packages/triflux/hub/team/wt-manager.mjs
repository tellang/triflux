import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { platform as osPlatform, tmpdir } from "node:os";
import { join } from "node:path";
import { getEnvironment } from "../lib/env-detect.mjs";
import * as childProcess from "../lib/spawn-trace.mjs";
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
 * WT 기본 프로필의 폰트 크기를 읽는다.
 */
function getWtDefaultFontSize() {
  const settingsPaths = [
    join(
      process.env.LOCALAPPDATA || "",
      "Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json",
    ),
    join(
      process.env.LOCALAPPDATA || "",
      "Microsoft/Windows Terminal/settings.json",
    ),
  ];
  for (const p of settingsPaths) {
    if (!existsSync(p)) continue;
    try {
      const settings = JSON.parse(
        readFileSync(p, "utf8").replace(/^\s*\/\/.*$/gm, ""),
      );
      const defaultGuid = settings.defaultProfile;
      const profiles = settings.profiles?.list || [];
      const defaultProfile =
        profiles.find((pr) => pr.guid === defaultGuid) || profiles[0];
      return (
        defaultProfile?.font?.size ||
        settings.profiles?.defaults?.font?.size ||
        12
      );
    } catch {
      /* 다음 */
    }
  }
  return 12;
}

/**
 * 파일을 원자적으로 쓴다.
 */
function atomicWriteSync(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmpPath, data, "utf8");
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* 무시 */
    }
    throw err;
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
  const getEnvironmentFn = deps.getEnvironment || getEnvironment;
  const isPidAlive =
    deps.isPidAlive || ((pid) => defaultIsPidAlive(pid, execFileSyncFn));
  const ensureDir =
    deps.ensureDir || ((dir) => mkdirSync(dir, { recursive: true }));
  const exists = deps.exists || existsSync;
  const readText =
    deps.readText || ((filePath) => readFileSync(filePath, "utf8"));
  const renameFile = deps.renameFile || renameSync;
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
  const waitTimeoutMs =
    resolvePositiveInteger(
      opts.waitTimeoutMs,
      process.env.WTM_WAIT_TIMEOUT_MS,
      DEFAULT_WAIT_TIMEOUT_MS,
    ) || DEFAULT_WAIT_TIMEOUT_MS;

  ensureDir(pidDir);

  /** @type {Map<string, { pid: number, createdAt: number, pidFile: string }>} */
  const tabs = new Map();
  let lastTabCreateAt = null;
  let _profileEnsured = false;

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

  function ensureWtProfile(workerCount = 2) {
    const settingsPaths = [
      join(
        process.env.LOCALAPPDATA || "",
        "Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json",
      ),
      join(
        process.env.LOCALAPPDATA || "",
        "Microsoft/Windows Terminal/settings.json",
      ),
    ];

    for (const settingsPath of settingsPaths) {
      if (!exists(settingsPath)) continue;
      try {
        const raw = readText(settingsPath);
        const cleaned = raw.replace(/^\s*\/\/.*$/gm, "");
        const settings = JSON.parse(cleaned);
        if (!settings.profiles?.list) continue;

        const existing = settings.profiles.list.findIndex(
          (p) => p.name === "triflux",
        );
        const profile = {
          name: "triflux",
          commandline: "psmux",
          icon: "\u{1F53A}",
          tabTitle: "triflux",
          suppressApplicationTitle: true,
          opacity: 40,
          useAcrylic: true,
          unfocusedAppearance: { opacity: 20 },
          colorScheme: "One Half Dark",
          font: {
            size: Math.max(
              6,
              getWtDefaultFontSize() - 1 - Math.floor(workerCount / 2),
            ),
          },
          closeOnExit: "always",
          hidden: true,
        };

        if (existing >= 0) {
          settings.profiles.list[existing] = {
            ...settings.profiles.list[existing],
            ...profile,
          };
        } else {
          settings.profiles.list.push(profile);
        }

        atomicWriteSync(settingsPath, JSON.stringify(settings, null, 2));
        _profileEnsured = true;
        return true;
      } catch {
        /* 파싱 실패 */
      }
    }
    return false;
  }

  async function createTab(tab = {}) {
    const title = String(tab.title || "").trim();
    if (!title) {
      throw new Error("title is required");
    }

    const env = getEnvironmentFn();
    if (env?.terminal?.hasWt === false) {
      return Object.freeze({
        success: false,
        reason: "wt-not-installed",
        installHint: env.terminal.installHint || null,
      });
    }

    const shellPath = String(opts.profile || env?.shell?.path || "pwsh.exe");

    // 프로필이 지정된 경우 WT settings.json에 존재하는지 보장
    // headless가 workerCount 기반으로 이미 호출한 경우 _profileEnsured로 skip
    if (tab.profile && !_profileEnsured) {
      try {
        ensureWtProfile();
      } catch {
        /* 프로필 보장 실패해도 진행 */
      }
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
      shellPath,
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
    return Object.freeze({
      success: true,
      title,
      pid: entry.pid,
      createdAt: entry.createdAt,
      pidFile: entry.pidFile,
    });
  }

  function renameTab({ oldTitle, newTitle } = {}) {
    const previousTitle = String(oldTitle || "").trim();
    const nextTitle = String(newTitle || "").trim();
    if (!previousTitle) {
      throw new Error("oldTitle is required");
    }
    if (!nextTitle) {
      throw new Error("newTitle is required");
    }

    pruneDeadTabs();

    const entry = tabs.get(previousTitle);
    if (!entry) {
      return false;
    }
    if (previousTitle === nextTitle) {
      return Object.freeze({
        success: true,
        title: nextTitle,
        pid: entry.pid,
        createdAt: entry.createdAt,
        pidFile: entry.pidFile,
      });
    }
    if (tabs.has(nextTitle)) {
      throw new Error(`WT tab already exists: ${nextTitle}`);
    }

    const nextPidFile = buildPidFilePath(pidDir, nextTitle);
    try {
      removeFile(nextPidFile);
    } catch {
      /* ignore */
    }
    renameFile(entry.pidFile, nextPidFile);

    tabs.delete(previousTitle);
    const nextEntry = Object.freeze({
      ...entry,
      pidFile: nextPidFile,
    });
    tabs.set(nextTitle, nextEntry);
    return Object.freeze({
      success: true,
      title: nextTitle,
      pid: nextEntry.pid,
      createdAt: nextEntry.createdAt,
      pidFile: nextEntry.pidFile,
    });
  }

  function getEnvironmentInfo() {
    return getEnvironmentFn();
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
  async function splitPane(splitOpts = {}) {
    // 프로필이 지정된 경우 WT settings.json에 존재하는지 보장
    if (splitOpts.profile && !_profileEnsured) {
      try {
        ensureWtProfile();
      } catch {
        /* 프로필 보장 실패해도 진행 */
      }
    }

    const direction = splitOpts.direction === "H" ? "-H" : "-V";
    const args = ["-w", windowName, "sp", direction];

    if (splitOpts.title) {
      args.push("--title", String(splitOpts.title));
    }
    if (splitOpts.profile) {
      args.push("--profile", String(splitOpts.profile));
    }
    if (splitOpts.size && Number.isFinite(splitOpts.size)) {
      args.push("-s", String(splitOpts.size / 100));
    }
    if (splitOpts.cwd) {
      args.push("-d", String(splitOpts.cwd));
    }
    if (splitOpts.command) {
      const env = getEnvironmentFn();
      const shellPath = String(opts.profile || env?.shell?.path || "pwsh.exe");
      const script = splitOpts.command;
      args.push(
        "--",
        shellPath,
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
    const createResult = await createTab({
      title: first.title,
      command: first.command,
      profile: first.profile,
    });
    if (createResult?.success === false) {
      return createResult;
    }

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

    return createResult;
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

    const createResult = await createTab(tab);
    if (createResult?.success === false) {
      return createResult;
    }
    sendKeysFn(String(sessionOpts.pane), String(sessionOpts.command), true);
    return createResult;
  }

  function getTabCount() {
    pruneDeadTabs();
    return tabs.size;
  }

  return Object.freeze({
    ensureWtProfile,
    createTab,
    renameTab,
    closeTab,
    listTabs,
    closeStale,
    createSession,
    splitPane,
    applySplitLayout,
    getEnvironmentInfo,
    getTabCount,
  });
}
