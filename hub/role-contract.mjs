export const PROJECT_ID_PATTERN = "^prj_[A-Za-z0-9_-]{22}$";
export const HOST_ID_PATTERN = "^hst_[A-Za-z0-9_-]+$";

const PROJECT_ID_RE = new RegExp(PROJECT_ID_PATTERN, "u");
const SCOPE_ID_RE = /^scp_[A-Za-z0-9_-]{22}$/u;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/u;

export const ROLE_KINDS = Object.freeze(["cto", "lead"]);
export const ROLE_REACHABILITY_STATES = Object.freeze([
  "electable",
  "elected-probing",
  "active",
  "unreachable",
  "quarantined",
]);
export const ROLE_STATUS_SCHEMA_VERSION = "tfx.roles.v2";
export const LEGACY_ROLE_SNAPSHOT_FIELDS = Object.freeze([
  "role",
  "status",
  "leader_agent_id",
  "previous_leader_agent_id",
  "leader_epoch",
  "lease_expires_ms",
  "candidate_source",
  "candidate_count",
  "live_candidate_count",
  "pending_count",
  "transferred_count",
  "last_transition_ms",
  "last_reason",
  "candidates",
]);

function roleContractError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJsonRoleKey(key) {
  return key.role_kind === "lead"
    ? `{"project_id":${JSON.stringify(key.project_id)},"role_kind":"lead","scope_id":${JSON.stringify(key.scope_id)}}`
    : `{"project_id":${JSON.stringify(key.project_id)},"role_kind":"cto"}`;
}

/**
 * Validate and normalize the only two valid dynamic role identities.
 *
 * @param {unknown} input
 * @returns {{project_id: string, role_kind: "cto"} | {project_id: string, role_kind: "lead", scope_id: string}}
 */
export function normalizeRoleKey(input) {
  if (!isRecord(input)) throw roleContractError("ROLE_KEY_INVALID");

  const fields = Object.keys(input);
  const allowed = new Set(["project_id", "role_kind", "scope_id"]);
  if (fields.some((field) => !allowed.has(field))) {
    throw roleContractError("ROLE_KEY_FIELD_UNSUPPORTED");
  }

  const { project_id: projectId, role_kind: roleKind } = input;
  if (typeof projectId !== "string" || !PROJECT_ID_RE.test(projectId)) {
    throw roleContractError("PROJECT_ID_INVALID");
  }
  if (!ROLE_KINDS.includes(roleKind)) {
    throw roleContractError("ROLE_KIND_UNSUPPORTED");
  }

  const hasScope = Object.hasOwn(input, "scope_id");
  if (roleKind === "cto") {
    if (hasScope) throw roleContractError("ROLE_SCOPE_FORBIDDEN");
    return { project_id: projectId, role_kind: "cto" };
  }

  if (!hasScope || typeof input.scope_id !== "string") {
    throw roleContractError("SCOPE_REQUIRED");
  }
  if (!SCOPE_ID_RE.test(input.scope_id)) {
    throw roleContractError("SCOPE_ID_INVALID");
  }
  return { project_id: projectId, role_kind: "lead", scope_id: input.scope_id };
}

/** @param {unknown} key */
export function encodeRoleKey(key) {
  const normalized = normalizeRoleKey(key);
  const wire = `rk2.${Buffer.from(canonicalJsonRoleKey(normalized), "utf8").toString("base64url")}`;
  if (Buffer.byteLength(wire, "utf8") > 512) {
    throw roleContractError("ROLE_KEY_WIRE_TOO_LONG");
  }
  return wire;
}

