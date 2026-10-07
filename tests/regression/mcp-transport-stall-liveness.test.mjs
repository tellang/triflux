import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { CodexMcpWorker } from "../../hub/workers/codex-mcp.mjs";

describe("Codex MCP worker activity sidecar", () => {
  const cleanupDirs = [];
  after(() => {
    cleanupDirs.forEach((dir) => {
      rmSync(dir, { recursive: true, force: true });
    });
  });

  it("MCP progress notification은 per-run activity sidecar에만 기록한다", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tfx-mcp-progress-"));
    cleanupDirs.push(dir);
    const activityFile = path.join(dir, "activity.log");
    const worker = new CodexMcpWorker({ activityFile });
    worker.start = async () => {
      worker.ready = true;
      worker.client = {
        callTool: async (_request, _schema, options) => {
          options.onprogress({ progress: 1, total: 2 });
          return {
            content: [{ type: "text", text: "done" }],
            structuredContent: { threadId: "thread-progress", content: "done" },
            isError: false,
          };
        },
      };
    };

    const result = await worker.execute("long MCP task");
    assert.equal(result.exitCode, 0);
    assert.equal(readFileSync(activityFile, "utf8"), "progress\n");
  });
});
