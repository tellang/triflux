// hub/pipe.mjs — Named Pipe/Unix socket 제어 채널
// NDJSON 프로토콜로 에이전트 실시간 제어/이벤트 푸시를 처리한다.

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import net from "node:net";
import { createPipeline } from "./pipeline/index.mjs";
import {
  ensurePipelineTable,
  initPipelineState,
  listPipelineStates,
  readPipelineState,
} from "./pipeline/state.mjs";
import { IS_WINDOWS, pipePath } from "./platform.mjs";
import { sendInputToConductorSession } from "./team/conductor-registry.mjs";
import { getTeamBridge } from "./team-bridge.mjs";
import { safeJsonParse } from "./workers/worker-utils.mjs";

const DEFAULT_HEARTBEAT_TTL_MS = 60000;
const TEAM_BRIDGE_NOT_REGISTERED = "bridge_not_registered";

/** 플랫폼별 pipe 경로 계산 */
export function getPipePath(sessionId = process.pid) {
  return pipePath("triflux", sessionId);
}

function normalizeTopics(topics) {
  if (!Array.isArray(topics)) return [];
  return topics.map((topic) => String(topic || "").trim()).filter(Boolean);
}

function getTeamBridgeMethod(methodName) {
  const method = getTeamBridge()?.[methodName];
  return typeof method === "function" ? method : null;
}

function teamInfoFallback(payload = {}) {
  return {
    ok: true,
    data: {
      team: {
        team_name: payload.team_name ?? null,
        description: null,
      },
      lead: {
        lead_agent_id: null,
        lead_session_id: null,
      },
      ...(payload.include_members !== false ? { members: [] } : {}),
      ...(payload.include_paths !== false
        ? {
            paths: {
              config_path: null,
              tasks_dir: null,
              inboxes_dir: null,
              tasks_dir_resolution: TEAM_BRIDGE_NOT_REGISTERED,
            },
          }
        : {}),
      bridge_installed: false,
      skipped: true,
    },
  };
}

function teamTaskListFallback() {
  return {
    ok: true,
    data: {
      tasks: [],
      count: 0,
      parse_warnings: 0,
      tasks_dir: null,
      tasks_dir_resolution: TEAM_BRIDGE_NOT_REGISTERED,
      bridge_installed: false,
      skipped: true,
    },
  };
}

function teamTaskUpdateFallback(payload = {}) {
  return {
    ok: true,
    data: {
      claimed: false,
      updated: false,
      task_before: null,
      task_after: null,
      task_file: null,
      task_id: payload.task_id ?? null,
      mtime_ms: null,
      bridge_installed: false,
      skipped: true,
    },
  };
}

function teamSendMessageFallback(payload = {}) {
  return {
    ok: true,
    data: {
      message_id: null,
      recipient: payload.to ?? "team-lead",
      inbox_file: null,
      queued_at: null,
      unread_count: 0,
      bridge_installed: false,
      skipped: true,
    },
  };
}

/**
 * Named Pipe 서버 생성
 * @param {object} opts
 * @param {object} opts.router
 * @param {object} [opts.store]
 * @param {string|number} [opts.sessionId]
 * @param {number} [opts.heartbeatTtlMs]
 */
