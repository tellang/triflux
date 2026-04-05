import { randomUUID } from "node:crypto";

export const MSG_TYPES = Object.freeze({
  REQUEST: "request",
  RESPONSE: "response",
  EVENT: "event",
  HEARTBEAT: "heartbeat",
});

const VALID_TYPES = new Set(Object.values(MSG_TYPES));

/**
 * Creates an immutable mesh message.
 * @param {string} type - One of MSG_TYPES values
 * @param {string} from - Sender agent ID
 * @param {string} to - Recipient agent ID (or "*" for broadcast)
 * @param {unknown} payload - Message payload
 * @returns {Readonly<object>}
 */
export function createMessage(type, from, to, payload = null) {
  if (!VALID_TYPES.has(type)) {
    throw new TypeError(`Invalid message type: ${type}`);
  }
  if (!from || typeof from !== "string") {
    throw new TypeError("from must be a non-empty string");
  }
  if (!to || typeof to !== "string") {
    throw new TypeError("to must be a non-empty string");
  }
  return Object.freeze({
    type,
    from,
    to,
    payload,
    timestamp: new Date().toISOString(),
    correlationId: randomUUID(),
  });
}

/**
 * Serializes a message to a JSON string.
 * @param {object} message
 * @returns {string}
 */
export function serialize(message) {
  return JSON.stringify(message);
}

/**
 * Deserializes a JSON string to a message object.
 * @param {string} raw
 * @returns {object}
 */
export function deserialize(raw) {
  if (typeof raw !== "string") {
    throw new TypeError("raw must be a string");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SyntaxError(`Failed to parse message: ${raw}`);
  }
  return parsed;
}

/**
 * Validates a message object.
 * @param {unknown} message
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validate(message) {
  const errors = [];

  if (!message || typeof message !== "object") {
    return { valid: false, errors: ["message must be an object"] };
  }

  if (!VALID_TYPES.has(message.type)) {
    errors.push(`Invalid type: ${message.type}`);
  }
  if (!message.from || typeof message.from !== "string") {
    errors.push("from must be a non-empty string");
  }
  if (!message.to || typeof message.to !== "string") {
    errors.push("to must be a non-empty string");
  }
  if (!message.timestamp || typeof message.timestamp !== "string") {
    errors.push("timestamp must be a non-empty string");
  }
  if (!message.correlationId || typeof message.correlationId !== "string") {
    errors.push("correlationId must be a non-empty string");
  }

  return { valid: errors.length === 0, errors };
}
