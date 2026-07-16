const EVENT_NAMES = new Set(["capability.degraded", "drift.detected"]);
const CONTROL_ACTIONS = new Set([
  "log_only",
  "candidate_exclude",
  "adapter_disable",
  "role_failover",
  "dispatch_block",
  "manager_disable",
]);
const OPTIONAL_FIELDS = [
  "project_id",
  "role_key_wire",
  "candidate_agent_id",
  "transport_id",
  "capability",
  "expected_version",
  "observed_version",
  "trace_id",
  "error_code",
];

export const ROLE_CONTROL_EVENT_SCHEMA_VERSION = "tfx.role-control-event.v1";
export const ROLE_CONTROL_EVENT_FIELDS = Object.freeze([
  "schema_version",
  "event",
  "event_id",
  "module",
  "dur_ms",
  "control_action",
  "reason_code",
  ...OPTIONAL_FIELDS,
]);

function eventError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function defaultEventId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `evt_${Math.random().toString(36).slice(2)}`
  );
}

function validateRequired(event) {
  if (!EVENT_NAMES.has(event.event))
    throw eventError("ROLE_CONTROL_EVENT_INVALID");
  if (typeof event.event_id !== "string" || !event.event_id) {
    throw eventError("ROLE_CONTROL_EVENT_REQUIRED");
  }
  if (typeof event.module !== "string" || !event.module) {
    throw eventError("ROLE_CONTROL_EVENT_REQUIRED");
  }
  if (!Number.isFinite(event.dur_ms) || event.dur_ms < 0) {
    throw eventError("ROLE_CONTROL_EVENT_REQUIRED");
  }
  if (!CONTROL_ACTIONS.has(event.control_action)) {
    throw eventError("ROLE_CONTROL_EVENT_REQUIRED");
  }
  if (typeof event.reason_code !== "string" || !event.reason_code) {
    throw eventError("ROLE_CONTROL_EVENT_REQUIRED");
  }
}

/**
 * Build an allowlisted event object. Unknown domain fields are intentionally
 * discarded before the event reaches a logger.
 */
export function buildRoleControlEvent(
  input = {},
  { eventId = defaultEventId } = {},
) {
  const event = {
    schema_version: ROLE_CONTROL_EVENT_SCHEMA_VERSION,
    event: input.event,
    event_id: input.event_id ?? eventId(),
    module: input.module,
    dur_ms: input.dur_ms,
    control_action: input.control_action,
    reason_code: input.reason_code,
  };
  for (const field of OPTIONAL_FIELDS) {
    if (input[field] !== undefined) event[field] = input[field];
  }
  validateRequired(event);
  return event;
}

export function buildCapabilityDegradedEvent(input = {}, options = {}) {
  return buildRoleControlEvent(
    { ...input, event: "capability.degraded" },
    options,
  );
}

export function buildDriftDetectedEvent(input = {}, options = {}) {
  return buildRoleControlEvent({ ...input, event: "drift.detected" }, options);
}

/**
 * Pino-style loggers receive event as an object field and as the message.
 */
export function emitRoleControlEvent(log, event, level = "warn") {
  if (!log || typeof log[level] !== "function") {
    throw eventError("ROLE_CONTROL_LOGGER_INVALID");
  }
  const sanitized = buildRoleControlEvent(event, {
    eventId: () => event?.event_id,
  });
  log[level](sanitized, sanitized.event);
}
