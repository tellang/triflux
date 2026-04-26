// hub/lib/process-utils.mjs
// 프로세스 관련 공유 유틸리티

import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { IS_WINDOWS, killProcess } from "../platform.mjs";

const CLEANUP_SCRIPT_DIR = join(tmpdir(), "tfx-process-utils");
const SCAN_SCRIPT_PATH = join(CLEANUP_SCRIPT_DIR, "scan-processes.ps1");
const TREE_SCRIPT_PATH = join(CLEANUP_SCRIPT_DIR, "get-ancestor-tree.ps1");

// 스크립트 버전 — 내용 변경 시 증가하여 캐시된 스크립트를 갱신
const SCRIPT_VERSION = 4;
const VERSION_FILE = join(CLEANUP_SCRIPT_DIR, ".version");
const FSMONITOR_DAEMON_MARKER = "fsmonitor--daemon run --detach";
const FSMONITOR_DAEMON_PATTERN =
  /(^|\s)fsmonitor--daemon\s+run\s+--detach(\s|$)/;
const DEFAULT_FSMONITOR_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * 주어진 PID의 프로세스가 살아있는지 확인한다.
 * EPERM: 프로세스는 존재하지만 signal 권한 없음 → alive
 * ESRCH: 프로세스가 존재하지 않음 → dead
 */
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

/**
 * 동기적 sleep. Atomics.wait 우선, 불가 시 busy-wait 폴백.
 */
function sleepSyncMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin */
    }
  }
}

/**
 * 고아 PID 목록에 SIGTERM → 3초 대기 → SIGKILL 에스컬레이션을 적용한다.
 * PID 재사용 레이스 방어: SIGTERM 전 alive 확인, SIGKILL 전 재검증.
 * @param {number[]} orphanPids
 * @param {Map<number, {ppid: number, name: string}>} [procMap] PID 재사용 감지용 스냅샷
 * @returns {number} killed count
 */
function killWithEscalation(orphanPids, procMap) {
  if (orphanPids.length === 0) return 0;

  // SIGTERM 전 alive 스냅샷 — 이미 죽은 PID는 카운트에서 제외
  const aliveBeforeKill = new Set(orphanPids.filter((pid) => isPidAlive(pid)));

  for (const pid of aliveBeforeKill) {
    killProcess(pid, { signal: "SIGTERM" });
  }

  sleepSyncMs(3000);

  let killed = 0;
  for (const pid of aliveBeforeKill) {
    if (isPidAlive(pid)) {
      // PID 재사용 방어: procMap이 있으면 스캔 시점의 ppid와 현재 ppid 비교
      // ppid가 변경되었으면 PID가 재사용된 것이므로 kill하지 않���
      if (procMap) {
        const snapshot = procMap.get(pid);
        if (snapshot) {
          try {
            const current = execSync(
              IS_WINDOWS
                ? `powershell -NoProfile -WindowStyle Hidden -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction SilentlyContinue).ParentProcessId"`
                : `ps -o ppid= -p ${pid}`,
              {
                encoding: "utf8",
                timeout: 3000,
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
              },
            );
            const currentPpid = Number.parseInt(current.trim(), 10);
            if (Number.isFinite(currentPpid) && currentPpid !== snapshot.ppid) {
              continue; // PID 재사용 감지 — skip
            }
          } catch {
            // 조회 실패 시 안전하게 skip
            continue;
          }
        }
      }
      killProcess(pid, {
        signal: "SIGKILL",
        force: true,
        tree: IS_WINDOWS,
      });
    }
    if (!isPidAlive(pid)) killed++;
  }
  return killed;
}

/**
 * PowerShell 헬퍼 스크립트를 임시 디렉토리에 생성한다.
 * bash의 $_ 이스케이핑 문제를 피하기 위해 -File로 실행.
 */
