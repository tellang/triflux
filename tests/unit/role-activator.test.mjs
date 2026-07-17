import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  computeRoleBackoffMs,
  createRoleActivator,
} from "../../hub/role-activator.mjs";
import { encodeRoleKey } from "../../hub/role-contract.mjs";
import { createStore } from "../../hub/store.mjs";
import { SQLITE_SKIP } from "../helpers/sqlite.mjs";

const PROJECT_ID = `prj_${"a".repeat(22)}`;
const CTO_KEY = { project_id: PROJECT_ID, role_kind: "cto" };
const CTO_WIRE = encodeRoleKey(CTO_KEY);
const LEAD_A_KEY = {
  project_id: PROJECT_ID,
  role_kind: "lead",
  scope_id: `scp_${"a".repeat(22)}`,
};
const LEAD_B_KEY = {
  project_id: PROJECT_ID,
  role_kind: "lead",
  scope_id: `scp_${"b".repeat(22)}`,
};
const TEMP_DIRS = [];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "tfx-role-activator-"));
  TEMP_DIRS.push(dir);
  return createStore(join(dir, "hub.db"));
}

function ensureRequest(overrides = {}) {
  return {
    schema_version: "tfx.ensure-role.v1",
    role_key: CTO_KEY,
    trigger: "manual",
    cause_id: "test-cause",
    ...overrides,
  };
}

function enabledControl(generation = 1) {
  return {
    generation,
    master_enabled: true,
    cto_manager_enabled: true,
    lead_manager_enabled: true,
    north_star_enabled: true,
    auto_collect_enabled: true,
  };
}

function tmuxLocator(id, priority = 100) {
  return {
    schema_version: "tfx.transport-locator.v1",
    transport_id: id,
    kind: "tmux",
    host_id: "hst_local",
    capabilities: ["probe", "wake", "activate"],
    priority,
    expires_at_ms: 60_000,
    locator: { session_name: id, mux_server_id: "mux_local" },
  };
}

function udsLocator(id, priority = 100) {
  return {
    schema_version: "tfx.transport-locator.v1",
    transport_id: id,
    kind: "claude-uds",
    host_id: "hst_local",
    capabilities: ["probe", "wake", "activate"],
    priority,
    expires_at_ms: 60_000,
    locator: { session_id: id, bridge_id: "local-hub" },
  };
}

function seedCandidate(store, agentId, priority, locators) {
  store.registerAgent({
    agent_id: agentId,
    cli: locators.some((locator) => locator.kind === "claude-uds")
      ? "claude"
      : "codex",
    capabilities: ["role:cto:candidate"],
    topics: [],
    heartbeat_ttl_ms: 120_000,
    metadata: { charter_version: "charter.v1" },
  });
  return store.upsertRoleCandidate({
    role_key_wire: CTO_WIRE,
    agent_id: agentId,
    source: "grant",
    priority,
    transport_locators: locators,
    updated_at_ms: 1_000,
  });
}

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    rmSync(TEMP_DIRS.pop(), { recursive: true, force: true });
  }
});