export function createPipeServer({
  router,
  store = null,
  sessionId = process.pid,
  heartbeatTtlMs = DEFAULT_HEARTBEAT_TTL_MS,
  delegatorService = null,
  hitlManager = null,
  onActivity = null,
} = {}) {
  if (!router) {
    throw new Error("router is required");
  }

  const pipePath = getPipePath(sessionId);
  const clients = new Map();
  let server = null;
  let heartbeatTimer = null;

  function sendFrame(client, frame) {
    if (!client || client.closed || !client.socket.writable) return false;
    try {
      client.socket.write(`${JSON.stringify(frame)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  function sendResponse(client, requestId, result) {
    return sendFrame(client, {
      type: "response",
      request_id: requestId,
      ...result,
    });
  }

  function closeClient(client) {
    if (!client || client.closed) return;
    client.closed = true;
    clients.delete(client.id);
    try {
      client.socket.destroy();
    } catch {}
  }

  function touchClient(client) {
    client.lastHeartbeatMs = Date.now();
    if (onActivity) onActivity();
  }

  function resolveAgentId(client, payload) {
    const agentId = payload?.agent_id || client?.agentId;
    if (!agentId) {
      throw new Error("agent_id required");
    }
    return agentId;
  }

  function pushEvent(agentId, message) {
    let delivered = false;
    for (const client of clients.values()) {
      if (client.agentId !== agentId) continue;
      if (
        sendFrame(client, {
          type: "event",
          event: "message",
          payload: { agent_id: agentId, message },
        })
      ) {
        delivered = true;
      }
    }
    return delivered;
  }

  function pushPendingMessages(agentId) {
    if (!agentId) return 0;
    const pending = router.getPendingMessages(agentId, { max_messages: 100 });
    let pushed = 0;
    for (const message of pending) {
      if (router.markMessagePushed(agentId, message.id)) {
        pushed += pushEvent(agentId, message) ? 1 : 0;
      } else if (pushEvent(agentId, message)) {
        pushed += 1;
      }
    }
    return pushed;
  }

  async function processCommand(client, action, payload = {}) {
    switch (action) {
      case "register": {
        const result = router.registerAgent(payload);
        if (client) {
          client.agentId = payload.agent_id;
          client.subscriptions = new Set(
            router.getSubscribedTopics(client.agentId),
          );
          touchClient(client);
          pushPendingMessages(client.agentId);
        }
        return { ok: true, data: { ...result, pipe_path: pipePath } };
      }

      case "subscribe": {
        const agentId = resolveAgentId(client, payload);
        const topics = normalizeTopics(payload.topics);
        const result = router.subscribeAgent(agentId, topics, {
          replace: Boolean(payload.replace),
        });
        if (client) {
          client.agentId = agentId;
          client.subscriptions = new Set(result.topics);
          touchClient(client);
        }
        const replayed = pushPendingMessages(agentId);
        return {
          ok: true,
          data: { ...result, replayed_messages: replayed },
        };
      }

      case "ack": {
        const agentId = resolveAgentId(client, payload);
        const acked = router.ackMessages(
          payload.message_ids || payload.ack_ids || [],
          agentId,
        );
        if (client) touchClient(client);
        return { ok: true, data: { agent_id: agentId, acked_count: acked } };
      }

      case "heartbeat": {
        const agentId = resolveAgentId(client, payload);
        const result = router.refreshAgentLease(
          agentId,
          payload.heartbeat_ttl_ms || heartbeatTtlMs,
        );
        if (client) touchClient(client);
        return { ok: true, data: result };
      }

      case "publish": {
        const result = router.handlePublish(payload);
        if (client) touchClient(client);
        return result;
      }

      case "handoff": {
        const result = router.handleHandoff(payload);
        if (client) touchClient(client);
        return result;
      }

      case "assign": {
        const result = router.assignAsync(payload);
        if (client) touchClient(client);
        return result;
      }

      case "assign_result": {
        const result = router.reportAssignResult(payload);
        if (client) touchClient(client);
        return result;
      }

      case "assign_retry": {
        const result = router.retryAssign(payload.job_id, payload);
        if (client) touchClient(client);
        return result;
      }

      case "result": {
        const result = router.handlePublish({
          from: payload.agent_id,
          to: `topic:${payload.topic || "task.result"}`,
          topic: payload.topic || "task.result",
          payload: payload.payload || {},
          priority: 5,
          ttl_ms: 3600000,
          trace_id: payload.trace_id,
          correlation_id: payload.correlation_id,
        });
        if (client) touchClient(client);
        return result;
      }

      case "control": {
        const result = router.handlePublish({
          from: payload.from_agent || "lead",
          to: payload.to_agent,
          topic: "lead.control",
          payload: {
            command: payload.command,
            reason: payload.reason || "",
            ...(payload.payload || {}),
            issued_at: Date.now(),
          },
          priority: 8,
          ttl_ms: Math.max(
            1000,
            Math.min(Number(payload.ttl_ms) || 3600000, 86400000),
          ),
          trace_id: payload.trace_id,
          correlation_id: payload.correlation_id,
        });
        if (client) touchClient(client);
        return result;
      }

      case "deregister": {
        const agentId = resolveAgentId(client, payload);
        router.updateAgentStatus(agentId, "offline");
        if (client) touchClient(client);
        return {
          ok: true,
          data: { agent_id: agentId, status: "offline" },
        };
      }

      case "send_input": {
        if (client) touchClient(client);
        return sendInputToConductorSession(payload.session_id, payload.text);
      }

      case "team_task_update": {
        const teamTaskUpdate = getTeamBridgeMethod("teamTaskUpdate");
        const result = teamTaskUpdate
          ? await teamTaskUpdate(payload)
          : teamTaskUpdateFallback(payload);
        if (client) touchClient(client);
        return result;
      }

      case "team_send_message": {
        const teamSendMessage = getTeamBridgeMethod("teamSendMessage");
        const result = teamSendMessage
          ? await teamSendMessage(payload)
          : teamSendMessageFallback(payload);
        if (client) touchClient(client);
        return result;
      }

      case "pipeline_advance": {
        if (client) touchClient(client);
        if (!store?.db) {
          return { ok: false, error: "hub_db_not_found" };
        }
        ensurePipelineTable(store.db);
        const pipeline = createPipeline(store.db, payload.team_name);
        return pipeline.advance(payload.phase);
      }

      case "pipeline_init": {
        if (client) touchClient(client);
        if (!store?.db) {
          return { ok: false, error: "hub_db_not_found" };
        }
        ensurePipelineTable(store.db);
        const state = initPipelineState(store.db, payload.team_name, {
          fix_max: payload.fix_max,
          ralph_max: payload.ralph_max,
        });
        return { ok: true, data: state };
      }

      case "hitl_request": {
        if (!hitlManager) {
          return { ok: false, error: "hitl not available" };
        }
        if (client) touchClient(client);
        return hitlManager.requestHumanInput(payload);
      }

      case "hitl_submit": {
        if (!hitlManager) {
          return { ok: false, error: "hitl not available" };
        }
        if (client) touchClient(client);
        return hitlManager.submitHumanInput(payload);
      }

      case "delegator_delegate": {
        if (!delegatorService) {
          return {
            ok: false,
            error: {
              code: "DELEGATOR_NOT_AVAILABLE",
              message: "Delegator service가 초기화되지 않았습니다",
            },
          };
        }
        if (client) touchClient(client);
        const result = await delegatorService.delegate(payload);
        return { ok: result?.ok !== false, data: result };
      }

      case "delegator_reply": {
        if (!delegatorService) {
          return {
            ok: false,
            error: {
              code: "DELEGATOR_NOT_AVAILABLE",
              message: "Delegator service가 초기화되지 않았습니다",
            },
          };
        }
        if (client) touchClient(client);
        const result = await delegatorService.reply(payload);
        return { ok: result?.ok !== false, data: result };
      }

      default:
        return {
          ok: false,
          error: {
            code: "UNKNOWN_PIPE_COMMAND",
            message: `지원하지 않는 command: ${action}`,
          },
        };
    }
  }

  function buildReplayMessages(agentId, payload = {}) {
    const maxMessages = Math.max(
      1,
      Math.min(Number(payload.max_messages) || 20, 100),
    );
    const pending = router.getPendingMessages(agentId, {
      max_messages: maxMessages,
      include_topics: payload.topics,
    });
    if (!store?.getAuditMessagesForAgent) {
      return pending.slice(0, maxMessages);
    }

    const audit = store.getAuditMessagesForAgent(agentId, {
      max_messages: maxMessages,
      include_topics: payload.topics,
    });
    const byId = new Map();
    for (const message of [...pending, ...audit]) {
      if (!message?.id || byId.has(message.id)) continue;
      byId.set(message.id, message);
    }
    return Array.from(byId.values())
      .sort((left, right) => right.created_at_ms - left.created_at_ms)
      .slice(0, maxMessages);
  }

  async function processQuery(client, action, payload = {}) {
    switch (action) {
      case "drain": {
        const agentId = resolveAgentId(client, payload);
        const messages = router.drainAgent(agentId, {
          max_messages: payload.max_messages,
          include_topics: payload.topics,
          auto_ack: payload.auto_ack,
        });
        if (client) touchClient(client);
        return {
          ok: true,
          data: {
            messages,
            count: messages.length,
            server_time_ms: Date.now(),
          },
        };
      }

      case "context": {
        const agentId = resolveAgentId(client, payload);
        const messages = buildReplayMessages(agentId, payload);
        if (client) touchClient(client);
        return {
          ok: true,
          data: {
            messages,
            count: messages.length,
            server_time_ms: Date.now(),
          },
        };
      }

      case "status": {
        const scope = payload.scope || "hub";
        if (client) touchClient(client);
        return router.getStatus(scope, payload);
      }

      case "assign_status": {
        if (client) touchClient(client);
        return router.getAssignStatus(payload);
      }

      case "team_info": {
        const teamInfo = getTeamBridgeMethod("teamInfo");
        const result = teamInfo
          ? await teamInfo(payload)
          : teamInfoFallback(payload);
        if (client) touchClient(client);
        return result;
      }

      case "team_task_list": {
        const teamTaskList = getTeamBridgeMethod("teamTaskList");
        const result = teamTaskList
          ? await teamTaskList(payload)
          : teamTaskListFallback(payload);
        if (client) touchClient(client);
        return result;
      }

      case "pipeline_state": {
        if (client) touchClient(client);
        if (!store?.db) {
          return { ok: false, error: "hub_db_not_found" };
        }
        ensurePipelineTable(store.db);
        const state = readPipelineState(store.db, payload.team_name);
        return state
          ? { ok: true, data: state }
          : { ok: false, error: "pipeline_not_found" };
      }

      case "pipeline_list": {
        if (client) touchClient(client);
        if (!store?.db) {
          return { ok: false, error: "hub_db_not_found" };
        }
        ensurePipelineTable(store.db);
        return { ok: true, data: listPipelineStates(store.db) };
      }

      case "hitl_pending": {
        if (client) touchClient(client);
        if (!hitlManager) {
          return { ok: false, error: "hitl not available" };
        }
        return { ok: true, data: hitlManager.getPendingRequests() };
      }

      case "delegator_status": {
        if (!delegatorService) {
          return {
            ok: false,
            error: {
              code: "DELEGATOR_NOT_AVAILABLE",
              message: "Delegator service가 초기화되지 않았습니다",
            },
          };
        }
        if (client) touchClient(client);
        const result = await delegatorService.status(payload);
        return { ok: result?.ok !== false, data: result };
      }

      default:
        return {
          ok: false,
          error: {
            code: "UNKNOWN_PIPE_QUERY",
            message: `지원하지 않는 query: ${action}`,
          },
        };
    }
  }

  function onMessage(agentId, message) {
    if (!agentId || !message) return;
    if (router.markMessagePushed(agentId, message.id)) {
      pushEvent(agentId, message);
      return;
    }
    pushEvent(agentId, message);
  }

  async function handleFrame(client, frame) {
    if (!frame || typeof frame !== "object") {
      return sendResponse(client, null, {
        ok: false,
        error: { code: "INVALID_FRAME", message: "JSON object frame required" },
      });
    }

    if (!frame.type) {
      return sendResponse(client, frame.request_id || null, {
        ok: false,
        error: { code: "INVALID_FRAME", message: "type required" },
      });
    }

    touchClient(client);

    try {
      if (frame.type === "command") {
        const action = frame.payload?.action || frame.payload?.command;
        const result = await processCommand(
          client,
          action,
          frame.payload || {},
        );
        return sendResponse(
          client,
          frame.payload?.request_id || frame.request_id || null,
          result,
        );
      }
      if (frame.type === "query") {
        const action = frame.payload?.action || frame.payload?.query;
        const result = await processQuery(client, action, frame.payload || {});
        return sendResponse(
          client,
          frame.payload?.request_id || frame.request_id || null,
          result,
        );
      }
      return sendResponse(client, frame.request_id || null, {
        ok: false,
        error: {
          code: "INVALID_FRAME_TYPE",
          message: `지원하지 않는 type: ${frame.type}`,
        },
      });
    } catch (error) {
      return sendResponse(client, frame.request_id || null, {
        ok: false,
        error: { code: "PIPE_REQUEST_FAILED", message: error.message },
      });
    }
  }

  function attachSocket(socket) {
    const client = {
      id: randomUUID(),
      socket,
      buffer: "",
      agentId: null,
      subscriptions: new Set(),
      lastHeartbeatMs: Date.now(),
      closed: false,
    };
    clients.set(client.id, client);

    socket.setEncoding("utf8");
    socket.on("data", async (chunk) => {
      client.buffer += chunk;
      let newlineIndex = client.buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = client.buffer.slice(0, newlineIndex).trim();
        client.buffer = client.buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            const frame = safeJsonParse(line);
            await handleFrame(client, frame);
          } catch (err) {
            pipeLog.error({ clientId: client.id, err: String(err?.message || err) }, "pipe.frame_handler_error");
          }
        }
        newlineIndex = client.buffer.indexOf("\n");
      }
    });

    socket.on("close", () => closeClient(client));
    socket.on("error", () => closeClient(client));
  }

  function startHeartbeatMonitor() {
    heartbeatTimer = setInterval(
      () => {
        const now = Date.now();
        for (const client of clients.values()) {
          if (now - client.lastHeartbeatMs <= heartbeatTtlMs) continue;
          sendFrame(client, {
            type: "event",
            event: "disconnect",
            payload: { reason: "heartbeat_timeout" },
          });
          closeClient(client);
        }
      },
      Math.max(1000, Math.floor(heartbeatTtlMs / 2)),
    );
    heartbeatTimer.unref();
  }

  return {
    path: pipePath,

    async start() {
      if (server) return { path: pipePath };

      if (!IS_WINDOWS && existsSync(pipePath)) {
        try {
          unlinkSync(pipePath);
        } catch {}
      }

      server = net.createServer(attachSocket);
      router.deliveryEmitter.on("message", onMessage);

      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(pipePath, () => {
          server.off("error", reject);
          resolve();
        });
      });

      startHeartbeatMonitor();
      return { path: pipePath };
    },

    async stop() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      router.deliveryEmitter.off("message", onMessage);

      for (const client of clients.values()) {
        closeClient(client);
      }

      if (server) {
        const current = server;
        server = null;
        await new Promise((resolve) => current.close(resolve));
      }

      if (!IS_WINDOWS && existsSync(pipePath)) {
        try {
          unlinkSync(pipePath);
        } catch {}
      }
    },

    getStatus() {
      return {
        path: pipePath,
        protocol: "ndjson",
        clients: clients.size,
        pending_messages: Array.from(clients.values()).reduce((sum, client) => {
          if (!client.agentId) return sum;
          return sum + router.countPendingMessages(client.agentId);
        }, 0),
      };
    },

    async executeCommand(action, payload) {
      return await processCommand(null, action, payload);
    },

    async executeQuery(action, payload) {
      return await processQuery(null, action, payload);
    },
  };
}
