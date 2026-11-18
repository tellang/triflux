import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IS_WINDOWS } from "../platform.mjs";

const CLEANUP_SCRIPT_DIR = join(tmpdir(), "tfx-process-utils");
const SCAN_SCRIPT_PATH = join(CLEANUP_SCRIPT_DIR, "scan-processes.ps1");
const TREE_SCRIPT_PATH = join(CLEANUP_SCRIPT_DIR, "get-ancestor-tree.ps1");

// 스크립트 내용 변경 시 버전을 올려 캐시된 스크립트를 갱신한다.
const SCRIPT_VERSION = 4;
const VERSION_FILE = join(CLEANUP_SCRIPT_DIR, ".version");
const FSMONITOR_DAEMON_MARKER = "fsmonitor--daemon run --detach";
const FSMONITOR_DAEMON_PATTERN =
  /(^|\s)fsmonitor--daemon\s+run\s+--detach(\s|$)/;
const DEFAULT_FSMONITOR_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const LEGACY_ORPHAN_KILLABLE_NAMES = new Set([
  "node.exe",
  "bash.exe",
  "cmd.exe",
  "uvx.exe",
]);
const LIVE_CLI_SESSION_ROOT_NAMES = new Set([
  "codex.exe",
  "claude.exe",
  "gemini.exe",
]);

// EPERM은 프로세스는 있으나 signal 권한이 없는 상태이므로 alive로 본다.
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e?.code === "EPERM") return true;
    if (e?.code === "ESRCH") return false;
    return false;
  }
}

export function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    if (e?.code === "EPERM") return true;
    return false;
  }
}

// 직접 실행 판정. 문자열로 붙인 file:// 은 공백, 한글 경로에서 어긋나므로 양쪽 실제 경로로 비교한다.
export function isMainModule(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  return realPathOf(entry) === realPathOf(fileURLToPath(moduleUrl));
}

