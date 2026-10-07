import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const TRIFLUX_BIN = join(PROJECT_ROOT, "bin", "triflux.mjs");
const START_FIXTURE = join(
  __dirname,
  "../fixtures/hub-start-config-preload.cjs",
);
const execFileAsync = promisify(execFile);

function makeIsolatedHome(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, ".claude", "cache", "tfx-hub"), { recursive: true });
  mkdirSync(join(root, ".codex"), { recursive: true });
  return root;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function runHubStart(
  homeDir,
  port,
  { passPortArg = true, simulateStartup = false } = {},
) {
  return execFileAsync(
    process.execPath,
    [
      "--require",
      START_FIXTURE,
      TRIFLUX_BIN,
      "hub",
      "start",
      ...(passPortArg ? ["--port", String(port)] : []),
    ],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      timeout: 20000,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        CODEX_HOME: join(homeDir, ".codex"),
        XDG_CONFIG_HOME: join(homeDir, ".config"),
        TRIFLUX_TEST_HOME: homeDir,
        TFX_CODEX_CONFIG_SYNC: "1",
        TFX_HUB_PORT: String(port),
        TFX_HUB_PID_DIR: join(homeDir, ".claude", "cache", "tfx-hub"),
        TFX_HUB_STATE_DIR: join(homeDir, ".claude", "cache", "tfx-hub"),
        TFX_TEST_HUB_START_PORT: simulateStartup ? String(port) : "",
      },
    },
  );
}

describe("tfx hub start re-enables Codex MCP config", () => {
  it("hub already running path should still flip tfx-hub back to enabled", async () => {
    const homeDir = makeIsolatedHome("tfx-hub-codex-");
    const configPath = join(homeDir, ".codex", "config.json");
    const server = createServer((req, res) => {
      assert.equal(req.url, "/status");
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          hub: {},
          pid: process.pid,
          port: server.address().port,
        }),
      );
    });

    try {
      // 확인한 포트를 닫지 않고 유지해 재바인딩 경쟁을 없앤다.
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const port = server.address().port;
      writeFileSync(
        join(homeDir, ".claude", "cache", "tfx-hub", "hub.pid"),
        JSON.stringify({ pid: process.pid, port, host: "127.0.0.1" }),
      );
      const { stdout } = await runHubStart(homeDir, port);
      assert.match(stdout, /hub 이미 실행 중/);

      let config = readJson(configPath);
      assert.equal(config.mcpServers["tfx-hub"].enabled, true);
      assert.equal(
        config.mcpServers["tfx-hub"].url,
        `http://127.0.0.1:${port}/mcp`,
      );

      config.mcpServers["tfx-hub"].enabled = false;
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
      await runHubStart(homeDir, port);

      config = readJson(configPath);
      assert.equal(config.mcpServers["tfx-hub"].enabled, true);
      assert.equal(
        config.mcpServers["tfx-hub"].url,
        `http://127.0.0.1:${port}/mcp`,
      );
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("hub start without --port should honor TFX_HUB_PORT", async () => {
    const homeDir = makeIsolatedHome("tfx-hub-env-port-");
    const port = 43127;
    const configPath = join(homeDir, ".codex", "config.json");

    try {
      // 서버 기동만 대역으로 바꾸고 CLI의 포트 전달과 설정 기록은 실제 실행한다.
      const { stdout } = await runHubStart(homeDir, port, {
        passPortArg: false,
        simulateStartup: true,
      });
      assert.match(stdout, /tfx-hub 시작/);

      const config = readJson(configPath);
      assert.equal(config.mcpServers["tfx-hub"].enabled, true);
      assert.equal(
        config.mcpServers["tfx-hub"].url,
        `http://127.0.0.1:${port}/mcp`,
      );
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
