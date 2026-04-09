const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_THRESHOLD_MS = 60_000;

/**
 * Creates a heartbeat monitor that tracks agent liveness.
 *
 * @param {object} registry - A mesh-registry instance
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=30000]   - Scan interval
 * @param {number} [opts.thresholdMs=60000]  - Stale threshold
 * @param {function} [opts.onStale]          - Called with agentId when stale detected
 * @returns {object} HeartbeatMonitor API
 */
export function createHeartbeatMonitor(registry, opts = {}) {
  const {
    intervalMs = DEFAULT_INTERVAL_MS,
    thresholdMs = DEFAULT_THRESHOLD_MS,
    onStale,
  } = opts;

  /** @type {Map<string, number>} agentId → last heartbeat timestamp */
  const heartbeats = new Map();
  let timer = null;

  /**
   * Records a heartbeat for an agent.
   * @param {string} agentId
   */
  function recordHeartbeat(agentId) {
    if (!agentId || typeof agentId !== "string") {
      throw new TypeError("agentId must be a non-empty string");
    }
    heartbeats.set(agentId, Date.now());
  }

  /**
   * Returns agent IDs whose last heartbeat exceeds the threshold.
   * Only considers agents currently registered in the registry.
   *
   * @param {number} [customThresholdMs] - Override default threshold
   * @returns {string[]}
   */
  function getStaleAgents(customThresholdMs) {
    const threshold = customThresholdMs ?? thresholdMs;
    const now = Date.now();
    const registered = registry.listAll();
    const stale = [];

    for (const agent of registered) {
      const lastBeat = heartbeats.get(agent.agentId);
      if (lastBeat === undefined || now - lastBeat >= threshold) {
        stale.push(agent.agentId);
      }
    }
    return stale;
  }

  /**
   * Runs a single scan: finds stale agents and invokes onStale callback.
   */
  function scan() {
    const stale = getStaleAgents();
    if (typeof onStale === "function") {
      for (const agentId of stale) {
        onStale(agentId);
      }
    }
  }

  /**
   * Starts periodic heartbeat scanning.
   * @param {number} [customIntervalMs]
   */
  function start(customIntervalMs) {
    stop();
    const interval = customIntervalMs ?? intervalMs;
    timer = setInterval(scan, interval);
    timer.unref?.();
  }

  /**
   * Stops periodic scanning.
   */
  function stop() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  /**
   * Removes heartbeat record for an agent.
   * @param {string} agentId
   */
  function remove(agentId) {
    heartbeats.delete(agentId);
  }

  return { recordHeartbeat, getStaleAgents, start, stop, scan, remove };
}
