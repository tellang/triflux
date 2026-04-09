// hub/team/conductor.mjs — 세션 오케스트레이션 Conductor
// native-supervisor.mjs의 spawn/kill을 래핑하되, 상태 머신 + health probe +
// auto-restart + event log를 추가하여 "조용한 실패"를 구조적으로 불가능하게 만든다.
//
// 기존 native-supervisor와의 차이:
// 1. 상태 머신 (alive/dead → 7 states + 2 terminal)
// 2. Health probe 4단계 (+ INPUT_WAIT 감지)
// 3. Auto-restart (maxRestarts=3)
// 4. JSONL event log (블랙박스 리코더)

import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  copyFileSync,
  createWriteStream,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRegistry } from "../../mesh/mesh-registry.mjs";
import { broker } from "@triflux/core/hub/account-broker.mjs";
import { killProcess } from "@triflux/core/hub/platform.mjs";
import { createConductorMeshBridge } from "./conductor-mesh-bridge.mjs";
import {
  ensureConductorRegistry,
  getConductorRegistry,
} from "./conductor-registry.mjs";
import { createEventLog } from "./event-log.mjs";
import { createHealthProbe } from "./health-probe.mjs";
import { buildLauncher } from "./launcher-template.mjs";
import { createRemoteProbe } from "./remote-probe.mjs";

/** 세션 상태 */
export const STATES = Object.freeze({
  INIT: "init",
  STARTING: "starting",
  HEALTHY: "healthy",
  STALLED: "stalled",
  INPUT_WAIT: "input_wait",
  FAILED: "failed",
  RESTARTING: "restarting",
  DEAD: "dead",
  COMPLETED: "completed",
});

/** 유효한 상태 전이 테이블 */
const TRANSITIONS = Object.freeze({
  [STATES.INIT]: [STATES.STARTING],
  [STATES.STARTING]: [STATES.HEALTHY, STATES.FAILED],
  [STATES.HEALTHY]: [
    STATES.STALLED,
    STATES.INPUT_WAIT,
    STATES.FAILED,
    STATES.COMPLETED,
  ],
  [STATES.STALLED]: [STATES.HEALTHY, STATES.FAILED],
  [STATES.INPUT_WAIT]: [STATES.HEALTHY, STATES.FAILED],
  [STATES.FAILED]: [STATES.RESTARTING, STATES.DEAD],
  [STATES.RESTARTING]: [STATES.STARTING],
  [STATES.DEAD]: [],
  [STATES.COMPLETED]: [],
});

const TERMINAL_STATES = new Set([STATES.DEAD, STATES.COMPLETED]);
const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_GRACE_MS = 10_000;

/**
 * Conductor 팩토리.
 * @param {object} opts
 * @param {string} opts.logsDir — 이벤트 로그 디렉토리
 * @param {number} [opts.maxRestarts=3]
 * @param {number} [opts.graceMs=10000] — shutdown grace period
 * @param {object} [opts.probeOpts] — health-probe 옵션 오버라이드
 * @returns {Conductor}
 */
