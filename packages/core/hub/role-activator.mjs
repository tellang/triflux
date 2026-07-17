import {
  decodeRoleKey,
  encodeRoleKey,
  normalizeRoleKey,
} from "./role-contract.mjs";
import {
  buildCapabilityDegradedEvent,
  emitRoleControlEvent,
} from "./role-control-events.mjs";

export const ENSURE_ROLE_SCHEMA_VERSION = "tfx.ensure-role.v1";
export const ROLE_ACTIVATION_ACK_SCHEMA_VERSION = "tfx.role-activation-ack.v1";

const ENSURE_ROLE_TRIGGERS = new Set([
  "session_start",
  "publish_no_holder",
  "lease_expired",
  "restart_recovery",
  "hygiene_changed",
  "charter_issued",
  "manual",
]);
const REQUIRED_LOCATOR_CAPABILITIES = ["probe", "wake", "activate"];
const DEFAULTS = Object.freeze({
  probe_timeout_ms: 10_000,
  activation_ack_timeout_ms: 45_000,
  standup_timeout_ms: 60_000,
  max_probe_failures: 3,
  backoff_base_ms: 1_000,
  backoff_factor: 2,
  backoff_max_ms: 30_000,
  backoff_jitter_ratio: 0.2,
  candidate_quarantine_ms: 120_000,
});

function activatorError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeEnsureRequest(request, now) {
  if (
    !isRecord(request) ||
    request.schema_version !== ENSURE_ROLE_SCHEMA_VERSION ||
    !ENSURE_ROLE_TRIGGERS.has(request.trigger) ||
    typeof request.cause_id !== "string" ||
    !request.cause_id.trim()
  ) {
    throw activatorError("ENSURE_ROLE_REQUEST_INVALID");
  }
  const roleKey = normalizeRoleKey(request.role_key);
  return {
    schema_version: ENSURE_ROLE_SCHEMA_VERSION,
    role_key: roleKey,
    role_key_wire: encodeRoleKey(roleKey),
    trigger: request.trigger,
    cause_id: request.cause_id.trim(),
    requested_at_ms: now(),
  };
}

function managerEnabled(control, roleKind) {
  if (!control?.master_enabled) return false;
  return roleKind === "cto"
    ? control.cto_manager_enabled === true
    : control.lead_manager_enabled === true;
}

function blockedReason(control) {
  return control?.master_enabled ? "manager_disabled" : "master_off";
}

function receipt(disposition, roleKeyWire, role, extra = {}) {
  return {
    accepted: !["manager_disabled", "scope_closed"].includes(disposition),
    disposition,
    role_key_wire: roleKeyWire,
    state: role?.state ?? "electable",
    epoch: role?.epoch ?? 0,
    ...(role?.activation_id ? { activation_id: role.activation_id } : {}),
    ...extra,
  };
}

function activationGuard(role) {
  return {
    role_key_wire: role.role_key_wire,
    expected_version: role.version,
    expected_epoch: role.epoch,
    expected_activation_seq: role.activation_seq,
    expected_activation_id: role.activation_id,
  };
}

function locatorUsable(locator, adapter, disabledAdapters, now) {
  return (
    isRecord(locator) &&
    locator.schema_version === "tfx.transport-locator.v1" &&
    typeof locator.kind === "string" &&
    !disabledAdapters.has(locator.kind) &&
    Number(locator.expires_at_ms) > now &&
    Array.isArray(locator.capabilities) &&
    REQUIRED_LOCATOR_CAPABILITIES.every((capability) =>
      locator.capabilities.includes(capability),
    ) &&
    adapter.supports(locator) === true
  );
}

function candidateLive(candidate, store, roleKey, now) {
  const agent = store.getAgent(candidate.agent_id);
  if (
    !agent ||
    agent.status !== "online" ||
    Number(agent.lease_expires_ms) <= now
  ) {
    return null;
  }
  if (agent.project_id && agent.project_id !== roleKey.project_id) return null;
  const capabilities = Array.isArray(agent.capabilities)
    ? agent.capabilities
    : [];
  if (!capabilities.includes(`role:${roleKey.role_kind}:candidate`))
    return null;
  return agent;
}

function normalizeProbeResult(result, locator) {
  if (
    !isRecord(result) ||
    result.schema_version !== "tfx-live.transport-probe.v1"
  ) {
    return {
      ok: false,
      reachable: false,
      wakeable: false,
      reason_code: "protocol_mismatch",
      transport_id: locator.transport_id,
    };
  }
  return result;
}

