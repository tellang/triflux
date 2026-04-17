// hub/team/process-cleanup.mjs — 고아 node/python 프로세스 감지 및 정리
// Windows: Get-CimInstance Win32_Process로 parent PID + cmdLine 접근
// Unix: ps aux 파싱
import { execFileSync, execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { IS_WINDOWS } from "../platform.mjs";

const execFileAsync = promisify(nodeExecFile);

// ── 상수 ────────────────────────────────────────────────────────────────────

const TARGET_PROCESS_NAMES = ["node", "python", "python3"];
const SIGTERM_GRACE_MS = 5000;

function forceKillPid(pid) {
  if (IS_WINDOWS) {
    try {
      execFileSync("taskkill", ["/F", "/PID", String(pid)], {
        stdio: "ignore",
        timeout: 5000,
        windowsHide: true,
      });
      return;
    } catch (taskkillError) {
      try {
        process.kill(pid);
        return;
      } catch {
        throw taskkillError;
      }
    }
  }

  process.kill(pid, "SIGKILL");
}

// cmdLine 패턴 기반 화이트리스트 (고아 후보에서 제외)
const WHITELIST_CMDLINE = [/oh-my-claudecode/i, /triflux[\\/]hub[\\/]s/i];

// 프로세스명 기반 화이트리스트
const WHITELIST_NAMES = ["claude", "CCXProcess"];

// ── PowerShell / ps 파싱 ─────────────────────────────────────────────────────

/**
 * Windows: Get-CimInstance Win32_Process로 프로세스 목록 조회
 * @param {Function} execFileFn - DI용 execFile 구현
 * @returns {Promise<Array<{pid,name,parentPid,cmdLine,ramMB}>>}
 */
async function queryWindowsProcesses(execFileFn) {
  const script = [
    "Get-CimInstance Win32_Process |",
    "  Select-Object ProcessId,Name,ParentProcessId,CommandLine,WorkingSetSize |",
    "  ConvertTo-Json -Compress",
  ].join(" ");

  const { stdout } = await execFileFn(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", timeout: 15_000, windowsHide: true },
  );

  const raw = JSON.parse(stdout.trim());
  const items = Array.isArray(raw) ? raw : [raw];

  return items.filter(Boolean).map((p) => ({
    pid: Number(p.ProcessId),
    name: String(p.Name || "").replace(/\.exe$/i, ""),
    parentPid: Number(p.ParentProcessId) || 0,
    cmdLine: String(p.CommandLine || ""),
    ramMB: Math.round((Number(p.WorkingSetSize) || 0) / 1024 / 1024),
  }));
}

/**
 * Unix: ps aux 파싱
 * @param {Function} execFileFn - DI용 execFile 구현
 * @returns {Promise<Array<{pid,name,parentPid,cmdLine,ramMB}>>}
 */
async function queryUnixProcesses(execFileFn) {
  const { stdout } = await execFileFn(
    "ps",
    ["-eo", "pid=,ppid=,rss=,comm=,args="],
    { encoding: "utf8", timeout: 10_000 },
  );

  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[0]);
      const parentPid = Number(parts[1]);
      const ramMB = Math.round((Number(parts[2]) || 0) / 1024);
      const name = String(parts[3] || "");
      const cmdLine = parts.slice(4).join(" ");
      return { pid, name, parentPid, cmdLine, ramMB };
    });
}

/**
 * 프로세스 시작 시각을 Unix 기준 ms로 조회 (Windows 전용, best-effort)
 * @param {number} pid
 * @param {Function} execFileFn
 * @returns {Promise<number>} epoch ms, 실패 시 0
 */
async function getWindowsProcessStartMs(pid, execFileFn) {
  try {
    const script = `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CreationDate | Get-Date -Format 'o'`;
    const { stdout } = await execFileFn(
      "pwsh",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", timeout: 5_000, windowsHide: true },
    );
    const ts = Date.parse(stdout.trim());
    return Number.isNaN(ts) ? 0 : ts;
  } catch {
    return 0;
  }
}

