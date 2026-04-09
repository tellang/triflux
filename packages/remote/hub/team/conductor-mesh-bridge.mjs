import { createMessage, MSG_TYPES } from "../../mesh/mesh-protocol.mjs";

const BRIDGE_AGENT_ID = "conductor";

/**
 * Creates a bridge that converts Conductor EventEmitter events
 * into Mesh protocol messages and keeps the registry in sync.
 *
 * @param {object} conductor - A conductor instance (with on/off)
 * @param {object} registry  - A mesh-registry instance
 * @param {object} [opts]
 * @param {string} [opts.bridgeAgentId="conductor"] - Agent ID for the bridge
 * @param {function} [opts.onMessage] - Called with each generated mesh message
 * @returns {object} Bridge API
 */
export function createConductorMeshBridge(conductor, registry, opts = {}) {
  const { bridgeAgentId = BRIDGE_AGENT_ID, onMessage } = opts;

  const sessionAgentMap = new Map();
  let attached = false;

  function emit(message) {
    if (typeof onMessage === "function") {
      onMessage(message);
    }
  }

  function agentIdForSession(sessionId) {
    return `session:${sessionId}`;
  }

  /**
   * Handle conductor stateChange events.
   * - starting → register agent in registry
   * - terminal states → unregister agent
   * - all transitions → emit mesh EVENT message
   */
  function handleStateChange(event) {
    const { sessionId, from, to, reason } = event;
    const agentId = agentIdForSession(sessionId);

    // Register on first starting transition
    if (to === "starting" && !sessionAgentMap.has(sessionId)) {
      registry.register(agentId, ["session"]);
      sessionAgentMap.set(sessionId, agentId);
    }

    // Emit mesh event
    const msg = createMessage(MSG_TYPES.EVENT, bridgeAgentId, "*", {
      event: "stateChange",
      sessionId,
      from,
      to,
      reason,
    });
    emit(msg);

    // Unregister on terminal states
    if (to === "dead" || to === "completed") {
      registry.unregister(agentId);
      sessionAgentMap.delete(sessionId);
    }
  }

  /**
   * Handle conductor completed events.
   */
  function handleCompleted(event) {
    const msg = createMessage(MSG_TYPES.EVENT, bridgeAgentId, "*", {
      event: "completed",
      sessionId: event.sessionId,
    });
    emit(msg);
  }

  /**
   * Handle conductor dead events.
   */
  function handleDead(event) {
    const msg = createMessage(MSG_TYPES.EVENT, bridgeAgentId, "*", {
      event: "dead",
      sessionId: event.sessionId,
      reason: event.reason,
    });
    emit(msg);
  }

  /**
   * Attaches event listeners to the conductor.
   */
  function attach() {
    if (attached) return;
    conductor.on("stateChange", handleStateChange);
    conductor.on("completed", handleCompleted);
    conductor.on("dead", handleDead);
    attached = true;
  }

  /**
   * Detaches event listeners and cleans up registry entries.
   */
  function detach() {
    if (!attached) return;
    conductor.off("stateChange", handleStateChange);
    conductor.off("completed", handleCompleted);
    conductor.off("dead", handleDead);

    for (const [, agentId] of sessionAgentMap) {
      registry.unregister(agentId);
    }
    sessionAgentMap.clear();
    attached = false;
  }

  return {
    attach,
    detach,
    get isAttached() {
      return attached;
    },
  };
}
