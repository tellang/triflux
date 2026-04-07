import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createPipeServer } from "../../hub/pipe.mjs";
import {
  createConductorRegistry,
  sendInputToConductorSession,
  setConductorRegistry,
} from "../../hub/team/conductor-registry.mjs";
import { createTools } from "../../hub/tools.mjs";

function parseToolResult(result) {
  return JSON.parse(result.content[0].text);
}

describe("conductor-registry send_input integration", () => {
  let previousRegistry;
  let registry;

  beforeEach(() => {
    registry = createConductorRegistry();
    previousRegistry = setConductorRegistry(registry);
  });

  afterEach(() => {
    setConductorRegistry(previousRegistry);
  });

  it("createTools는 send_input을 21번째 MCP 도구로 노출해야 한다", () => {
    const tools = createTools({}, {}, {}, null);
    assert.equal(tools.length, 21);
    assert.equal(tools.at(-1)?.name, "send_input");
  });

  it("tool과 pipe는 registry에 등록된 conductor session으로 send_input을 전달해야 한다", async () => {
    const calls = [];
    registry.register("session-input-1", {
      sendInput(sessionId, text) {
        calls.push({ sessionId, text });
        return true;
      },
    });

    const tools = createTools({}, {}, {}, null);
    const sendInputTool = tools.find((tool) => tool.name === "send_input");
    const toolResult = parseToolResult(
      await sendInputTool.handler({
        session_id: "session-input-1",
        text: "continue please",
      }),
    );

    assert.deepEqual(toolResult, {
      ok: true,
      data: {
        session_id: "session-input-1",
        sent: true,
      },
    });

    const pipe = createPipeServer({
      router: {
        deliveryEmitter: {
          on() {},
          off() {},
        },
      },
    });
    const pipeResult = await pipe.executeCommand("send_input", {
      session_id: "session-input-1",
      text: "second line",
    });

    assert.deepEqual(pipeResult, {
      ok: true,
      data: {
        session_id: "session-input-1",
        sent: true,
      },
    });
    assert.deepEqual(calls, [
      { sessionId: "session-input-1", text: "continue please" },
      { sessionId: "session-input-1", text: "second line" },
    ]);
  });

  it("registry가 없거나 session_id를 찾지 못하면 명시적 에러를 반환해야 한다", async () => {
    setConductorRegistry(null);
    assert.deepEqual(sendInputToConductorSession("missing-session", "hello"), {
      ok: false,
      error: {
        code: "CONDUCTOR_REGISTRY_NOT_AVAILABLE",
        message: "Conductor registry가 초기화되지 않았습니다",
      },
    });

    setConductorRegistry(registry);
    const pipe = createPipeServer({
      router: {
        deliveryEmitter: {
          on() {},
          off() {},
        },
      },
    });

    assert.deepEqual(
      await pipe.executeCommand("send_input", {
        session_id: "missing-session",
        text: "hello",
      }),
      {
        ok: false,
        error: {
          code: "CONDUCTOR_SESSION_NOT_FOUND",
          message: "Conductor session not found: missing-session",
        },
      },
    );
  });
});