// ── 화이트리스트 판정 ──────────────────────────────────────────────────────

/**
 * 프로세스가 화이트리스트에 해당하는지 판정
 * @param {{name:string, cmdLine:string}} proc
 * @param {Set<number>} parentPids - 화이트리스트 부모 PID 집합
 * @returns {boolean}
 */
function isWhitelisted(proc, parentPids) {
  const nameLower = proc.name.toLowerCase();

  // 프로세스명 기반
  if (WHITELIST_NAMES.some((n) => nameLower.includes(n.toLowerCase()))) {
    return true;
  }

  // cmdLine 패턴 기반
  if (WHITELIST_CMDLINE.some((re) => re.test(proc.cmdLine))) {
    return true;
  }

  // CCXProcess 자식 (Adobe Creative Cloud)
  if (parentPids.has(proc.parentPid)) {
    return true;
  }

  return false;
}

// ── psmux 교차검증 ──────────────────────────────────────────────────────────

/**
 * psmux list-sessions 결과에서 활성 세션 pane PID 집합을 수집
 * @param {Function} execFileFn
 * @returns {Promise<Set<number>>}
 */
async function getActivePsmuxPids(execFileFn) {
  try {
    const { stdout: sessOut } = await execFileFn(
      "psmux",
      ["list-sessions", "-F", "#{session_name}"],
      { encoding: "utf8", timeout: 5_000, windowsHide: true },
    );

    const sessions = sessOut.trim().split(/\r?\n/).filter(Boolean);
    if (sessions.length === 0) return new Set();

    const pids = new Set();

    await Promise.all(
      sessions.map(async (session) => {
        try {
          const { stdout: paneOut } = await execFileFn(
            "psmux",
            ["list-panes", "-t", session, "-a", "-F", "#{pane_pid}"],
            { encoding: "utf8", timeout: 5_000, windowsHide: true },
          );
          paneOut
            .trim()
            .split(/\r?\n/)
            .filter(Boolean)
            .forEach((p) => {
              const n = Number(p.trim());
              if (n > 0) pids.add(n);
            });
        } catch {
          // 세션 쿼리 실패 시 해당 세션만 건너뜀
        }
      }),
    );

    return pids;
  } catch {
    // psmux 미설치 또는 실패 시 빈 집합 반환
    return new Set();
  }
}

// ── 공개 API ────────────────────────────────────────────────────────────────

/**
 * 고아 프로세스 목록을 반환한다.
 *
 * @param {object} [opts]
 * @param {Function} [opts.execFileFn] - DI용 execFile (기본: node:child_process.execFile의 promisify 버전)
 * @param {boolean} [opts.skipPsmuxCheck] - psmux 교차검증 생략 (테스트용)
 * @returns {Promise<Array<{pid,name,ramMB,parentPid,cmdLine,age}>>}
 */