/** @param {unknown} wire */
export function decodeRoleKey(wire) {
  if (typeof wire !== "string" || Buffer.byteLength(wire, "utf8") > 512) {
    throw roleContractError("ROLE_KEY_WIRE_INVALID");
  }
  if (!wire.startsWith("rk2.")) throw roleContractError("ROLE_KEY_WIRE_PREFIX");

  const encoded = wire.slice(4);
  if (!encoded || !BASE64URL_RE.test(encoded)) {
    throw roleContractError("ROLE_KEY_NON_CANONICAL");
  }

  let parsed;
  try {
    const canonicalSource = Buffer.from(encoded, "base64url").toString("utf8");
    parsed = JSON.parse(canonicalSource);
  } catch {
    throw roleContractError("ROLE_KEY_NON_CANONICAL");
  }

  let normalized;
  try {
    normalized = normalizeRoleKey(parsed);
  } catch (error) {
    if (error?.code) throw error;
    throw roleContractError("ROLE_KEY_NON_CANONICAL");
  }
  if (encodeRoleKey(normalized) !== wire) {
    throw roleContractError("ROLE_KEY_NON_CANONICAL");
  }
  return normalized;
}

/** @param {unknown} key */
export function roleTopicAddress(key) {
  return `topic:role:${encodeRoleKey(key)}`;
}

const TRANSITION_ROWS = [
  ["electable", "candidate_selected", "elected-probing", "reserve_holder"],
  ["electable", "standup_reserved", "elected-probing", "reserve_standup"],
  ["electable", "no_candidate", "electable", "record_blocked_no_candidate"],
  [
    "electable",
    "candidates_excluded",
    "quarantined",
    "schedule_exclusion_expiry",
  ],
  ["elected-probing", "probe_succeeded", "elected-probing", "send_activation"],
  ["elected-probing", "activation_acked", "active", "record_activation_ack"],
  [
    "elected-probing",
    "probe_failed",
    "unreachable",
    "exclude_failed_candidate",
  ],
  ["elected-probing", "wake_failed", "unreachable", "exclude_failed_candidate"],
  ["elected-probing", "ack_timeout", "unreachable", "exclude_failed_candidate"],
  [
    "elected-probing",
    "holder_lease_expired",
    "electable",
    "revoke_holder_epoch_fence",
  ],
  [
    "active",
    "holder_lease_expired",
    "electable",
    "revoke_holder_preserve_backlog",
  ],
  ["active", "holder_offline", "electable", "revoke_holder_preserve_backlog"],
  ["active", "transport_failed", "unreachable", "fence_active_authority"],
  ["active", "charter_reissued", "elected-probing", "reserve_reack"],
  [
    "unreachable",
    "alternate_candidate_available",
    "electable",
    "failover_candidate",
  ],
  ["unreachable", "retry_due", "elected-probing", "reserve_retry_epoch"],
  ["unreachable", "retries_exhausted", "quarantined", "schedule_quarantine"],
  [
    "quarantined",
    "exclusion_expired",
    "electable",
    "restore_candidate_eligibility",
  ],
  ["quarantined", "candidate_registered", "electable", "clear_quarantine"],
  ["quarantined", "locator_registered", "electable", "clear_quarantine"],
  ["quarantined", "capability_registered", "electable", "clear_quarantine"],
  ...ROLE_REACHABILITY_STATES.flatMap((state) => [
    [state, "stale_ack", state, "reject_stale_ack"],
    [state, "scope_closed", null, "remove_registry"],
  ]),
];

export const ROLE_REACHABILITY_TRANSITIONS = Object.freeze(
  TRANSITION_ROWS.map(([from, trigger, to, action]) =>
    Object.freeze({ from, trigger, to, action }),
  ),
);

const TRANSITIONS_BY_KEY = new Map(
  ROLE_REACHABILITY_TRANSITIONS.map((transition) => [
    `${transition.from}:${transition.trigger}`,
    transition,
  ]),
);

/**
 * Apply one already-guarded reachability event. Guard evaluation and all side
 * effects deliberately remain outside this inert contract kernel.
 */