function realPathOf(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// bash의 $_ 이스케이핑 문제를 피하기 위해 -File로 실행한다.
function ensureHelperScripts() {
  mkdirSync(CLEANUP_SCRIPT_DIR, { recursive: true });

  let needsUpdate = true;
  try {
    if (existsSync(VERSION_FILE)) {
      const cached = Number.parseInt(
        readFileSync(VERSION_FILE, "utf8").trim(),
        10,
      );
      if (cached === SCRIPT_VERSION) needsUpdate = false;
    }
  } catch {}

  if (needsUpdate) {
    try {
      unlinkSync(SCAN_SCRIPT_PATH);
    } catch {}
    try {
      unlinkSync(TREE_SCRIPT_PATH);
    } catch {}
  }

  if (!existsSync(TREE_SCRIPT_PATH)) {
    writeFileSync(
      TREE_SCRIPT_PATH,
      [
        "param([int]$StartPid)",
        "$p = $StartPid",
        "for ($i = 0; $i -lt 10; $i++) {",
        "    if ($p -le 0) { break }",
        "    Write-Output $p",
        '    $parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue).ParentProcessId',
        "    if ($null -eq $parent -or $parent -le 0) { break }",
        "    $p = $parent",
        "}",
      ].join("\n"),
      "utf8",
    );
  }

  if (!existsSync(SCAN_SCRIPT_PATH)) {
    // codex/claude/pwsh/uvx가 빠지면 중간 셸이 alive로 판정돼 고아 트리 전체가 보호된다.
    // 예: WT(dead) 아래 pwsh(alive, 미스캔), 그 아래 codex, cmd, node 순서면 pwsh에서 끊긴다.
    writeFileSync(
      SCAN_SCRIPT_PATH,
      [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='bash.exe' OR Name='cmd.exe' OR Name='codex.exe' OR Name='claude.exe' OR Name='gemini.exe' OR Name='pwsh.exe' OR Name='uvx.exe'\" | ForEach-Object {",
        '    Write-Output "$($_.ProcessId),$($_.ParentProcessId),$($_.Name)"',
        "}",
      ].join("\n"),
      "utf8",
    );
  }

  if (needsUpdate) {
    writeFileSync(VERSION_FILE, String(SCRIPT_VERSION), "utf8");
  }
}

function hasLiveAncestorChain(pid, procMap, protectedPids) {
  const visited = new Set();
  let current = pid;

  while (current > 0 && !visited.has(current)) {
    visited.add(current);

    if (protectedPids.has(current)) return true;

    const info = procMap.get(current);
    if (!info) {
      return isPidAlive(current);
    }
    if (LIVE_CLI_SESSION_ROOT_NAMES.has(normalizeName(info.name))) {
      return true;
    }

    const ppid = info.ppid;
    if (!Number.isFinite(ppid) || ppid <= 0) {
      // ppid=0 시스템 프로세스는 보호한다.
      return true;
    }

    if (!procMap.has(ppid) && !isPidAlive(ppid)) return false;

    current = ppid;
  }

  return false;
}

function hasLiveCliDescendant(pid, procMap) {
  const children = new Map();
  for (const proc of procMap.values()) {
    if (!Number.isFinite(proc.ppid) || proc.ppid <= 0) continue;
    const list = children.get(proc.ppid) || [];
    list.push(proc);
    children.set(proc.ppid, list);
  }

  const visited = new Set();
  const stack = [...(children.get(pid) || [])];
  while (stack.length > 0) {
    const proc = stack.pop();
    if (!proc || visited.has(proc.pid)) continue;
    visited.add(proc.pid);
    if (LIVE_CLI_SESSION_ROOT_NAMES.has(normalizeName(proc.name))) {
      return true;
    }
    stack.push(...(children.get(proc.pid) || []));
  }
  return false;
}

// `tfx doctor --fix` 호환 별칭
export function cleanupOrphanNodeProcesses(opts = {}) {
  return cleanupOrphanRuntimeProcesses(opts);
}

function normalizePowerShellJson(output) {
  const trimmed = String(output || "").trim();
  if (!trimmed || trimmed === "null") return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function parseCreationDateMs(value) {
  if (!value) return NaN;
  if (value instanceof Date) return value.getTime();

  const text = String(value);
  const dotNetMatch = /\/Date\((-?\d+)\)\//.exec(text);
  if (dotNetMatch) return Number.parseInt(dotNetMatch[1], 10);

  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : NaN;
}

function normalizePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function normalizeName(name) {
  return String(name || "").toLowerCase();
}

function processRecordFromCim(record) {
  const pid = normalizePid(record?.ProcessId ?? record?.pid);
  if (!pid) return null;
  const ppid = Number(record?.ParentProcessId ?? record?.ppid ?? 0);
  return {
    pid,
    ppid: Number.isFinite(ppid) ? ppid : 0,
    name: String(record?.Name ?? record?.name ?? ""),
    commandLine: String(record?.CommandLine ?? record?.commandLine ?? ""),
    creationDate: record?.CreationDate,
  };
}

function runSpawn(spawnSyncFn, command, args, options = {}) {
  return spawnSyncFn(command, args, {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function runPowerShellJson(spawnSyncFn, command) {
  const result = runSpawn(spawnSyncFn, "powershell", [
    "-NoProfile",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command,
  ]);
  if (result.status !== 0) {
    throw new Error(
      String(result.stderr || result.error || "PowerShell failed"),
    );
  }
  return normalizePowerShellJson(result.stdout);
}

function getWindowsProcessSnapshot(spawnSyncFn = spawnSync) {
  const records = runPowerShellJson(
    spawnSyncFn,
    "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ConvertTo-Json -Depth 3 -Compress",
  );
  return records.map(processRecordFromCim).filter(Boolean);
}

function parsePosixProcessSnapshot(output) {
  const processes = [];
  for (const line of String(output || "")
    .split(/\r?\n/)
    .slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/.exec(trimmed);
    if (!match) continue;
    processes.push({
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
      name: match[3],
      commandLine: match[4] || match[3],
    });
  }
  return processes;
}

function getPosixProcessSnapshot(spawnSyncFn = spawnSync) {
  const result = runSpawn(spawnSyncFn, "ps", ["-eo", "pid,ppid,comm,args"]);
  if (result.status !== 0) return [];
  return parsePosixProcessSnapshot(result.stdout);
}

function getProcessSnapshot({
  isWindows = IS_WINDOWS,
  spawnSyncFn = spawnSync,
} = {}) {
  try {
    return isWindows
      ? getWindowsProcessSnapshot(spawnSyncFn)
      : getPosixProcessSnapshot(spawnSyncFn);
  } catch {
    return [];
  }
}

function getProtectedPids({
  protectedPids,
  isWindows = IS_WINDOWS,
  spawnSyncFn = spawnSync,
  includeAncestorScan = false,
} = {}) {
  const result = new Set(protectedPids || []);
  result.add(process.pid);
  if (Number.isInteger(process.ppid) && process.ppid > 0) {
    result.add(process.ppid);
  }
  if (!includeAncestorScan) return result;

  const snapshot = getProcessSnapshot({ isWindows, spawnSyncFn });
  const byPid = new Map(snapshot.map((proc) => [proc.pid, proc]));
  let current = process.pid;
  const seen = new Set();
  while (current > 0 && !seen.has(current)) {
    seen.add(current);
    result.add(current);
    const parent = byPid.get(current)?.ppid;
    if (!Number.isInteger(parent) || parent <= 0) break;
    current = parent;
  }

  return result;
}

function collectDescendants(rootPid, processes) {
  const childrenByParent = new Map();
  for (const proc of processes) {
    if (!childrenByParent.has(proc.ppid)) childrenByParent.set(proc.ppid, []);
    childrenByParent.get(proc.ppid).push(proc);
  }

  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const root = byPid.get(rootPid) || {
    pid: rootPid,
    ppid: 0,
    name: "",
    commandLine: "",
  };
  const result = [];
  const queue = [root];
  const seen = new Set();

  while (queue.length > 0) {
    const proc = queue.shift();
    if (!proc || seen.has(proc.pid)) continue;
    seen.add(proc.pid);
    result.push(proc);
    for (const child of childrenByParent.get(proc.pid) || []) {
      queue.push(child);
    }
  }

  return result;
}

function snapshotPids(snapshot) {
  const values = Array.isArray(snapshot) ? snapshot : [snapshot];
  return values
    .map((item) => normalizePid(typeof item === "object" ? item?.pid : item))
    .filter(Boolean);
}

function matchesPattern(commandLine, pattern, { exact = false } = {}) {
  if (pattern instanceof RegExp) return pattern.test(commandLine);
  const text = String(pattern || "");
  if (!text) return false;
  return exact ? commandLine === text : commandLine.includes(text);
}

export function findProcessTree(
  rootPid,
  { isWindows = IS_WINDOWS, spawnSyncFn = spawnSync } = {},
) {
  const pid = normalizePid(rootPid);
  if (!pid) return [];
  const snapshot = getProcessSnapshot({ isWindows, spawnSyncFn });
  return collectDescendants(pid, snapshot).map((proc) => ({
    pid: proc.pid,
    ppid: proc.ppid,
    name: proc.name,
    commandLine: proc.commandLine,
  }));
}

export function killProcessTree(
  pid,
  {
    isWindows = IS_WINDOWS,
    spawnSyncFn = spawnSync,
    killFn = process.kill,
    isPidAliveFn = isPidAlive,
    protectedPids,
  } = {},
) {
  const rootPid = normalizePid(pid);
  const protectedSet = getProtectedPids({
    protectedPids,
    isWindows,
    spawnSyncFn,
  });
  const errors = [];
  if (!rootPid) return { ok: false, killed: 0, errors: ["invalid pid"] };
  if (protectedSet.has(rootPid)) {
    return { ok: false, killed: 0, errors: ["protected pid"] };
  }

  if (isWindows) {
    const result = runSpawn(spawnSyncFn, "taskkill", [
      "/T",
      "/F",
      "/PID",
      String(rootPid),
    ]);
    if (result.status === 0) return { ok: true, killed: 1, errors };
    errors.push(String(result.stderr || result.error || "taskkill failed"));

    const tree = findProcessTree(rootPid, { isWindows, spawnSyncFn })
      .filter((proc) => proc.pid !== rootPid)
      .reverse();
    let killed = 0;
    for (const proc of tree) {
      if (protectedSet.has(proc.pid) || !isPidAliveFn(proc.pid)) continue;
      try {
        killFn(proc.pid, "SIGKILL");
        killed++;
      } catch (error) {
        errors.push({ pid: proc.pid, error: String(error?.message || error) });
      }
    }
    return { ok: killed > 0, killed, errors };
  }

  let killed = 0;
  try {
    killFn(-rootPid, "SIGKILL");
    killed++;
  } catch (error) {
    errors.push({ pid: -rootPid, error: String(error?.message || error) });
    try {
      killFn(rootPid, "SIGKILL");
      killed++;
    } catch (fallbackError) {
      errors.push({
        pid: rootPid,
        error: String(fallbackError?.message || fallbackError),
      });
    }
  }

  return { ok: killed > 0, killed, errors };
}

// 부모가 이미 죽어 트리 조회로 자손을 찾을 수 없을 때 스냅샷으로 SIGKILL을 보낸다.
export function killProcessTreeSnapshot(
  snapshot,
  {
    killFn = process.kill,
    isPidAliveFn = isPidAlive,
    protectedPids = new Set(),
  } = {},
) {
  let killed = 0;
  let missing = 0;
  for (const pid of snapshotPids(snapshot)) {
    if (protectedPids.has(pid)) continue;
    if (!isPidAliveFn(pid)) {
      missing++;
      continue;
    }
    try {
      killFn(pid, "SIGKILL");
      killed++;
    } catch {
      missing++;
    }
  }
  return { killed, missing };
}

export function findProcessesByCommandLine(
  patterns,
  {
    isWindows = IS_WINDOWS,
    spawnSyncFn = spawnSync,
    exact = false,
    nowMs = Date.now(),
  } = {},
) {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  if (list.length === 0) return [];

  return getProcessSnapshot({ isWindows, spawnSyncFn })
    .filter((proc) =>
      list.some((pattern) =>
        matchesPattern(proc.commandLine, pattern, { exact }),
      ),
    )
    .map((proc) => {
      const creationMs = parseCreationDateMs(proc.creationDate);
      const result = {
        pid: proc.pid,
        name: proc.name,
        commandLine: proc.commandLine,
      };
      if (Number.isFinite(creationMs)) result.ageMs = nowMs - creationMs;
      return result;
    });
}

// 조상 체인이 살아 있거나 Claude/Codex/Gemini 자손이 있으면 건드리지 않는다.
// 운영 호출자가 Windows `tfx doctor --fix` 하나라 다른 OS 에서는 아무것도 하지 않는다.
export function cleanupOrphanRuntimeProcesses({
  isWindows = IS_WINDOWS,
  spawnSyncFn = spawnSync,
  killFn = process.kill,
  protectedPids,
} = {}) {
  if (!isWindows) return { killed: 0, remaining: 0, killedProcesses: [] };

  const protectedSet = getProtectedPids({
    protectedPids,
    isWindows,
    spawnSyncFn,
    includeAncestorScan: true,
  });
  const processes = getProcessSnapshot({ isWindows, spawnSyncFn });
  const procMap = new Map(processes.map((proc) => [proc.pid, proc]));
  let killed = 0;
  const killedProcesses = [];

  for (const proc of processes) {
    if (
      protectedSet.has(proc.pid) ||
      !LEGACY_ORPHAN_KILLABLE_NAMES.has(normalizeName(proc.name)) ||
      hasLiveAncestorChain(proc.pid, procMap, protectedSet) ||
      hasLiveCliDescendant(proc.pid, procMap)
    )
      continue;
    try {
      killFn(proc.pid, "SIGKILL");
      killed++;
      killedProcesses.push({
        pid: proc.pid,
        ppid: proc.ppid,
        name: proc.name,
        commandLine: String(proc.commandLine || "").slice(0, 200),
        killReason: "legacy_orphan_ancestor_chain_dead",
      });
    } catch {}
  }

  const remaining = processes.length - killed;
  return { killed, remaining, killedProcesses };
}

// Windows 전용. 포그라운드 git 명령을 건드리지 않게 marker를 좁게 제한한다.
export function findFsmonitorDaemons({
  minAgeMs = DEFAULT_FSMONITOR_MIN_AGE_MS,
  execSyncFn = execSync,
  nowMs = Date.now(),
  isWindows = IS_WINDOWS,
} = {}) {
  if (!isWindows) return [];

  ensureHelperScripts();

  let records;
  try {
    const output = execSyncFn(
      `powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process -Filter \\"Name='git.exe'\\" | Where-Object { $_.CommandLine -match '(^|\\s)fsmonitor--daemon run --detach(\\s|$)' } | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress"`,
      {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    records = normalizePowerShellJson(output);
  } catch {
    return [];
  }

  const stale = [];
  for (const record of records) {
    const pid = Number(record?.ProcessId);
    const parentPid = Number(record?.ParentProcessId);
    const commandLine = String(record?.CommandLine || "");
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (!commandLine.includes(FSMONITOR_DAEMON_MARKER)) continue;
    if (!FSMONITOR_DAEMON_PATTERN.test(commandLine)) continue;

    const creationMs = parseCreationDateMs(record?.CreationDate);
    const ageMs = Number.isFinite(creationMs) ? nowMs - creationMs : NaN;
    if (!Number.isFinite(ageMs) || ageMs < minAgeMs) continue;

    stale.push({
      pid,
      parentPid: Number.isFinite(parentPid) ? parentPid : 0,
      creationDate: String(record?.CreationDate || ""),
      ageMs,
      commandLine,
    });
  }

  return stale;
}

export function cleanupStaleFsmonitorDaemons({
  killFn = process.kill,
  ...findOpts
} = {}) {
  const stale = findFsmonitorDaemons(findOpts);
  let killed = 0;

  for (const proc of stale) {
    try {
      killFn(proc.pid, "SIGKILL");
      killed++;
    } catch {}
  }

  return { killed, stale };
}