export async function findOrphanProcesses(opts = {}) {
  const execFileFn = opts.execFileFn ?? execFileAsync;

  let allProcs;
  try {
    allProcs = IS_WINDOWS
      ? await queryWindowsProcesses(execFileFn)
      : await queryUnixProcesses(execFileFn);
  } catch {
    return [];
  }

  if (allProcs.length === 0) return [];

  const pidSet = new Set(allProcs.map((p) => p.pid));

  // CCXProcess 부모 PID 집합 구성
  const ccxParentPids = new Set(
    allProcs
      .filter((p) => p.name.toLowerCase() === "ccxprocess")
      .map((p) => p.pid),
  );

  // 활성 psmux PID 교차검증
  const activePsmuxPids = opts.skipPsmuxCheck
    ? new Set()
    : await getActivePsmuxPids(execFileFn);

  const now = Date.now();

  const candidates = allProcs.filter((p) => {
    const nameLower = p.name.toLowerCase();

    // 대상 프로세스만
    if (
      !TARGET_PROCESS_NAMES.some(
        (t) => nameLower === t || nameLower === `${t}.exe`,
      )
    ) {
      return false;
    }

    // 화이트리스트
    if (isWhitelisted(p, ccxParentPids)) return false;

    // 활성 psmux 세션 소속 PID 제외
    if (activePsmuxPids.has(p.pid)) return false;

    // 부모가 없거나(0, 1 제외 시 존재하지 않는 PID) 고아
    const parentAlive = p.parentPid <= 1 || pidSet.has(p.parentPid);
    if (parentAlive) return false;

    return true;
  });

  // age 계산 (Windows만 best-effort, Unix는 0)
  const results = await Promise.all(
    candidates.map(async (p) => {
      let startMs = 0;
      if (IS_WINDOWS) {
        startMs = await getWindowsProcessStartMs(p.pid, execFileFn);
      }
      return {
        pid: p.pid,
        name: p.name,
        ramMB: p.ramMB,
        parentPid: p.parentPid,
        cmdLine: p.cmdLine,
        age: startMs > 0 ? now - startMs : 0,
      };
    }),
  );

  return results;
}

/**
 * createProcessCleanup — scan/kill/getOrphans 인터페이스를 반환한다.
 *
 * @param {object} [opts]
 * @param {Function} [opts.execFileFn] - DI용 execFile (promisify된 버전)
 * @param {boolean} [opts.dryRun] - true이면 kill 없이 목록만 반환
 * @param {boolean} [opts.skipPsmuxCheck] - psmux 교차검증 생략 (테스트용)
 * @returns {{ scan: Function, kill: Function, getOrphans: Function }}
 */
export function createProcessCleanup(opts = {}) {
  const execFileFn = opts.execFileFn ?? execFileAsync;
  const dryRun = opts.dryRun ?? false;

  let lastOrphans = [];

  /**
   * 고아 프로세스를 스캔하여 내부 상태에 저장하고 목록을 반환한다.
   * @returns {Promise<Array<{pid,name,ramMB,parentPid,cmdLine,age}>>}
   */
  async function scan() {
    const found = await findOrphanProcesses({
      execFileFn,
      skipPsmuxCheck: opts.skipPsmuxCheck,
    });
    lastOrphans = found;
    return found;
  }

  /**
   * 마지막 scan 결과의 프로세스를 kill한다.
   * dryRun=true이면 kill 없이 목록만 반환한다.
   * SIGTERM → 5s 대기 → 강제 종료(taskkill/SIGKILL) 순서.
   * @returns {Promise<Array<{pid,name,killed,error}>>}
   */
  async function kill() {
    if (dryRun) {
      return lastOrphans.map((p) => ({
        pid: p.pid,
        name: p.name,
        killed: false,
        dryRun: true,
      }));
    }

    const results = await Promise.all(
      lastOrphans.map(async (p) => {
        try {
          // SIGTERM
          process.kill(p.pid, "SIGTERM");

          // 5초 대기 후 살아있으면 강제 종료
          await new Promise((resolve) => setTimeout(resolve, SIGTERM_GRACE_MS));

          try {
            // 프로세스가 아직 살아있는지 확인 (signal 0)
            process.kill(p.pid, 0);
            // 여전히 살아있음 → Windows는 taskkill/process.kill, 그 외는 SIGKILL
            forceKillPid(p.pid);
          } catch {
            // ESRCH: 이미 종료됨 — 정상
          }

          return { pid: p.pid, name: p.name, killed: true };
        } catch (err) {
          return {
            pid: p.pid,
            name: p.name,
            killed: false,
            error: String(err.message || err),
          };
        }
      }),
    );

    return results;
  }

  /**
   * 마지막 scan 결과를 반환한다 (재스캔 없음).
   * @returns {Array<{pid,name,ramMB,parentPid,cmdLine,age}>}
   */
  function getOrphans() {
    return lastOrphans;
  }

  return { scan, kill, getOrphans };
}