export function reduceRoleReachabilityTransition(state, trigger) {
  if (!ROLE_REACHABILITY_STATES.includes(state)) {
    throw roleContractError("ROLE_REACHABILITY_STATE_INVALID");
  }
  const transition = TRANSITIONS_BY_KEY.get(`${state}:${trigger}`);
  if (!transition) throw roleContractError("INVALID_ROLE_TRANSITION");
  return trigger === "stale_ack"
    ? { state: transition.to, action: transition.action, code: "STALE_EPOCH" }
    : { state: transition.to, action: transition.action };
}

export const reduceRoleReachability = reduceRoleReachabilityTransition;

function snapshotLegacyDetails(snapshot) {
  const legacy = isRecord(snapshot.legacy) ? snapshot.legacy : {};
  return {
    candidate_source:
      legacy.candidate_source ?? snapshot.candidate_source ?? null,
    transferred_count:
      legacy.transferred_count ?? snapshot.transferred_count ?? 0,
    candidates: legacy.candidates ?? snapshot.candidates ?? [],
  };
}

/**
 * Construct the v2 status envelope in deterministic role-key order.
 * `generatedAtMs` is supplied by the caller so the kernel has no clock.
 */
export function createRoleStatusEnvelopeV2({
  items = [],
  generatedAtMs,
  projectId,
} = {}) {
  if (!Number.isFinite(generatedAtMs)) {
    throw roleContractError("ROLE_STATUS_GENERATED_AT_REQUIRED");
  }
  if (
    projectId !== undefined &&
    (typeof projectId !== "string" || !PROJECT_ID_RE.test(projectId))
  ) {
    throw roleContractError("PROJECT_ID_INVALID");
  }
  if (!Array.isArray(items))
    throw roleContractError("ROLE_STATUS_ITEMS_INVALID");

  return {
    schema_version: ROLE_STATUS_SCHEMA_VERSION,
    generated_at_ms: generatedAtMs,
    ...(projectId === undefined ? {} : { project_id: projectId }),
    items: [...items].sort((left, right) =>
      String(left?.role_key_wire || "").localeCompare(
        String(right?.role_key_wire || ""),
      ),
    ),
  };
}

/**
 * Project the single exact-project CTO into the legacy `roles.cto` shape.
 * The optional `legacy` detail preserves fields that v2 callers do not use.
 */
export function projectLegacyCtoStatus(envelope, projectId) {
  if (
    !isRecord(envelope) ||
    envelope.schema_version !== ROLE_STATUS_SCHEMA_VERSION ||
    !Array.isArray(envelope.items)
  ) {
    throw roleContractError("ROLE_STATUS_ENVELOPE_INVALID");
  }
  if (typeof projectId !== "string" || !PROJECT_ID_RE.test(projectId)) {
    throw roleContractError("SCOPE_REQUIRED");
  }

  const snapshot = envelope.items.find((item) => {
    const key = item?.role_key;
    return key?.project_id === projectId && key?.role_kind === "cto";
  });
  if (!snapshot) return { cto: null };

  const status =
    snapshot.state === "active"
      ? "active"
      : snapshot.state === "electable" || snapshot.state === "elected-probing"
        ? "electable"
        : "offline";
  const legacy = snapshotLegacyDetails(snapshot);
  return {
    cto: {
      role: "cto",
      status,
      leader_agent_id:
        status === "active" ? (snapshot.holder_agent_id ?? null) : null,
      previous_leader_agent_id: snapshot.previous_holder_agent_id ?? null,
      leader_epoch: snapshot.epoch,
      lease_expires_ms:
        status === "active" ? (snapshot.lease_expires_ms ?? null) : null,
      candidate_source: legacy.candidate_source,
      candidate_count: snapshot.candidate_count,
      live_candidate_count: snapshot.live_candidate_count,
      pending_count: snapshot.pending_count,
      transferred_count: legacy.transferred_count,
      last_transition_ms: snapshot.last_transition_ms,
      last_reason: snapshot.last_reason,
      candidates: legacy.candidates,
    },
  };
}
