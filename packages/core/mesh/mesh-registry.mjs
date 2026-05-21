/**
 * Creates an agent registry for the mesh network.
 * Agents register with capabilities; registry enables discovery.
 * @returns {object} Registry API
 */
export function createRegistry() {
  // Map<agentId, AgentInfo>
  const agents = new Map();

  /**
   * Registers an agent with the registry.
   * @param {string} agentId
   * @param {string[]} capabilities
   */
  function register(agentId, capabilities = []) {
    if (!agentId || typeof agentId !== "string") {
      throw new TypeError("agentId must be a non-empty string");
    }
    if (!Array.isArray(capabilities)) {
      throw new TypeError("capabilities must be an array");
    }
    const info = Object.freeze({
      agentId,
      capabilities: Object.freeze([...capabilities]),
      registeredAt: new Date().toISOString(),
    });
    agents.set(agentId, info);
  }

  /**
   * Unregisters an agent from the registry.
   * @param {string} agentId
   */
  function unregister(agentId) {
    agents.delete(agentId);
  }

  /**
   * Discovers agents that have a specific capability.
   * @param {string} capability
   * @returns {string[]} Array of agentIds
   */
  function discover(capability) {
    const result = [];
    for (const [agentId, info] of agents) {
      if (info.capabilities.includes(capability)) {
        result.push(agentId);
      }
    }
    return result;
  }

  /**
   * Gets agent info by ID.
   * @param {string} agentId
   * @returns {object | null}
   */
  function getAgent(agentId) {
    return agents.get(agentId) ?? null;
  }

  /**
   * Lists all registered agents.
   * @returns {object[]}
   */
  function listAll() {
    return [...agents.values()];
  }

  /**
   * Clears all registered agents.
   */
  function clear() {
    agents.clear();
  }

  return { register, unregister, discover, getAgent, listAll, clear };
}
