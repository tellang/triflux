import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  isCacheFresh,
  parseMcpServersFromToml,
  probeHttp,
  probeServer,
  probeStdio,
  probeAll,
  splitHealthy,
  writeCache,
  readCache,
} from "../../scripts/lib/mcp-health.mjs";
import { createServer } from "node:http";

const NODE_BIN = process.execPath;

function tmpDir(prefix = "mcp-health-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

describe("mcp-health — parseMcpServersFromToml", () => {
  it("stdio 서버와 env 서브테이블을 함께 파싱한다", () => {
    const toml = `
[mcp_servers.context7]
command = "context7-mcp"
args = []
startup_timeout_sec = 5.0

[mcp_servers.context7.env]
CONTEXT7_API_KEY = "abc"

[mcp_servers.exa]
command = "cmd"
args = ["/c", "npx", "-y", "exa-mcp-server"]
`;
    const servers = parseMcpServersFromToml(toml);
    assert.deepEqual(servers.context7.command, "context7-mcp");
    assert.deepEqual(servers.context7.args, []);
    assert.deepEqual(servers.context7.env, { CONTEXT7_API_KEY: "abc" });
    assert.deepEqual(servers.exa.args, ["/c", "npx", "-y", "exa-mcp-server"]);
  });

  it("HTTP url 기반 서버도 파싱한다", () => {
    const toml = `
[mcp_servers.tfx-hub]
url = "http://127.0.0.1:29145/mcp"
`;
    const servers = parseMcpServersFromToml(toml);
    assert.equal(servers["tfx-hub"].url, "http://127.0.0.1:29145/mcp");
  });

  it("다른 섹션이 나오면 현재 서버 컨텍스트를 닫는다", () => {
    const toml = `
[mcp_servers.foo]
command = "foo"

[projects.'C:\\other']
trust_level = "trusted"

[mcp_servers.bar]
command = "bar"
`;
    const servers = parseMcpServersFromToml(toml);
    assert.equal(servers.foo.command, "foo");
    assert.equal(servers.bar.command, "bar");
    assert.equal(servers.foo.trust_level, undefined);
    assert.equal(servers.bar.trust_level, undefined);
  });

  it("주석과 빈 줄을 건너뛴다", () => {
    const toml = `
# top comment
[mcp_servers.foo]
# inside comment
command = "foo"

`;
    const servers = parseMcpServersFromToml(toml);
    assert.equal(servers.foo.command, "foo");
  });

  it("regression A1: 멀티라인 args array 를 올바르게 배열로 파싱한다", () => {
    // Codex config.toml 은 args 를 여러 줄로 포맷하는 게 일반적.
    // 이전 버전은 `args = [` 만 읽고 `"["` 문자열로 처리 → probeStdio args=[]
    // → 정상 서버를 dead 로 오탐. 이제는 `]` 까지 누적해서 array 로 만든다.
    const toml = `
[mcp_servers.foo]
command = "node"
args = [
  "server.js",
  "--flag",
]
`;
    const servers = parseMcpServersFromToml(toml);
    assert.deepEqual(servers.foo.args, ["server.js", "--flag"]);
  });

  it("regression A1: 멀티라인 array 에 인라인 주석이 섞여도 끝까지 누적한다", () => {
    // bracket tracker 가 `#` 뒤 텍스트와 문자열 속 `]` 를 올바르게 무시하는지.
    const toml = `
[mcp_servers.bar]
command = "run"
args = [
  "serve", # first arg
  "--path", # second
  "/tmp/data",
]
`;
    const servers = parseMcpServersFromToml(toml);
    assert.deepEqual(servers.bar.args, ["serve", "--path", "/tmp/data"]);
  });

  it("regression A1: 단일 줄 array 는 기존처럼 동일하게 파싱한다", () => {
    // 회귀 확인 — 멀티라인 경로가 single-line 을 깨뜨리지 않는지.
    const toml = `
[mcp_servers.inline]
command = "x"
args = ["--one", "--two"]
`;
    const servers = parseMcpServersFromToml(toml);
    assert.deepEqual(servers.inline.args, ["--one", "--two"]);
  });
});

describe("mcp-health — isCacheFresh", () => {
  it("checkedAt + ttlMs 가 현재보다 미래면 fresh", () => {
    const cache = { checkedAt: 1000, ttlMs: 500, configMtime: 42 };
    assert.equal(isCacheFresh(cache, { now: 1200, configMtime: 42 }), true);
  });

  it("TTL 초과면 stale", () => {
    const cache = { checkedAt: 1000, ttlMs: 500, configMtime: 42 };
    assert.equal(isCacheFresh(cache, { now: 1600, configMtime: 42 }), false);
  });

  it("configMtime 불일치면 stale", () => {
    const cache = { checkedAt: 1000, ttlMs: 500, configMtime: 42 };
    assert.equal(isCacheFresh(cache, { now: 1200, configMtime: 99 }), false);
  });

  it("null/빈 cache 는 stale", () => {
    assert.equal(isCacheFresh(null), false);
    assert.equal(isCacheFresh({}), false);
  });
});

describe("mcp-health — splitHealthy", () => {
  it("alive 여부로 healthy/dead 나눈다", () => {
    const { healthy, dead } = splitHealthy({
      a: { alive: true, ms: 10 },
      b: { alive: false, reason: "timeout", ms: 3000 },
      c: { alive: true, ms: 20 },
    });
    assert.deepEqual(healthy.sort(), ["a", "c"]);
    assert.deepEqual(dead, ["b"]);
  });

  it("빈 입력은 빈 배열", () => {
    const { healthy, dead } = splitHealthy({});
    assert.deepEqual(healthy, []);
    assert.deepEqual(dead, []);
  });
});

describe("mcp-health — cache read/write roundtrip", () => {
  it("writeCache 후 readCache 로 동일한 데이터 반환", () => {
    const dir = tmpDir();
    const cachePath = path.join(dir, "cache.json");
    const cache = {
      configMtime: 42,
      checkedAt: 1000,
      ttlMs: 500,
      results: { a: { alive: true, ms: 10 } },
    };
    assert.equal(writeCache(cache, cachePath), true);
    const read = readCache(cachePath);
    assert.deepEqual(read, cache);
  });

  it("존재하지 않는 cache 파일은 null 반환", () => {
    const dir = tmpDir();
    const cachePath = path.join(dir, "missing.json");
    assert.equal(readCache(cachePath), null);
  });
});

describe("mcp-health — probeStdio", () => {
  it("valid MCP initialize 응답을 쓰는 프로세스는 alive 로 판정", async () => {
    const script = `
      let buf = '';
      process.stdin.on('data', (chunk) => {
        buf += chunk.toString();
        if (buf.includes('"method":"initialize"')) {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "1" } } }) + "\\n");
        }
      });
    `;
    const result = await probeStdio(
      { command: NODE_BIN, args: ["-e", script] },
      4000,
    );
    assert.equal(result.alive, true);
    assert.ok(result.ms < 4000);
  });

  it("응답 안 하면 timeout 으로 dead 판정", async () => {
    const script = `setInterval(() => {}, 10000);`; // never responds
    const result = await probeStdio(
      { command: NODE_BIN, args: ["-e", script] },
      500,
    );
    assert.equal(result.alive, false);
    assert.equal(result.reason, "timeout");
  });

  it("즉시 종료하는 프로세스는 exit reason 으로 dead 판정", async () => {
    const result = await probeStdio(
      { command: NODE_BIN, args: ["-e", "process.exit(3)"] },
      2000,
    );
    assert.equal(result.alive, false);
    assert.match(result.reason, /^(exit:3|signal:)/);
  });

  it("존재하지 않는 바이너리는 error reason 으로 dead 판정", async () => {
    const result = await probeStdio(
      { command: "this-binary-does-not-exist-xyz123", args: [] },
      1000,
    );
    assert.equal(result.alive, false);
    assert.match(result.reason, /^(error:|spawn:)/);
  });
});

describe("mcp-health — probeServer dispatch", () => {
  it("url 이 있으면 HTTP 로, command 가 있으면 stdio 로 분기한다", async () => {
    const noTransport = await probeServer({});
    assert.equal(noTransport.alive, false);
    assert.equal(noTransport.reason, "no-transport");
  });
});

describe("mcp-health — probeAll orchestration", () => {
  it("cache fresh 면 probe 스킵하고 cache 에서 반환", async () => {
    const dir = tmpDir();
    const configPath = path.join(dir, "config.toml");
    const cachePath = path.join(dir, "cache.json");
    writeFileSync(
      configPath,
      `[mcp_servers.alive-one]\ncommand = "${NODE_BIN.replace(/\\/g, "\\\\")}"\n`,
    );
    // Pre-seed cache with configMtime matching the file we just wrote.
    const { statSync } = await import("node:fs");
    const mtime = Math.floor(statSync(configPath).mtimeMs);
    writeCache(
      {
        configMtime: mtime,
        checkedAt: Date.now(),
        ttlMs: 60_000,
        results: { "alive-one": { alive: true, ms: 5 } },
      },
      cachePath,
    );
    const { results, source } = await probeAll({
      configPath,
      cachePath,
      names: ["alive-one"],
    });
    assert.equal(source, "cache");
    assert.deepEqual(results["alive-one"], { alive: true, ms: 5 });
  });

  it("cache 가 없으면 probe 실행하고 결과 저장", async () => {
    const dir = tmpDir();
    const configPath = path.join(dir, "config.toml");
    const cachePath = path.join(dir, "cache.json");
    // Use a command that exits instantly so probe returns fast.
    writeFileSync(
      configPath,
      `[mcp_servers.exits-fast]\ncommand = "${NODE_BIN.replace(/\\/g, "\\\\")}"\nargs = ["-e", "process.exit(0)"]\n`,
    );
    const { results, source } = await probeAll({
      configPath,
      cachePath,
      timeoutMs: 2000,
      useCache: false,
    });
    assert.equal(source, "probe");
    assert.equal(results["exits-fast"].alive, false);
    // Cache should have been written.
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.ok(cached.results["exits-fast"]);
  });
});

// Review finding A2 (commit 9298fd6 cross-review): 이전 구현은 status
// 2xx-4xx 를 전부 alive 로 간주해 404/401 응답도 healthy 로 오판. 이제는
// 200 + JSON-RPC envelope 둘 다 성립해야 alive 이며 나머지는 dead.
describe("mcp-health — probeHttp validation (A2 regression)", () => {
  function startMock(handler) {
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

  it("200 + valid JSON-RPC result 는 alive", async () => {
    const { server, url } = await startMock((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { protocolVersion: "2024-11-05" },
        }),
      );
    });
    try {
      const result = await probeHttp(url, 2000);
      assert.equal(result.alive, true);
    } finally {
      await close(server);
    }
  });

  it("404 는 dead (이전 구현은 alive 로 오판)", async () => {
    const { server, url } = await startMock((req, res) => {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<html>not found</html>");
    });
    try {
      const result = await probeHttp(url, 2000);
      assert.equal(result.alive, false);
      assert.match(result.reason, /^http:404/);
    } finally {
      await close(server);
    }
  });

  it("200 + non-JSON body 는 dead", async () => {
    const { server, url } = await startMock((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello world");
    });
    try {
      const result = await probeHttp(url, 2000);
      assert.equal(result.alive, false);
      assert.match(result.reason, /http:(no-jsonrpc-body|invalid-json)/);
    } finally {
      await close(server);
    }
  });

  it("200 + jsonrpc id 불일치 는 dead", async () => {
    const { server, url } = await startMock((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} }),
      );
    });
    try {
      const result = await probeHttp(url, 2000);
      assert.equal(result.alive, false);
      assert.equal(result.reason, "http:id-mismatch");
    } finally {
      await close(server);
    }
  });

  it("200 + result/error 둘 다 없으면 dead", async () => {
    const { server, url } = await startMock((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1 }));
    });
    try {
      const result = await probeHttp(url, 2000);
      assert.equal(result.alive, false);
      assert.equal(result.reason, "http:no-result");
    } finally {
      await close(server);
    }
  });

  it("SSE (data: prefix) 로 감싼 JSON-RPC envelope 도 인식", async () => {
    const { server, url } = await startMock((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n\n`,
      );
    });
    try {
      const result = await probeHttp(url, 2000);
      assert.equal(result.alive, true);
    } finally {
      await close(server);
    }
  });
});
