import { recalcConfidence } from './reflexion.mjs';
import { createStore, importBetterSqlite3, uuidv7 } from './store.mjs';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function clampMaxMessages(value, fallback = 20) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(1, Math.min(Math.trunc(num), 100));
}

function clampPriority(value, fallback = 5) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(1, Math.min(Math.trunc(num), 9));
}

function clampDuration(value, fallback = 600000, min = 1000, max = 86400000) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(Math.trunc(num), max));
}

function buildAssignCallbackEvent(row) {
  return {
    job_id: row.job_id,
    status: row.status,
    result: row.result ?? row.error ?? null,
    timestamp: new Date(row.updated_at_ms || Date.now()).toISOString(),
  };
}

export function createMemoryStore() {
  const agents = new Map();
  const messages = new Map();
  const humanRequests = new Map();
  const deadLetters = new Map();
  const assignJobs = new Map();
  const reflexionEntries = new Map();
  const assignStatusListeners = new Set();

  function notifyAssignStatusListeners(row) {
    const event = buildAssignCallbackEvent(row);
    for (const listener of Array.from(assignStatusListeners)) {
      try { listener(event, clone(row)); } catch {}
    }
  }

  function getRecentMessages() {
    return Array.from(messages.values()).sort((left, right) => right.created_at_ms - left.created_at_ms);
  }

  function upsertMessage(message) {
    messages.set(message.id, clone(message));
    return clone(message);
  }

  const store = {
    type: 'memory',
    db: null,
    uuidv7,

    close() {},

    registerAgent({ agent_id, cli, pid, capabilities = [], topics = [], heartbeat_ttl_ms = 30000, metadata = {} }) {
      const now = Date.now();
      const current = agents.get(agent_id) || {};
      const next = {
        ...current,
        agent_id,
        cli,
        pid: pid ?? null,
        capabilities: clone(capabilities),
        topics: clone(topics),
        last_seen_ms: now,
        lease_expires_ms: now + heartbeat_ttl_ms,
        status: 'online',
        metadata: clone(metadata),
      };
      agents.set(agent_id, next);
      return { agent_id, lease_id: uuidv7(), lease_expires_ms: next.lease_expires_ms, server_time_ms: now };
    },

    getAgent(id) {
      return clone(agents.get(id) || null);
    },

    refreshLease(agentId, ttlMs = 30000) {
      const current = agents.get(agentId);
      if (!current) return { agent_id: agentId, lease_expires_ms: Date.now() + ttlMs, server_time_ms: Date.now() };
      const now = Date.now();
      current.last_seen_ms = now;
      current.lease_expires_ms = now + ttlMs;
      current.status = 'online';
      return { agent_id: agentId, lease_expires_ms: current.lease_expires_ms, server_time_ms: now };
    },

    updateAgentTopics(agentId, topics = []) {
      const current = agents.get(agentId);
      if (!current) return false;
      current.topics = clone(topics);
      current.last_seen_ms = Date.now();
      return true;
    },

    listOnlineAgents() {
      return Array.from(agents.values())
        .filter((agent) => agent.status !== 'offline')
        .map((agent) => clone(agent));
    },

    listAllAgents() {
      return Array.from(agents.values()).map((agent) => clone(agent));
    },

    getAgentsByTopic(topic) {
      return Array.from(agents.values())
        .filter((agent) => agent.status !== 'offline' && Array.isArray(agent.topics) && agent.topics.includes(topic))
        .map((agent) => clone(agent));
    },

    sweepStaleAgents() {
      const now = Date.now();
      let stale = 0;
      let offline = 0;
      for (const agent of agents.values()) {
        if (agent.status === 'online' && agent.lease_expires_ms < now) {
          agent.status = 'stale';
          stale += 1;
        } else if (agent.status === 'stale' && agent.lease_expires_ms < now - 300000) {
          agent.status = 'offline';
          offline += 1;
        }
      }
      return { stale, offline };
    },

    updateAgentStatus(agentId, status) {
      const current = agents.get(agentId);
      if (!current) return false;
      current.status = status;
      return true;
    },

    auditLog({ type, from, to, topic, priority = 5, ttl_ms = 300000, payload = {}, trace_id, correlation_id, status = 'queued' }) {
      const now = Date.now();
      const row = {
        id: uuidv7(),
        type,
        from_agent: from,
        to_agent: to,
        topic,
        priority,
        ttl_ms,
        created_at_ms: now,
        expires_at_ms: now + ttl_ms,
        correlation_id: correlation_id || uuidv7(),
        trace_id: trace_id || uuidv7(),
        payload: clone(payload || {}),
        status,
      };
      return upsertMessage(row);
    },

    enqueueMessage(args) {
      return store.auditLog(args);
    },

    getMessage(id) {
      return clone(messages.get(id) || null);
    },

    getResponseByCorrelation(cid) {
      return getRecentMessages().find((message) => message.correlation_id === cid && message.type === 'response') || null;
    },

    getMessagesByTrace(tid) {
      return Array.from(messages.values())
        .filter((message) => message.trace_id === tid)
        .sort((left, right) => left.created_at_ms - right.created_at_ms)
        .map((message) => clone(message));
    },

    updateMessageStatus(id, status) {
      const current = messages.get(id);
      if (!current) return false;
      current.status = status;
      return true;
    },

    getAuditMessagesForAgent(agentId, { max_messages = 20, include_topics = null } = {}) {
      const limit = clampMaxMessages(max_messages);
      const topics = Array.isArray(include_topics) && include_topics.length
        ? include_topics
        : (agents.get(agentId)?.topics || []);
      const topicSet = new Set(topics);
      return getRecentMessages()
        .filter((message) => (
          message.to_agent === agentId
          || (String(message.to_agent || '').startsWith('topic:') && topicSet.has(message.topic))
        ))
        .slice(0, limit)
        .map((message) => clone(message));
    },

    deliverToAgent(messageId, agentId) {
      return Boolean(messages.get(messageId) && agentId);
    },

    deliverToTopic(messageId, topic) {
      void messageId;
      return store.getAgentsByTopic(topic).length;
    },

    pollForAgent(agentId, { max_messages = 20, include_topics = null } = {}) {
      return store.getAuditMessagesForAgent(agentId, { max_messages, include_topics });
    },

    ackMessages() {
      return 0;
    },

    insertHumanRequest({ requester_agent, kind, prompt, requested_schema = {}, deadline_ms, default_action, correlation_id, trace_id }) {
      const requestId = uuidv7();
      const now = Date.now();
      const row = {
        request_id: requestId,
        requester_agent,
        kind,
        prompt,
        schema: clone(requested_schema),
        state: 'pending',
        deadline_ms: now + deadline_ms,
        default_action,
        correlation_id: correlation_id || uuidv7(),
        trace_id: trace_id || uuidv7(),
        response: null,
      };
      humanRequests.set(requestId, row);
      return { request_id: requestId, state: 'pending', deadline_ms: row.deadline_ms };
    },

    getHumanRequest(id) {
      return clone(humanRequests.get(id) || null);
    },

    updateHumanRequest(id, state, resp = null) {
      const current = humanRequests.get(id);
      if (!current) return false;
      current.state = state;
      current.response = resp == null ? null : clone(resp);
      return true;
    },

    getPendingHumanRequests() {
      return Array.from(humanRequests.values())
        .filter((request) => request.state === 'pending')
        .map((request) => clone(request));
    },

    expireHumanRequests() {
      let changed = 0;
      const now = Date.now();
      for (const request of humanRequests.values()) {
        if (request.state === 'pending' && request.deadline_ms < now) {
          request.state = 'timed_out';
          changed += 1;
        }
      }
      return changed;
    },

    moveToDeadLetter(messageId, reason, lastError = null) {
      const current = messages.get(messageId);
      if (current) current.status = 'dead_letter';
      deadLetters.set(messageId, {
        message_id: messageId,
        reason,
        failed_at_ms: Date.now(),
        last_error: lastError,
      });
      return true;
    },

    getDeadLetters(limit = 50) {
      return Array.from(deadLetters.values())
        .sort((left, right) => right.failed_at_ms - left.failed_at_ms)
        .slice(0, limit)
        .map((entry) => clone(entry));
    },

    createAssign({
      job_id,
      supervisor_agent,
      worker_agent,
      topic = 'assign.job',
      task = '',
      payload = {},
      status = 'queued',
      attempt = 1,
      retry_count = 0,
      max_retries = 0,
      priority = 5,
      ttl_ms = 600000,
      timeout_ms = 600000,
      deadline_ms,
      trace_id,
      correlation_id,
      last_message_id = null,
      result = null,
      error = null,
    }) {
      const now = Date.now();
      const normalizedTimeout = clampDuration(timeout_ms, 600000);
      const row = {
        job_id: job_id || uuidv7(),
        supervisor_agent,
        worker_agent,
        topic: String(topic || 'assign.job'),
        task: String(task || ''),
        payload: clone(payload || {}),
        status,
        attempt: Math.max(1, Number(attempt) || 1),
        retry_count: Math.max(0, Number(retry_count) || 0),
        max_retries: Math.max(0, Number(max_retries) || 0),
        priority: clampPriority(priority, 5),
        ttl_ms: clampDuration(ttl_ms, normalizedTimeout),
        timeout_ms: normalizedTimeout,
        deadline_ms: Number.isFinite(Number(deadline_ms))
          ? Math.trunc(Number(deadline_ms))
          : now + normalizedTimeout,
        trace_id: trace_id || uuidv7(),
        correlation_id: correlation_id || uuidv7(),
        last_message_id,
        result: result == null ? null : clone(result),
        error: error == null ? null : clone(error),
        created_at_ms: now,
        updated_at_ms: now,
        started_at_ms: status === 'running' ? now : null,
        completed_at_ms: ['succeeded', 'failed', 'timed_out'].includes(status) ? now : null,
        last_retry_at_ms: retry_count > 0 ? now : null,
      };
      assignJobs.set(row.job_id, row);
      notifyAssignStatusListeners(row);
      return clone(row);
    },

    getAssign(jobId) {
      return clone(assignJobs.get(jobId) || null);
    },

    updateAssignStatus(jobId, status, patch = {}) {
      const current = assignJobs.get(jobId);
      if (!current) return null;

      const snapshot = clone(current);
      const now = Date.now();
      const nextStatus = status || current.status;
      const isTerminal = ['succeeded', 'failed', 'timed_out'].includes(nextStatus);
      const nextTimeout = clampDuration(patch.timeout_ms ?? current.timeout_ms, current.timeout_ms);
      const nextRow = {
        ...current,
        supervisor_agent: patch.supervisor_agent ?? current.supervisor_agent,
        worker_agent: patch.worker_agent ?? current.worker_agent,
        topic: patch.topic ?? current.topic,
        task: patch.task ?? current.task,
        payload: clone(patch.payload ?? current.payload ?? {}),
        status: nextStatus,
        attempt: Math.max(1, Number(patch.attempt ?? current.attempt) || current.attempt || 1),
        retry_count: Math.max(0, Number(patch.retry_count ?? current.retry_count) || 0),
        max_retries: Math.max(0, Number(patch.max_retries ?? current.max_retries) || 0),
        priority: clampPriority(patch.priority ?? current.priority, current.priority || 5),
        ttl_ms: clampDuration(patch.ttl_ms ?? current.ttl_ms, current.ttl_ms || nextTimeout),
        timeout_ms: nextTimeout,
        deadline_ms: (() => {
          if (Object.prototype.hasOwnProperty.call(patch, 'deadline_ms')) {
            return patch.deadline_ms == null ? null : Math.trunc(Number(patch.deadline_ms));
          }
          if (isTerminal) return null;
          if (nextStatus === 'running' && !current.deadline_ms) return now + nextTimeout;
          return current.deadline_ms;
        })(),
        trace_id: patch.trace_id ?? current.trace_id,
        correlation_id: patch.correlation_id ?? current.correlation_id,
        last_message_id: Object.prototype.hasOwnProperty.call(patch, 'last_message_id')
          ? patch.last_message_id
          : current.last_message_id,
        result: Object.prototype.hasOwnProperty.call(patch, 'result')
          ? (patch.result == null ? null : clone(patch.result))
          : current.result,
        error: Object.prototype.hasOwnProperty.call(patch, 'error')
          ? (patch.error == null ? null : clone(patch.error))
          : current.error,
        updated_at_ms: now,
        started_at_ms: Object.prototype.hasOwnProperty.call(patch, 'started_at_ms')
          ? patch.started_at_ms
          : (nextStatus === 'running' ? (current.started_at_ms || now) : current.started_at_ms),
        completed_at_ms: Object.prototype.hasOwnProperty.call(patch, 'completed_at_ms')
          ? patch.completed_at_ms
          : (isTerminal ? (current.completed_at_ms || now) : current.completed_at_ms),
        last_retry_at_ms: Object.prototype.hasOwnProperty.call(patch, 'last_retry_at_ms')
          ? patch.last_retry_at_ms
          : current.last_retry_at_ms,
      };
      assignJobs.set(jobId, nextRow);
      if (snapshot.status !== nextRow.status) {
        notifyAssignStatusListeners(nextRow);
      }
      return clone(nextRow);
    },

    listAssigns({
      supervisor_agent,
      worker_agent,
      status,
      statuses,
      trace_id,
      correlation_id,
      active_before_ms,
      limit = 50,
    } = {}) {
      const statusList = Array.isArray(statuses) && statuses.length
        ? statuses
        : (status ? [status] : []);
      return Array.from(assignJobs.values())
        .filter((job) => !supervisor_agent || job.supervisor_agent === supervisor_agent)
        .filter((job) => !worker_agent || job.worker_agent === worker_agent)
        .filter((job) => !trace_id || job.trace_id === trace_id)
        .filter((job) => !correlation_id || job.correlation_id === correlation_id)
        .filter((job) => !statusList.length || statusList.includes(job.status))
        .filter((job) => !Number.isFinite(Number(active_before_ms))
          || (job.deadline_ms != null && job.deadline_ms <= Number(active_before_ms)))
        .sort((left, right) => right.updated_at_ms - left.updated_at_ms)
        .slice(0, clampMaxMessages(limit, 50))
        .map((job) => clone(job));
    },

    retryAssign(jobId, patch = {}) {
      const current = assignJobs.get(jobId);
      if (!current) return null;
      const nextRetryCount = Math.max(0, Number(patch.retry_count ?? current.retry_count + 1) || 0);
      const nextAttempt = Math.max(current.attempt + 1, Number(patch.attempt ?? current.attempt + 1) || 1);
      const nextTimeout = clampDuration(patch.timeout_ms ?? current.timeout_ms, current.timeout_ms);
      return store.updateAssignStatus(jobId, 'queued', {
        retry_count: nextRetryCount,
        attempt: nextAttempt,
        timeout_ms: nextTimeout,
        ttl_ms: patch.ttl_ms ?? current.ttl_ms,
        deadline_ms: Date.now() + nextTimeout,
        completed_at_ms: null,
        started_at_ms: null,
        last_retry_at_ms: Date.now(),
        result: patch.result ?? null,
        error: Object.prototype.hasOwnProperty.call(patch, 'error') ? patch.error : current.error,
        last_message_id: null,
      });
    },

    sweepExpired() {
      const now = Date.now();
      let expiredMessages = 0;
      for (const message of messages.values()) {
        if (message.status === 'queued' && message.expires_at_ms < now) {
          message.status = 'dead_letter';
          deadLetters.set(message.id, {
            message_id: message.id,
            reason: 'ttl_expired',
            failed_at_ms: now,
            last_error: null,
          });
          expiredMessages += 1;
        }
      }
      const humanRequestsExpired = store.expireHumanRequests();
      return { messages: expiredMessages, human_requests: humanRequestsExpired };
    },

    getQueueDepths() {
      const depths = { urgent: 0, normal: 0, dlq: deadLetters.size };
      const now = Date.now();
      for (const message of messages.values()) {
        if (message.status !== 'queued' || message.expires_at_ms < now) continue;
        if (message.priority >= 7) depths.urgent += 1;
        else depths.normal += 1;
      }
      return depths;
    },

    onAssignStatusChange(listener) {
      if (typeof listener !== 'function') {
        return () => {};
      }
      assignStatusListeners.add(listener);
      return () => assignStatusListeners.delete(listener);
    },

    getDeliveryStats() {
      const cutoff = Date.now() - 300000;
      const totalDeliveries = Array.from(messages.values())
        .filter((message) => message.status === 'acked' && message.created_at_ms > cutoff)
        .length;
      return { total_deliveries: totalDeliveries, avg_delivery_ms: 0 };
    },

    getHubStats() {
      return {
        online_agents: Array.from(agents.values()).filter((agent) => agent.status === 'online').length,
        total_messages: messages.size,
        active_assign_jobs: Array.from(assignJobs.values()).filter((job) => ['queued', 'running'].includes(job.status)).length,
        ...store.getQueueDepths(),
      };
    },

    getAuditStats() {
      const countByStatus = (targetStatus) => Array.from(assignJobs.values()).filter((job) => job.status === targetStatus).length;
      return {
        online_agents: Array.from(agents.values()).filter((agent) => agent.status === 'online').length,
        total_messages: messages.size,
        dlq: deadLetters.size,
        assign_queued: countByStatus('queued'),
        assign_running: countByStatus('running'),
        assign_failed: countByStatus('failed'),
        assign_timed_out: countByStatus('timed_out'),
      };
    },

    addReflexion({ error_pattern, error_message, context = {}, solution, solution_code = null }) {
      const now = Date.now();
      const entry = {
        id: uuidv7(),
        error_pattern,
        error_message,
        context: clone(context),
        solution,
        solution_code,
        confidence: 0.5,
        hit_count: 1,
        success_count: 0,
        last_hit_ms: now,
        created_at_ms: now,
        updated_at_ms: now,
      };
      reflexionEntries.set(entry.id, entry);
      return clone(entry);
    },

    getReflexion(id) {
      return clone(reflexionEntries.get(id) || null);
    },

    findReflexion(errorPattern, context = {}) {
      const entries = Array.from(reflexionEntries.values())
        .filter((entry) => entry.error_pattern === errorPattern || entry.error_pattern.includes(errorPattern) || errorPattern.includes(entry.error_pattern))
        .filter((entry) => Object.entries(context).every(([key, value]) => value == null || entry.context?.[key] === value))
        .sort((left, right) => right.confidence - left.confidence);
      return entries.map((entry) => clone(entry));
    },

    updateReflexionHit(id, success = false) {
      const current = reflexionEntries.get(id);
      if (!current) return null;
      const now = Date.now();
      current.hit_count += 1;
      if (success) current.success_count += 1;
      current.last_hit_ms = now;
      current.updated_at_ms = now;
      current.confidence = Math.max(0, Math.min(1, recalcConfidence(current)));
      return clone(current);
    },

    pruneReflexion(maxAge_ms = 30 * 24 * 3600 * 1000, minConfidence = 0.2) {
      const cutoff = Date.now() - maxAge_ms;
      let removed = 0;
      for (const [id, entry] of Array.from(reflexionEntries.entries())) {
        if (entry.updated_at_ms < cutoff && entry.confidence < minConfidence) {
          reflexionEntries.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
  };

  return store;
}

export async function createStoreAdapter(dbPath, options = {}) {
  const loadDatabase = options.loadDatabase || importBetterSqlite3;
  try {
    const DatabaseCtor = await loadDatabase();
    const store = createStore(dbPath, { DatabaseCtor });
    store.type = 'sqlite';
    return store;
  } catch (error) {
    console.warn(`[store] SQLite unavailable (${error.message}), using in-memory fallback`);
    return createMemoryStore();
  }
}
