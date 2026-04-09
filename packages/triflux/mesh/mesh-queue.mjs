const DEFAULT_MAX_QUEUE_SIZE = 100;
const DEFAULT_TTL_MS = 0; // 0 = no expiry

/**
 * Creates a per-agent message queue with TTL and size limits.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxQueueSize=100] - Max messages per agent queue
 * @param {number} [opts.ttlMs=0]         - Message TTL in ms (0 = no expiry)
 * @returns {object} Queue API
 */
export function createMessageQueue(opts = {}) {
  const { maxQueueSize = DEFAULT_MAX_QUEUE_SIZE, ttlMs = DEFAULT_TTL_MS } =
    opts;

  /** @type {Map<string, Array<{ message: object, enqueuedAt: number }>>} */
  const queues = new Map();

  /**
   * Returns the queue array for an agent (creates if absent).
   * @param {string} agentId
   * @returns {Array}
   */
  function getQueue(agentId) {
    let q = queues.get(agentId);
    if (!q) {
      q = [];
      queues.set(agentId, q);
    }
    return q;
  }

  /**
   * Removes expired messages from the front of a queue.
   * @param {Array} q
   * @param {number} now
   */
  function purgeExpired(q, now) {
    if (ttlMs <= 0) return;
    while (q.length > 0 && now - q[0].enqueuedAt > ttlMs) {
      q.shift();
    }
  }

  /**
   * Adds a message to the target agent's queue.
   * If queue exceeds maxQueueSize, the oldest message is dropped.
   *
   * @param {string} agentId - Target agent
   * @param {object} message - Mesh message
   * @returns {{ queued: boolean, dropped: boolean }}
   */
  function enqueue(agentId, message) {
    if (!agentId || typeof agentId !== "string") {
      throw new TypeError("agentId must be a non-empty string");
    }
    const q = getQueue(agentId);
    const now = Date.now();

    purgeExpired(q, now);

    let dropped = false;
    if (q.length >= maxQueueSize) {
      q.shift();
      dropped = true;
    }

    q.push({ message, enqueuedAt: now });
    return { queued: true, dropped };
  }

  /**
   * Removes and returns the next message for an agent.
   *
   * @param {string} agentId
   * @returns {object | null} The message, or null if queue is empty
   */
  function dequeue(agentId) {
    const q = queues.get(agentId);
    if (!q || q.length === 0) return null;

    const now = Date.now();
    purgeExpired(q, now);

    if (q.length === 0) return null;
    return q.shift().message;
  }

  /**
   * Returns the next message without removing it.
   *
   * @param {string} agentId
   * @returns {object | null}
   */
  function peek(agentId) {
    const q = queues.get(agentId);
    if (!q || q.length === 0) return null;

    const now = Date.now();
    purgeExpired(q, now);

    if (q.length === 0) return null;
    return q[0].message;
  }

  /**
   * Returns the number of (non-expired) messages in an agent's queue.
   *
   * @param {string} agentId
   * @returns {number}
   */
  function size(agentId) {
    const q = queues.get(agentId);
    if (!q) return 0;

    const now = Date.now();
    purgeExpired(q, now);

    return q.length;
  }

  /**
   * Drains all messages for an agent.
   *
   * @param {string} agentId
   * @returns {object[]} Array of messages
   */
  function drain(agentId) {
    const q = queues.get(agentId);
    if (!q || q.length === 0) return [];

    const now = Date.now();
    purgeExpired(q, now);

    const messages = q.map((entry) => entry.message);
    q.length = 0;
    return messages;
  }

  /**
   * Removes an agent's queue entirely.
   * @param {string} agentId
   */
  function clear(agentId) {
    queues.delete(agentId);
  }

  /**
   * Returns total message count across all agent queues.
   * @returns {number}
   */
  function totalSize() {
    let total = 0;
    const now = Date.now();
    for (const [, q] of queues) {
      purgeExpired(q, now);
      total += q.length;
    }
    return total;
  }

  return { enqueue, dequeue, peek, size, drain, clear, totalSize };
}
