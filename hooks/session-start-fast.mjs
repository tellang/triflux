// hooks/session-start-fast.mjs — SessionStart in-process fast-path
//
// hook-orchestrator.mjs가 SessionStart 이벤트일 때 이 모듈을 dynamic import.
// 6개 훅을 1개 node 프로세스 안에서 실행하여 콜드스타트 7회 → 1회로 줄인다.
//
// 분류:
//   BLOCKING  (직렬, stdout 반환 전 완료): setup.runCritical, mcp-safety-guard.run, hub-ensure.run
//   DEFERRED  (병렬, 실패해도 안 죽음):   mcp-gateway-ensure.run, setup.runDeferred
//   BACKGROUND (fire-and-forget):          preflight-cache.run
//
// external source 훅 (session-vault 등)은 여전히 execFile로 실행된다.

import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  heartbeatSynapseSession,
  registerSynapseSession,
} from "../hub/team/synapse-http.mjs";
import { createModuleLogger } from "../scripts/lib/logger.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(__dirname, "..", "scripts");
const importMod = (p) => import(pathToFileURL(p).href);

const log = createModuleLogger("session-start-fast");

/**
 * SessionStart 페이로드(JSON 문자열)에서 session_id / cwd 를 추출한다.
 * 파싱 실패는 빈 객체로 흡수한다 (BLOCKING path 에 절대 영향 없음).
 */
