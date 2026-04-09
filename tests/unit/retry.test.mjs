import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClaudeWorker } from "../../hub/workers/claude-worker.mjs";
import {
  CODEX_MCP_EXECUTION_EXIT_CODE,
  CodexMcpTransportError,
  CodexMcpWorker,
} from "../../hub/workers/codex-mcp.mjs";
import { GeminiWorker } from "../../hub/workers/gemini-worker.mjs";
import { withRetry } from "../../hub/workers/worker-utils.mjs";

function createWorkerError(message, details = {}) {
  return Object.assign(new Error(message), details);
}

class TestCodexWorker extends CodexMcpWorker {
  constructor(sequence, options = {}) {
    super(options);
    this.sequence = [...sequence];
    this.startCalls = 0;
    this.stopCalls = 0;
  }

  async start() {
    this.startCalls += 1;
    this.ready = true;
    this.client = {
      callTool: async () => {
        const next = this.sequence.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    };
  }

  async stop() {
    this.stopCalls += 1;
    this.ready = false;
    this.client = null;
  }
}

class TestGeminiWorker extends GeminiWorker {
  constructor(sequence, options = {}) {
    super(options);
    this.sequence = [...sequence];
    this.runCalls = 0;
  }

  async run(prompt) {
    this.runCalls += 1;
    const next = this.sequence.shift();
    if (next instanceof Error) throw next;
    return {
      type: "gemini",
      command: this.command,
      args: [],
      response: next?.response || `gemini:${prompt}`,
      events: [],
      resultEvent: null,
      usage: null,
      stdout: "",
      stderr: "",
      exitCode: 0,
      exitSignal: null,
      timedOut: false,
      startedAtMs: 0,
      finishedAtMs: 0,
      ...next,
    };
  }
}

class TestClaudeWorker extends ClaudeWorker {
  constructor(sequence, options = {}) {
    super(options);
    this.sequence = [...sequence];
    this.runCalls = 0;
    this.restartCalls = 0;
  }

  async start() {
    this.state = "ready";
    return this.getStatus();
  }

  async stop() {
    this.state = "stopped";
    return this.getStatus();
  }

  async restart() {
    this.restartCalls += 1;
    this.state = "ready";
    return this.getStatus();
  }

  async run(prompt) {
    this.runCalls += 1;
    const next = this.sequence.shift();
    if (next instanceof Error) throw next;
    this.sessionId = next?.sessionId || "claude-session-1";
    return {
      type: "claude",
      sessionId: this.sessionId,
      response: next?.response || `claude:${prompt}`,
      assistantEvents: [],
      resultEvent: null,
      stderr: "",
      history: [],
      startedAtMs: 0,
      finishedAtMs: 0,
      durationMs: 0,
      ...next,
    };
  }
}

describe("withRetry", () => {
  it("retries retryable failures until success", async () => {
    let attempts = 0;

    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error(`flaky-${attempts}`);
        }
        return "ok";
      },
      {
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
        shouldRetry: () => true,
      },
    );

    assert.equal(result, "ok");
    assert.equal(attempts, 3);
  });

  it("stops after the first non-retryable failure", async () => {
    let attempts = 0;

    await assert.rejects(
      withRetry(
        async () => {
          attempts += 1;
          throw new Error("fatal");
        },
        {
          maxAttempts: 3,
          baseDelayMs: 0,
          maxDelayMs: 0,
          shouldRetry: () => false,
        },
      ),
      /fatal/,
    );

    assert.equal(attempts, 1);
  });
});

