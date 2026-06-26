// tests/unit/tray-state.test.mjs — tray UI data contract regression tests

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildTrayStatePayload,
  normalizeTraySessions,
} from "../../hub/tray-state.mjs";

describe("tray-state contract", () => {
  it("projects synapse snapshot wrapper to a flat sessions array", () => {
    const payload = buildTrayStatePayload({
      synapseSnapshot: {
        sessions: [
          {
            sessionId: "stale-1",
            status: "stale",
            cwd: "/stale",
            lastHeartbeat: 10,
          },
          {
            sessionId: "active-1",
            status: "active",
            cwd: "/active",
            lastHeartbeat: 20,
          },
        ],
      },
      now: 123,
    });

    assert.equal(Array.isArray(payload.sessions), true);
    assert.equal(payload.sessions.length, 2);
    assert.equal(payload.sessions[0].sessionId, "active-1");
    assert.equal(payload.sessions.sessions, undefined);
    assert.equal(payload.cto.summary.tray_sessions_by_status.active, 1);
    assert.equal(payload.cto.summary.tray_sessions_by_status.stale, 1);
  });

  it("accepts legacy object maps without rendering the wrapper key as a session", () => {
    const sessions = normalizeTraySessions({
      "session-a": { sessionId: "session-a", status: "idle" },
      metadata: { generated_at: "not a session" },
    });

    assert.deepEqual(
      sessions.map((session) => session.sessionId),
      ["session-a"],
    );
  });

  it("passes compact CTO hygiene counts and actions through to the tray payload", () => {
    const payload = buildTrayStatePayload({
      ctoStatus: {
        schema_version: "cto-lake.v1",
        hygiene: {
          active_tasks: 2,
          completed_tasks: 1,
          stale_sessions: 1,
          orphan_worktrees: 1,
          superseded_checkpoints: 3,
          unknown_owner: 2,
        },
        hygiene_actions: [
          {
            kind: "session",
            id: "stale-session",
            status: "stale",
            action: "review_or_archive_session",
          },
          {
            kind: "worktree",
            id: "wt-old",
            status: "orphaned",
            action: "remove_or_reassign_worktree",
          },
          {
            kind: "ignored",
            id: "too-many",
            status: "ignored",
            action: "ignored",
          },
        ],
      },
    });

    assert.deepEqual(payload.cto.hygiene, {
      active_tasks: 2,
      completed_tasks: 1,
      stale_sessions: 1,
      orphan_worktrees: 1,
      superseded_checkpoints: 3,
      unknown_owner: 2,
      action_count: 3,
      actions: [
        {
          kind: "session",
          id: "stale-session",
          status: "stale",
          action: "review_or_archive_session",
        },
        {
          kind: "worktree",
          id: "wt-old",
          status: "orphaned",
          action: "remove_or_reassign_worktree",
        },
      ],
    });
    assert.equal(payload.cto.summary.live_session_count, 0);
  });

  it("passes CTO succession role metadata through to the tray payload", () => {
    const payload = buildTrayStatePayload({
      ctoStatus: {
        roles: {
          cto: {
            status: "active",
            leader_agent_id: "cto-leader",
            previous_leader_agent_id: "cto-old",
            leader_epoch: 3,
            pending_count: 7,
            candidate_source: "explicit",
          },
        },
      },
    });

    assert.deepEqual(payload.cto.roles.cto, {
      status: "active",
      leader_agent_id: "cto-leader",
      previous_leader_agent_id: "cto-old",
      leader_epoch: 3,
      pending_count: 7,
      candidate_source: "explicit",
    });
  });

  it("preserves arbitrary CTO leader agent ids in normalized live sessions", () => {
    const payload = buildTrayStatePayload({
      ctoStatus: {
        roles: {
          cto: {
            status: "active",
            leader_agent_id: "cto-agent-1",
            leader_epoch: 2,
          },
        },
        live_sessions: [
          {
            sessionId: "synapse-session-123",
            agent_id: "cto-agent-1",
            phase: "active",
            cwd: "/repo",
            role: "cto",
            taskSummary: "actual role leader",
          },
        ],
      },
    });

    assert.equal(payload.cto.live_sessions[0].agent_id, "cto-agent-1");
    assert.equal(payload.cto.live_sessions[0].role, "cto");
    assert.equal(payload.cto.roles.cto.leader_agent_id, "cto-agent-1");
  });

  it("includes CTO overlay and MCP rows in one tray payload", () => {
    const payload = buildTrayStatePayload({
      hub: { id: "hub-123456", pid: 123456, port: 27888 },
      synapseSnapshot: {
        sessions: [{ sessionId: "s1", status: "active", cwd: "/repo" }],
      },
      ctoStatus: {
        schema_version: "cto-lake.v1",
        live_sessions: [{ sessionId: "s1", phase: "active" }],
        active_shards: [{ shard_name: "ui", phase: "active" }],
      },
      mcpStatus: {
        registry_path: "/repo/config/mcp-registry.json",
        server_count: 2,
        rows: [
          {
            type: "registry",
            name: "tfx-hub",
            client: "codex",
            label: "Codex",
            actualUrl: "http://127.0.0.1:27888/mcp",
            status: "present",
            headerStatus: "ok",
          },
        ],
      },
    });

    assert.equal(payload.cto.live_sessions.length, 1);
    assert.equal(payload.cto.active_shards.length, 1);
    assert.equal(payload.mcp.server_count, 2);
    assert.equal(payload.mcp.rows.length, 1);
    assert.equal(payload.mcp.summary.by_status.present, 1);
    assert.equal(payload.mcp.rows[0].name, "tfx-hub");
    assert.deepEqual(payload.hub, {
      id: "hub-123456",
      pid: 123456,
      port: 27888,
      url: "",
      projectRoot: "",
    });
  });

  it("summarizes MCP status for the Claude, Codex, and Antigravity clients", () => {
    const payload = buildTrayStatePayload({
      mcpStatus: {
        server_count: 2,
        rows: [
          {
            type: "registry",
            name: "tfx-hub",
            client: "claude",
            status: "present",
          },
          {
            type: "registry",
            name: "context7",
            client: "claude",
            status: "present",
          },
          {
            type: "registry",
            name: "tfx-hub",
            client: "codex",
            status: "present",
          },
          {
            type: "registry",
            name: "context7",
            client: "codex",
            status: "missing",
          },
          {
            type: "registry",
            name: "tfx-hub",
            client: "antigravity",
            status: "present",
          },
        ],
      },
    });

    assert.deepEqual(
      payload.mcp.clients.map((client) => client.id),
      ["claude", "codex", "antigravity"],
    );
    assert.deepEqual(payload.mcp.clients[0], {
      id: "claude",
      label: "Claude",
      icon: "C",
      color: "#d19a66",
      status: "on",
      present: 2,
      total: 2,
    });
    assert.deepEqual(payload.mcp.clients[1], {
      id: "codex",
      label: "Codex",
      icon: "X",
      color: "#ffffff",
      status: "partial",
      present: 1,
      total: 2,
    });
    assert.deepEqual(payload.mcp.clients[2], {
      id: "antigravity",
      label: "Antigravity",
      icon: "A",
      color: "#61afef",
      status: "on",
      present: 1,
      total: 1,
    });
  });

  it("groups MCP registry rows into one server card with client status chips", () => {
    const payload = buildTrayStatePayload({
      mcpStatus: {
        rows: [
          {
            type: "registry",
            name: "tavily",
            client: "claude",
            label: "Claude User MCP",
            status: "present",
            expectedUrl: "https://mcp.tavily.com/mcp",
          },
          {
            type: "registry",
            name: "tavily",
            client: "claude",
            label: "Claude Project MCP",
            status: "present",
            expectedUrl: "https://mcp.tavily.com/mcp",
          },
          {
            type: "registry",
            name: "tavily",
            client: "codex",
            label: "Codex",
            status: "present",
            expectedUrl: "https://mcp.tavily.com/mcp",
          },
          {
            type: "registry",
            name: "tfx-hub",
            client: "claude",
            label: "Claude",
            status: "present",
            expectedUrl: "http://127.0.0.1:27888/mcp",
          },
          {
            type: "registry",
            name: "tfx-hub",
            client: "codex",
            label: "Codex",
            status: "missing",
            expectedUrl: "http://127.0.0.1:27888/mcp",
          },
          {
            type: "registry",
            name: "tfx-hub",
            client: "antigravity",
            label: "Antigravity",
            status: "present",
            expectedUrl: "http://127.0.0.1:27888/mcp",
          },
        ],
      },
    });

    assert.deepEqual(
      payload.mcp.servers.map((server) => server.name),
      ["tfx-hub", "tavily"],
    );
    assert.deepEqual(
      payload.mcp.servers[0].clients.map((client) => [
        client.id,
        client.status,
      ]),
      [
        ["claude", "on"],
        ["codex", "off"],
        ["antigravity", "on"],
      ],
    );
    assert.deepEqual(
      payload.mcp.servers[1].clients.map((client) => [
        client.id,
        client.status,
      ]),
      [
        ["claude", "on"],
        ["codex", "on"],
      ],
    );
    assert.equal(payload.mcp.servers[1].clients[0].present, 2);
    assert.equal(payload.mcp.servers[1].clients[0].total, 2);
    assert.equal(payload.mcp.servers[1].target, "https://mcp.tavily.com/mcp");
  });

  it("uses runtime CLI processes as the CTO live-session fallback", () => {
    const payload = buildTrayStatePayload({
      synapseSnapshot: {
        sessions: [{ sessionId: "old-1", status: "stale", cwd: "/old" }],
      },
      ctoStatus: { schema_version: "cto-lake.v1", live_sessions: [] },
      runtimeStatus: {
        processes: [
          {
            client: "claude",
            pid: 101,
            command: "claude agents",
            cwd: "/Users/tellang/Projects/tpcg-mailrouter",
          },
          {
            client: "codex",
            pid: 202,
            command: "codex",
            cwd: "/Users/tellang/Projects/tools/triflux",
          },
        ],
      },
    });

    assert.equal(payload.cto.live_sessions.length, 2);
    assert.deepEqual(
      payload.cto.live_sessions.map((session) => session.agent_id),
      ["claude", "codex"],
    );
    assert.deepEqual(
      payload.cto.live_sessions.map((session) => session.cwd),
      [
        "/Users/tellang/Projects/tpcg-mailrouter",
        "/Users/tellang/Projects/tools/triflux",
      ],
    );
    assert.equal(payload.cto.summary.live_session_count, 2);
    assert.equal(payload.runtime.summary.total, 2);
  });

  it("attaches visual provider metadata to Sessions/CTO entries", () => {
    const payload = buildTrayStatePayload({
      synapseSnapshot: {
        sessions: [
          {
            sessionId: "syn-claude",
            agent_id: "claude",
            status: "active",
            taskSummary: "Investigate tray",
          },
        ],
      },
      runtimeStatus: {
        processes: [
          { client: "codex", pid: 202, command: "codex" },
          { client: "antigravity", pid: 303, command: "antigravity" },
        ],
      },
    });

    assert.deepEqual(payload.sessions[0].agent, {
      id: "claude",
      label: "Claude",
      icon: "C",
      color: "#d19a66",
    });
    assert.deepEqual(
      payload.cto.live_sessions.map((session) => session.agent),
      [
        {
          id: "codex",
          label: "Codex",
          icon: "X",
          color: "#ffffff",
        },
        {
          id: "antigravity",
          label: "Antigravity",
          icon: "A",
          color: "#61afef",
        },
      ],
    );
  });

  it("prefers runtime CLI processes when the CTO overlay is undersampled", () => {
    const payload = buildTrayStatePayload({
      ctoStatus: {
        schema_version: "cto-lake.v1",
        live_sessions: [{ sessionId: "overlay-1", phase: "active" }],
      },
      runtimeStatus: {
        processes: [
          { client: "claude", pid: 101, command: "claude agents" },
          { client: "codex", pid: 202, command: "codex" },
        ],
      },
    });

    assert.equal(payload.cto.live_sessions.length, 2);
    assert.deepEqual(
      payload.cto.live_sessions.map((session) => session.sessionId),
      ["claude-101", "codex-202"],
    );
  });

  it("carries AGY conversation rows into CTO live sessions without requiring a pid", () => {
    const payload = buildTrayStatePayload({
      hub: { projectRoot: "/Users/tellang/Projects/tools/triflux" },
      ctoStatus: { schema_version: "cto-lake.v1", live_sessions: [] },
      runtimeStatus: {
        processes: [
          {
            client: "antigravity",
            sessionId: "antigravity-b948f5a5",
            conversationId: "b948f5a5-f029-4762-8540-33e34d7daca8",
            source: "conversation",
            focusable: false,
            pid: null,
            cwd: "/Users/tellang/Projects/tools/triflux",
            command: "agy conversation",
            taskSummary: "AGY conversation",
          },
        ],
        summary: {
          total: 1,
          clients: [
            {
              id: "antigravity",
              label: "Antigravity",
              icon: "A",
              color: "#61afef",
              count: 1,
              status: "on",
            },
          ],
        },
      },
    });

    assert.equal(payload.runtime.processes.length, 1);
    assert.equal(payload.runtime.processes[0].pid, null);
    assert.equal(payload.cto.live_sessions.length, 1);
    assert.deepEqual(payload.cto.live_sessions[0], {
      sessionId: "antigravity-b948f5a5",
      host: "local",
      agent_id: "antigravity",
      agent: {
        id: "antigravity",
        label: "Antigravity",
        icon: "A",
        color: "#61afef",
      },
      phase: "idle",
      pid: null,
      command: "agy conversation",
      elapsed: "",
      cwd: "/Users/tellang/Projects/tools/triflux",
      taskSummary: "AGY conversation",
      source: "conversation",
      conversationId: "b948f5a5-f029-4762-8540-33e34d7daca8",
      focusable: false,
      started_at: null,
    });
  });
});