function parseStartPayload(stdinData) {
  try {
    const raw = typeof stdinData === "string" ? stdinData : "";
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/**
 * cwd 기준 git 컨텍스트(worktree root / branch)를 best-effort, 비동기로 수집.
 * execFileSync 와 달리 호출자(BACKGROUND)를 블로킹하지 않는다. 각 git 호출은
 * tight timeout(1.5s) + 강제 kill 로 묶여 hub/디스크 stall 시에도 잔류하지 않는다.
 * @param {string} cwd
 * @param {(args:string[], cb:(out:string)=>void)=>void} [gitRunner] 테스트용 seam
 * @returns {Promise<{ worktreePath: string, branch: string }>}
 */
function gitContextAsync(cwd, gitRunner = defaultGitRunner) {
  const run = (args) =>
    new Promise((resolve) => {
      try {
        gitRunner(cwd, args, (out) => resolve(out));
      } catch {
        resolve("");
      }
    });
  return Promise.all([
    run(["rev-parse", "--show-toplevel"]),
    run(["rev-parse", "--abbrev-ref", "HEAD"]),
  ]).then(([toplevel, branch]) => ({
    worktreePath: toplevel || cwd,
    branch,
  }));
}

/** 기본 git runner: execFile(async) + tight timeout + kill. 실패는 빈 문자열. */
function defaultGitRunner(cwd, args, cb) {
  execFile(
    "git",
    args,
    {
      cwd,
      encoding: "utf8",
      timeout: 1500,
      killSignal: "SIGKILL",
      windowsHide: true,
    },
    (err, stdout) => {
      cb(err ? "" : String(stdout || "").trim());
    },
  );
}

/**
 * 인터랙티브 세션을 Synapse 레지스트리에 self-register (fire-and-forget).
 * hub 미응답이면 silent no-op. BLOCKING path 에 latency 0 — git 컨텍스트는
 * 블로킹 경로 밖에서 비동기로 enrich 한다 (cwd 만으로 즉시 minimal register).
 *
 * pid 는 의도적으로 보내지 않는다: 이 훅 프로세스의 process.pid 는 short-lived
 * 훅 PID 일 뿐 세션 PID 가 아니므로 오기재가 된다. liveness 는 TTL 이 담당한다.
 *
 * @param {string} stdinData
 * @param {object} [seams] 테스트용 injectable seam
 * @param {Function} [seams.register]  registerSynapseSession 대체
 * @param {Function} [seams.heartbeat] heartbeatSynapseSession 대체
 * @param {Function} [seams.gitRunner] git runner 대체
 * @returns {void} (enrich 는 백그라운드에서 완료)
 */
export function registerInteractiveSession(stdinData, seams = {}) {
  const register = seams.register || registerSynapseSession;
  const heartbeat = seams.heartbeat || heartbeatSynapseSession;
  const gitRunner = seams.gitRunner || defaultGitRunner;
  try {
    const payload = parseStartPayload(stdinData);
    const sessionId = String(payload?.session_id || "").trim();
    if (!sessionId) return;
    const cwd = typeof payload?.cwd === "string" ? payload.cwd : process.cwd();

    // 1) cwd 만으로 즉시 minimal register (블로킹 git 없음, latency 0).
    register({
      sessionId,
      cwd,
      worktreePath: cwd,
      branch: "",
      host: "local",
      sessionKind: "interactive",
      isRemote: false,
    });

    // 2) worktree/branch 는 블로킹 경로 밖에서 비동기 enrich → heartbeat partial.
    gitContextAsync(cwd, gitRunner)
      .then(({ worktreePath, branch }) => {
        if (worktreePath === cwd && !branch) return; // 추가 정보 없음
        heartbeat(sessionId, { worktreePath, branch });
      })
      .catch(() => {});
  } catch {
    /* best-effort — never affects session start */
  }
}

/**
 * BLOCKING 훅을 순차 실행. 하나라도 throw하면 로그만 남기고 계속.
 * @param {string} stdinData
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
async function runBlocking(stdinData) {
  const output = { stdout: "", stderr: "" };
  const timings = [];

  // 1. setup.runCritical — 환경 초기화 필수
  try {
    const t0 = performance.now();
    const setup = await importMod(join(SCRIPTS, "setup.mjs"));
    const result = await setup.runCritical(stdinData);
    const dur = performance.now() - t0;
    timings.push({ hook: "setup.critical", dur_ms: Math.round(dur) });
    if (result?.stdout) output.stdout += result.stdout + "\n";
    if (result?.stderr) output.stderr += result.stderr + "\n";
    log.info(
      { hook: "setup.critical", dur_ms: Math.round(dur) },
      "hook.completed",
    );
  } catch (err) {
    log.error(
      { hook: "setup.critical", err: String(err.message || err) },
      "hook.failed",
    );
  }

  // 2. mcp-safety-guard.run — EPERM 방지
  try {
    const t0 = performance.now();
    const guard = await importMod(join(SCRIPTS, "mcp-safety-guard.mjs"));
    guard.run();
    const dur = performance.now() - t0;
    timings.push({ hook: "mcp-safety-guard", dur_ms: Math.round(dur) });
    log.info(
      { hook: "mcp-safety-guard", dur_ms: Math.round(dur) },
      "hook.completed",
    );
  } catch (err) {
    log.error(
      { hook: "mcp-safety-guard", err: String(err.message || err) },
      "hook.failed",
    );
  }

  // 3. hub-ensure — Hub 필수 인프라, BLOCKING으로 실행
  try {
    const t0 = performance.now();
    const hubMod = await importMod(join(SCRIPTS, "hub-ensure.mjs"));
    const result = await hubMod.run(stdinData);
    const dur = performance.now() - t0;
    timings.push({ hook: "hub-ensure", dur_ms: Math.round(dur) });
    if (result?.stdout) output.stdout += result.stdout + "\n";
    if (result?.stderr) output.stderr += result.stderr + "\n";
    if (result?.code !== 0) {
      log.warn(
        { hook: "hub-ensure", dur_ms: Math.round(dur), code: result?.code },
        "hook.warn",
      );
    } else {
      log.info(
        { hook: "hub-ensure", dur_ms: Math.round(dur) },
        "hook.completed",
      );
    }
  } catch (err) {
    log.error(
      { hook: "hub-ensure", err: String(err.message || err) },
      "hook.failed",
    );
  }

  return { ...output, timings };
}

/**
 * DEFERRED 훅을 병렬 실행. 실패해도 crash 안 함, 로그만 남김.
 * Promise는 의도적으로 관리하지 않음 (fire-and-forget with logging).
 * @param {string} stdinData
 */
function runDeferred(stdinData) {
  const tasks = [
    {
      name: "session-stale-cleanup",
      fn: async () => {
        const mod = await importMod(join(SCRIPTS, "session-stale-cleanup.mjs"));
        if (typeof mod.main === "function") mod.main();
      },
    },
    {
      name: "claude-login-detect",
      fn: async () => {
        const mod = await importMod(join(SCRIPTS, "claude-login-detect.mjs"));
        const result = mod.run?.();
        if (result?.changed) {
          return {
            stdout: `[claude-login] HUD 캐시 ${result.cleared}개 초기화됨\n`,
          };
        }
      },
    },
    {
      name: "mcp-gateway-ensure",
      fn: async () => {
        const mod = await importMod(join(SCRIPTS, "mcp-gateway-ensure.mjs"));
        return mod.run(stdinData);
      },
    },
    {
      name: "setup.deferred",
      fn: async () => {
        const mod = await importMod(join(SCRIPTS, "setup.mjs"));
        return mod.runDeferred(stdinData);
      },
    },
  ];

  for (const task of tasks) {
    const t0 = performance.now();
    task
      .fn()
      .then((result) => {
        const dur = performance.now() - t0;
        log.info(
          { hook: task.name, dur_ms: Math.round(dur), code: result?.code },
          "deferred.completed",
        );
      })
      .catch((err) => {
        const dur = performance.now() - t0;
        log.error(
          {
            hook: task.name,
            dur_ms: Math.round(dur),
            err: String(err.message || err),
          },
          "deferred.failed",
        );
      });
  }
}

/**
 * BACKGROUND 훅. fire-and-forget.
 * @param {string} stdinData
 */
function runBackground(stdinData) {
  // preflight-cache
  importMod(join(SCRIPTS, "preflight-cache.mjs"))
    .then((mod) => mod.run(stdinData))
    .catch(() => {}); // 완전 무시

  // Synapse: 인터랙티브 세션 self-register (fire-and-forget, hub 미응답 무시)
  registerInteractiveSession(stdinData);

  // session-vault은 external source — hook-orchestrator가 execFile로 실행
}

/**
 * SessionStart fast-path 진입점.
 * hook-orchestrator.mjs에서 호출된다.
 *
 * @param {string} stdinData — orchestrator가 전달하는 stdin JSON
 * @param {Array} externalHooks — source !== 'triflux'인 훅 목록 (orchestrator가 execFile로 실행)
 * @returns {Promise<{stdout: string, stderr: string, timings: Array}>}
 */
export async function execute(stdinData, externalHooks = []) {
  const totalStart = performance.now();

  // BLOCKING: 프롬프트 전 완료 필수
  const blocking = await runBlocking(stdinData);

  // DEFERRED + BACKGROUND: fire-and-forget
  runDeferred(stdinData);
  runBackground(stdinData);

  const totalDur = performance.now() - totalStart;
  log.info(
    {
      total_ms: Math.round(totalDur),
      blocking_count: 3,
      deferred_count: 2,
      bg_count: 1,
    },
    "session-start.done",
  );

  return {
    stdout: blocking.stdout,
    stderr: blocking.stderr,
    timings: blocking.timings,
  };
}