describe("CodexMcpWorker.execute", () => {
  it("retries retryable transport failures after reconnecting", async () => {
    const worker = new TestCodexWorker(
      [
        new CodexMcpTransportError("temporary bootstrap failure"),
        {
          content: [{ type: "text", text: "codex:ok" }],
          structuredContent: { threadId: "thread-1", content: "codex:ok" },
          isError: false,
        },
      ],
      {
        retryOptions: { baseDelayMs: 0, maxDelayMs: 0 },
      },
    );

    const result = await worker.execute("retry me", { sessionKey: "job-1" });

    assert.equal(result.exitCode, 0);
    assert.equal(result.output, "codex:ok");
    assert.equal(result.threadId, "thread-1");
    assert.equal(worker.startCalls, 2);
    assert.equal(worker.stopCalls, 1);
  });

  it("returns structured error metadata after retry exhaustion", async () => {
    const worker = new TestCodexWorker(
      [
        new CodexMcpTransportError("transport down"),
        new CodexMcpTransportError("transport down"),
        new CodexMcpTransportError("transport down"),
      ],
      {
        retryOptions: { baseDelayMs: 0, maxDelayMs: 0 },
      },
    );

    const result = await worker.execute("still broken", {
      sessionKey: "job-2",
    });

    assert.equal(result.exitCode, CODEX_MCP_EXECUTION_EXIT_CODE);
    assert.match(result.output, /transport down/);
    assert.deepEqual(result.error, {
      code: "CODEX_TRANSPORT_ERROR",
      retryable: true,
      attempts: 3,
      category: "transient",
      recovery: "Retry after reconnecting the Codex MCP transport.",
    });
  });
});

describe("GeminiWorker.execute", () => {
  it("retries transient worker exits and succeeds", async () => {
    const worker = new TestGeminiWorker(
      [
        createWorkerError("Gemini worker exited with code 1", {
          code: "WORKER_EXIT",
          stderr: "temporary failure",
          result: { exitCode: 1, stderr: "temporary failure" },
        }),
        { response: "gemini:ok" },
      ],
      {
        retryOptions: { baseDelayMs: 0, maxDelayMs: 0 },
      },
    );

    const result = await worker.execute("retry me");

    assert.equal(result.exitCode, 0);
    assert.equal(result.output, "gemini:ok");
    assert.equal(worker.runCalls, 2);
  });

  it("does not retry misuse exits and reports config metadata", async () => {
    const worker = new TestGeminiWorker(
      [
        createWorkerError("Gemini worker exited with code 2", {
          code: "WORKER_EXIT",
          stderr: "bad args",
          result: { exitCode: 2, stderr: "bad args" },
        }),
      ],
      {
        retryOptions: { baseDelayMs: 0, maxDelayMs: 0 },
      },
    );

    const result = await worker.execute("bad config");

    assert.equal(result.exitCode, 1);
    assert.equal(worker.runCalls, 1);
    assert.deepEqual(result.error, {
      code: "WORKER_EXIT",
      retryable: false,
      attempts: 1,
      category: "config",
      recovery: "Check the Gemini CLI flags and worker configuration.",
    });
  });
});

describe("ClaudeWorker.execute", () => {
  it("retries closed stdin failures by restarting the session", async () => {
    const worker = new TestClaudeWorker(
      [
        createWorkerError("Claude worker stdin is not writable", {
          code: "WORKER_STDIN_CLOSED",
          stderr: "stdin closed",
        }),
        { response: "claude:ok", sessionId: "claude-session-1" },
      ],
      {
        retryOptions: { baseDelayMs: 0, maxDelayMs: 0 },
      },
    );

    const result = await worker.execute("retry me");

    assert.equal(result.exitCode, 0);
    assert.equal(result.output, "claude:ok");
    assert.equal(result.sessionKey, "claude-session-1");
    assert.equal(worker.runCalls, 2);
    assert.equal(worker.restartCalls, 1);
  });

  it("returns structured error metadata after retry exhaustion", async () => {
    const worker = new TestClaudeWorker(
      [
        createWorkerError("Claude worker exited with code 1", {
          code: "WORKER_EXIT",
          stderr: "worker crashed",
        }),
        createWorkerError("Claude worker exited with code 1", {
          code: "WORKER_EXIT",
          stderr: "worker crashed",
        }),
        createWorkerError("Claude worker exited with code 1", {
          code: "WORKER_EXIT",
          stderr: "worker crashed",
        }),
      ],
      {
        retryOptions: { baseDelayMs: 0, maxDelayMs: 0 },
      },
    );

    const result = await worker.execute("still broken");

    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.error, {
      code: "WORKER_EXIT",
      retryable: true,
      attempts: 3,
      category: "transient",
      recovery: "Restart the Claude worker session and retry the turn.",
    });
  });
});
