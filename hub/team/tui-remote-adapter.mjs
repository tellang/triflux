// hub/team/tui-remote-adapter.mjs — 원격 세션을 TUI 워커 형식으로 변환하는 어댑터
//
// conductor.mjs의 stateChange 이벤트(primary) + remote-watcher.mjs(supplemental)를
// tui.mjs updateWorker() 호환 형식으로 변환한다.
// 완료/실패 시 notify.mjs 자동 호출.

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { STATES } from "./conductor.mjs";

// ── 상수 ─────────────────────────────────────────────────────────────────────

const HOSTS_JSON_REL = "../../references/hosts.json";

const CONDUCTOR_STATE_TO_TUI_STATUS = Object.freeze({
  [STATES.INIT]: "pending",
  [STATES.STARTING]: "pending",
  [STATES.HEALTHY]: "running",
  [STATES.STALLED]: "running",
  [STATES.INPUT_WAIT]: "running",
  [STATES.FAILED]: "running",
  [STATES.RESTARTING]: "running",
  [STATES.COMPLETED]: "completed",
  [STATES.DEAD]: "failed",
});

const SESSION_PREFIX = "tfx-spawn-";

// ── 유틸 ─────────────────────────────────────────────────────────────────────

function loadHostsJson(hostsJsonPath) {
  try {
    const raw = readFileSync(hostsJsonPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return { hosts: {} };
  }
}

function resolveHostsJsonPath(overridePath) {
  if (overridePath) return overridePath;
  const thisDir = fileURLToPath(new URL(".", import.meta.url));
  return join(thisDir, HOSTS_JSON_REL);
}

function resolveSshUser(hostsData, host) {
  if (!host || !hostsData?.hosts) return null;
  return hostsData.hosts[host]?.ssh_user || null;
}

/**
 * tfx-spawn-{host}-{id} 형식에서 host를 추출한다.
 * @param {string} sessionName
 * @returns {string|null}
 */
function resolveHostFromSessionName(sessionName) {
  if (!sessionName?.startsWith(SESSION_PREFIX)) return null;
  const rest = sessionName.slice(SESSION_PREFIX.length);
  const dashIdx = rest.indexOf("-");
  if (dashIdx === -1) return rest || null;
  return rest.slice(0, dashIdx) || null;
}

/**
 * sessionName에서 role을 파생한다.
 * conductor config.id가 있으면 우선 사용, 없으면 sessionName 자체.
 */
function resolveRole(configId, sessionName) {
  return configId || sessionName || "unknown";
}

function buildPaneName(sessionName) {
  return `remote:${sessionName}`;
}

function mapConductorStateToStatus(conductorState) {
  return CONDUCTOR_STATE_TO_TUI_STATUS[conductorState] || "pending";
}

/**
 * conductor snapshot 엔트리 → TUI 워커 데이터.
 * @param {object} entry — conductor getSnapshot() 엔트리
 * @param {object} watcherSession — remote-watcher의 세션 레코드 (nullable)
 * @param {object} hostsData — hosts.json 데이터
 * @returns {object}
 */
function buildWorkerData(entry, watcherSession, hostsData) {
  const host = entry.host || resolveHostFromSessionName(entry.id);
  const snapshot = watcherSession?.lastOutput || "";
  const probeLevel =
    entry.health?.level || watcherSession?.lastProbeLevel || null;

  return Object.freeze({
    cli: entry.agent || "claude",
    role: resolveRole(entry.id, entry.id),
    status: mapConductorStateToStatus(entry.state),
    host: host || "unknown",
    remote: true,
    sshUser: resolveSshUser(hostsData, host),
    sessionName: entry.id,
    snapshot,
    conductor: Object.freeze({
      state: entry.state,
      restarts: entry.restarts || 0,
      probeLevel,
    }),
  });
}

/**
 * remote-watcher 전용 엔트리 → TUI 워커 데이터 (conductor 미등록 세션).
 */
function buildWatcherOnlyWorkerData(watcherRecord, hostsData) {
  const host =
    watcherRecord.host || resolveHostFromSessionName(watcherRecord.sessionName);

  return Object.freeze({
    cli: "claude",
    role: resolveRole(null, watcherRecord.sessionName),
    status:
      watcherRecord.state === "completed"
        ? "completed"
        : watcherRecord.state === "failed"
          ? "failed"
          : "running",
    host: host || "unknown",
    remote: true,
    sshUser: resolveSshUser(hostsData, host),
    sessionName: watcherRecord.sessionName,
    snapshot: watcherRecord.lastOutput || "",
    conductor: null,
  });
}

// ── 팩토리 ───────────────────────────────────────────────────────────────────

/**
 * 원격 세션 어댑터 팩토리.
 *
 * @param {object} opts
 * @param {object} opts.conductor — createConductor() 인스턴스
 * @param {object} [opts.watcher] — createRemoteWatcher() 인스턴스 (nullable)
 * @param {object} [opts.notifier] — createNotifier() 인스턴스 (nullable)
 * @param {string} [opts.hostsJsonPath] — hosts.json 경로 override
 * @param {number} [opts.pollMs=10000] — conductor snapshot 폴링 간격
 * @param {object} [opts.deps] — 테스트용 의존성 주입
 * @returns {{ start, stop, getWorkers, on, off }}
 */
export function createRemoteAdapter(opts = {}) {
  const {
    conductor,
    watcher = null,
    notifier = null,
    pollMs = 10_000,
    deps = {},
  } = opts;

  if (!conductor) throw new Error("conductor is required");

  const hostsJsonPath = resolveHostsJsonPath(opts.hostsJsonPath);
  const loadHosts = deps.loadHostsJson || loadHostsJson;
  const setIntervalFn = deps.setInterval || setInterval;
  const clearIntervalFn = deps.clearInterval || clearInterval;
  const _nowFn = deps.now || Date.now;

  const emitter = new EventEmitter();
  let hostsData = loadHosts(hostsJsonPath);
  let workers = new Map();
  let pollHandle = null;
  let running = false;

  // ── conductor stateChange 핸들러 (primary) ──

  function handleStateChange({ sessionId, from, to, reason }) {
    const snapshots = conductor.getSnapshot();
    const entry = snapshots.find((s) => s.id === sessionId);
    if (!entry?.remote) return;

    const watcherStatus = getWatcherSession(sessionId);
    const workerData = buildWorkerData(entry, watcherStatus, hostsData);
    const paneName = buildPaneName(sessionId);

    workers = new Map(workers);
    workers.set(paneName, workerData);

    emitter.emit("workerUpdate", { ...workerData, paneName });

    if (to === STATES.COMPLETED) {
      emitter.emit("workerCompleted", {
        name: paneName,
        host: workerData.host,
        exitCode: 0,
      });
      notifyIfAvailable({
        type: "completed",
        sessionId,
        host: workerData.host,
        summary: `completed (${reason})`,
      });
    } else if (to === STATES.DEAD) {
      emitter.emit("workerFailed", {
        name: paneName,
        host: workerData.host,
        reason,
      });
      notifyIfAvailable({
        type: "failed",
        sessionId,
        host: workerData.host,
        summary: `dead: ${reason}`,
      });
    } else if (to === STATES.INPUT_WAIT) {
      emitter.emit("workerInputWait", {
        name: paneName,
        host: workerData.host,
        pattern: reason,
      });
      notifyIfAvailable({
        type: "inputWait",
        sessionId,
        host: workerData.host,
        summary: `input_wait: ${reason}`,
      });
    }
  }

  // ── remote-watcher 이벤트 핸들러 (supplemental) ──

  function handleWatcherCompleted({ sessionName, exitCode, host }) {
    if (isConductorTracked(sessionName)) return;

    const paneName = buildPaneName(sessionName);
    notifyIfAvailable({
      type: "completed",
      sessionId: sessionName,
      host: host || resolveHostFromSessionName(sessionName),
      summary: `exit ${exitCode ?? 0}`,
    });
    emitter.emit("workerCompleted", {
      name: paneName,
      host: host || resolveHostFromSessionName(sessionName),
      exitCode: exitCode ?? 0,
    });
  }

  function handleWatcherFailed({ sessionName, reason, host }) {
    if (isConductorTracked(sessionName)) return;

    const paneName = buildPaneName(sessionName);
    notifyIfAvailable({
      type: "failed",
      sessionId: sessionName,
      host: host || resolveHostFromSessionName(sessionName),
      summary: reason || "session failed",
    });
    emitter.emit("workerFailed", {
      name: paneName,
      host: host || resolveHostFromSessionName(sessionName),
      reason: reason || "session failed",
    });
  }

  function handleWatcherInputWait({ sessionName, inputWaitPattern, host }) {
    if (isConductorTracked(sessionName)) return;

    const paneName = buildPaneName(sessionName);
    notifyIfAvailable({
      type: "inputWait",
      sessionId: sessionName,
      host: host || resolveHostFromSessionName(sessionName),
      summary: `input_wait: ${inputWaitPattern || "unknown"}`,
    });
    emitter.emit("workerInputWait", {
      name: paneName,
      host: host || resolveHostFromSessionName(sessionName),
      pattern: inputWaitPattern || "unknown",
    });
  }

  // ── 내부 헬퍼 ──

  function isConductorTracked(sessionName) {
    const snapshots = conductor.getSnapshot();
    return snapshots.some((s) => s.id === sessionName && s.remote);
  }

  function getWatcherSession(sessionName) {
    if (!watcher) return null;
    const status = watcher.getStatus();
    return status.sessions?.[sessionName] || null;
  }

  function notifyIfAvailable(event) {
    if (!notifier) return;
    try {
      notifier.notify(event);
    } catch {
      // notify 실패는 adapter를 중단시키지 않는다
    }
  }

  /**
   * conductor snapshot을 폴링하여 모든 원격 워커를 갱신.
   */
  function pollConductorSnapshot() {
    const snapshots = conductor.getSnapshot();
    const nextWorkers = new Map(workers);
    const conductorSessionIds = new Set();

    for (const entry of snapshots) {
      if (!entry.remote) continue;
      conductorSessionIds.add(entry.id);

      const watcherSession = getWatcherSession(entry.id);
      const workerData = buildWorkerData(entry, watcherSession, hostsData);
      const paneName = buildPaneName(entry.id);
      nextWorkers.set(paneName, workerData);
    }

    // watcher-only 세션 (conductor 미등록)
    if (watcher) {
      const watcherStatus = watcher.getStatus();
      for (const [sessionName, record] of Object.entries(
        watcherStatus.sessions || {},
      )) {
        if (conductorSessionIds.has(sessionName)) continue;
        const paneName = buildPaneName(sessionName);
        const workerData = buildWatcherOnlyWorkerData(record, hostsData);
        nextWorkers.set(paneName, workerData);
      }
    }

    workers = nextWorkers;
  }

  // ── 공개 API ───────────────────────────────────────────────────────────────

  function start() {
    if (running) return;
    running = true;

    // hosts.json 리로드
    hostsData = loadHosts(hostsJsonPath);

    // conductor stateChange 구독
    conductor.on("stateChange", handleStateChange);

    // watcher 이벤트 구독
    if (watcher) {
      watcher.on("sessionCompleted", handleWatcherCompleted);
      watcher.on("sessionFailed", handleWatcherFailed);
      watcher.on("sessionInputWait", handleWatcherInputWait);
    }

    // 초기 snapshot 로드
    pollConductorSnapshot();

    // 주기적 폴링 (snapshot 갱신용 — stateChange가 primary)
    pollHandle = setIntervalFn(() => {
      pollConductorSnapshot();
    }, pollMs);
    pollHandle?.unref?.();
  }

  function stop() {
    if (!running) return;
    running = false;

    conductor.off("stateChange", handleStateChange);

    if (watcher) {
      watcher.off("sessionCompleted", handleWatcherCompleted);
      watcher.off("sessionFailed", handleWatcherFailed);
      watcher.off("sessionInputWait", handleWatcherInputWait);
    }

    if (pollHandle) {
      clearIntervalFn(pollHandle);
      pollHandle = null;
    }
  }

  function getWorkers() {
    return new Map(workers);
  }

  return Object.freeze({
    start,
    stop,
    getWorkers,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
  });
}
