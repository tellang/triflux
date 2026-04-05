import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { publishLeadControl } from "../../hub/team/lead-control.mjs";
import { getTeamStatus, subscribeToLeadCommands } from "../../hub/team/session-sync.mjs";

function mockJsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

describe("team lead-control/session-sync", () => {
  it("publishLeadControl()는 stop alias를 abort로 정규화해 /bridge/control로 전송해야 한다", async () => {
    const calls = [];
    const result = await publishLeadControl({
      hubUrl: "http://127.0.0.1:27888/mcp",
      fromAgent: "lead-agent",
      toAgent: "worker-1",
      command: "stop",
      reason: "중단 테스트",
      payload: { source: "unit-test" },
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return mockJsonResponse(200, { ok: true, data: { message_id: "m-1" } });
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.command, "abort");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:27888/bridge/control");

    const payload = JSON.parse(calls[0].options.body);
    assert.equal(payload.from_agent, "lead-agent");
    assert.equal(payload.to_agent, "worker-1");
    assert.equal(payload.command, "abort");
    assert.equal(payload.payload.source, "unit-test");
  });

  it("publishLeadControl()는 지원하지 않는 command를 거부해야 한다", async () => {
    let called = false;
    const result = await publishLeadControl({
      hubUrl: "http://127.0.0.1:27888",
      toAgent: "worker-1",
      command: "unknown-command",
      fetchImpl: async () => {
        called = true;
        return mockJsonResponse(200, { ok: true });
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "INVALID_COMMAND");
    assert.equal(called, false);
  });

  it("subscribeToLeadCommands()는 lead.control 메시지만 command로 변환해야 한다", async () => {
    const received = [];
    const result = await subscribeToLeadCommands({
      hubUrl: "http://127.0.0.1:27888",
      agentId: "worker-1",
      onCommand: async (command) => {
        received.push(command.command);
      },
      fetchImpl: async () => mockJsonResponse(200, {
        ok: true,
        data: {
          messages: [
            {
              id: "msg-1",
              topic: "lead.control",
              from_agent: "lead",
              payload: { command: "pause", reason: "잠시 멈춤" },
            },
            {
              id: "msg-2",
              topic: "task.result",
              from_agent: "worker-2",
              payload: { output: "done" },
            },
          ],
        },
      }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.commands.length, 1);
    assert.equal(result.commands[0].command, "pause");
    assert.deepEqual(received, ["pause"]);
  });

  it("getTeamStatus()는 GET 요청으로 /bridge/status를 조회해야 한다", async () => {
    const calls = [];
    const result = await getTeamStatus({
      hubUrl: "http://127.0.0.1:27888",
      scope: "agent",
      agentId: "worker-1",
      includeMetrics: false,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return mockJsonResponse(200, { ok: true, data: { agent: { agent_id: "worker-1" } } });
      },
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/bridge\/status\?/);
    assert.match(calls[0].url, /scope=agent/);
    assert.match(calls[0].url, /agent_id=worker-1/);
    assert.match(calls[0].url, /include_metrics=0/);
    assert.equal(calls[0].options.method, "GET");
  });

  it("getTeamStatus()는 POST 요청도 지원해야 한다", async () => {
    const calls = [];
    const result = await getTeamStatus({
      hubUrl: "http://127.0.0.1:27888",
      method: "POST",
      scope: "hub",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return mockJsonResponse(200, { ok: true, data: { hub: { state: "healthy" } } });
      },
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:27888/bridge/status");
    assert.equal(calls[0].options.method, "POST");
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.scope, "hub");
    assert.equal(body.include_metrics, true);
  });
});
