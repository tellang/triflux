import { validate } from "./mesh-protocol.mjs";

/**
 * Routes a mesh message to target agent(s) based on the `to` field.
 *
 * Addressing modes:
 *   - "agent-id"       → direct delivery (registry lookup)
 *   - "*"              → broadcast to all registered agents
 *   - "capability:X"   → discover agents with capability X
 *
 * @param {object} message  - A mesh-protocol message
 * @param {object} registry - A mesh-registry instance
 * @returns {{ routed: boolean, targets?: string[], reason?: string }}
 */
export function routeMessage(message, registry) {
  const { valid, errors } = validate(message);
  if (!valid) {
    return { routed: false, reason: `invalid message: ${errors.join(", ")}` };
  }

  const { to, from } = message;

  // Broadcast
  if (to === "*") {
    const all = registry.listAll();
    const targets = all
      .map((a) => a.agentId)
      .filter((id) => id !== from);
    if (targets.length === 0) {
      return { routed: false, reason: "broadcast: no agents registered" };
    }
    return { routed: true, targets };
  }

  // Capability-based routing
  if (to.startsWith("capability:")) {
    const capability = to.slice("capability:".length);
    if (!capability) {
      return { routed: false, reason: "capability: empty capability name" };
    }
    const targets = registry.discover(capability);
    if (targets.length === 0) {
      return { routed: false, reason: `capability: no agents with "${capability}"` };
    }
    return { routed: true, targets };
  }

  // Direct addressing
  const agent = registry.getAgent(to);
  if (!agent) {
    return { routed: false, reason: `agent not found: "${to}"` };
  }
  return { routed: true, targets: [to] };
}

/**
 * Routes a message and collects dead-letter info when delivery fails.
 *
 * @param {object} message
 * @param {object} registry
 * @returns {{ routed: boolean, targets?: string[], deadLetter?: object }}
 */
export function routeOrDeadLetter(message, registry) {
  const result = routeMessage(message, registry);
  if (!result.routed) {
    return {
      ...result,
      deadLetter: {
        originalMessage: message,
        reason: result.reason,
        timestamp: new Date().toISOString(),
      },
    };
  }
  return result;
}