export function createConductor(opts = {}) {
  const {
    logsDir,
    maxRestarts = DEFAULT_MAX_RESTARTS,
    graceMs = DEFAULT_GRACE_MS,
    probeOpts = {},
  } = opts;

  if (!logsDir) throw new Error("logsDir is required");
  mkdirSync(logsDir, { recursive: true });

  const emitter = new EventEmitter();
  const sessions = new Map();
  let shuttingDown = false;
  const publicApi = null;

  // 공유 event log (모든 세션 이벤트를 하나의 JSONL에)
  const eventLog = createEventLog(join(logsDir, "conductor-events.jsonl"));

  /**
   * 세션 상태 전이.
   * @param {object} session
   * @param {string} nextState
   * @param {string} [reason]
   */
  function transition(session, nextState, reason = "") {
    const valid = TRANSITIONS[session.state] || [];
    if (!valid.includes(nextState)) {
      eventLog.append("invalid_transition", {
        session: session.id,
        from: session.state,
        to: nextState,
        reason,
      });
      return false;
    }

    const prev = session.state;
    session.state = nextState;

    eventLog.append("stateChange", {
      session: session.id,
      from: prev,
      to: nextState,
      reason,
      restarts: session.restarts,
    });

    emitter.emit("stateChange", {
      sessionId: session.id,
      from: prev,
      to: nextState,
      reason,
    });

    // Terminal state cleanup
    if (TERMINAL_STATES.has(nextState)) {
      session.probe?.stop();
      getConductorRegistry()?.unregister?.(session.id, publicApi);
    }

    return true;
  }

  /**
   * 프로세스를 강제 종료.
   * Windows: taskkill /T /F /PID (프로세스 트리). POSIX: SIGKILL.
   */
  function forceKill(pid) {
    if (!pid || pid <= 0) return;
    killProcess(pid, {
      signal: "SIGKILL",
      tree: true,
      force: true,
      timeout: 5000,
    });
  }

  /**
   * 원격 세션의 psmux 세션을 SSH 경유로 kill.
   * fire-and-forget: 실패해도 에러 전파 안 함.
   */
  function killRemoteSession(session) {
    const host = session.config.host;
    if (!host) return;
    let sshUser = session.config.sshUser;
    let sshIp = host;
    // hosts.json에서 ssh_user/IP 해결
    try {
      const hostsPath = join(
        opts.repoRoot || process.cwd(),
        "references",
        "hosts.json",
      );
      const hosts = JSON.parse(readFileSync(hostsPath, "utf8"));
      const hostCfg = hosts.hosts?.[host];
      if (hostCfg) {
        sshUser = sshUser || hostCfg.ssh_user;
        sshIp = hostCfg.tailscale?.ip || host;
      }
    } catch {
      /* hosts.json 없으면 fallback */
    }
    if (!sshUser) return;
    const execFn = opts.deps?.execFile || execFile;
    execFn(
      "ssh",
      [`${sshUser}@${sshIp}`, "psmux", "kill-session", "-t", session.id],
      { timeout: 10_000 },
      () => {},
    );
    eventLog.append("remote_kill", {
      session: session.id,
      host,
      sshUser,
      sshIp,
    });
  }

  /**
   * 단일 세션의 child process를 정리.
   * 원격 세션은 SSH 경유 psmux kill-session으로 정리.
   */
  async function cleanupChild(session) {
    session.probe?.stop();

    // 원격 세션 — SSH 경유 psmux kill-session
    if (session.config.remote) {
      killRemoteSession(session);
      return;
    }

    const child = session.child;
    if (!child) return;

    const pid = child.pid;
    if (!pid) return;

    // SIGTERM 먼저
    try {
      child.kill("SIGTERM");
    } catch {
      /* already dead */
    }

    // Grace period 대기
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        forceKill(pid);
        resolve();
      }, graceMs);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Health probe 콜백 — probe 결과에 따라 상태 전이 판단.
   */
  function handleProbeResult(session, result) {
    if (TERMINAL_STATES.has(session.state)) return;
    if (session.state === STATES.INIT || session.state === STATES.RESTARTING)
      return;

    eventLog.append("health", {
      session: session.id,
      ...result,
    });

    // L0 실패 — 로컬: exit handler에서 처리. 원격: probe가 유일한 감지 수단.
    if (result.l0 === "fail") {
      if (session.config.remote) {
        handleFailure(session, "remote_L0_fail");
      }
      return;
    }

    // L3 completed (원격 완료 토큰 감지)
    if (result.l3 === "completed" && session.config.remote) {
      transition(session, STATES.COMPLETED, "remote_completion_token");
      emitter.emit("completed", { sessionId: session.id });
      if (typeof session.config.onCompleted === "function") {
        session.config.onCompleted({ sessionId: session.id });
      }
      maybeAutoShutdown();
      return;
    }

    // L1 INPUT_WAIT 감지
    if (result.l1 === "input_wait" && session.state === STATES.HEALTHY) {
      transition(
        session,
        STATES.INPUT_WAIT,
        `input_wait:${result.inputWaitPattern}`,
      );
      emitter.emit("inputWait", {
        sessionId: session.id,
        pattern: result.inputWaitPattern,
      });
      return;
    }

    // INPUT_WAIT → output 재개 시 HEALTHY 복귀
    if (session.state === STATES.INPUT_WAIT && result.l1 === "ok") {
      transition(session, STATES.HEALTHY, "output_resumed");
      return;
    }

    // L1 stall
    if (result.l1 === "stall" && session.state === STATES.HEALTHY) {
      transition(session, STATES.STALLED, "L1_stall");
      return;
    }

    // STALLED → output 재개 시 HEALTHY 복귀
    if (session.state === STATES.STALLED && result.l1 === "ok") {
      transition(session, STATES.HEALTHY, "output_resumed");
      return;
    }

    // L3 timeout (아직 STARTING 상태)
    if (result.l3 === "timeout" && session.state === STATES.STARTING) {
      handleFailure(session, "L3_timeout");
      return;
    }

    // STARTING → L0 ok + L3 ok → HEALTHY
    if (
      session.state === STATES.STARTING &&
      result.l0 === "ok" &&
      result.l3 === "ok"
    ) {
      transition(session, STATES.HEALTHY, "probe_healthy");
      return;
    }

    // STARTING → L0 ok (L3 아직 미판정) → STARTING 유지 (대기)
  }

  /**
   * 실패 처리 — restart 또는 DEAD.
   */
  function handleFailure(session, reason) {
    if (TERMINAL_STATES.has(session.state)) return;

    transition(session, STATES.FAILED, reason);

    if (session.restarts < maxRestarts) {
      transition(
        session,
        STATES.RESTARTING,
        `restart_${session.restarts + 1}/${maxRestarts}`,
      );
      session.restarts += 1;
      void respawnSession(session);
    } else {
      transition(session, STATES.DEAD, `maxRestarts(${maxRestarts})_exceeded`);
      emitter.emit("dead", { sessionId: session.id, reason });

      // broker release on final death
      if (broker && session.config.accountId) {
        broker.release(session.config.accountId, {
          ok: false,
          failureMode: session.lastFailureMode,
        });
        if (session.lastFailureMode === "rate_limited") {
          broker.markRateLimited(session.config.accountId, 5 * 60 * 1000);
        }
      }
    }
  }

  /**
   * 세션의 child process를 (재)시작.
   */
  async function respawnSession(session) {
    // 기존 child 정리
    await cleanupChild(session);

    transition(
      session,
      STATES.STARTING,
      session.restarts > 0 ? "respawn" : "initial",
    );

    const launcher = session.launcher;
    const outPath = join(logsDir, `${session.id}.out.log`);
    const errPath = join(logsDir, `${session.id}.err.log`);
    mkdirSync(logsDir, { recursive: true });

    const outWs = createWriteStream(outPath, { flags: "a" });
    const errWs = createWriteStream(errPath, { flags: "a" });

    let outputBytes = 0;
    let recentOutput = "";

    let child;
    try {
      child = spawn(launcher.command, {
        shell: true,
        env: { ...process.env, ...launcher.env, ...(session.config.env || {}) },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      eventLog.append("spawn_error", {
        session: session.id,
        error: err.message,
      });
      handleFailure(session, `spawn_error:${err.message}`);
      return;
    }

    session.child = child;
    session.outPath = outPath;
    session.errPath = errPath;

    eventLog.append("spawn", {
      session: session.id,
      agent: session.config.agent,
      pid: child.pid,
      command: launcher.command,
      restart: session.restarts,
    });

    // stdout+stderr 통합 추적 (F3 해결: stderr만 출력되는 경우도 advancing 판정)
    const trackOutput = (buf) => {
      outputBytes += buf.length;
      const txt = String(buf);
      // 최근 2KB만 유지 (INPUT_WAIT 패턴 감지용)
      recentOutput += txt;
      if (recentOutput.length > 2048) {
        recentOutput = recentOutput.slice(-2048);
      }
    };

    child.stdout?.on("data", (buf) => {
      outWs.write(buf);
      trackOutput(buf);
    });
    child.stderr?.on("data", (buf) => {
      errWs.write(buf);
      trackOutput(buf);
    });

    child.on("exit", (code, signal) => {
      session.alive = false;
      try {
        outWs.end();
      } catch {
        /* ignore */
      }
      try {
        errWs.end();
      } catch {
        /* ignore */
      }

      eventLog.append("exit", {
        session: session.id,
        code,
        signal,
        restart: session.restarts,
      });

      if (TERMINAL_STATES.has(session.state)) return;

      if (code === 0 && !signal) {
        transition(session, STATES.COMPLETED, "exit_0");
        emitter.emit("completed", { sessionId: session.id });
        if (typeof session.config.onCompleted === "function") {
          session.config.onCompleted({ sessionId: session.id });
        }
        if (broker && session.config.accountId) {
          broker.release(session.config.accountId, { ok: true });
        }
      } else {
        // detect rate_limited from recent output before handleFailure
        if (
          /(rate.?limit|quota|throttl|too.many.requests|429|usage.limit)/iu.test(
            recentOutput,
          )
        ) {
          session.lastFailureMode = "rate_limited";
        }
        handleFailure(session, `exit_code:${code},signal:${signal}`);
      }

      maybeAutoShutdown();
    });

    child.on("error", (err) => {
      session.alive = false;
      eventLog.append("child_error", {
        session: session.id,
        error: err.message,
      });
      if (!TERMINAL_STATES.has(session.state)) {
        handleFailure(session, `child_error:${err.message}`);
      }
    });

    session.alive = true;

    // Health probe 설정
    session.probe?.stop();
    const probe = createHealthProbe(
      {
        get pid() {
          return child.pid;
        },
        get alive() {
          return session.alive;
        },
        getOutputBytes: () => outputBytes,
        getRecentOutput: () => recentOutput,
      },
      {
        ...probeOpts,
        onProbe: (result) => handleProbeResult(session, result),
      },
    );
    session.probe = probe;
    probe.start();
  }

  /**
   * 원격 세션 시작 — child process 대신 SSH capture-pane 폴링.
   * 원격 세션은 remote-spawn.mjs가 이미 psmux 세션을 생성한 상태를 가정.
   */
  function startRemoteSession(session) {
    transition(session, STATES.STARTING, "remote_initial");

    const { host, paneTarget, sessionName } = session.config;
    const resolvedPane = paneTarget || `${sessionName || session.id}:0.0`;
    const resolvedSessionName = sessionName || session.id;

    eventLog.append("remote_start", {
      session: session.id,
      host,
      paneTarget: resolvedPane,
      sessionName: resolvedSessionName,
    });

    session.alive = true;

    // Remote health probe 설정
    session.probe?.stop();
    const probe = createRemoteProbe(
      {
        host,
        paneTarget: resolvedPane,
        sessionName: resolvedSessionName,
      },
      {
        ...probeOpts,
        onProbe: (result) => handleProbeResult(session, result),
      },
    );
    session.probe = probe;
    probe.start();
  }

  /**
   * 모든 세션이 terminal이면 auto-shutdown.
   */
  function maybeAutoShutdown() {
    if (shuttingDown) return;
    const allTerminal = [...sessions.values()].every((s) =>
      TERMINAL_STATES.has(s.state),
    );
    if (allTerminal && sessions.size > 0) {
      emitter.emit("allCompleted");
    }
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * 새 세션 spawn.
   * @param {object} config
   * @param {string} config.id — 세션 ID (unique)
   * @param {'codex'|'gemini'|'claude'} config.agent
   * @param {string} config.prompt
   * @param {string} [config.profile]
   * @param {string} [config.workdir]
   * @param {string} [config.model]
   * @param {boolean} [config.remote=false] — 원격 세션 여부
   * @param {string} [config.host] — SSH 호스트 (remote=true 필수)
   * @param {string} [config.paneTarget] — psmux pane target (remote용)
   * @param {string} [config.sessionName] — psmux 세션 이름 (remote용)
   * @param {function} [config.onCompleted] — 세션 완료 시 콜백 ({sessionId}) => void
   * @returns {string} session ID
   */
  function spawnSession(config) {
    if (shuttingDown) throw new Error("Conductor is shutting down");
    if (!config.id) throw new Error("session id is required");
    if (sessions.has(config.id))
      throw new Error(`Session "${config.id}" already exists`);
    if (config.remote && !config.host)
      throw new Error("host is required for remote sessions");

    // broker lease (graceful — broker null if accounts.json absent)
    let lease = null;
    if (broker && config.agent && !config.remote) {
      lease = broker.lease({ provider: config.agent });
      if (lease === null) {
        const eta = broker.nextAvailableEta(config.agent);
        eventLog.append("broker_no_lease", {
          session: config.id,
          agent: config.agent,
          eta: eta ? new Date(eta).toISOString() : "unknown",
        });
        // 계정이 모두 cooldown이어도 세션 생성 자체는 유지한다.
        // 로컬 테스트/단일 계정 없는 환경에서도 상태 머신이 일관되게 동작해야 한다.
      }
    }

    // apply lease profile/env/auth to config (immutable — new object)
    const resolvedConfig = lease
      ? {
          ...config,
          profile: lease.profile ?? config.profile,
          env: { ...(config.env || {}), ...(lease.env || {}) },
          accountId: lease.id,
        }
      : config;

    // auth file copy — broker resolved absolute path, conductor does the actual copy
    if (lease?.mode === "auth" && lease.authFile) {
      const dests =
        config.agent === "codex"
          ? [join(homedir(), ".codex", "auth.json")]
          : [
              join(homedir(), ".gemini", "oauth_creds.json"),
              join(homedir(), ".gemini", "gemini-credentials.json"),
            ];
      for (const dest of dests) {
        try {
          mkdirSync(dirname(dest), { recursive: true });
          copyFileSync(lease.authFile, dest);
          eventLog.append("auth_copy", {
            session: config.id,
            agent: config.agent,
            dest,
          });
        } catch (err) {
          eventLog.append("auth_copy_error", {
            session: config.id,
            dest,
            error: err.message,
          });
        }
      }
    }

    // 원격 세션은 launcher 불필요 (이미 원격에서 실행 중)
    const launcher = resolvedConfig.remote
      ? null
      : buildLauncher({
          agent: resolvedConfig.agent,
          profile: resolvedConfig.profile,
          prompt: resolvedConfig.prompt,
          workdir: resolvedConfig.workdir,
          model: resolvedConfig.model,
        });

    const session = {
      id: resolvedConfig.id,
      config: resolvedConfig,
      launcher,
      state: STATES.INIT,
      child: null,
      probe: null,
      alive: false,
      restarts: 0,
      outPath: null,
      errPath: null,
      createdAt: Date.now(),
    };

    sessions.set(resolvedConfig.id, session);
    getConductorRegistry()?.register?.(resolvedConfig.id, publicApi);

    if (resolvedConfig.remote) {
      startRemoteSession(session);
    } else {
      void respawnSession(session);
    }
    return resolvedConfig.id;
  }

  /**
   * 세션 kill.
   * @param {string} id
   * @param {string} [reason]
   */
  async function killSession(id, reason = "user_kill") {
    const session = sessions.get(id);
    if (!session) return;
    if (TERMINAL_STATES.has(session.state)) return;

    eventLog.append("kill", { session: id, reason });
    await cleanupChild(session);
    transition(session, STATES.FAILED, reason);
    transition(session, STATES.DEAD, reason);
  }

  /**
   * 세션에 stdin 입력 전송 (INPUT_WAIT 해소용).
   * @param {string} id
   * @param {string} text
   */
  function sendInput(id, text) {
    const session = sessions.get(id);
    if (!session) return false;

    // 원격 세션 — stdin 미지원 (psmux send-keys는 별도 경로)
    if (session.config.remote) {
      eventLog.append("stdin_remote_unsupported", { session: id });
      return false;
    }

    if (!session.child) return false;
    try {
      session.child.stdin.write(`${text}\n`);
      eventLog.append("stdin", { session: id, text: text.slice(0, 100) });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 전체 세션 스냅샷.
   * @returns {object[]}
   */
  function getSnapshot() {
    return [...sessions.values()].map((s) => ({
      id: s.id,
      agent: s.config.agent,
      state: s.state,
      pid: s.child?.pid || null,
      remote: s.config.remote || false,
      host: s.config.host || null,
      restarts: s.restarts,
      health: s.probe?.getStatus() || null,
      outPath: s.outPath,
      errPath: s.errPath,
      createdAt: s.createdAt,
    }));
  }

  /**
   * Graceful shutdown — 전체 세션 종료.
   */
  async function shutdown(reason = "shutdown") {
    if (shuttingDown) return;
    shuttingDown = true;

    eventLog.append("shutdown", { reason, sessions: sessions.size });

    const cleanups = [...sessions.values()]
      .filter((s) => !TERMINAL_STATES.has(s.state))
      .map(async (s) => {
        s.probe?.stop();
        await cleanupChild(s);
        if (!TERMINAL_STATES.has(s.state)) {
          transition(s, STATES.FAILED, reason);
          transition(s, STATES.DEAD, reason);
        }
      });

    await Promise.allSettled(cleanups);
    if (conductor._meshBridge) conductor._meshBridge.detach();
    await eventLog.flush();
    await eventLog.close();
    emitter.emit("shutdown");
  }

  // Shutdown traps
  const onSignal = () => {
    void shutdown("signal");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const conductor = {
    spawnSession,
    killSession,
    sendInput,
    getSnapshot,
    getMeshRegistry() {
      return this._meshRegistry || null;
    },
    shutdown,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    get sessionCount() {
      return sessions.size;
    },
    get isShuttingDown() {
      return shuttingDown;
    },
    get eventLogPath() {
      return eventLog.filePath;
    },
  };

  if (opts.enableMesh !== false) {
    try {
      const registry = opts.meshRegistry || createRegistry();
      const bridge = createConductorMeshBridge(conductor, registry);
      bridge.attach();
      conductor._meshBridge = bridge;
      conductor._meshRegistry = registry;
    } catch {
      // mesh 실패해도 conductor 정상 동작
    }
  }

  const frozenApi = Object.freeze(conductor);
  ensureConductorRegistry();
  return frozenApi;
}
