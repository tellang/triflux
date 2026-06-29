// hub/router.mjs — 실시간 라우팅/수신함 상태 관리자
// SQLite는 감사 로그만 담당하고, 실제 배달 상태는 메모리에서 관리한다.
import { EventEmitter, once } from "node:events";
import { uuidv7 } from "./lib/uuidv7.mjs";

const ASSIGN_PENDING_STATUSES = new Set(["queued", "running"]);
const ROLE_TOPICS = new Set(["cto"]);
const ROLE_SOURCE_RANK = Object.freeze({
  explicit: 2,
  "topic-fallback": 1,
});

function uniqueStrings(values = []) {
  return Array.from(
    new Set(
      (values || []).map((value) => String(value || "").trim()).filter(Boolean),
    ),
  );
}

function normalizeRoleName(value) {
  const role = String(value || "")
    .trim()
    .toLowerCase();
  return ROLE_TOPICS.has(role) ? role : "";
}

function normalizeRoleValues(value) {
  if (Array.isArray(value))
    return uniqueStrings(value).map((item) => item.toLowerCase());
  if (typeof value === "string") {
    return uniqueStrings(value.split(/[,\s]+/u)).map((item) =>
      item.toLowerCase(),
    );
  }
  return [];
}

function rolePriority(metadata = {}, roleName = "") {
  const candidates = [
    metadata?.[`${roleName}_priority`],
    metadata?.role_priority,
    metadata?.priority,
  ];
  for (const value of candidates) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return 0;
}

function clampAssignDuration(
  value,
  fallback = 600000,
  min = 1000,
  max = 86400000,
) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(Math.trunc(num), max));
}

function normalizeAssignTerminalStatus(input, metadata = {}) {
  const status = String(input || "")
    .trim()
    .toLowerCase();
  const resultTag = String(
    metadata?.result ?? metadata?.status ?? metadata?.outcome ?? "",
  )
    .trim()
    .toLowerCase();

  if (status === "queued") return "queued";
  if (status === "running" || status === "in_progress") return "running";
  if (status === "timed_out" || status === "timeout") return "timed_out";
  if (status === "failed" || status === "error") return "failed";
  if (status === "succeeded" || status === "success") return "succeeded";

  if (status === "completed") {
    if (resultTag === "failed" || resultTag === "error") return "failed";
    if (resultTag === "timed_out" || resultTag === "timeout")
      return "timed_out";
    return "succeeded";
  }

  if (resultTag === "failed" || resultTag === "error") return "failed";
  if (resultTag === "timed_out" || resultTag === "timeout") return "timed_out";
  if (resultTag === "succeeded" || resultTag === "success") return "succeeded";
  return "succeeded";
}

function normalizeAgentTopics(store, agentId, runtimeTopics) {
  const topics = new Set(runtimeTopics || []);
  const persisted = store.getAgent(agentId)?.topics || [];
  for (const topic of persisted) topics.add(topic);
  return Array.from(topics);
}

function waitForEmitterOnce(emitter, eventName, timeoutMs) {
  let timer = null;
  const timeout = Math.max(0, Math.min(Number(timeoutMs) || 0, 30000));
  return Promise.race([
    once(emitter, eventName),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`timed out waiting for ${eventName}`));
      }, timeout);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * 라우터 생성
 * @param {object} store
 */
