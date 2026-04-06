import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMonitor } from "../../tui/monitor.mjs";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/gu;

function stripAnsi(text) {
  return String(text || "").replace(ANSI_PATTERN, "");
}

function makeStream() {
  let output = "";
  return {
    columns: 100,
    write(chunk) {
      output += String(chunk);
    },
    read() {
      return output;
    },
  };
}

describe("createMonitor", () => {
  it("에이전트가 없을 때 빈 상태를 렌더링한다", async () => {
    const stream = makeStream();
    const monitor = createMonitor({
      stream,
      refreshMs: 0,
      _deps: {
        pollAgents: () => [],
        fetchHubStatus: async () => ({ online: false }),
      },
    });

    await monitor.renderFrame();
    const clean = stripAnsi(stream.read());

    assert.ok(clean.includes("triflux monitor"));
    assert.ok(clean.includes("hub offline"));
    assert.ok(clean.includes("에이전트 없음"));
  });

  it("에이전트가 있으면 목록과 진행 바를 렌더링한다", async () => {
    const stream = makeStream();
    const monitor = createMonitor({
      stream,
      refreshMs: 0,
      _deps: {
        pollAgents: () => [
          { pid: 101, cli: "codex", agent: "worker-a", started: 0, elapsed: 4_000, alive: true },
          { pid: 202, cli: "gemini", agent: "worker-b", started: 0, elapsed: 8_000, alive: true },
        ],
        fetchHubStatus: async () => ({ online: true, queueDepth: 2, agents: 2 }),
      },
    });

    await monitor.renderFrame();
    const clean = stripAnsi(stream.read());

    assert.ok(clean.includes("▶ codex worker-a"));
    assert.ok(clean.includes("gemini worker-b"));
    assert.ok(clean.includes("["));
    assert.ok(clean.includes("queue 2"));
  });

  it("j/k 입력에서 커서가 경계값을 넘지 않는다", async () => {
    const monitor = createMonitor({
      stream: makeStream(),
      refreshMs: 0,
      _deps: {
        pollAgents: () => [
          { pid: 1, cli: "codex", agent: "worker-a", started: 0, elapsed: 1_000, alive: true },
          { pid: 2, cli: "claude", agent: "worker-b", started: 0, elapsed: 2_000, alive: true },
        ],
        fetchHubStatus: async () => ({ online: false }),
      },
    });

    await monitor.renderFrame();
    await monitor.handleKey("j", {});
    await monitor.handleKey("j", {});
    assert.equal(monitor.getState().cursor, 1);

    await monitor.handleKey("k", {});
    await monitor.handleKey("k", {});
    assert.equal(monitor.getState().cursor, 0);
  });
});
