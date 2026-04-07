import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  publishHeadlessControl,
  publishLeadControl,
} from "../../hub/team/lead-control.mjs";
import {
  createHeadlessControlSubscriber,
  getTeamStatus,
  subscribeToLeadCommands,
} from "../../hub/team/session-sync.mjs";

function mockJsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function withHubState(state, run) {
  const stateDir = mkdtempSync(join(tmpdir(), "tfx-hub-state-"));
  const previousStateDir = process.env.TFX_HUB_STATE_DIR;
  process.env.TFX_HUB_STATE_DIR = stateDir;
  writeFileSync(join(stateDir, "hub.pid"), JSON.stringify(state), "utf8");

  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (previousStateDir === undefined) delete process.env.TFX_HUB_STATE_DIR;
      else process.env.TFX_HUB_STATE_DIR = previousStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    });
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

  it("publishHeadlessControl()는 headless session 대상과 target_worker payload를 함께 전송해야 한다", async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return mockJsonResponse(200, {
        ok: true,
        data: { message_id: "m-headless-1" },
      });
    };

    try {
      const result = await withHubState(
        { pid: process.pid, url: "http://127.0.0.1:27888/mcp" },
        () => publishHeadlessControl("hl-session", "pause", "worker-2"),
      );

      assert.equal(result.ok, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "http://127.0.0.1:27888/bridge/control");

      const payload = JSON.parse(calls[0].options.body);
      assert.equal(payload.to_agent, "session:hl-session");
      assert.equal(payload.command, "pause");
      assert.equal(payload.payload.session_name, "hl-session");
      assert.equal(payload.payload.target_worker, "worker-2");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("subscribeToLeadCommands()는 lead.control 메시지만 command로 변환해야 한다", async () => {
    const received = [];
    const result = await subscribeToLeadCommands({
      hubUrl: "http://127.0.0.1:27888",
      agentId: "worker-1",
      onCommand: async (command) => {
        received.push(command.command);
      },
      fetchImpl: async () =>
        mockJsonResponse(200, {
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

  it("createHeadlessControlSubscriber()는 Hub 상태가 없으면 noop handle을 반환해야 한다", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tfx-hub-state-empty-"));
    const previousStateDir = process.env.TFX_HUB_STATE_DIR;
    const originalFetch = globalThis.fetch;
    let called = false;

    process.env.TFX_HUB_STATE_DIR = stateDir;
    globalThis.fetch = async () => {
      called = true;
      return mockJsonResponse(200, { ok: true, data: { messages: [] } });
    };

    try {
      const handle = createHeadlessControlSubscriber("hl-session");
      await new Promise((resolve) => setTimeout(resolve, 40));
      handle.stop();

      assert.equal(typeof handle.stop, "function");
      assert.equal(called, false);
    } finally {
      if (previousStateDir === undefined) delete process.env.TFX_HUB_STATE_DIR;
      else process.env.TFX_HUB_STATE_DIR = previousStateDir;
      globalThis.fetch = originalFetch;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("createHeadlessControlSubscriber()는 headless session 명령을 콜백으로 분기해야 한다", async () => {
    const seen = [];
    let pollCount = 0;
    let handle;

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        handle?.stop();
        reject(new Error("headless subscriber callback timeout"));
      }, 500);

      handle = createHeadlessControlSubscriber("hl-session", {
        hubUrl: "http://127.0.0.1:27888/mcp",
        pollIntervalMs: 20,
        fetchImpl: async () => {
          pollCount += 1;
          if (pollCount > 1) {
            return mockJsonResponse(200, { ok: true, data: { messages: [] } });
          }
          return mockJsonResponse(200, {
            ok: true,
            data: {
              messages: [
                {
                  id: "msg-h1",
                  topic: "lead.control",
                  from_agent: "lead",
                  payload: { command: "pause", target_worker: "worker-1" },
                },
                {
                  id: "msg-h2",
                  topic: "lead.control",
                  from_agent: "lead",
                  payload: { command: "reassign", target_worker: "worker-2" },
                },
              ],
            },
          });
        },
        onPause: async (command) => {
          seen.push(`pause:${command.payload.target_worker}`);
        },
        onReassign: async (command) => {
          seen.push(`reassign:${command.payload.target_worker}`);
          handle.stop();
          clearTimeout(timeout);
          resolve();
        },
      });
    });

    assert.deepEqual(seen, ["pause:worker-1", "reassign:worker-2"]);
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
        return mockJsonResponse(200, {
          ok: true,
          data: { agent: { agent_id: "worker-1" } },
        });
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
        return mockJsonResponse(200, {
          ok: true,
          data: { hub: { state: "healthy" } },
        });
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
