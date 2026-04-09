import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CODEX_MCP_EXECUTION_EXIT_CODE,
  CodexMcpTransportError,
  CodexMcpWorker,
} from "../../hub/workers/codex-mcp.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(TEST_DIR, "..", "fixtures", "fake-codex.mjs");

function createWorker(env = {}) {
  return new CodexMcpWorker({
    command: process.execPath,
    args: [FIXTURE, "mcp-server"],
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    clientInfo: { name: "triflux-test", version: "1.0.0" },
  });
}

describe("CodexMcpWorker", () => {
  // MCP transport 핸들이 프로세스 종료를 차단하지 않도록 강제 정리
  after(() => setTimeout(() => process.exit(0), 100));

  it("sessionKey가 같으면 threadId를 재사용해 codex-reply로 이어서 실행한다", async () => {
    const worker = createWorker({ FAKE_CODEX_MODE: "mcp-ok" });

    try {
      const first = await worker.execute("remember:ORANGE", {
        sessionKey: "task-1",
        profile: "codex53_low",
      });
      const second = await worker.execute("what did i say?", {
        sessionKey: "task-1",
      });

      assert.equal(first.exitCode, 0);
      assert.equal(second.exitCode, 0);
      assert.equal(first.output, "ORANGE");
      assert.equal(second.output, "ORANGE");
      assert.ok(first.threadId);
      assert.equal(second.threadId, first.threadId);
    } finally {
      await worker.stop();
    }
  });

  it("resetSession=true 이면 같은 sessionKey에서도 새 threadId를 발급한다", async () => {
    const worker = createWorker({ FAKE_CODEX_MODE: "mcp-ok" });

    try {
      const first = await worker.execute("remember:ALPHA", {
        sessionKey: "task-2",
      });
      const second = await worker.execute("remember:BETA", {
        sessionKey: "task-2",
        resetSession: true,
      });

      assert.equal(first.exitCode, 0);
      assert.equal(second.exitCode, 0);
      assert.notEqual(first.threadId, second.threadId);
      assert.equal(second.output, "BETA");
    } finally {
      await worker.stop();
    }
  });

  it("tool error는 exitCode=1과 함께 텍스트를 반환한다", async () => {
    const worker = createWorker({ FAKE_CODEX_MODE: "mcp-ok" });

    try {
      const result = await worker.execute("FAIL_TOOL");
      assert.equal(result.exitCode, CODEX_MCP_EXECUTION_EXIT_CODE);
      assert.match(result.output, /fake tool failure/);
    } finally {
      await worker.stop();
    }
  });

  it("MCP bootstrap 실패는 CodexMcpTransportError를 던진다", async () => {
    const worker = createWorker({ FAKE_CODEX_MODE: "mcp-fail" });

    await assert.rejects(
      worker.start(),
      (error) =>
        error instanceof CodexMcpTransportError &&
        /Codex MCP 연결 실패/.test(error.message),
    );
    await worker.stop();
  });

  it("config 옵션은 codex MCP tool 호출 인자로 전달된다", async () => {
    const worker = createWorker({ FAKE_CODEX_MODE: "mcp-ok" });

    try {
      const result = await worker.execute("SHOW_CONFIG", {
        config: {
          mcp_servers: {
            context7: {
              enabled: true,
              enabled_tools: ["resolve-library-id", "query-docs"],
            },
            tavily: {
              enabled: false,
            },
          },
        },
      });

      assert.equal(result.exitCode, 0);
      assert.deepEqual(JSON.parse(result.output), {
        mcp_servers: {
          context7: {
            enabled: true,
            enabled_tools: ["resolve-library-id", "query-docs"],
          },
          tavily: {
            enabled: false,
          },
        },
      });
    } finally {
      await worker.stop();
    }
  });
});