export function computeRoleBackoffMs(
  failureCount,
  config = {},
  rng = Math.random,
) {
  const options = { ...DEFAULTS, ...config };
  const count = Math.max(1, Number(failureCount) || 1);
  const base = Math.min(
    options.backoff_base_ms * options.backoff_factor ** (count - 1),
    options.backoff_max_ms,
  );
  const unit = Math.max(0, Math.min(1, Number(rng()) || 0));
  const jitter = (unit * 2 - 1) * options.backoff_jitter_ratio;
  return Math.round(base * (1 + jitter));
}

export function createRoleActivator(options = {}) {
  const {
    store,
    adapter,
    getControlSnapshot = () => ({
      generation: 0,
      master_enabled: false,
      cto_manager_enabled: false,
      lead_manager_enabled: false,
    }),
    getCharterVersion = () => null,
    isScopeClosed = () => false,
    runCoreCanary = () => ({ ok: true }),
    uuid = () => globalThis.crypto.randomUUID(),
    now = Date.now,
    rng = Math.random,
    logger = null,
    onControlEvent = null,
    onRoleActive = null,
    scheduleTimeout = setTimeout,
    clearScheduledTimeout = clearTimeout,
    writeFallback = (line) => process.stderr.write(line),
  } = options;
  const config = { ...DEFAULTS, ...(options.config || {}) };
  if (!store || !adapter)
    throw activatorError("ROLE_ACTIVATOR_DEPENDENCY_INVALID");

  const flights = new Map();
  const ackTimers = new Map();
  const disabledAdapters = new Set();
  let controlOverride = null;
  let managerCircuitReason = null;

  function controlSnapshot() {
    return controlOverride || getControlSnapshot();
  }

  function emitDegraded(input) {
    let event = null;
    try {
      event = buildCapabilityDegradedEvent({
        module: "role-activator",
        dur_ms: 0,
        ...input,
      });
      if (typeof onControlEvent === "function") onControlEvent(event);
      if (logger) emitRoleControlEvent(logger, event);
      return event;
    } catch {
      managerCircuitReason = "logger_event_shape_failed";
      try {
        writeFallback(
          `${JSON.stringify({
            service: "triflux",
            env: process.env.NODE_ENV || "development",
            module: "role-activator",
            event: "capability.degraded",
            event_id:
              event?.event_id ??
              globalThis.crypto?.randomUUID?.() ??
              "evt_fallback",
            dur_ms: 0,
            control_action: "manager_disable",
            reason_code: managerCircuitReason,
            level: "error",
            time: new Date(now()).toISOString(),
            msg: "capability.degraded",
          })}\n`,
        );
      } catch {}
      return null;
    }
  }

  function runCanary(roleKeyWire) {
    if (managerCircuitReason) return false;
    let result;
    try {
      result = runCoreCanary({ store, adapter });
    } catch (error) {
      result = { ok: false, reason_code: error?.code || "core_canary_failed" };
    }
    if (result?.ok !== false) return true;
    managerCircuitReason = result.reason_code || "core_canary_failed";
    emitDegraded({
      control_action: "manager_disable",
      reason_code: managerCircuitReason,
      role_key_wire: roleKeyWire,
    });
    return false;
  }

  function eligibleCandidates(roleKey, roleKeyWire, excluded = new Set()) {
    const currentTime = now();
    return store
      .listRoleCandidates(roleKeyWire)
      .filter((candidate) => !excluded.has(candidate.agent_id))
      .filter(
        (candidate) =>
          candidate.excluded_until_ms == null ||
          Number(candidate.excluded_until_ms) <= currentTime,
      )
      .map((candidate) => {
        const agent = candidateLive(candidate, store, roleKey, currentTime);
        if (!agent) return null;
        const locators = (candidate.transport_locators || [])
          .filter((locator) =>
            locatorUsable(locator, adapter, disabledAdapters, currentTime),
          )
          .sort(
            (left, right) =>
              Number(right.priority || 0) - Number(left.priority || 0) ||
              String(left.transport_id).localeCompare(
                String(right.transport_id),
              ),
          );
        return locators.length ? { candidate, agent, locators } : null;
      })
      .filter(Boolean);
  }

  function reserve(roleKey, current, holder, trigger, activationId = uuid()) {
    const roleKeyWire = encodeRoleKey(roleKey);
    const result = store.upsertRoleReservation({
      role_key_wire: roleKeyWire,
      ...(current
        ? {
            expected_version: current.version,
            expected_epoch: current.epoch,
          }
        : {}),
      holder_agent_id: holder?.candidate.agent_id ?? null,
      holder_lease_expires_ms: holder?.agent.lease_expires_ms ?? null,
      state: "elected-probing",
      activation_id: activationId,
      activation_deadline_ms:
        now() +
        (holder ? config.activation_ack_timeout_ms : config.standup_timeout_ms),
      charter_version: getCharterVersion(roleKey.role_kind),
      charter_acked_epoch: null,
      blocked_reason: null,
      last_transition_ms: now(),
      last_reason: holder ? "candidate_selected" : "standup_reserved",
    });
    if (!result.ok) {
      throw activatorError("ROLE_RESERVATION_CONFLICT", result.reason);
    }
    return {
      roleKey,
      roleKeyWire,
      role: result.role,
      holder,
      trigger,
      controlGeneration: controlSnapshot()?.generation ?? 0,
    };
  }

  function prepare(normalized) {
    const { role_key: roleKey, role_key_wire: roleKeyWire } = normalized;
    const control = controlSnapshot();
    if (
      !managerEnabled(control, roleKey.role_kind) ||
      !runCanary(roleKeyWire)
    ) {
      const reasonCode = managerCircuitReason || blockedReason(control);
      let current = store.getRole(roleKeyWire);
      if (
        current &&
        (current.holder_agent_id ||
          current.activation_id ||
          current.state === "active" ||
          current.state === "elected-probing")
      ) {
        current = fencePlan({ roleKeyWire }, reasonCode).role;
      }
      return {
        receipt: receipt("manager_disabled", roleKeyWire, current, {
          blocked_reason: reasonCode,
        }),
      };
    }
    if (roleKey.role_kind === "lead" && isScopeClosed(roleKey)) {
      return {
        receipt: receipt(
          "scope_closed",
          roleKeyWire,
          store.getRole(roleKeyWire),
        ),
      };
    }

    const current = store.getRole(roleKeyWire);
    const charterVersion = getCharterVersion(roleKey.role_kind);
    if (
      current?.state === "active" &&
      current.holder_agent_id &&
      Number(current.holder_lease_expires_ms) > now() &&
      current.charter_acked_epoch === current.epoch &&
      current.charter_version === charterVersion &&
      normalized.trigger !== "charter_issued"
    ) {
      return {
        receipt: receipt("already_active", roleKeyWire, current),
      };
    }

    if (
      current?.state === "elected-probing" &&
      current.activation_id &&
      Number(current.activation_deadline_ms) > now()
    ) {
      return { receipt: receipt("joined", roleKeyWire, current) };
    }
    if (
      ["unreachable", "quarantined"].includes(current?.state) &&
      Number(current.next_probe_ms) > now()
    ) {
      return { receipt: receipt("joined", roleKeyWire, current) };
    }

    const candidates = eligibleCandidates(roleKey, roleKeyWire);
    const holder = candidates[0] || null;
    const plan = reserve(roleKey, current, holder, normalized.trigger);
    return { plan, candidates };
  }

  function cas(plan, patch) {
    return store.compareAndSetRole({
      ...activationGuard(plan.role),
      patch: {
        last_transition_ms: now(),
        ...patch,
      },
    });
  }

  function fencePlan(plan, reasonCode) {
    const current = store.getRole(plan.roleKeyWire);
    if (!current) return { ok: false, reason: "not_found", role: null };
    return store.upsertRoleReservation({
      role_key_wire: plan.roleKeyWire,
      expected_version: current.version,
      expected_epoch: current.epoch,
      holder_agent_id: null,
      previous_holder_agent_id:
        current.holder_agent_id ?? current.previous_holder_agent_id,
      state: "electable",
      activation_id: null,
      activation_deadline_ms: null,
      holder_lease_expires_ms: null,
      charter_acked_epoch: null,
      blocked_reason: reasonCode,
      last_transition_ms: now(),
      last_reason: reasonCode,
    });
  }

  async function cancelPlan(plan, reasonCode) {
    const entry = flights.get(plan.roleKeyWire);
    if (entry?.cancelledOutcome) return entry.cancelledOutcome;
    try {
      await adapter.cancel(plan.role.activation_id);
    } catch {}
    const result = fencePlan(plan, reasonCode);
    return {
      status: "cancelled",
      reason_code: reasonCode,
      role: result.role,
    };
  }

  async function gate(plan) {
    const current = store.getRole(plan.roleKeyWire);
    if (
      !current ||
      current.version !== plan.role.version ||
      current.epoch !== plan.role.epoch ||
      current.activation_seq !== plan.role.activation_seq ||
      current.activation_id !== plan.role.activation_id
    ) {
      return { status: "stale", reason_code: "cas_conflict", role: current };
    }
    const control = controlSnapshot();
    if (
      managerCircuitReason ||
      !managerEnabled(control, plan.roleKey.role_kind) ||
      Number(control?.generation ?? 0) !== Number(plan.controlGeneration)
    ) {
      return await cancelPlan(
        plan,
        managerCircuitReason || blockedReason(control),
      );
    }
    return null;
  }

  function markCandidateFailure(plan, holder, reasonCode) {
    const failures =
      Number(holder.candidate.consecutive_probe_failures || 0) + 1;
    const delay =
      failures >= config.max_probe_failures
        ? config.candidate_quarantine_ms
        : computeRoleBackoffMs(failures, config, rng);
    const excludedUntil = now() + delay;
    store.updateCandidateReachability({
      role_key_wire: plan.roleKeyWire,
      agent_id: holder.candidate.agent_id,
      consecutive_probe_failures: failures,
      excluded_until_ms: excludedUntil,
      last_probe_ms: now(),
      last_probe_code: reasonCode,
      updated_at_ms: now(),
    });
    const failed = cas(plan, {
      state: "unreachable",
      activation_id: null,
      activation_deadline_ms: null,
      holder_lease_expires_ms: null,
      charter_acked_epoch: null,
      next_probe_ms: excludedUntil,
      retry_count: Number(plan.role.retry_count || 0) + 1,
      last_reason: reasonCode,
    });
    emitDegraded({
      control_action: "candidate_exclude",
      reason_code: reasonCode,
      project_id: plan.roleKey.project_id,
      role_key_wire: plan.roleKeyWire,
      candidate_agent_id: holder.candidate.agent_id,
    });
    return { ...failed, failures, excludedUntil };
  }

  function scheduleAckTimeout(plan) {
    const delay = Math.max(0, Number(plan.role.activation_deadline_ms) - now());
    const timer = scheduleTimeout(() => {
      ackTimers.delete(plan.role.activation_id);
      const current = store.getRole(plan.roleKeyWire);
      if (
        !current ||
        current.state !== "elected-probing" ||
        current.epoch !== plan.role.epoch ||
        current.activation_seq !== plan.role.activation_seq ||
        current.activation_id !== plan.role.activation_id
      ) {
        return;
      }
      store.compareAndSetRole({
        ...activationGuard(current),
        patch: {
          state: "unreachable",
          activation_deadline_ms: null,
          next_probe_ms: now(),
          last_transition_ms: now(),
          last_reason: "ack_timeout",
        },
      });
    }, delay);
    timer?.unref?.();
    ackTimers.set(plan.role.activation_id, timer);
  }

  function deferStandupRetry(plan, reasonCode) {
    const failures = Number(plan.role.retry_count || 0) + 1;
    const exhausted = failures >= config.max_probe_failures;
    const delay = exhausted
      ? config.candidate_quarantine_ms
      : computeRoleBackoffMs(failures, config, rng);
    const result = cas(plan, {
      state: exhausted ? "quarantined" : "unreachable",
      holder_agent_id: null,
      activation_id: null,
      activation_deadline_ms: null,
      holder_lease_expires_ms: null,
      charter_acked_epoch: null,
      retry_count: failures,
      next_probe_ms: now() + delay,
      blocked_reason: null,
      last_reason: reasonCode,
    });
    emitDegraded({
      control_action: "dispatch_block",
      reason_code: reasonCode,
      project_id: plan.roleKey.project_id,
      role_key_wire: plan.roleKeyWire,
      capability: "standup_activation",
    });
    return result;
  }

  function scheduleStandupAckTimeout(plan) {
    const delay = Math.max(0, Number(plan.role.activation_deadline_ms) - now());
    const timer = scheduleTimeout(() => {
      ackTimers.delete(plan.role.activation_id);
      const current = store.getRole(plan.roleKeyWire);
      if (
        !current ||
        current.state !== "elected-probing" ||
        current.holder_agent_id !== null ||
        current.epoch !== plan.role.epoch ||
        current.activation_seq !== plan.role.activation_seq ||
        current.activation_id !== plan.role.activation_id
      ) {
        return;
      }
      deferStandupRetry({ ...plan, role: current }, "standup_ack_timeout");
    }, delay);
    timer?.unref?.();
    ackTimers.set(plan.role.activation_id, timer);
  }

  async function runCandidatePlan(initialPlan, initialCandidates) {
    let plan = initialPlan;
    let remaining = initialCandidates;
    const attempted = new Set();

    while (plan.holder) {
      const holder = plan.holder;
      attempted.add(holder.candidate.agent_id);
      let lastReason = "transport_error";

      for (const locator of holder.locators) {
        const beforeProbe = await gate(plan);
        if (beforeProbe) return beforeProbe;

        let rawProbe;
        try {
          rawProbe = await adapter.probe(locator, {
            timeout_ms: config.probe_timeout_ms,
            signal: flights.get(plan.roleKeyWire)?.controller.signal,
          });
        } catch (error) {
          rawProbe = {
            schema_version: "tfx-live.transport-probe.v1",
            ok: false,
            reachable: false,
            wakeable: false,
            reason_code: error?.code || "transport_error",
            transport_id: locator.transport_id,
          };
        }
        const probe = normalizeProbeResult(rawProbe, locator);
        const afterProbe = await gate(plan);
        if (afterProbe) return afterProbe;

        if (!probe.ok || !probe.reachable || !probe.wakeable) {
          lastReason = probe.reason_code || "transport_error";
          if (lastReason === "adapter_unavailable") {
            disabledAdapters.add(locator.kind);
            emitDegraded({
              control_action: "adapter_disable",
              reason_code: lastReason,
              project_id: plan.roleKey.project_id,
              role_key_wire: plan.roleKeyWire,
              candidate_agent_id: holder.candidate.agent_id,
              transport_id: locator.transport_id,
            });
          }
          continue;
        }

        store.updateCandidateReachability({
          role_key_wire: plan.roleKeyWire,
          agent_id: holder.candidate.agent_id,
          probe_succeeded: true,
          excluded_until_ms: null,
          last_probe_ms: now(),
          last_probe_code: "ok",
          updated_at_ms: now(),
        });

        const beforeWake = await gate(plan);
        if (beforeWake) return beforeWake;
        let wake;
        try {
          wake = await adapter.wake(
            locator,
            {
              schema_version: "tfx.role-activation.v1",
              role_key: plan.roleKey,
              role_key_wire: plan.roleKeyWire,
              epoch: plan.role.epoch,
              activation_seq: plan.role.activation_seq,
              activation_id: plan.role.activation_id,
              charter_version: plan.role.charter_version,
              holder_cli: holder.agent.cli,
            },
            {
              timeout_ms: config.probe_timeout_ms,
              signal: flights.get(plan.roleKeyWire)?.controller.signal,
            },
          );
        } catch (error) {
          wake = { ok: false, reason_code: error?.code || "transport_error" };
        }
        const afterWake = await gate(plan);
        if (afterWake) return afterWake;
        if (wake?.ok === false) {
          lastReason = wake.reason_code || "wake_failed";
          continue;
        }

        scheduleAckTimeout(plan);
        return {
          status: "awaiting_ack",
          role: store.getRole(plan.roleKeyWire),
          activation_id: plan.role.activation_id,
          holder_agent_id: holder.candidate.agent_id,
          transport_id: locator.transport_id,
        };
      }

      const failed = markCandidateFailure(plan, holder, lastReason);
      if (!failed.ok) {
        return {
          status: "stale",
          reason_code: failed.reason,
          role: failed.role,
        };
      }
      remaining = eligibleCandidates(plan.roleKey, plan.roleKeyWire, attempted);
      if (!remaining.length) {
        if (failed.failures < config.max_probe_failures) {
          return {
            status: "unreachable",
            role: failed.role,
            reason_code: lastReason,
          };
        }
        const quarantined = store.compareAndSetRole({
          ...activationGuard(failed.role),
          patch: {
            state: "quarantined",
            activation_id: null,
            activation_deadline_ms: null,
            holder_lease_expires_ms: null,
            last_transition_ms: now(),
            last_reason: "candidates_excluded",
          },
        });
        return {
          status: "quarantined",
          role: quarantined.role,
          reason_code: lastReason,
        };
      }
      plan = reserve(plan.roleKey, failed.role, remaining[0], plan.trigger);
    }

    return await runStandupPlan(plan);
  }

  async function runStandupPlan(plan) {
    const before = await gate(plan);
    if (before) return before;

    function blockStandup(reasonCode) {
      const blocked = cas(plan, {
        state: "electable",
        holder_agent_id: null,
        activation_id: null,
        activation_deadline_ms: null,
        holder_lease_expires_ms: null,
        blocked_reason: "no_candidate",
        last_reason: reasonCode,
      });
      emitDegraded({
        control_action: "dispatch_block",
        reason_code: reasonCode,
        project_id: plan.roleKey.project_id,
        role_key_wire: plan.roleKeyWire,
        capability: "standup",
      });
      return {
        status: "blocked",
        reason_code: reasonCode,
        role: blocked.role,
      };
    }

    if (typeof adapter.standup !== "function") {
      return blockStandup("standup_unavailable");
    }

    let locator;
    try {
      locator = await adapter.standup(plan.roleKey, "claude", {
        timeout_ms: config.standup_timeout_ms,
        signal: flights.get(plan.roleKeyWire)?.controller.signal,
        activation: {
          schema_version: "tfx.role-activation.v1",
          role_key: plan.roleKey,
          role_key_wire: plan.roleKeyWire,
          epoch: plan.role.epoch,
          activation_seq: plan.role.activation_seq,
          activation_id: plan.role.activation_id,
          charter_version: plan.role.charter_version,
        },
      });
    } catch (error) {
      const afterFailure = await gate(plan);
      if (afterFailure) return afterFailure;
      return blockStandup(error?.code || "standup_failed");
    }
    const after = await gate(plan);
    if (after) return after;
    let supported = false;
    try {
      supported = locatorUsable(locator, adapter, disabledAdapters, now());
    } catch {}
    if (!supported) return blockStandup("standup_locator_invalid");
    // C3 binds the stood-up session identity/grant and delivers its charter
    // ACK. C6a-4 still sends the activation now and bounds retries until that
    // binding exists, so a missing C3 hook cannot create a tight orphan loop.
    let wake;
    try {
      wake = await adapter.wake(
        locator,
        {
          schema_version: "tfx.role-activation.v1",
          role_key: plan.roleKey,
          role_key_wire: plan.roleKeyWire,
          epoch: plan.role.epoch,
          activation_seq: plan.role.activation_seq,
          activation_id: plan.role.activation_id,
          charter_version: plan.role.charter_version,
          holder_cli: "claude",
        },
        {
          timeout_ms: config.probe_timeout_ms,
          signal: flights.get(plan.roleKeyWire)?.controller.signal,
        },
      );
    } catch (error) {
      const reasonCode = error?.code || "standup_wake_failed";
      const deferred = deferStandupRetry(plan, reasonCode);
      return {
        status: deferred.role?.state || "unreachable",
        reason_code: reasonCode,
        role: deferred.role,
      };
    }
    const afterWake = await gate(plan);
    if (afterWake) return afterWake;
    if (wake?.ok !== true) {
      const reasonCode = wake?.reason_code || "standup_wake_failed";
      const deferred = deferStandupRetry(plan, reasonCode);
      return {
        status: deferred.role?.state || "unreachable",
        reason_code: reasonCode,
        role: deferred.role,
      };
    }
    scheduleStandupAckTimeout(plan);
    return {
      status: "standup_started",
      role: store.getRole(plan.roleKeyWire),
      activation_id: plan.role.activation_id,
      locator,
    };
  }

  function startFlight(plan, candidates = []) {
    const controller = new AbortController();
    const entry = { controller, plan, promise: null };
    entry.promise = Promise.resolve()
      .then(() =>
        plan.holder ? runCandidatePlan(plan, candidates) : runStandupPlan(plan),
      )
      .catch((error) => {
        const reasonCode = error?.code || "activation_dispatch_failed";
        emitDegraded({
          control_action: "dispatch_block",
          reason_code: reasonCode,
          project_id: plan.roleKey.project_id,
          role_key_wire: plan.roleKeyWire,
        });
        return {
          status: "error",
          reason_code: reasonCode,
          role: store.getRole(plan.roleKeyWire),
        };
      })
      .finally(() => {
        if (flights.get(plan.roleKeyWire) === entry) {
          flights.delete(plan.roleKeyWire);
        }
      });
    flights.set(plan.roleKeyWire, entry);
    return entry;
  }

  function requestEnsureRole(request, context = {}) {
    const normalized = normalizeEnsureRequest(request, now);
    const currentFlight = flights.get(normalized.role_key_wire);
    if (currentFlight) {
      return receipt(
        "joined",
        normalized.role_key_wire,
        store.getRole(normalized.role_key_wire),
      );
    }

    let prepared;
    try {
      prepared = prepare(normalized, context);
    } catch (error) {
      emitDegraded({
        control_action: "dispatch_block",
        reason_code: error?.code || "activation_reservation_failed",
        project_id: normalized.role_key.project_id,
        role_key_wire: normalized.role_key_wire,
      });
      throw error;
    }
    if (prepared.receipt) return prepared.receipt;
    startFlight(prepared.plan, prepared.candidates);
    return receipt("started", normalized.role_key_wire, prepared.plan.role);
  }

  async function ensureRoleAwake(request, context = {}) {
    const normalized = normalizeEnsureRequest(request, now);
    const currentFlight = flights.get(normalized.role_key_wire);
    if (currentFlight) return await currentFlight.promise;
    const result = requestEnsureRole(request, context);
    const started = flights.get(normalized.role_key_wire);
    return started ? await started.promise : result;
  }

  function ackActivation(input, context = {}) {
    if (
      !isRecord(input) ||
      input.schema_version !== ROLE_ACTIVATION_ACK_SCHEMA_VERSION ||
      input.reachable !== true ||
      !isRecord(input.charter_ack)
    ) {
      return { ok: false, code: "ACTIVATION_ACK_INVALID" };
    }
    let roleKey;
    let roleKeyWire;
    try {
      roleKey = normalizeRoleKey(input.role_key);
      roleKeyWire = encodeRoleKey(roleKey);
      if (encodeRoleKey(input.charter_ack.role_key) !== roleKeyWire) {
        return { ok: false, code: "STALE_EPOCH" };
      }
    } catch {
      return { ok: false, code: "ACTIVATION_ACK_INVALID" };
    }

    const current = store.getRole(roleKeyWire);
    if (!current) return { ok: false, code: "STALE_EPOCH" };
    const control = controlSnapshot();
    if (!managerEnabled(control, roleKey.role_kind) || managerCircuitReason) {
      const fenced = fencePlan(
        { roleKeyWire },
        managerCircuitReason || blockedReason(control),
      );
      return { ok: false, code: "STALE_EPOCH", role: fenced.role };
    }
    if (
      input.epoch !== current.epoch ||
      input.activation_seq !== current.activation_seq ||
      input.activation_id !== current.activation_id ||
      input.charter_ack.epoch !== current.epoch
    ) {
      return { ok: false, code: "STALE_EPOCH", role: current };
    }
    const principalAgentId = context?.principal?.agent_id;
    if (
      input.holder_agent_id !== current.holder_agent_id ||
      principalAgentId !== current.holder_agent_id
    ) {
      return { ok: false, code: "HOLDER_MISMATCH", role: current };
    }
    if (
      input.charter_ack.charter_version !== current.charter_version ||
      input.charter_ack.charter_version !== getCharterVersion(roleKey.role_kind)
    ) {
      return { ok: false, code: "CHARTER_VERSION_MISMATCH", role: current };
    }
    const holder = store.getAgent(current.holder_agent_id);
    if (
      !holder ||
      holder.status !== "online" ||
      Number(holder.lease_expires_ms) <= now() ||
      Number(current.holder_lease_expires_ms) <= now()
    ) {
      return { ok: false, code: "HOLDER_LEASE_EXPIRED", role: current };
    }
    if (
      current.state === "active" &&
      current.charter_acked_epoch === current.epoch
    ) {
      return { ok: true, idempotent: true, role: current, ack: input };
    }
    if (current.state !== "elected-probing") {
      return { ok: false, code: "STALE_EPOCH", role: current };
    }

    const activated = store.compareAndSetRole({
      ...activationGuard(current),
      patch: {
        state: "active",
        charter_acked_epoch: current.epoch,
        activation_deadline_ms: null,
        blocked_reason: null,
        last_transition_ms: now(),
        last_reason: "activation_acked",
      },
    });
    if (!activated.ok) {
      return { ok: false, code: "STALE_EPOCH", role: activated.role };
    }
    const timer = ackTimers.get(current.activation_id);
    if (timer) clearScheduledTimeout(timer);
    ackTimers.delete(current.activation_id);
    if (typeof onRoleActive === "function") {
      try {
        onRoleActive({ role: activated.role, ack: input });
      } catch (error) {
        emitDegraded({
          control_action: "dispatch_block",
          reason_code: error?.code || "backlog_transfer_failed",
          project_id: roleKey.project_id,
          role_key_wire: roleKeyWire,
        });
      }
    }
    return { ok: true, idempotent: false, role: activated.role, ack: input };
  }

  async function drain() {
    await Promise.allSettled(
      [...flights.values()].map((entry) => entry.promise),
    );
  }

  function close() {
    for (const entry of flights.values()) entry.controller.abort();
    for (const timer of ackTimers.values()) clearScheduledTimeout(timer);
    ackTimers.clear();
  }

  function updateControlSnapshot(snapshot) {
    const previousGeneration = Number(controlSnapshot()?.generation ?? 0);
    controlOverride = snapshot;
    if (Number(snapshot?.generation ?? 0) !== previousGeneration) {
      disabledAdapters.clear();
    }
    for (const entry of flights.values()) {
      if (managerEnabled(snapshot, entry.plan.roleKey.role_kind)) continue;
      entry.controller.abort();
      Promise.resolve(adapter.cancel(entry.plan.role.activation_id)).catch(
        () => {},
      );
      const result = fencePlan(entry.plan, blockedReason(snapshot));
      entry.cancelledOutcome = {
        status: "cancelled",
        reason_code: blockedReason(snapshot),
        role: result.role,
      };
    }
    return snapshot;
  }

  function notifyCandidateChanged(
    roleKeyInput,
    agentId,
    reason = "candidate_registered",
  ) {
    const roleKey = normalizeRoleKey(roleKeyInput);
    const roleKeyWire = encodeRoleKey(roleKey);
    const candidateResult = store.updateCandidateReachability({
      role_key_wire: roleKeyWire,
      agent_id: agentId,
      probe_succeeded: true,
      excluded_until_ms: null,
      last_probe_ms: now(),
      last_probe_code: reason,
      updated_at_ms: now(),
    });
    if (!candidateResult.ok) return candidateResult;

    const current = store.getRole(roleKeyWire);
    if (!current || current.state !== "quarantined") {
      return { ok: true, candidate: candidateResult.candidate, role: current };
    }
    const restored = store.upsertRoleReservation({
      role_key_wire: roleKeyWire,
      expected_version: current.version,
      expected_epoch: current.epoch,
      holder_agent_id: null,
      previous_holder_agent_id:
        current.holder_agent_id ?? current.previous_holder_agent_id,
      state: "electable",
      activation_id: null,
      activation_deadline_ms: null,
      holder_lease_expires_ms: null,
      charter_acked_epoch: null,
      retry_count: 0,
      next_probe_ms: null,
      blocked_reason: null,
      last_transition_ms: now(),
      last_reason: reason,
    });
    return {
      ok: restored.ok,
      candidate: candidateResult.candidate,
      role: restored.role,
      ...(restored.ok ? {} : { reason: restored.reason }),
    };
  }

  function ensureExpiredRoles(sweepNow = now()) {
    const receipts = [];
    for (const expired of store.listRolesWithExpiredHolder(sweepNow)) {
      let roleKey;
      try {
        roleKey = decodeRoleKey(expired.role_key_wire);
      } catch {
        continue;
      }
      const current = store.getRole(expired.role_key_wire);
      if (
        !current ||
        current.holder_agent_id == null ||
        Number(current.holder_lease_expires_ms) > sweepNow
      ) {
        continue;
      }
      const flight = flights.get(expired.role_key_wire);
      if (flight) {
        flight.controller.abort();
        Promise.resolve(adapter.cancel(flight.plan.role.activation_id)).catch(
          () => {},
        );
        flight.cancelledOutcome = {
          status: "cancelled",
          reason_code: "holder_lease_expired",
          role: current,
        };
        flights.delete(expired.role_key_wire);
      }
      const fenced = store.upsertRoleReservation({
        role_key_wire: expired.role_key_wire,
        expected_version: current.version,
        expected_epoch: current.epoch,
        holder_agent_id: null,
        previous_holder_agent_id: current.holder_agent_id,
        state: "electable",
        activation_id: null,
        activation_deadline_ms: null,
        holder_lease_expires_ms: null,
        charter_acked_epoch: null,
        blocked_reason: null,
        last_transition_ms: sweepNow,
        last_reason: "holder_lease_expired",
      });
      if (!fenced.ok) continue;
      receipts.push(
        requestEnsureRole(
          {
            schema_version: ENSURE_ROLE_SCHEMA_VERSION,
            role_key: roleKey,
            trigger: "lease_expired",
            cause_id: `lease:${expired.role_key_wire}:${sweepNow}`,
          },
          {
            principal: {
              type: "system",
              service: "sweeper",
              project_id: roleKey.project_id,
            },
          },
        ),
      );
    }
    return receipts;
  }

  function ensureRecoveredRoles(recovery) {
    const receipts = [];
    for (const recovered of recovery?.roles || []) {
      let roleKey;
      try {
        roleKey = decodeRoleKey(recovered.role_key_wire);
      } catch {
        continue;
      }
      receipts.push(
        requestEnsureRole(
          {
            schema_version: ENSURE_ROLE_SCHEMA_VERSION,
            role_key: roleKey,
            trigger: "restart_recovery",
            cause_id: `restart:${recovered.role_key_wire}:${recovered.epoch}`,
          },
          {
            principal: {
              type: "system",
              service: "hub-recovery",
              project_id: roleKey.project_id,
            },
          },
        ),
      );
    }
    return receipts;
  }

  return {
    requestEnsureRole,
    ensureRole: ensureRoleAwake,
    ensureRoleAwake,
    ackActivation,
    updateControlSnapshot,
    notifyCandidateChanged,
    ensureExpiredRoles,
    ensureRecoveredRoles,
    drain,
    close,
    isRoleManaged(roleKeyInput) {
      const roleKey = normalizeRoleKey(roleKeyInput);
      return (
        !managerCircuitReason &&
        managerEnabled(controlSnapshot(), roleKey.role_kind) &&
        !(roleKey.role_kind === "lead" && isScopeClosed(roleKey))
      );
    },
    getRoleSnapshot(roleKey) {
      return store.getRole(encodeRoleKey(roleKey));
    },
  };
}

export async function ensureRoleAwake(activator, request, context = {}) {
  if (!activator || typeof activator.ensureRoleAwake !== "function") {
    throw activatorError("ROLE_ACTIVATOR_INVALID");
  }
  return await activator.ensureRoleAwake(request, context);
}
