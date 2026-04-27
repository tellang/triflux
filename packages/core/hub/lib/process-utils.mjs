// hub/lib/process-utils.mjs
// 프로세스 관련 공유 유틸리티

import { execSync } from "node:child_process";
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
const SCRIPT_VERSION = 3;
const VERSION_FILE = join(CLEANUP_SCRIPT_DIR, ".version");

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
    if (
      LIVE_CLI_SESSION_ROOT_NAMES.has(String(info.name || "").toLowerCase())
    ) {
      return true;
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

function hasLiveCliDescendant(pid, procMap) {
  const children = new Map();
  for (const [childPid, proc] of procMap) {
    if (!Number.isFinite(proc.ppid) || proc.ppid <= 0) continue;
    const list = children.get(proc.ppid) || [];
    list.push({ pid: childPid, ...proc });
    children.set(proc.ppid, list);
  }

  const visited = new Set();
  const stack = [...(children.get(pid) || [])];
  while (stack.length > 0) {
    const proc = stack.pop();
    if (!proc || visited.has(proc.pid)) continue;
    visited.add(proc.pid);
    if (
      LIVE_CLI_SESSION_ROOT_NAMES.has(String(proc.name || "").toLowerCase())
    ) {
      return true;
    }
    stack.push(...(children.get(proc.pid) || []));
  }
  return false;
}

// kill 대상 프로세스 이름 (Windows)
// codex/claude는 활성 세션 루트로만 취급한다. 전역 orphan sweep이
// 사용자 Claude Code/Codex 세션을 직접 종료하면 안 된다.
const KILLABLE_NAMES = new Set([
  "node.exe",
  "bash.exe",
  "cmd.exe",
  "uvx.exe",
]);
const LIVE_CLI_SESSION_ROOT_NAMES = new Set(["codex.exe", "claude.exe"]);

/**
 * 고아 프로세스 트리를 정리한다 (node.exe + bash.exe + cmd.exe + uvx.exe).
 * Windows 전용 — Agent 서브프로세스가 MCP 서버, bash 래퍼, cmd 래퍼를 남기는 문제 대응.
 *
 * 전략: 부모 체인을 루트까지 추적하여, 체인 중간에 죽은 프로세스가 있으면
 * 해당 프로세스 아래의 전체 트리를 고아로 판정하고 정리.
 * 스캔 범위에는 codex/claude/pwsh도 포함하여 체인 추적 정확도를 높인다.
 *
 * 보호 대상: 현재 프로세스 조상 트리, Hub PID
 * @returns {{ killed: number, remaining: number }}
 */
export function cleanupOrphanNodeProcesses() {
  if (!IS_WINDOWS) return cleanupOrphansUnix();

  ensureHelperScripts();

  const myPid = process.pid;

  // Hub PID 보호
  let hubPid = null;
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
      hubPid = Number(hubInfo?.pid);
    }
  } catch {}

  // 보호 PID 세트: 현재 프로세스 + Hub + 현재 프로세스의 조상 트리
  const protectedPids = new Set();
  protectedPids.add(myPid);
  if (Number.isFinite(hubPid) && hubPid > 0) protectedPids.add(hubPid);

  try {
    const treeOutput = execSync(
      `powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${TREE_SCRIPT_PATH}" -StartPid ${myPid}`,
      {
        encoding: "utf8",
        timeout: 8000,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    for (const line of treeOutput.split(/\r?\n/)) {
      const pid = Number.parseInt(line.trim(), 10);
      if (Number.isFinite(pid) && pid > 0) protectedPids.add(pid);
    }
  } catch {}

  // 전체 프로세스 맵 구축 (node + bash + cmd + codex + claude + pwsh + uvx)
  const procMap = new Map();
  try {
    const output = execSync(
      `powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${SCAN_SCRIPT_PATH}"`,
      {
        encoding: "utf8",
        timeout: 15000,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    for (const line of output.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [pidStr, ppidStr, name] = trimmed.split(",");
      const pid = Number.parseInt(pidStr, 10);
      const ppid = Number.parseInt(ppidStr, 10);
      if (Number.isFinite(pid) && pid > 0) {
        procMap.set(pid, { ppid, name: name || "unknown" });
      }
    }
  } catch {}

  // 고아 판정 + 정리 (SIGTERM → 3s → SIGKILL 에스컬레이션)
  // CLI 도구(codex/claude/pwsh)는 체인 추적용으로만 스캔 — kill 대상에서 제외
  const orphanPids = [];
  for (const [pid, info] of procMap) {
    if (protectedPids.has(pid)) continue;
    if (!KILLABLE_NAMES.has(info.name?.toLowerCase())) continue;
    if (hasLiveAncestorChain(pid, procMap, protectedPids)) continue;
    if (hasLiveCliDescendant(pid, procMap)) continue;
    orphanPids.push(pid);
  }

  const killed = killWithEscalation(orphanPids, procMap);

  // 남은 프로세스 수 확인
  let remaining = 0;
  try {
    const countOutput = execSync(
      `powershell -NoProfile -WindowStyle Hidden -Command "(Get-Process node -ErrorAction SilentlyContinue).Count"`,
      {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    remaining = Number.parseInt(countOutput.trim(), 10) || 0;
  } catch {}

  return { killed, remaining };
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
    if (hasLiveCliDescendant(pid, procMap)) continue;
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