function ensureHelperScripts() {
  mkdirSync(CLEANUP_SCRIPT_DIR, { recursive: true });

  // 버전 체크 — 스크립트 갱신 필요 여부
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
    // 기존 스크립트 삭제 후 재생성
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
    // CLI + 쉘 + 런타임 전체를 스캔하여 PID,ParentPID,Name 출력
    // codex/claude/pwsh/uvx 누락 시 중간 프로세스가 alive 판정되어 고아 트리 전체가 보호됨
    // 예: WT(dead)→pwsh(alive,미스캔)→codex→cmd→node — pwsh에서 isPidAlive=true로 끊김
    writeFileSync(
      SCAN_SCRIPT_PATH,
      [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='bash.exe' OR Name='cmd.exe' OR Name='codex.exe' OR Name='claude.exe' OR Name='pwsh.exe' OR Name='uvx.exe'\" | ForEach-Object {",
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

/**
 * PID → 루트 조상까지의 체인에서 살아있는 조상이 있는지 확인한다.
 * 프로세스 맵을 사용하여 O(depth) 탐색.
 * @param {number} pid
 * @param {Map<number, {ppid: number, name: string}>} procMap
 * @param {Set<number>} protectedPids
 * @returns {boolean} true = 보호됨 (활성 조상 체인이 있음)
 */
function hasLiveAncestorChain(pid, procMap, protectedPids) {
  const visited = new Set();
  let current = pid;

  while (current > 0 && !visited.has(current)) {
    visited.add(current);

    if (protectedPids.has(current)) return true;

    const info = procMap.get(current);
    if (!info) {
      // 프로세스 맵에 없음 → 살아있는지 직접 확인
      return isPidAlive(current);
    }

    const ppid = info.ppid;
    if (!Number.isFinite(ppid) || ppid <= 0) {
      // 루트 프로세스 (ppid=0) — 시스템 프로세스이므로 보호
      return true;
    }

    // 부모가 맵에 없고 죽었으면 → 고아 체인
    if (!procMap.has(ppid) && !isPidAlive(ppid)) return false;

    current = ppid;
  }

  return false;
}

/**
 * Legacy wrapper for scoped orphan node runtime cleanup.
 * @param {Parameters<typeof cleanupOrphanRuntimeProcesses>[0]} opts
 * @returns {{ killed: number, remaining: number }}
 */
export function cleanupOrphanNodeProcesses(opts = {}) {
  return cleanupOrphanRuntimeProcesses({ ...opts, legacy: true });
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

function normalizeCommandLine(commandLine) {
  return String(commandLine || "").replace(/\//g, "\\");
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
    [
      "$ErrorActionPreference='SilentlyContinue'",
      "Get-CimInstance Win32_Process |",
      "Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate |",
      "ConvertTo-Json -Compress",
    ].join("; "),
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

function addHubPid(protectedPids) {
  try {
    const hubPidPath = join(
      homedir(),
      ".claude",
      "cache",
      "tfx-hub",
      "hub.pid",
    );
    if (existsSync(hubPidPath)) {
      const hubInfo = JSON.parse(readFileSync(hubPidPath, "utf8"));
      const hubPid = normalizePid(hubInfo?.pid);
      if (hubPid) protectedPids.add(hubPid);
    }
  } catch {}
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
  addHubPid(result);
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

function hasExactGbrainServe(commandLine) {
  return /^("?[^"\s]*bun(?:\.exe)?"?\s+)?gbrain\s+serve$/i.test(
    commandLine.trim(),
  );
}

function hasExactFsmonitorDaemon(commandLine) {
  return /^("?[^"\s]*git(?:\.exe)?"?\s+)?fsmonitor--daemon\s+run\s+--detach$/i.test(
    commandLine.trim(),
  );
}

function categoryForShardProcess(proc, context) {
  const name = normalizeName(proc.name);
  const commandLine = normalizeCommandLine(proc.commandLine);
  const worktreePath = normalizeCommandLine(context.worktreePath || "");
  const shardMarker = context.shardName
    ? `.codex-swarm\\wt-${context.shardName}`
    : "";
  const hasWorktree = worktreePath && commandLine.includes(worktreePath);
  const hasShardMarker = shardMarker && commandLine.includes(shardMarker);

  if (name === "node.exe" || name === "node") {
    if (hasWorktree || hasShardMarker) return "node";
  }

  if (name === "bash.exe" || name === "bash" || name === "sh") {
    if (hasWorktree) return "bash";
  }

  if (name === "conhost.exe" || name === "conhost") {
    if (
      context.sessionIds?.length > 0 &&
      context.sessionIds.some((id) => id && commandLine.includes(id))
    ) {
      return "conhost";
    }
  }

  if (name === "bun.exe" || name === "bun") {
    if (hasExactGbrainServe(proc.commandLine)) return "bun";
  }

  if (name === "git.exe" || name === "git") {
    if (hasExactFsmonitorDaemon(proc.commandLine)) return "git";
  }

  return null;
}

function killPid(
  pid,
  { killFn = process.kill, protectedPids = new Set() } = {},
) {
  if (protectedPids.has(pid)) return false;
  killFn(pid, "SIGKILL");
  return true;
}

/**
 * Return a process tree rooted at `rootPid`.
 *
 * Windows queries `Get-CimInstance Win32_Process` once and builds a
 * ParentProcessId map. POSIX uses `ps` as a best-effort fallback.
 *
 * @param {number} rootPid
 * @param {{isWindows?: boolean, spawnSyncFn?: typeof spawnSync}} opts
 * @returns {Array<{pid: number, ppid: number, name: string, commandLine: string}>}
 */
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

/**
 * Kill a process tree.
 *
 * Windows tries `taskkill /T /F /PID <pid>` first. If that fails, it falls
 * back to a CIM process snapshot and kills descendants recursively. POSIX
 * first targets the process group, then the PID itself.
 *
 * @param {number} pid
 * @param {{isWindows?: boolean, spawnSyncFn?: typeof spawnSync, killFn?: typeof process.kill, isPidAliveFn?: typeof isPidAlive, protectedPids?: Set<number>}} opts
 * @returns {{ok: boolean, killed: number, errors: Array}}
 */
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

/**
 * Kill a previously captured PID snapshot with SIGKILL.
 *
 * This is used when a parent process has already died and tree lookup can no
 * longer reconstruct the original descendants.
 *
 * @param {Array<number | {pid: number}>} snapshot
 * @param {{killFn?: typeof process.kill, isPidAliveFn?: typeof isPidAlive, protectedPids?: Set<number>}} opts
 * @returns {{killed: number, missing: number}}
 */
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

/**
 * Find processes whose command line matches any string or RegExp pattern.
 *
 * String patterns use substring matching by default; pass `exact: true` for
 * exact command-line equality.
 *
 * @param {Array<RegExp | string>} patterns
 * @param {{isWindows?: boolean, spawnSyncFn?: typeof spawnSync, exact?: boolean, nowMs?: number}} opts
 * @returns {Array<{pid: number, name: string, commandLine: string, ageMs?: number}>}
 */
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

/**
 * Cleanup processes associated with a swarm shard.
 *
 * Sequence: kill known top PID snapshots, scan scoped command lines, skip
 * protected PIDs, and kill only narrowly gated runtime categories.
 *
 * @param {{worktreePath?: string, sessionIds?: string[], topPids?: Array<number | {pid: number}>, runId?: string, shardName?: string, dryRun?: boolean, isWindows?: boolean, spawnSyncFn?: typeof spawnSync, killFn?: typeof process.kill, protectedPids?: Set<number>}} opts
 * @returns {{killed: number, scanned: number, skipped: number, byCategory: {node: number, bash: number, conhost: number, bun: number, git: number}}}
 */
export function cleanupShardProcesses({
  worktreePath,
  sessionIds = [],
  topPids = [],
  runId,
  shardName,
  dryRun = false,
  isWindows = IS_WINDOWS,
  spawnSyncFn = spawnSync,
  killFn = process.kill,
  protectedPids,
} = {}) {
  const protectedSet = getProtectedPids({
    protectedPids,
    isWindows,
    spawnSyncFn,
    includeAncestorScan: true,
  });
  const byCategory = { node: 0, bash: 0, conhost: 0, bun: 0, git: 0 };
  let killed = 0;
  let skipped = 0;

  if (!dryRun && topPids.length > 0) {
    killed += killProcessTreeSnapshot(topPids, {
      killFn,
      protectedPids: protectedSet,
    }).killed;
  }

  const scanned = getProcessSnapshot({ isWindows, spawnSyncFn });

  for (const proc of scanned) {
    const category = categoryForShardProcess(proc, {
      worktreePath,
      sessionIds,
      shardName,
    });
    if (!category) continue;
    byCategory[category]++;
    if (protectedSet.has(proc.pid)) {
      skipped++;
      continue;
    }
    if (dryRun) continue;
    try {
      if (killPid(proc.pid, { killFn, protectedPids: protectedSet })) killed++;
    } catch {}
  }

  return { killed, scanned: scanned.length, skipped, byCategory };
}

/**
 * Cleanup narrowly gated orphan runtime processes.
 *
 * Windows scans node/bash/bun and optional conhost command lines. POSIX is a
 * best-effort fallback. `legacy: true` preserves `cleanupOrphanNodeProcesses`
 * behavior by targeting scoped orphan node runtimes only.
 *
 * @param {{legacy?: boolean, includeConhost?: boolean, sessionIds?: string[], isWindows?: boolean, spawnSyncFn?: typeof spawnSync, killFn?: typeof process.kill, protectedPids?: Set<number>}} opts
 * @returns {{killed: number, remaining: number}}
 */
export function cleanupOrphanRuntimeProcesses({
  legacy = false,
  includeConhost = false,
  sessionIds = [],
  isWindows = IS_WINDOWS,
  spawnSyncFn = spawnSync,
  killFn = process.kill,
  protectedPids,
} = {}) {
  if (!isWindows) return cleanupOrphansUnix();

  const protectedSet = getProtectedPids({
    protectedPids,
    isWindows,
    spawnSyncFn,
  });
  const processes = getProcessSnapshot({ isWindows, spawnSyncFn });
  let killed = 0;

  for (const proc of processes) {
    if (protectedSet.has(proc.pid)) continue;
    const name = normalizeName(proc.name);
    const commandLine = normalizeCommandLine(proc.commandLine);
    let shouldKill = false;

    if (legacy) {
      shouldKill =
        name === "node.exe" &&
        commandLine.includes(".codex-swarm\\wt-") &&
        /hub\\server\.mjs/i.test(commandLine);
    } else if (name === "bun.exe") {
      shouldKill = hasExactGbrainServe(proc.commandLine);
    } else if (includeConhost && name === "conhost.exe") {
      shouldKill =
        sessionIds.length > 0 &&
        sessionIds.some((id) => id && commandLine.includes(id));
    }

    if (!shouldKill) continue;
    try {
      killFn(proc.pid, "SIGKILL");
      killed++;
    } catch {}
  }

  const remaining = processes.length - killed;
  return { killed, remaining };
}

/**
 * Find stale git fsmonitor--daemon processes.
 *
 * Windows only. The CIM query is scoped to git.exe and the command line marker
 * is intentionally narrow so foreground git commands are never targeted.
 *
 * @param {{minAgeMs?: number, execSyncFn?: typeof execSync, nowMs?: number, isWindows?: boolean}} opts
 * @returns {Array<{pid: number, parentPid: number, creationDate: string, ageMs: number, commandLine: string}>}
 */
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

/**
 * Cleanup stale git fsmonitor--daemon processes.
 * @param {{minAgeMs?: number, execSyncFn?: typeof execSync, nowMs?: number, isWindows?: boolean, killFn?: typeof process.kill}} opts
 * @returns {{killed: number, stale: Array}}
 */
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

/**
 * Unix/macOS 고아 프로세스 정리.
 * `ps -eo pid,ppid,comm` 기반 프로세스 맵 → 동일한 조상 체인 판정 → SIGKILL 에스컬레이션.
 * @returns {{ killed: number, remaining: number }}
 */
function cleanupOrphansUnix() {
  const myPid = process.pid;

  // Hub PID 보호
  const protectedPids = new Set();
  protectedPids.add(myPid);
  try {
    const hubPidPath = join(
      homedir(),
      ".claude",
      "cache",
      "tfx-hub",
      "hub.pid",
    );
    if (existsSync(hubPidPath)) {
      const hubPid = Number(JSON.parse(readFileSync(hubPidPath, "utf8"))?.pid);
      if (Number.isFinite(hubPid) && hubPid > 0) protectedPids.add(hubPid);
    }
  } catch {}

  // 현재 프로세스의 조상 트리 보호
  try {
    let current = myPid;
    for (let i = 0; i < 10; i++) {
      protectedPids.add(current);
      const output = execSync(`ps -o ppid= -p ${current}`, {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const ppid = Number.parseInt(output.trim(), 10);
      if (!Number.isFinite(ppid) || ppid <= 1) break;
      current = ppid;
    }
  } catch {}

  // 프로세스 맵 구축 (런타임 + CLI — 체인 추적 정확도를 위해 CLI도 포함)
  const procMap = new Map();
  try {
    const output = execSync("ps -eo pid,ppid,comm", {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    for (const line of output.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const pid = Number.parseInt(parts[0], 10);
      const ppid = Number.parseInt(parts[1], 10);
      const name = parts.slice(2).join(" ");
      if (
        Number.isFinite(pid) &&
        pid > 0 &&
        /^(node|bash|sh|python|codex|claude|uvx)/.test(name)
      ) {
        procMap.set(pid, { ppid, name });
      }
    }
  } catch {}

  // kill 대상: node, python, codex, claude, uvx — bash/sh는 사용자 인터랙티브 쉘 가능성
  const killableUnix = /^(node|python|codex|claude|uvx)/;

  // 고아 판정 + SIGKILL 에스컬레이션
  const orphanPids = [];
  for (const [pid, info] of procMap) {
    if (protectedPids.has(pid)) continue;
    if (!killableUnix.test(info.name)) continue;
    if (hasLiveAncestorChain(pid, procMap, protectedPids)) continue;
    orphanPids.push(pid);
  }

  const killed = killWithEscalation(orphanPids, procMap);

  let remaining = 0;
  try {
    const output = execSync("ps -eo comm | grep -c '^node$'", {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    remaining = Number.parseInt(output.trim(), 10) || 0;
  } catch {}

  return { killed, remaining };
}
