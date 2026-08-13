import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";

import { probeHttp } from "../../scripts/lib/mcp-health.mjs";

const MCP_ACCEPT = "application/json, text/event-stream";

function startStub(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/mcp` });
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function initializeResult() {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: { protocolVersion: "2024-11-05", capabilities: {} },
  };
}

describe("mcp-health — Streamable HTTP regression", () => {
  it("sends the MCP Accept header required by a JSON HTTP endpoint", async () => {
    const { server, url } = await startStub((req, res) => {
      if (req.headers.accept !== MCP_ACCEPT) {
        res.writeHead(406, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing MCP Accept header" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(initializeResult()));
    });

    try {
      const result = await probeHttp(url, 2000);
      assert.equal(result.alive, true, JSON.stringify(result));
    } finally {
      await close(server);
    }
  });

  it("accepts an initialize envelope framed as a text/event-stream response", async () => {
    const { server, url } = await startStub((req, res) => {
      assert.equal(req.headers.accept, MCP_ACCEPT);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `event: message\ndata: ${JSON.stringify(initializeResult())}\n\n`,
      );
    });

    try {
      const result = await probeHttp(url, 2000);
      assert.equal(result.alive, true, JSON.stringify(result));
    } finally {
      await close(server);
    }
  });

  it("keeps an unreachable HTTP endpoint dead", async () => {
    const { server, url } = await startStub(() => {});
    const closedUrl = url;
    await close(server);

    const result = await probeHttp(closedUrl, 500);
    assert.equal(result.alive, false, JSON.stringify(result));
    assert.match(result.reason, /^fetch:/);
  });
});