describe("role activator", { skip: SQLITE_SKIP }, () => {
  it("joins 50 concurrent ensures into one standup for the same role key", async () => {
    const store = tempStore();
    const standupGate = deferred();
    let standupCalls = 0;
    const activator = createRoleActivator({
      store,
      adapter: {
        supports: () => true,
        probe: async () => ({ ok: false, reachable: false }),
        wake: async () => ({ ok: true }),
        standup: async () => {
          standupCalls += 1;
          return await standupGate.promise;
        },
        cancel: async () => {},
      },
      getControlSnapshot: () => enabledControl(),
      getCharterVersion: () => "charter.v1",
      uuid: () => "activation-singleflight",
      now: () => 1_000,
      rng: () => 0.5,
    });

    const receipts = Array.from({ length: 50 }, (_, index) =>
      activator.requestEnsureRole(
        ensureRequest({ cause_id: `cause-${index}` }),
        { principal: { type: "system", project_id: PROJECT_ID } },
      ),
    );

    assert.equal(
      receipts.filter((receipt) => receipt.disposition === "started").length,
      1,
    );
    assert.equal(
      receipts.filter((receipt) => receipt.disposition === "joined").length,
      49,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(standupCalls, 1);

    standupGate.resolve({
      schema_version: "tfx.transport-locator.v1",
      transport_id: "standup-locator",
      kind: "tmux",
      host_id: "hst_local",
      capabilities: ["probe", "wake", "activate"],
      priority: 100,
      expires_at_ms: 60_000,
      locator: { session_name: "cto-role", mux_server_id: "mux_local" },
    });
    await activator.drain();

    assert.equal(standupCalls, 1);
    const role = store.getRole(CTO_WIRE);
    assert.equal(role.state, "elected-probing");
    assert.equal(role.activation_id, "activation-singleflight");
    activator.close();
    store.close();
  });

  it("sends activation to a stood-up session and backoffs when C3 ACK does not arrive", async () => {
    const store = tempStore();
    let currentTime = 1_000;
    const scheduled = [];
    const activations = [];
    const activator = createRoleActivator({
      store,
      adapter: {
        supports: () => true,
        probe: async () => ({ ok: false }),
        wake: async (locator, activation) => {
          activations.push({ locator, activation });
          return { ok: true };
        },
        standup: async () => tmuxLocator("standup-needs-c3"),
        cancel: async () => {},
      },
      getControlSnapshot: () => enabledControl(),
      getCharterVersion: () => "charter.v1",
      uuid: () => "activation-standup-needs-c3",
      now: () => currentTime,
      rng: () => 0.5,
      scheduleTimeout: (fn, delay) => {
        const timer = { fn, delay, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      clearScheduledTimeout: () => {},
    });

    const outcome = await activator.ensureRoleAwake(ensureRequest(), {
      principal: { type: "system", project_id: PROJECT_ID },
    });
    assert.equal(outcome.status, "standup_started");
    assert.equal(activations.length, 1);
    assert.equal(
      activations[0].activation.activation_id,
      "activation-standup-needs-c3",
    );
    assert.equal(scheduled.length, 1);

    currentTime += scheduled[0].delay;
    scheduled[0].fn();
    const timedOut = store.getRole(CTO_WIRE);
    assert.equal(timedOut.state, "unreachable");
    assert.equal(timedOut.activation_id, null);
    assert.ok(timedOut.next_probe_ms > currentTime);
    const held = activator.requestEnsureRole(
      ensureRequest({ cause_id: "standup-backoff" }),
      { principal: { type: "system", project_id: PROJECT_ID } },
    );
    assert.equal(held.disposition, "joined");
    assert.equal(activations.length, 1);
    activator.close();
    store.close();
  });

  it("defers a standup retry when waking the stood-up session throws", async () => {
    const store = tempStore();
    const activator = createRoleActivator({
      store,
      adapter: {
        supports: () => true,
        probe: async () => ({ ok: false }),
        wake: async () => {
          const error = new Error("wake failed");
          error.code = "standup_transport_error";
          throw error;
        },
        standup: async () => tmuxLocator("standup-wake-throws"),
        cancel: async () => {},
      },
      getControlSnapshot: () => enabledControl(),
      getCharterVersion: () => "charter.v1",
      uuid: () => "activation-standup-wake-throws",
      now: () => 1_000,
      rng: () => 0.5,
    });

    const outcome = await activator.ensureRoleAwake(ensureRequest(), {
      principal: { type: "system", project_id: PROJECT_ID },
    });

    assert.equal(outcome.status, "unreachable");
    assert.equal(outcome.reason_code, "standup_transport_error");
    assert.equal(outcome.role.state, "unreachable");
    assert.equal(outcome.role.retry_count, 1);
    assert.equal(outcome.role.activation_id, null);
    assert.ok(outcome.role.next_probe_ms > 1_000);
    activator.close();
    store.close();
  });

  it("fails over an unreachable elected candidate and activates only after a fenced ACK", async () => {
    const store = tempStore();
    store.upsertRoleReservation({
      role_key_wire: CTO_WIRE,
      holder_agent_id: null,
      state: "electable",
      activation_id: null,
      last_transition_ms: 1_000,
      last_reason: "test_seed",
    });
    seedCandidate(store, "candidate-uds", 200, [udsLocator("uds-first")]);
    seedCandidate(store, "candidate-tmux", 100, [tmuxLocator("tmux-second")]);

    const calls = [];
    const events = [];
    const activeTransitions = [];
    const activator = createRoleActivator({
      store,
      adapter: {
        supports: () => true,
        probe: async (locator) => {
          calls.push(`probe:${locator.transport_id}`);
          return locator.kind === "claude-uds"
            ? {
                schema_version: "tfx-live.transport-probe.v1",
                ok: false,
                reachable: false,
                wakeable: false,
                transport_selected: "claude-uds",
                transport_id: locator.transport_id,
                host_id: locator.host_id,
                latency_ms: 1,
                observed_at_ms: 1_000,
                reason_code: "transport_error",
              }
            : {
                schema_version: "tfx-live.transport-probe.v1",
                ok: true,
                reachable: true,
                wakeable: true,
                transport_selected: "tmux",
                transport_id: locator.transport_id,
                host_id: locator.host_id,
                latency_ms: 1,
                observed_at_ms: 1_000,
                reason_code: "ok",
              };
        },
        wake: async (locator, activation) => {
          calls.push(`wake:${locator.transport_id}`);
          assert.equal(activation.holder_cli, "codex");
          return { ok: true };
        },
        standup: async () => {
          calls.push("standup");
          return tmuxLocator("unexpected-standup");
        },
        cancel: async () => {},
      },
      getControlSnapshot: () => enabledControl(),
      getCharterVersion: () => "charter.v1",
      uuid: (() => {
        let index = 0;
        return () => `activation-${++index}`;
      })(),
      now: () => 1_000,
      rng: () => 0.5,
      onControlEvent: (event) => events.push(event),
      onRoleActive: (transition) => activeTransitions.push(transition),
    });

    const outcome = await activator.ensureRoleAwake(ensureRequest(), {
      principal: { type: "system", project_id: PROJECT_ID },
    });

    assert.equal(outcome.status, "awaiting_ack");
    assert.deepEqual(calls, [
      "probe:uds-first",
      "probe:tmux-second",
      "wake:tmux-second",
    ]);
    const probing = store.getRole(CTO_WIRE);
    assert.equal(probing.state, "elected-probing");
    assert.equal(probing.holder_agent_id, "candidate-tmux");
    assert.equal(probing.epoch, 2);
    assert.equal(
      store.listRoleCandidates(CTO_WIRE)[0].consecutive_probe_failures,
      1,
    );
    assert.equal(events[0].event, "capability.degraded");
    assert.equal(events[0].control_action, "candidate_exclude");

    const ack = activator.ackActivation(
      {
        schema_version: "tfx.role-activation-ack.v1",
        activation_id: probing.activation_id,
        role_key: CTO_KEY,
        epoch: probing.epoch,
        activation_seq: probing.activation_seq,
        holder_agent_id: "candidate-tmux",
        reachable: true,
        charter_ack: {
          role_key: CTO_KEY,
          epoch: probing.epoch,
          charter_version: "charter.v1",
        },
      },
      { principal: { type: "agent", agent_id: "candidate-tmux" } },
    );
    assert.equal(ack.ok, true);
    assert.equal(ack.role.state, "active");
    assert.equal(activeTransitions.length, 1);
    assert.equal(activeTransitions[0].role.holder_agent_id, "candidate-tmux");

    const duplicate = activator.ackActivation(ack.ack, {
      principal: { type: "agent", agent_id: "candidate-tmux" },
    });
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.idempotent, true);
    assert.equal(duplicate.role.epoch, ack.role.epoch);
    assert.equal(duplicate.role.version, ack.role.version);
    assert.equal(activeTransitions.length, 1);
    store.close();
  });

  it("emits a complete secret-free stderr fallback and opens the manager circuit when event logging fails", async () => {
    const store = tempStore();
    store.upsertRoleReservation({
      role_key_wire: CTO_WIRE,
      holder_agent_id: null,
      state: "electable",
      activation_id: null,
      last_transition_ms: 1_000,
      last_reason: "test_seed",
    });
    seedCandidate(store, "candidate-log-failure", 100, [
      tmuxLocator("tmux-log-failure"),
    ]);
    const fallbackLines = [];
    let transportCalls = 0;
    const activator = createRoleActivator({
      store,
      adapter: {
        supports: () => true,
        probe: async (locator) => {
          transportCalls += 1;
          return {
            schema_version: "tfx-live.transport-probe.v1",
            ok: false,
            reachable: false,
            wakeable: false,
            transport_selected: locator.kind,
            transport_id: locator.transport_id,
            host_id: locator.host_id,
            latency_ms: 1,
            observed_at_ms: 1_000,
            reason_code: "transport_error",
          };
        },
        wake: async () => ({ ok: true }),
        standup: async () => tmuxLocator("unexpected-standup"),
        cancel: async () => {},
      },
      getControlSnapshot: () => enabledControl(),
      getCharterVersion: () => "charter.v1",
      uuid: () => "activation-log-failure",
      now: () => 1_000,
      rng: () => 0.5,
      onControlEvent() {
        throw new Error("/Users/private/.tokens role-secret");
      },
      writeFallback: (line) => fallbackLines.push(line),
    });

    const first = await activator.ensureRoleAwake(ensureRequest(), {
      principal: { type: "system", project_id: PROJECT_ID },
    });
    assert.equal(first.status, "unreachable");
    assert.equal(fallbackLines.length, 1);
    const fallback = JSON.parse(fallbackLines[0]);
    for (const field of [
      "service",
      "env",
      "module",
      "event",
      "event_id",
      "dur_ms",
      "control_action",
      "reason_code",
      "level",
      "time",
      "msg",
    ]) {
      assert.ok(Object.hasOwn(fallback, field), `missing fallback ${field}`);
    }
    assert.equal(fallback.event, "capability.degraded");
    assert.equal(fallback.msg, fallback.event);
    assert.equal(fallback.control_action, "manager_disable");
    assert.equal(fallback.reason_code, "logger_event_shape_failed");
    assert.doesNotMatch(fallbackLines[0], /Users|tokens|role-secret/);

    const blocked = activator.requestEnsureRole(
      ensureRequest({ cause_id: "after-logger-failure" }),
      { principal: { type: "system", project_id: PROJECT_ID } },
    );
    assert.equal(blocked.disposition, "manager_disabled");
    assert.equal(transportCalls, 1);
    store.close();
  });

  it("cancels an in-flight probe and epoch-fences its ACK when the manager turns off", async () => {
    const store = tempStore();
    store.upsertRoleReservation({
      role_key_wire: CTO_WIRE,
      holder_agent_id: null,
      state: "electable",
      activation_id: null,
      last_transition_ms: 1_000,
      last_reason: "test_seed",
    });
    seedCandidate(store, "candidate-control", 100, [
      tmuxLocator("tmux-control"),
    ]);

    const probeGate = deferred();
    const probeStarted = deferred();
    const cancelled = [];
    const activator = createRoleActivator({
      store,
      adapter: {
        supports: () => true,
        probe: async () => {
          probeStarted.resolve();
          return await probeGate.promise;
        },
        wake: async () => ({ ok: true }),
        standup: async () => tmuxLocator("standup-control"),
        cancel: async (activationId) => cancelled.push(activationId),
      },
      getControlSnapshot: () => enabledControl(1),
      getCharterVersion: () => "charter.v1",
      uuid: () => "activation-control",
      now: () => 1_000,
      rng: () => 0.5,
    });

    const started = activator.requestEnsureRole(ensureRequest(), {
      principal: { type: "system", project_id: PROJECT_ID },
    });
    await probeStarted.promise;
    const probing = store.getRole(CTO_WIRE);
    assert.equal(probing.state, "elected-probing");

    activator.updateControlSnapshot({
      ...enabledControl(2),
      cto_manager_enabled: false,
      lead_manager_enabled: false,
    });
    probeGate.resolve({
      schema_version: "tfx-live.transport-probe.v1",
      ok: true,
      reachable: true,
      wakeable: true,
      transport_selected: "tmux",
      transport_id: "tmux-control",
      host_id: "hst_local",
      latency_ms: 1,
      observed_at_ms: 1_000,
      reason_code: "ok",
    });
    await activator.drain();

    const fenced = store.getRole(CTO_WIRE);
    assert.deepEqual(cancelled, [started.activation_id]);
    assert.equal(fenced.state, "electable");
    assert.equal(fenced.holder_agent_id, null);
    assert.equal(fenced.blocked_reason, "manager_disabled");
    assert.equal(fenced.epoch, probing.epoch + 1);

    const lateAck = activator.ackActivation(
      {
        schema_version: "tfx.role-activation-ack.v1",
        activation_id: probing.activation_id,
        role_key: CTO_KEY,
        epoch: probing.epoch,
        activation_seq: probing.activation_seq,
        holder_agent_id: "candidate-control",
        reachable: true,
        charter_ack: {
          role_key: CTO_KEY,
          epoch: probing.epoch,
          charter_version: "charter.v1",
        },
      },
      { principal: { type: "agent", agent_id: "candidate-control" } },
    );
    assert.equal(lateAck.ok, false);
    assert.equal(lateAck.code, "STALE_EPOCH");
    store.close();
  });

  it("ignores a probe result and ACK after a concurrent takeover reservation", async () => {
    const store = tempStore();
    store.upsertRoleReservation({
      role_key_wire: CTO_WIRE,
      holder_agent_id: null,
      state: "electable",
      activation_id: null,
      last_transition_ms: 1_000,
      last_reason: "test_seed",
    });
    seedCandidate(store, "candidate-before-takeover", 100, [
      tmuxLocator("tmux-before-takeover"),
    ]);
    const probeGate = deferred();
    const probeStarted = deferred();
    let wakeCalls = 0;
    const activator = createRoleActivator({
      store,
      adapter: {
        supports: () => true,
        probe: async () => {
          probeStarted.resolve();
          return await probeGate.promise;
        },
        wake: async () => {
          wakeCalls += 1;
          return { ok: true };
        },
        standup: async () => tmuxLocator("unexpected-standup"),
        cancel: async () => {},
      },
      getControlSnapshot: () => enabledControl(),
      getCharterVersion: () => "charter.v1",
      uuid: () => "activation-before-takeover",
      now: () => 1_000,
    });

    const flight = activator.ensureRoleAwake(ensureRequest(), {
      principal: { type: "system", project_id: PROJECT_ID },
    });
    await probeStarted.promise;
    const beforeTakeover = store.getRole(CTO_WIRE);
    const takeover = store.upsertRoleReservation({
      role_key_wire: CTO_WIRE,
      expected_version: beforeTakeover.version,
      expected_epoch: beforeTakeover.epoch,
      holder_agent_id: "takeover-holder",
      holder_lease_expires_ms: 60_000,
      state: "elected-probing",
      activation_id: "activation-takeover",
      activation_deadline_ms: 46_000,
      charter_version: "charter.v1",
      last_transition_ms: 1_000,
      last_reason: "operator_takeover",
    });
    assert.equal(takeover.ok, true);

    probeGate.resolve({
      schema_version: "tfx-live.transport-probe.v1",
      ok: true,
      reachable: true,
      wakeable: true,
      transport_selected: "tmux",
      transport_id: "tmux-before-takeover",
      host_id: "hst_local",
      latency_ms: 1,
      observed_at_ms: 1_000,
      reason_code: "ok",
    });
    const outcome = await flight;
    assert.equal(outcome.status, "stale");
    assert.equal(wakeCalls, 0);
    assert.equal(store.getRole(CTO_WIRE).activation_id, "activation-takeover");

    const staleAck = activator.ackActivation(
      {
        schema_version: "tfx.role-activation-ack.v1",
        activation_id: beforeTakeover.activation_id,
        role_key: CTO_KEY,
        epoch: beforeTakeover.epoch,
        activation_seq: beforeTakeover.activation_seq,
        holder_agent_id: "candidate-before-takeover",
        reachable: true,
        charter_ack: {
          role_key: CTO_KEY,
          epoch: beforeTakeover.epoch,
          charter_version: "charter.v1",
        },
      },
      {
        principal: {
          type: "agent",
          agent_id: "candidate-before-takeover",
        },
      },
    );
    assert.equal(staleAck.ok, false);
    assert.equal(staleAck.code, "STALE_EPOCH");
    store.close();
  });

  it("contains a persistent reservation fault without rejecting the flight", async () => {
    const store = tempStore();
    store.upsertRoleReservation({
      role_key_wire: CTO_WIRE,
      holder_agent_id: null,
      state: "electable",
      activation_id: null,
      last_transition_ms: 1_000,
      last_reason: "test_seed",
    });
    seedCandidate(store, "candidate-fault-first", 200, [
      tmuxLocator("tmux-fault-first"),
    ]);
    seedCandidate(store, "candidate-fault-second", 100, [
      tmuxLocator("tmux-fault-second"),
    ]);
    let reservations = 0;
    const faultingStore = {
      ...store,
      upsertRoleReservation(input) {
        reservations += 1;
        if (reservations === 2) {
          const error = new Error("database busy");
          error.code = "SQLITE_BUSY";
          throw error;
        }
        return store.upsertRoleReservation(input);
      },
    };
    const events = [];
    const activator = createRoleActivator({
      store: faultingStore,
      adapter: {
        supports: () => true,
        probe: async (locator) => ({
          schema_version: "tfx-live.transport-probe.v1",
          ok: false,
          reachable: false,
          wakeable: false,
          transport_selected: locator.kind,
          transport_id: locator.transport_id,
          host_id: locator.host_id,
          latency_ms: 1,
          observed_at_ms: 1_000,
          reason_code: "transport_error",
        }),
        wake: async () => ({ ok: true }),
        standup: async () => tmuxLocator("unexpected-standup"),
        cancel: async () => {},
      },
      getControlSnapshot: () => enabledControl(),
      getCharterVersion: () => "charter.v1",
      uuid: (() => {
        let index = 0;
        return () => `activation-fault-${++index}`;
      })(),
      now: () => 1_000,
      rng: () => 0.5,
      onControlEvent: (event) => events.push(event),
    });

    const outcome = await activator.ensureRoleAwake(ensureRequest(), {
      principal: { type: "system", project_id: PROJECT_ID },
    });
    assert.equal(outcome.status, "error");
    assert.equal(outcome.reason_code, "SQLITE_BUSY");
    assert.equal(events.at(-1).control_action, "dispatch_block");
    assert.notEqual(store.getRole(CTO_WIRE).state, "active");
    activator.close();
    store.close();
  });

  it("runs different scoped lead standups in parallel", async () => {
    const store = tempStore();
    const gates = new Map([
      [encodeRoleKey(LEAD_A_KEY), deferred()],
      [encodeRoleKey(LEAD_B_KEY), deferred()],
    ]);
    const calls = [];
    const activator = createRoleActivator({
      store,
      adapter: {
        supports: () => true,
        probe: async () => ({ ok: false }),
        wake: async () => ({ ok: true }),
        standup: async (roleKey) => {
          const wire = encodeRoleKey(roleKey);
          calls.push(wire);
          return await gates.get(wire).promise;
        },
        cancel: async () => {},
      },
      getControlSnapshot: () => enabledControl(),
      getCharterVersion: () => "charter.v1",
      uuid: () => "parallel-activation",
      now: () => 1_000,
    });

    const receipts = [LEAD_A_KEY, LEAD_B_KEY].map((roleKey) =>
      activator.requestEnsureRole(ensureRequest({ role_key: roleKey }), {
        principal: { type: "system", project_id: PROJECT_ID },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      receipts.every((item) => item.disposition === "started"),
      true,
    );
    assert.equal(calls.length, 2);
    for (const [wire, gate] of gates) gate.resolve(tmuxLocator(wire));
    await activator.drain();
    activator.close();
    store.close();
  });

  it("blocks closed lead scopes and failed core canaries before transport dispatch", () => {
    const store = tempStore();
    let transportCalls = 0;
    const adapter = {
      supports: () => true,
      probe: async () => {
        transportCalls += 1;
        return { ok: true };
      },
      wake: async () => {
        transportCalls += 1;
        return { ok: true };
      },
      standup: async () => {
        transportCalls += 1;
        return tmuxLocator("blocked");
      },
      cancel: async () => {},
    };
    const closed = createRoleActivator({
      store,
      adapter,
      getControlSnapshot: () => enabledControl(),
      getCharterVersion: () => "charter.v1",
      isScopeClosed: (roleKey) => roleKey.scope_id === LEAD_A_KEY.scope_id,
      now: () => 1_000,
    });
    const closedReceipt = closed.requestEnsureRole(
      ensureRequest({ role_key: LEAD_A_KEY }),
      { principal: { type: "system", project_id: PROJECT_ID } },
    );
    assert.equal(closedReceipt.disposition, "scope_closed");

    const events = [];
    const canaryBlocked = createRoleActivator({
      store,
      adapter,
      getControlSnapshot: () => enabledControl(),
      getCharterVersion: () => "charter.v1",
      runCoreCanary: () => ({
        ok: false,
        reason_code: "role_state_schema_mismatch",
      }),
      onControlEvent: (event) => events.push(event),
      now: () => 1_000,
    });
    const canaryReceipt = canaryBlocked.requestEnsureRole(ensureRequest(), {
      principal: { type: "system", project_id: PROJECT_ID },
    });
    assert.equal(canaryReceipt.disposition, "manager_disabled");
    assert.equal(canaryReceipt.blocked_reason, "role_state_schema_mismatch");
    assert.equal(transportCalls, 0);
    assert.equal(events[0].control_action, "manager_disable");
    store.close();
  });

  it("turns standup failure into a fenced no-candidate block", async () => {
    const store = tempStore();
    const events = [];
    const activator = createRoleActivator({
      store,
      adapter: {
        supports: () => true,
        probe: async () => ({ ok: false }),
        wake: async () => ({ ok: false }),
        standup: async () => {
          const error = new Error("runtime unavailable");
          error.code = "adapter_unavailable";
          throw error;
        },
        cancel: async () => {},
      },
      getControlSnapshot: () => enabledControl(),
      getCharterVersion: () => "charter.v1",
      uuid: () => "activation-standup-failure",
      now: () => 1_000,
      onControlEvent: (event) => events.push(event),
    });

    const outcome = await activator.ensureRoleAwake(ensureRequest(), {
      principal: { type: "system", project_id: PROJECT_ID },
    });
    assert.equal(outcome.status, "blocked");
    assert.equal(outcome.reason_code, "adapter_unavailable");
    assert.equal(outcome.role.state, "electable");
    assert.equal(outcome.role.activation_id, null);
    assert.equal(outcome.role.blocked_reason, "no_candidate");
    assert.equal(events[0].control_action, "dispatch_block");
    store.close();
  });

  it("fences persisted holder authority when ensure runs with the manager disabled", () => {
    const store = tempStore();
    store.upsertRoleReservation({
      role_key_wire: CTO_WIRE,
      holder_agent_id: "persisted-holder",
      holder_lease_expires_ms: 60_000,
      state: "active",
      activation_id: "persisted-activation",
      charter_version: "charter.v1",
      charter_acked_epoch: 0,
      last_transition_ms: 1_000,
      last_reason: "persisted_active",
    });
    const activator = createRoleActivator({
      store,
      adapter: {
        supports: () => true,
        probe: async () => assert.fail("probe must remain disabled"),
        wake: async () => assert.fail("wake must remain disabled"),
        standup: async () => assert.fail("standup must remain disabled"),
        cancel: async () => {},
      },
      getControlSnapshot: () => ({
        generation: 1,
        master_enabled: true,
        cto_manager_enabled: false,
        lead_manager_enabled: false,
      }),
      getCharterVersion: () => "charter.v1",
      now: () => 1_000,
    });

    const result = activator.requestEnsureRole(ensureRequest());
    const role = store.getRole(CTO_WIRE);
    assert.equal(result.disposition, "manager_disabled");
    assert.equal(role.state, "electable");
    assert.equal(role.holder_agent_id, null);
    assert.equal(role.activation_id, null);
    assert.equal(role.blocked_reason, "manager_disabled");
    assert.equal(role.epoch, 1);
    store.close();
  });

  it("disables only the failed adapter kind and uses another locator on the same candidate", async () => {
    const store = tempStore();
    store.upsertRoleReservation({
      role_key_wire: CTO_WIRE,
      holder_agent_id: null,
      state: "electable",
      activation_id: null,
      last_transition_ms: 1_000,
      last_reason: "test_seed",
    });
    seedCandidate(store, "candidate-multi-transport", 100, [
      udsLocator("uds-disabled", 200),
      tmuxLocator("tmux-supported", 100),
    ]);
    const calls = [];
    const events = [];
    const activator = createRoleActivator({
      store,
      adapter: {
        supports: () => true,
        probe: async (locator) => {
          calls.push(`probe:${locator.kind}`);
          return {
            schema_version: "tfx-live.transport-probe.v1",
            ok: locator.kind === "tmux",
            reachable: locator.kind === "tmux",
            wakeable: locator.kind === "tmux",
            transport_selected: locator.kind,
            transport_id: locator.transport_id,
            host_id: locator.host_id,
            latency_ms: 1,
            observed_at_ms: 1_000,
            reason_code: locator.kind === "tmux" ? "ok" : "adapter_unavailable",
          };
        },
        wake: async (locator) => {
          calls.push(`wake:${locator.kind}`);
          return { ok: true };
        },
        standup: async () => tmuxLocator("unexpected"),
        cancel: async () => {},
      },
      getControlSnapshot: () => enabledControl(),
      getCharterVersion: () => "charter.v1",
      uuid: () => "activation-multi-transport",
      now: () => 1_000,
      onControlEvent: (event) => events.push(event),
    });

    const outcome = await activator.ensureRoleAwake(ensureRequest(), {
      principal: { type: "system", project_id: PROJECT_ID },
    });

    assert.equal(outcome.status, "awaiting_ack");
    assert.deepEqual(calls, ["probe:claude-uds", "probe:tmux", "wake:tmux"]);
    assert.equal(events[0].control_action, "adapter_disable");
    assert.equal(
      store.listRoleCandidates(CTO_WIRE)[0].consecutive_probe_failures,
      0,
    );
    activator.close();
    store.close();
  });

  it("re-enables an adapter kind after a control generation reload", async () => {
    const store = tempStore();
    let currentTime = 1_000;
    let probeCalls = 0;
    store.upsertRoleReservation({
      role_key_wire: CTO_WIRE,
      holder_agent_id: null,
      state: "electable",
      activation_id: null,
      last_transition_ms: currentTime,
      last_reason: "test_seed",
    });
    seedCandidate(store, "candidate-adapter-reload", 100, [
      udsLocator("uds-adapter-reload"),
    ]);
    const activator = createRoleActivator({
      store,
      adapter: {
        supports: () => true,
        probe: async (locator) => {
          probeCalls += 1;
          const ok = probeCalls > 1;
          return {
            schema_version: "tfx-live.transport-probe.v1",
            ok,
            reachable: ok,
            wakeable: ok,
            transport_selected: locator.kind,
            transport_id: locator.transport_id,
            host_id: locator.host_id,
            latency_ms: 1,
            observed_at_ms: currentTime,
            reason_code: ok ? "ok" : "adapter_unavailable",
          };
        },
        wake: async () => ({ ok: true }),
        standup: async () => assert.fail("adapter reload must retry locator"),
        cancel: async () => {},
      },
      getControlSnapshot: () => enabledControl(1),
      getCharterVersion: () => "charter.v1",
      uuid: (() => {
        let index = 0;
        return () => `activation-adapter-reload-${++index}`;
      })(),
      now: () => currentTime,
      rng: () => 0.5,
    });

    const first = await activator.ensureRoleAwake(ensureRequest(), {
      principal: { type: "system", project_id: PROJECT_ID },
    });
    assert.equal(first.status, "unreachable");
    currentTime = store.listRoleCandidates(CTO_WIRE)[0].excluded_until_ms;
    activator.updateControlSnapshot(enabledControl(2));
    const second = await activator.ensureRoleAwake(
      ensureRequest({ cause_id: "adapter-reload" }),
      { principal: { type: "system", project_id: PROJECT_ID } },
    );
    assert.equal(second.status, "awaiting_ack");
    assert.equal(probeCalls, 2);
    activator.close();
    store.close();
  });

  it("rejects a late ACK after timeout and retries the same holder with a new epoch and token", async () => {
    const store = tempStore();
    let currentTime = 1_000;
    let activationIndex = 0;
    const scheduled = [];
    store.upsertRoleReservation({
      role_key_wire: CTO_WIRE,
      holder_agent_id: null,
      state: "electable",
      activation_id: null,
      last_transition_ms: currentTime,
      last_reason: "test_seed",
    });
    seedCandidate(store, "candidate-retry", 100, [tmuxLocator("tmux-retry")]);
    const activator = createRoleActivator({
      store,
      adapter: {
        supports: () => true,
        probe: async (locator) => ({
          schema_version: "tfx-live.transport-probe.v1",
          ok: true,
          reachable: true,
          wakeable: true,
          transport_selected: locator.kind,
          transport_id: locator.transport_id,
          host_id: locator.host_id,
          latency_ms: 1,
          observed_at_ms: currentTime,
          reason_code: "ok",
        }),
        wake: async () => ({ ok: true }),
        standup: async () => tmuxLocator("unexpected"),
        cancel: async () => {},
      },
      getControlSnapshot: () => enabledControl(),
      getCharterVersion: () => "charter.v1",
      uuid: () => `activation-retry-${++activationIndex}`,
      now: () => currentTime,
      scheduleTimeout: (fn, delay) => {
        const timer = { fn, delay, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      clearScheduledTimeout: () => {},
    });

    await activator.ensureRoleAwake(ensureRequest(), {
      principal: { type: "system", project_id: PROJECT_ID },
    });
    const first = store.getRole(CTO_WIRE);
    assert.equal(scheduled.length, 1);
    currentTime += scheduled[0].delay;
    scheduled[0].fn();
    assert.equal(store.getRole(CTO_WIRE).state, "unreachable");
    const failedCandidate = store.listRoleCandidates(CTO_WIRE)[0];
    assert.equal(failedCandidate.consecutive_probe_failures, 1);
    assert.ok(failedCandidate.excluded_until_ms > currentTime);

    const lateAck = activator.ackActivation(
      {
        schema_version: "tfx.role-activation-ack.v1",
        activation_id: first.activation_id,
        role_key: CTO_KEY,
        epoch: first.epoch,
        activation_seq: first.activation_seq,
        holder_agent_id: "candidate-retry",
        reachable: true,
        charter_ack: {
          role_key: CTO_KEY,
          epoch: first.epoch,
          charter_version: "charter.v1",
        },
      },
      { principal: { type: "agent", agent_id: "candidate-retry" } },
    );
    assert.equal(lateAck.code, "STALE_EPOCH");

    currentTime = failedCandidate.excluded_until_ms;
    const retry = await activator.ensureRoleAwake(
      ensureRequest({ cause_id: "retry" }),
      { principal: { type: "system", project_id: PROJECT_ID } },
    );
    const second = store.getRole(CTO_WIRE);
    assert.equal(retry.status, "awaiting_ack");
    assert.equal(second.holder_agent_id, first.holder_agent_id);
    assert.equal(second.epoch, first.epoch + 1);
    assert.notEqual(second.activation_id, first.activation_id);
    activator.close();
    store.close();
  });

  it("quarantines a probe/wake-successful candidate that never ACKs within max failures", async () => {
    const store = tempStore();
    let currentTime = 1_000;
    let activationIndex = 0;
    const scheduled = [];
    const events = [];
    store.upsertRoleReservation({
      role_key_wire: CTO_WIRE,
      holder_agent_id: null,
      state: "electable",
      activation_id: null,
      last_transition_ms: currentTime,
      last_reason: "test_seed",
    });
    seedCandidate(store, "candidate-ack-timeout", 100, [
      { ...tmuxLocator("tmux-ack-timeout"), expires_at_ms: 1_000_000 },
    ]);
    let probeCalls = 0;
    let wakeCalls = 0;
    const activator = createRoleActivator({
      store,
      adapter: {
        supports: () => true,
        probe: async (locator) => {
          probeCalls += 1;
          return {
            schema_version: "tfx-live.transport-probe.v1",
            ok: true,
            reachable: true,
            wakeable: true,
            transport_selected: locator.kind,
            transport_id: locator.transport_id,
            host_id: locator.host_id,
            latency_ms: 1,
            observed_at_ms: currentTime,
            reason_code: "ok",
          };
        },
        wake: async () => {
          wakeCalls += 1;
          return { ok: true };
        },
        standup: async () => tmuxLocator("unexpected"),
        cancel: async () => {},
      },
      getControlSnapshot: () => enabledControl(),
      getCharterVersion: () => "charter.v1",
      uuid: () => `activation-ack-timeout-${++activationIndex}`,
      now: () => currentTime,
      rng: () => 0.5,
      scheduleTimeout: (fn, delay) => {
        const timer = { fn, delay, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      clearScheduledTimeout: () => {},
      onControlEvent: (event) => events.push(event),
    });

    for (let failure = 1; failure <= 3; failure += 1) {
      const outcome = await activator.ensureRoleAwake(
        ensureRequest({ cause_id: `ack-timeout-${failure}` }),
        { principal: { type: "system", project_id: PROJECT_ID } },
      );
      assert.equal(outcome.status, "awaiting_ack");
      assert.equal(scheduled.length, failure);

      currentTime += scheduled.at(-1).delay;
      scheduled.at(-1).fn();

      const role = store.getRole(CTO_WIRE);
      const candidate = store.listRoleCandidates(CTO_WIRE)[0];
      assert.equal(role.state, "unreachable");
      assert.equal(role.retry_count, failure);
      assert.equal(role.last_reason, "ack_timeout");
      assert.equal(candidate.consecutive_probe_failures, failure);
      assert.equal(candidate.last_probe_code, "ack_timeout");
      assert.equal(role.next_probe_ms, candidate.excluded_until_ms);

      const held = activator.requestEnsureRole(
        ensureRequest({ cause_id: `ack-timeout-backoff-${failure}` }),
        { principal: { type: "system", project_id: PROJECT_ID } },
      );
      assert.equal(held.disposition, "joined");
      assert.equal(probeCalls, failure);
      assert.equal(wakeCalls, failure);

      if (failure < 3) currentTime = candidate.excluded_until_ms;
    }

    const quarantined = store.listRoleCandidates(CTO_WIRE)[0];
    assert.equal(quarantined.excluded_until_ms - currentTime, 120_000);
    assert.equal(events.length, 3);
    assert.equal(
      events.every(
        (event) =>
          event.control_action === "candidate_exclude" &&
          event.reason_code === "ack_timeout",
      ),
      true,
    );
    activator.close();
    store.close();
  });

  it("computes deterministic backoff and jitter bounds", () => {
    assert.equal(
      computeRoleBackoffMs(1, {}, () => 0),
      800,
    );
    assert.equal(
      computeRoleBackoffMs(1, {}, () => 1),
      1_200,
    );
    assert.equal(
      computeRoleBackoffMs(10, {}, () => 0.5),
      30_000,
    );
  });

  it("quarantines a thrice-failed candidate for 120 seconds and clears it on locator update", async () => {
    const store = tempStore();
    let currentTime = 1_000;
    let activationIndex = 0;
    store.upsertRoleReservation({
      role_key_wire: CTO_WIRE,
      holder_agent_id: null,
      state: "electable",
      activation_id: null,
      last_transition_ms: currentTime,
      last_reason: "test_seed",
    });
    seedCandidate(store, "candidate-quarantine", 100, [
      tmuxLocator("tmux-quarantine"),
    ]);
    let probeCalls = 0;
    const activator = createRoleActivator({
      store,
      adapter: {
        supports: () => true,
        probe: async (locator) => {
          probeCalls += 1;
          return {
            schema_version: "tfx-live.transport-probe.v1",
            ok: false,
            reachable: false,
            wakeable: false,
            transport_selected: locator.kind,
            transport_id: locator.transport_id,
            host_id: locator.host_id,
            latency_ms: 1,
            observed_at_ms: currentTime,
            reason_code: "transport_error",
          };
        },
        wake: async () => ({ ok: true }),
        standup: async () => tmuxLocator("unexpected"),
        cancel: async () => {},
      },
      getControlSnapshot: () => enabledControl(),
      getCharterVersion: () => "charter.v1",
      uuid: () => `activation-quarantine-${++activationIndex}`,
      now: () => currentTime,
      rng: () => 0.5,
    });

    for (let failure = 1; failure <= 3; failure += 1) {
      const outcome = await activator.ensureRoleAwake(
        ensureRequest({ cause_id: `failure-${failure}` }),
        { principal: { type: "system", project_id: PROJECT_ID } },
      );
      const expectedState = failure < 3 ? "unreachable" : "quarantined";
      assert.equal(outcome.status, expectedState);
      assert.equal(store.getRole(CTO_WIRE).state, expectedState);
      const candidate = store.listRoleCandidates(CTO_WIRE)[0];
      assert.equal(candidate.consecutive_probe_failures, failure);
      if (failure < 3) {
        const held = activator.requestEnsureRole(
          ensureRequest({ cause_id: `backoff-${failure}` }),
          { principal: { type: "system", project_id: PROJECT_ID } },
        );
        assert.equal(held.disposition, "joined");
        assert.equal(probeCalls, failure);
        currentTime = candidate.excluded_until_ms;
      }
    }

    const quarantined = store.listRoleCandidates(CTO_WIRE)[0];
    assert.equal(quarantined.excluded_until_ms - currentTime, 120_000);
    const restored = activator.notifyCandidateChanged(
      CTO_KEY,
      "candidate-quarantine",
      "locator_registered",
    );
    assert.equal(restored.role.state, "electable");
    assert.equal(restored.candidate.excluded_until_ms, null);
    assert.equal(restored.candidate.consecutive_probe_failures, 0);
    store.close();
  });

  it("fences and ensures only the scoped role keys whose holder lease expired", async () => {
    const store = tempStore();
    const leadWire = encodeRoleKey(LEAD_A_KEY);
    for (const [roleKeyWire, holder, lease] of [
      [CTO_WIRE, "expired-cto", 900],
      [leadWire, "live-lead", 2_000],
    ]) {
      store.upsertRoleReservation({
        role_key_wire: roleKeyWire,
        holder_agent_id: holder,
        holder_lease_expires_ms: lease,
        state: "active",
        activation_id: `activation-${holder}`,
        charter_version: "charter.v1",
        charter_acked_epoch: 0,
        last_transition_ms: 100,
        last_reason: "test_seed",
      });
    }
    const standups = [];
    const activator = createRoleActivator({
      store,
      adapter: {
        supports: () => true,
        probe: async () => ({ ok: false }),
        wake: async () => ({ ok: true }),
        standup: async (roleKey) => {
          standups.push(encodeRoleKey(roleKey));
          return tmuxLocator(`standup-${roleKey.role_kind}`);
        },
        cancel: async () => {},
      },
      getControlSnapshot: () => enabledControl(),
      getCharterVersion: () => "charter.v1",
      uuid: (() => {
        let index = 0;
        return () => `activation-expiry-${++index}`;
      })(),
      now: () => 1_000,
    });

    const receipts = activator.ensureExpiredRoles(1_000);
    assert.deepEqual(
      receipts.map((item) => item.role_key_wire),
      [CTO_WIRE],
    );
    await activator.drain();
    assert.deepEqual(standups, [CTO_WIRE]);
    assert.equal(store.getRole(CTO_WIRE).last_reason, "standup_reserved");
    assert.equal(store.getRole(leadWire).holder_agent_id, "live-lead");
    activator.close();
    store.close();
  });
});