export function createRouter(store) {
  let sweepTimer = null;
  let staleTimer = null;
  const responseEmitter = new EventEmitter();
  const deliveryEmitter = new EventEmitter();
  responseEmitter.setMaxListeners(200);
  deliveryEmitter.setMaxListeners(200);

  const runtimeTopics = new Map();
  const queuesByAgent = new Map();
  const liveMessages = new Map();
  const roleStates = new Map();
  const MAX_LATENCY_SAMPLES = 100;
  let latencyIdx = 0;
  const deliveryLatencies = new Array(MAX_LATENCY_SAMPLES).fill(0);

  function ensureAgentQueue(agentId) {
    let queue = queuesByAgent.get(agentId);
    if (!queue) {
      queue = new Map();
      queuesByAgent.set(agentId, queue);
    }
    return queue;
  }

  function recordLatency(ms) {
    deliveryLatencies[latencyIdx % MAX_LATENCY_SAMPLES] = ms;
    latencyIdx++;
  }

  function upsertRuntimeTopics(agentId, topics, { replace = true } = {}) {
    const normalized = uniqueStrings(topics);
    const current = replace
      ? new Set()
      : new Set(runtimeTopics.get(agentId) || []);
    for (const topic of normalized) current.add(topic);
    runtimeTopics.set(agentId, current);
    store.updateAgentTopics(agentId, Array.from(current));
    return Array.from(current);
  }

  function listRuntimeTopics(agentId) {
    return normalizeAgentTopics(store, agentId, runtimeTopics.get(agentId));
  }

  function ensureRoleState(roleName) {
    const role = normalizeRoleName(roleName);
    if (!role) return null;
    if (!roleStates.has(role)) {
      roleStates.set(role, {
        role,
        leaderAgentId: null,
        previousLeaderAgentId: null,
        leaderEpoch: 0,
        leaderSource: null,
        status: "offline",
        candidates: new Map(),
        lastTransitionMs: null,
        lastReason: "init",
        transferredCount: 0,
      });
    }
    return roleStates.get(role);
  }

  function hasRoleCapability(capabilities = [], roleName) {
    const normalized = normalizeRoleValues(capabilities);
    return normalized.some(
      (capability) =>
        capability === roleName ||
        capability === `role:${roleName}` ||
        capability === `${roleName}:leader` ||
        capability === `${roleName}:candidate`,
    );
  }

  function getRoleCandidateSource(agent, topics, roleName) {
    if (!agent) return null;
    const metadata = agent.metadata || {};
    const roles = [
      ...normalizeRoleValues(metadata.role),
      ...normalizeRoleValues(metadata.roles),
    ];
    const explicit =
      roles.includes(roleName) ||
      metadata?.[roleName] === true ||
      metadata?.is_cto === true ||
      hasRoleCapability(agent.capabilities, roleName);
    if (explicit) return "explicit";
    return topics.includes(roleName) ? "topic-fallback" : null;
  }

  function buildRoleCandidate(agentId, roleName) {
    const role = normalizeRoleName(roleName);
    if (!agentId || !role) return null;
    const agent = store.getAgent(agentId);
    if (!agent) return null;
    const topics = listRuntimeTopics(agentId);
    const source = getRoleCandidateSource(agent, topics, role);
    if (!source) return null;
    return {
      agent_id: agent.agent_id,
      status: agent.status,
      source,
      priority: rolePriority(agent.metadata, role),
      last_seen_ms: agent.last_seen_ms || 0,
      lease_expires_ms: agent.lease_expires_ms || 0,
      topics,
      capabilities: agent.capabilities || [],
    };
  }

  function refreshRoleCandidateForAgent(agentId) {
    if (!agentId) return;
    for (const roleName of ROLE_TOPICS) {
      const role = ensureRoleState(roleName);
      const candidate = buildRoleCandidate(agentId, roleName);
      if (candidate) role.candidates.set(agentId, candidate);
      else role.candidates.delete(agentId);
    }
  }

  function refreshRoleCandidates(roleName) {
    const role = ensureRoleState(roleName);
    if (!role) return [];
    const ids = new Set(role.candidates.keys());
    for (const [agentId, topics] of runtimeTopics) {
      if (topics.has(role.role)) ids.add(agentId);
    }
    for (const agent of store.getAgentsByTopic(role.role)) {
      ids.add(agent.agent_id);
    }
    if (typeof store.listAllAgents === "function") {
      for (const agent of store.listAllAgents()) ids.add(agent.agent_id);
    }
    for (const agentId of ids) refreshRoleCandidateForAgent(agentId);
    return Array.from(role.candidates.values());
  }

  function isCandidateLive(candidate, now = Date.now()) {
    return (
      candidate?.status === "online" && Number(candidate.lease_expires_ms) > now
    );
  }

  function sortRoleCandidates(candidates = []) {
    return [...candidates].sort((left, right) => {
      const sourceDelta =
        (ROLE_SOURCE_RANK[right.source] || 0) -
        (ROLE_SOURCE_RANK[left.source] || 0);
      if (sourceDelta !== 0) return sourceDelta;
      const priorityDelta =
        Number(right.priority || 0) - Number(left.priority || 0);
      if (priorityDelta !== 0) return priorityDelta;
      const seenDelta =
        Number(right.last_seen_ms || 0) - Number(left.last_seen_ms || 0);
      if (seenDelta !== 0) return seenDelta;
      return String(left.agent_id).localeCompare(String(right.agent_id));
    });
  }

  function chooseRoleLeader(roleName) {
    const now = Date.now();
    return (
      sortRoleCandidates(refreshRoleCandidates(roleName)).find((candidate) =>
        isCandidateLive(candidate, now),
      ) || null
    );
  }

  function messageMatchesRole(record, roleName) {
    const message = record?.message || {};
    const to = message.to_agent ?? message.to;
    return to === `topic:${roleName}`;
  }

  function roleTopicForMessage(message = {}) {
    const to = message?.to_agent ?? message?.to;
    if (!String(to || "").startsWith("topic:")) return "";
    return normalizeRoleName(String(to).slice(6));
  }

  function isReplayAllowedForAgent(agentId, message = {}) {
    const roleName = roleTopicForMessage(message);
    if (!roleName) return true;
    const targetAgentId = String(agentId || "").trim();
    if (!targetAgentId) return false;
    const role = getRoleSnapshot(roleName);
    return role?.leader_agent_id === targetAgentId;
  }

  function shouldTrackWithoutRecipients(message) {
    const to = message?.to_agent ?? message?.to;
    if (!String(to || "").startsWith("topic:")) return false;
    return ROLE_TOPICS.has(String(to).slice(6));
  }

  function isRoleMessageFullyHandled(record, roleName) {
    if (!messageMatchesRole(record, roleName)) return true;
    return (
      record.recipients.size > 0 &&
      record.ackedBy.size >= record.recipients.size
    );
  }

  function isRoleRecipient(agentId, roleName, previousLeaderAgentId = null) {
    if (!agentId) return false;
    if (agentId === previousLeaderAgentId) return true;
    return Boolean(buildRoleCandidate(agentId, roleName));
  }

  function countPendingForRole(roleName) {
    const now = Date.now();
    let count = 0;
    for (const record of liveMessages.values()) {
      if (!messageMatchesRole(record, roleName)) continue;
      if (record.message.expires_at_ms <= now) continue;
      if (isRoleMessageFullyHandled(record, roleName)) continue;
      count += 1;
    }
    return count;
  }

  function transferRoleBacklog(
    roleName,
    newLeaderAgentId,
    previousLeaderAgentId,
  ) {
    const role = ensureRoleState(roleName);
    const now = Date.now();
    const stats = { transferred_count: 0, skipped_count: 0, removed_count: 0 };
    if (!role || !newLeaderAgentId) return stats;

    for (const record of liveMessages.values()) {
      const { message, recipients, ackedBy } = record;
      if (!messageMatchesRole(record, role.role)) continue;
      if (message.expires_at_ms <= now) {
        stats.skipped_count += 1;
        continue;
      }
      if (isRoleMessageFullyHandled(record, role.role)) {
        stats.skipped_count += 1;
        continue;
      }

      for (const recipient of Array.from(recipients)) {
        if (
          recipient !== newLeaderAgentId &&
          isRoleRecipient(recipient, role.role, previousLeaderAgentId)
        ) {
          queuesByAgent.get(recipient)?.delete(message.id);
          recipients.delete(recipient);
          ackedBy.delete(recipient);
          stats.removed_count += 1;
        }
      }

      recipients.add(newLeaderAgentId);
      const alreadyQueued = queuesByAgent
        .get(newLeaderAgentId)
        ?.has(message.id);
      if (!alreadyQueued && !ackedBy.has(newLeaderAgentId)) {
        queueMessage(newLeaderAgentId, message);
        stats.transferred_count += 1;
      } else {
        stats.skipped_count += 1;
      }
      message.status = "delivered";
      store.updateMessageStatus(message.id, "delivered");
    }

    role.transferredCount += stats.transferred_count;
    return stats;
  }

  function buildRoleSnapshot(roleName, { refreshCandidates = true } = {}) {
    const role = ensureRoleState(roleName);
    if (!role) return null;
    const now = Date.now();
    const candidates = sortRoleCandidates(
      refreshCandidates
        ? refreshRoleCandidates(role.role)
        : Array.from(role.candidates.values()),
    );
    const leader =
      role.leaderAgentId && buildRoleCandidate(role.leaderAgentId, role.role);
    const leaderLive = isCandidateLive(leader, now);
    const liveCandidates = candidates.filter((candidate) =>
      isCandidateLive(candidate, now),
    );
    return {
      role: role.role,
      status: leaderLive
        ? "active"
        : liveCandidates.length
          ? "electable"
          : "offline",
      leader_agent_id: leaderLive ? role.leaderAgentId : null,
      previous_leader_agent_id: role.previousLeaderAgentId || null,
      leader_epoch: role.leaderEpoch,
      lease_expires_ms: leaderLive ? leader.lease_expires_ms : null,
      candidate_source: leaderLive
        ? leader.source
        : liveCandidates[0]?.source || null,
      candidate_count: candidates.length,
      live_candidate_count: liveCandidates.length,
      pending_count: countPendingForRole(role.role),
      transferred_count: role.transferredCount,
      last_transition_ms: role.lastTransitionMs,
      last_reason: role.lastReason,
      candidates: candidates.slice(0, 16).map((candidate) => ({
        agent_id: candidate.agent_id,
        status: isCandidateLive(candidate, now) ? "online" : candidate.status,
        source: candidate.source,
        priority: candidate.priority,
        last_seen_ms: candidate.last_seen_ms,
        lease_expires_ms: candidate.lease_expires_ms,
      })),
    };
  }

  function ensureRoleLeader(
    roleName,
    { reason = "ensure", transferBacklog = true } = {},
  ) {
    const role = ensureRoleState(roleName);
    if (!role) return null;
    const now = Date.now();
    const current =
      role.leaderAgentId && buildRoleCandidate(role.leaderAgentId, role.role);
    const best = chooseRoleLeader(role.role);
    const currentLive = isCandidateLive(current, now);
    const shouldPreemptFallback =
      currentLive &&
      current?.source === "topic-fallback" &&
      best?.source === "explicit" &&
      best.agent_id !== current.agent_id;

    if (currentLive && !shouldPreemptFallback) {
      role.status = "active";
      role.leaderSource = current.source;
      return buildRoleSnapshot(role.role);
    }

    if (!best) {
      if (role.leaderAgentId) {
        role.previousLeaderAgentId = role.leaderAgentId;
        role.leaderAgentId = null;
        role.leaderSource = null;
        role.leaderEpoch += 1;
        role.lastTransitionMs = Date.now();
        role.lastReason = reason;
      }
      role.status = "offline";
      return buildRoleSnapshot(role.role);
    }

    if (role.leaderAgentId !== best.agent_id) {
      const previousLeaderAgentId = role.leaderAgentId;
      role.previousLeaderAgentId =
        previousLeaderAgentId || role.previousLeaderAgentId;
      role.leaderAgentId = best.agent_id;
      role.leaderSource = best.source;
      role.leaderEpoch += 1;
      role.status = "active";
      role.lastTransitionMs = Date.now();
      role.lastReason = reason;
      if (transferBacklog) {
        transferRoleBacklog(role.role, best.agent_id, previousLeaderAgentId);
      }
    }

    return buildRoleSnapshot(role.role);
  }

  function getRoleSnapshot(roleName) {
    return buildRoleSnapshot(roleName, { refreshCandidates: true });
  }

  function trackMessage(message, recipients) {
    liveMessages.set(message.id, {
      message,
      recipients: new Set(recipients),
      ackedBy: new Set(),
    });
  }

  function getMessageRecord(messageId) {
    return liveMessages.get(messageId) || null;
  }

  function removeMessage(messageId) {
    const record = liveMessages.get(messageId);
    if (!record) return;
    for (const agentId of record.recipients) {
      queuesByAgent.get(agentId)?.delete(messageId);
    }
    liveMessages.delete(messageId);
  }

  function queueMessage(agentId, message) {
    const queue = ensureAgentQueue(agentId);
    queue.set(message.id, {
      message,
      attempts: 0,
      delivered_at_ms: null,
      acked_at_ms: null,
    });
    deliveryEmitter.emit("message", agentId, message);
  }

  function resolveRecipients(msg) {
    const to = msg.to_agent ?? msg.to;
    if (!to?.startsWith("topic:")) {
      return [to];
    }

    const topic = to.slice(6);
    if (ROLE_TOPICS.has(topic)) {
      const role = ensureRoleLeader(topic, {
        reason: "route",
        transferBacklog: true,
      });
      return role?.leader_agent_id ? [role.leader_agent_id] : [];
    }

    const recipients = new Set();
    for (const [agentId, topics] of runtimeTopics) {
      if (topics.has(topic)) recipients.add(agentId);
    }
    for (const agent of store.getAgentsByTopic(topic)) {
      recipients.add(agent.agent_id);
    }
    return Array.from(recipients);
  }

  function sortedPending(
    agentId,
    { max_messages = 20, include_topics = null } = {},
  ) {
    const queue = ensureAgentQueue(agentId);
    const topicFilter = include_topics?.length ? new Set(include_topics) : null;
    const now = Date.now();
    const pending = [];

    for (const delivery of queue.values()) {
      const { message } = delivery;
      if (delivery.acked_at_ms) continue;
      if (message.expires_at_ms <= now) continue;
      if (topicFilter && !topicFilter.has(message.topic)) continue;
      pending.push(message);
    }

    pending.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.created_at_ms - b.created_at_ms;
    });
    return pending.slice(0, max_messages);
  }

  function markDelivered(agentId, messageId) {
    const delivery = queuesByAgent.get(agentId)?.get(messageId);
    const record = getMessageRecord(messageId);
    if (!delivery || !record) return false;

    delivery.attempts += 1;
    if (!delivery.delivered_at_ms) {
      delivery.delivered_at_ms = Date.now();
      record.message.status = "delivered";
      store.updateMessageStatus(messageId, "delivered");
      recordLatency(delivery.delivered_at_ms - record.message.created_at_ms);
      return true;
    }
    return false;
  }

  function ackMessages(ids, agentId) {
    const now = Date.now();
    let count = 0;

    for (const id of ids || []) {
      const delivery = queuesByAgent.get(agentId)?.get(id);
      const record = getMessageRecord(id);
      if (!delivery || !record || delivery.acked_at_ms) continue;

      delivery.acked_at_ms = now;
      record.ackedBy.add(agentId);
      count += 1;

      if (record.ackedBy.size >= record.recipients.size) {
        record.message.status = "acked";
        store.updateMessageStatus(id, "acked");
        removeMessage(id);
      }
    }

    return count;
  }

  function dispatchMessage({
    type,
    from,
    to,
    topic,
    priority = 5,
    ttl_ms = 300000,
    payload = {},
    trace_id,
    correlation_id,
  }) {
    const msg = store.auditLog({
      type,
      from,
      to,
      topic,
      priority,
      ttl_ms,
      payload,
      trace_id,
      correlation_id,
    });
    const recipients = uniqueStrings(resolveRecipients(msg));
    if (recipients.length || shouldTrackWithoutRecipients(msg)) {
      trackMessage(msg, recipients);
    }
    if (recipients.length) {
      for (const agentId of recipients) {
        queueMessage(agentId, msg);
      }
      msg.status = "delivered";
      store.updateMessageStatus(msg.id, "delivered");
    }
    if (msg.type === "response") {
      responseEmitter.emit(msg.correlation_id, msg.payload);
    }
    return { msg, recipients };
  }

  function buildAssignSnapshot(job, extra = {}) {
    if (!job) return null;
    return {
      job_id: job.job_id,
      supervisor_agent: job.supervisor_agent,
      worker_agent: job.worker_agent,
      topic: job.topic,
      task: job.task,
      status: job.status,
      attempt: job.attempt,
      retry_count: job.retry_count,
      max_retries: job.max_retries,
      timeout_ms: job.timeout_ms,
      deadline_ms: job.deadline_ms,
      trace_id: job.trace_id,
      correlation_id: job.correlation_id,
      last_message_id: job.last_message_id,
      result: job.result,
      error: job.error,
      updated_at_ms: job.updated_at_ms,
      completed_at_ms: job.completed_at_ms,
      ...extra,
    };
  }

  function notifyAssignSupervisor(job, event, extra = {}) {
    if (!job?.supervisor_agent) return null;
    const { msg } = dispatchMessage({
      type: "event",
      from: job.worker_agent || "assign-router",
      to: job.supervisor_agent,
      topic: "assign.result",
      priority: Math.max(5, job.priority || 5),
      ttl_ms: job.ttl_ms || job.timeout_ms || 600000,
      payload: {
        event,
        ...buildAssignSnapshot(job),
        ...extra,
      },
      trace_id: job.trace_id,
      correlation_id: job.correlation_id,
    });
    return msg;
  }

  function dispatchAssignJob(job, reason = "dispatch") {
    const { msg, recipients } = dispatchMessage({
      type: "handoff",
      from: job.supervisor_agent,
      to: job.worker_agent,
      topic: job.topic || "assign.job",
      priority: job.priority || 5,
      ttl_ms: job.ttl_ms || job.timeout_ms || 600000,
      payload: {
        kind: "assign.job",
        reason,
        assign_job_id: job.job_id,
        attempt: job.attempt,
        retry_count: job.retry_count,
        max_retries: job.max_retries,
        timeout_ms: job.timeout_ms,
        supervisor_agent: job.supervisor_agent,
        worker_agent: job.worker_agent,
        task: job.task,
        payload: job.payload || {},
      },
      trace_id: job.trace_id,
      correlation_id: job.correlation_id,
    });

    const updated = store.updateAssignStatus(job.job_id, job.status, {
      last_message_id: msg.id,
    });
    return { job: updated || job, recipients, message_id: msg.id };
  }

  function scheduleAssignRetry(
    job,
    reason,
    error = null,
    requested_by = "system",
  ) {
    if (!job) {
      return {
        ok: false,
        error: { code: "ASSIGN_NOT_FOUND", message: "assign job not found" },
      };
    }
    if (job.retry_count >= job.max_retries) {
      return {
        ok: false,
        error: {
          code: "ASSIGN_RETRY_EXHAUSTED",
          message: `retry exhausted for ${job.job_id}`,
        },
      };
    }

    const queued = store.retryAssign(job.job_id, {
      error,
      timeout_ms: job.timeout_ms,
      ttl_ms: job.ttl_ms,
    });
    const dispatched = dispatchAssignJob(queued, "retry");
    notifyAssignSupervisor(dispatched.job, "retry_scheduled", {
      retry_reason: reason,
      requested_by,
    });
    return {
      ok: true,
      data: {
        retried: true,
        ...buildAssignSnapshot(dispatched.job, {
          retry_reason: reason,
          requested_by,
        }),
      },
    };
  }

  function handleAssignTimeout(job) {
    const timedOut = store.updateAssignStatus(job.job_id, "timed_out", {
      error: job.error ?? { message: "assign job timed out" },
    });

    if (timedOut.retry_count < timedOut.max_retries) {
      return scheduleAssignRetry(
        timedOut,
        "timed_out",
        timedOut.error,
        "sweeper",
      );
    }

    notifyAssignSupervisor(timedOut, "completed", {
      completion_reason: "timed_out",
    });
    return {
      ok: true,
      data: buildAssignSnapshot(timedOut, { completion_reason: "timed_out" }),
    };
  }

  const router = {
    responseEmitter,
    deliveryEmitter,

    registerAgent(args) {
      const result = store.registerAgent(args);
      upsertRuntimeTopics(args.agent_id, args.topics || [], { replace: true });
      refreshRoleCandidateForAgent(args.agent_id);
      for (const roleName of ROLE_TOPICS) {
        ensureRoleLeader(roleName, {
          reason: "register",
          transferBacklog: true,
        });
      }
      return result;
    },

    refreshAgentLease(agentId, ttlMs = 30000) {
      const result = store.refreshLease(agentId, ttlMs);
      refreshRoleCandidateForAgent(agentId);
      for (const roleName of ROLE_TOPICS) {
        ensureRoleLeader(roleName, {
          reason: "heartbeat",
          transferBacklog: true,
        });
      }
      return result;
    },

    subscribeAgent(agentId, topics, { replace = false } = {}) {
      const nextTopics = upsertRuntimeTopics(agentId, topics, { replace });
      refreshRoleCandidateForAgent(agentId);
      for (const roleName of ROLE_TOPICS) {
        ensureRoleLeader(roleName, {
          reason: "subscribe",
          transferBacklog: true,
        });
      }
      return { agent_id: agentId, topics: nextTopics };
    },

    getSubscribedTopics(agentId) {
      return listRuntimeTopics(agentId);
    },

    updateAgentStatus(agentId, status) {
      if (status === "offline") {
        runtimeTopics.delete(agentId);
      }
      const updated = store.updateAgentStatus(agentId, status);
      refreshRoleCandidateForAgent(agentId);
      for (const roleName of ROLE_TOPICS) {
        ensureRoleLeader(roleName, {
          reason: `status:${status}`,
          transferBacklog: true,
        });
      }
      return updated;
    },

    route(msg) {
      const recipients = uniqueStrings(resolveRecipients(msg));
      if (!recipients.length) {
        if (shouldTrackWithoutRecipients(msg) && !getMessageRecord(msg.id)) {
          trackMessage(msg, []);
        }
        return 0;
      }
      if (!getMessageRecord(msg.id)) {
        trackMessage(msg, recipients);
      }
      for (const agentId of recipients) {
        queueMessage(agentId, msg);
      }
      store.updateMessageStatus(msg.id, "delivered");
      return recipients.length;
    },

    getPendingMessages(agentId, options = {}) {
      return sortedPending(agentId, options);
    },

    canReplayMessageForAgent(agentId, message) {
      return isReplayAllowedForAgent(agentId, message);
    },

    countPendingMessages(agentId) {
      const queue = ensureAgentQueue(agentId);
      const now = Date.now();
      let count = 0;
      for (const delivery of queue.values()) {
        if (delivery.acked_at_ms) continue;
        if (delivery.message.expires_at_ms <= now) continue;
        count++;
      }
      return count;
    },

    markMessagePushed(agentId, messageId) {
      return markDelivered(agentId, messageId);
    },

    drainAgent(
      agentId,
      { max_messages = 20, include_topics = null, auto_ack = false } = {},
    ) {
      const messages = sortedPending(agentId, { max_messages, include_topics });
      for (const message of messages) {
        markDelivered(agentId, message.id);
      }
      if (auto_ack && messages.length) {
        ackMessages(
          messages.map((message) => message.id),
          agentId,
        );
      }
      return messages;
    },

    ackMessages(ids, agentId) {
      return ackMessages(ids, agentId);
    },

    async handleAsk({
      from,
      to,
      topic,
      question,
      context_refs,
      payload = {},
      priority = 5,
      ttl_ms = 300000,
      await_response_ms = 0,
      trace_id,
      correlation_id,
    }) {
      const cid = correlation_id || uuidv7();
      const tid = trace_id || uuidv7();

      const { msg } = dispatchMessage({
        type: "request",
        from,
        to,
        topic,
        priority,
        ttl_ms,
        payload: { question, context_refs, ...payload },
        correlation_id: cid,
        trace_id: tid,
      });

      if (await_response_ms <= 0) {
        return {
          ok: true,
          data: {
            request_message_id: msg.id,
            correlation_id: cid,
            trace_id: tid,
            state: "queued",
          },
        };
      }

      try {
        const [response] = await waitForEmitterOnce(
          responseEmitter,
          cid,
          await_response_ms,
        );
        return {
          ok: true,
          data: {
            request_message_id: msg.id,
            correlation_id: cid,
            trace_id: tid,
            state: "answered",
            response,
          },
        };
      } catch {
        const resp = store.getResponseByCorrelation(cid);
        if (resp) {
          return {
            ok: true,
            data: {
              request_message_id: msg.id,
              correlation_id: cid,
              trace_id: tid,
              state: "answered",
              response: resp.payload,
            },
          };
        }
        return {
          ok: true,
          data: {
            request_message_id: msg.id,
            correlation_id: cid,
            trace_id: tid,
            state: "delivered",
          },
        };
      }
    },

    handlePublish({
      from,
      to,
      topic,
      priority = 5,
      ttl_ms = 300000,
      payload = {},
      trace_id,
      correlation_id,
      message_type,
    }) {
      const type = message_type || (correlation_id ? "response" : "event");
      const { msg, recipients } = dispatchMessage({
        type,
        from,
        to,
        topic,
        priority,
        ttl_ms,
        payload,
        trace_id: trace_id || uuidv7(),
        correlation_id: correlation_id || uuidv7(),
      });
      return {
        ok: true,
        data: {
          message_id: msg.id,
          fanout_count: recipients.length,
          expires_at_ms: msg.expires_at_ms,
          role: to === "topic:cto" ? getRoleSnapshot("cto") : undefined,
        },
      };
    },

    takeoverRole({
      role = "cto",
      agent_id,
      reason = "manual",
      requested_by = "manual",
    } = {}) {
      const roleName = normalizeRoleName(role);
      if (!roleName) {
        return {
          ok: false,
          error: {
            code: "ROLE_NOT_SUPPORTED",
            message: `unsupported role: ${role}`,
          },
        };
      }
      const targetAgentId = String(agent_id || "").trim();
      if (!targetAgentId) {
        return {
          ok: false,
          error: {
            code: "AGENT_ID_REQUIRED",
            message: "agent_id required",
          },
        };
      }

      refreshRoleCandidates(roleName);
      const roleState = ensureRoleState(roleName);
      const candidate = buildRoleCandidate(targetAgentId, roleName);
      if (!isCandidateLive(candidate)) {
        return {
          ok: false,
          error: {
            code: "ROLE_CANDIDATE_UNAVAILABLE",
            message: `${targetAgentId} is not a live ${roleName} candidate`,
          },
          data: {
            role: buildRoleSnapshot(roleName),
          },
        };
      }

      const previousLeaderAgentId =
        roleState.leaderAgentId && roleState.leaderAgentId !== targetAgentId
          ? roleState.leaderAgentId
          : roleState.previousLeaderAgentId || null;
      const changed = roleState.leaderAgentId !== targetAgentId;
      if (changed) {
        roleState.previousLeaderAgentId = previousLeaderAgentId || null;
        roleState.leaderAgentId = targetAgentId;
        roleState.leaderSource = candidate.source;
        roleState.leaderEpoch += 1;
        roleState.status = "active";
        roleState.lastTransitionMs = Date.now();
        roleState.lastReason = reason || "manual";
      }

      const transfer = transferRoleBacklog(
        roleName,
        targetAgentId,
        previousLeaderAgentId,
      );
      const snapshot = buildRoleSnapshot(roleName);
      return {
        ok: true,
        data: {
          role: roleName,
          requested_by,
          reason,
          changed,
          previous_leader_agent_id: previousLeaderAgentId,
          leader_agent_id: snapshot.leader_agent_id,
          leader_epoch: snapshot.leader_epoch,
          ...transfer,
          status: snapshot,
        },
      };
    },

    handleHandoff({
      from,
      to,
      topic,
      task,
      acceptance_criteria,
      context_refs,
      priority = 5,
      ttl_ms = 600000,
      trace_id,
      correlation_id,
    }) {
      const { msg } = dispatchMessage({
        type: "handoff",
        from,
        to,
        topic,
        priority,
        ttl_ms,
        payload: { task, acceptance_criteria, context_refs },
        trace_id: trace_id || uuidv7(),
        correlation_id: correlation_id || uuidv7(),
      });
      return {
        ok: true,
        data: { handoff_message_id: msg.id, state: "queued", assigned_to: to },
      };
    },

    assignAsync({
      supervisor_agent,
      worker_agent,
      topic = "assign.job",
      task = "",
      payload = {},
      priority = 5,
      ttl_ms = 600000,
      timeout_ms = 600000,
      max_retries = 0,
      trace_id,
      correlation_id,
    }) {
      const job = store.createAssign({
        supervisor_agent,
        worker_agent,
        topic,
        task,
        payload,
        priority,
        ttl_ms,
        timeout_ms,
        max_retries,
        trace_id,
        correlation_id,
      });
      const dispatched = dispatchAssignJob(job, "create");
      return {
        ok: true,
        data: {
          assigned_to: worker_agent,
          ...buildAssignSnapshot(dispatched.job),
        },
      };
    },

    reportAssignResult({
      job_id,
      worker_agent,
      status,
      attempt,
      result,
      error,
      payload = {},
      metadata = {},
    }) {
      const job = store.getAssign(job_id);
      if (!job) {
        return {
          ok: false,
          error: {
            code: "ASSIGN_NOT_FOUND",
            message: `assign job not found: ${job_id}`,
          },
        };
      }
      if (worker_agent && worker_agent !== job.worker_agent) {
        return {
          ok: false,
          error: {
            code: "ASSIGN_WORKER_MISMATCH",
            message: `worker mismatch: ${worker_agent}`,
          },
        };
      }
      if (Number.isFinite(Number(attempt)) && Number(attempt) !== job.attempt) {
        return {
          ok: false,
          error: {
            code: "ASSIGN_ATTEMPT_MISMATCH",
            message: `stale assign result for attempt ${attempt} (current ${job.attempt})`,
          },
        };
      }

      const mergedMetadata = {
        ...(payload?.metadata || {}),
        ...(metadata || {}),
      };
      const normalizedStatus = normalizeAssignTerminalStatus(
        status || payload?.status,
        mergedMetadata,
      );
      const nextResult =
        result ??
        (Object.hasOwn(payload || {}, "result") ? payload.result : payload);
      const nextError = error ?? payload?.error ?? null;

      if (normalizedStatus === "running") {
        const running = store.updateAssignStatus(job.job_id, "running", {
          started_at_ms: job.started_at_ms || Date.now(),
          deadline_ms:
            Date.now() + clampAssignDuration(job.timeout_ms, job.timeout_ms),
          result: nextResult,
          error: nextError,
        });
        notifyAssignSupervisor(running, "progress");
        return { ok: true, data: buildAssignSnapshot(running) };
      }

      const finalized = store.updateAssignStatus(job.job_id, normalizedStatus, {
        result: nextResult,
        error: nextError,
      });

      if (
        (normalizedStatus === "failed" || normalizedStatus === "timed_out") &&
        finalized.retry_count < finalized.max_retries
      ) {
        return scheduleAssignRetry(
          finalized,
          normalizedStatus,
          nextError,
          worker_agent || finalized.worker_agent,
        );
      }

      notifyAssignSupervisor(finalized, "completed");
      return { ok: true, data: buildAssignSnapshot(finalized) };
    },

    getAssignStatus({ job_id, ...filters } = {}) {
      if (job_id) {
        const job = store.getAssign(job_id);
        return job
          ? { ok: true, data: buildAssignSnapshot(job) }
          : {
              ok: false,
              error: {
                code: "ASSIGN_NOT_FOUND",
                message: `assign job not found: ${job_id}`,
              },
            };
      }
      return {
        ok: true,
        data: {
          assigns: store
            .listAssigns(filters)
            .map((job) => buildAssignSnapshot(job)),
        },
      };
    },

    retryAssign(job_id, { reason = "manual", requested_by = "manual" } = {}) {
      const job = store.getAssign(job_id);
      if (!job) {
        return {
          ok: false,
          error: {
            code: "ASSIGN_NOT_FOUND",
            message: `assign job not found: ${job_id}`,
          },
        };
      }
      return scheduleAssignRetry(job, reason, job.error, requested_by);
    },

    sweepExpired() {
      const now = Date.now();
      let expired = 0;
      for (const [messageId, record] of Array.from(liveMessages.entries())) {
        if (record.message.expires_at_ms > now) continue;
        store.moveToDeadLetter(messageId, "ttl_expired", null);
        removeMessage(messageId);
        expired += 1;
      }
      return { messages: expired };
    },

    sweepTimedOutAssigns() {
      const expiredAssigns = store.listAssigns({
        statuses: Array.from(ASSIGN_PENDING_STATUSES),
        active_before_ms: Date.now(),
        limit: 100,
      });
      let timed_out = 0;
      let retried = 0;

      for (const job of expiredAssigns) {
        const result = handleAssignTimeout(job);
        timed_out += 1;
        if (result?.data?.retried) retried += 1;
      }

      return { timed_out, retried };
    },

    startSweeper() {
      if (sweepTimer) return;
      sweepTimer = setInterval(() => {
        try {
          router.sweepExpired();
          router.sweepTimedOutAssigns();
        } catch {}
      }, 10000);
      staleTimer = setInterval(() => {
        try {
          store.sweepStaleAgents();
          router.reelectStaleRoles();
        } catch {}
      }, 120000);
      sweepTimer.unref();
      staleTimer.unref();
    },

    stopSweeper() {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      if (staleTimer) {
        clearInterval(staleTimer);
        staleTimer = null;
      }
    },

    reelectStaleRoles({ reason = "sweep" } = {}) {
      for (const roleName of ROLE_TOPICS) {
        const role = roleStates.get(roleName);
        const leader = role?.leaderAgentId
          ? buildRoleCandidate(role.leaderAgentId, roleName)
          : null;
        if (!isCandidateLive(leader)) {
          ensureRoleLeader(roleName, { reason });
        }
      }
    },

    getQueueDepths() {
      const counts = { urgent: 0, normal: 0, dlq: store.getAuditStats().dlq };
      for (const record of liveMessages.values()) {
        const pending = record.recipients.size > record.ackedBy.size;
        if (!pending) continue;
        if (record.message.priority >= 7) counts.urgent += 1;
        else counts.normal += 1;
      }
      return counts;
    },

    getDeliveryStats() {
      if (latencyIdx === 0) {
        return { total_deliveries: 0, avg_delivery_ms: 0 };
      }
      const filled = Math.min(latencyIdx, MAX_LATENCY_SAMPLES);
      const total = deliveryLatencies
        .slice(0, filled)
        .reduce((sum, ms) => sum + ms, 0);
      return {
        total_deliveries: latencyIdx,
        avg_delivery_ms: Math.round(total / filled),
      };
    },

    getStatus(
      scope = "hub",
      { agent_id, trace_id, include_metrics = true } = {},
    ) {
      const data = {};

      if (scope === "hub" || scope === "queue") {
        data.hub = {
          state: "healthy",
          uptime_ms: (process.uptime() * 1000) | 0,
          realtime_transport: "named-pipe",
          audit_store: store.type || "sqlite",
        };
        data.roles = {
          cto: getRoleSnapshot("cto"),
        };
        if (include_metrics) {
          const depths = router.getQueueDepths();
          const stats = router.getDeliveryStats();
          const auditStats = store.getAuditStats();
          data.queues = {
            urgent_depth: depths.urgent,
            normal_depth: depths.normal,
            dlq_depth: depths.dlq,
            avg_delivery_ms: stats.avg_delivery_ms,
          };
          data.assigns = {
            queued: auditStats.assign_queued,
            running: auditStats.assign_running,
            failed: auditStats.assign_failed,
            timed_out: auditStats.assign_timed_out,
          };
        }
      }

      if (scope === "agent" && agent_id) {
        const agent = store.getAgent(agent_id);
        if (agent) {
          refreshRoleCandidateForAgent(agent_id);
          data.agent = {
            agent_id: agent.agent_id,
            status: agent.status,
            pending: sortedPending(agent_id, { max_messages: 1000 }).length,
            last_seen_ms: agent.last_seen_ms,
            topics: listRuntimeTopics(agent_id),
          };
          const roles = {};
          for (const roleName of ROLE_TOPICS) {
            const candidate = buildRoleCandidate(agent_id, roleName);
            if (candidate) {
              roles[roleName] = {
                candidate_source: candidate.source,
                priority: candidate.priority,
                leader: getRoleSnapshot(roleName)?.leader_agent_id === agent_id,
              };
            }
          }
          if (Object.keys(roles).length) data.agent.roles = roles;
        }
      }

      if (scope === "trace" && trace_id) {
        data.trace = store.getMessagesByTrace(trace_id);
      }

      return { ok: true, data };
    },
  };

  return router;
}
