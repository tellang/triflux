import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const TRIFLUX_BIN = join(PROJECT_ROOT, "bin", "triflux.mjs");
const SLEEP_SAB = new Int32Array(new SharedArrayBuffer(4));

function makeIsolatedHome(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, ".claude"), { recursive: true });
  mkdirSync(join(root, ".codex"), { recursive: true });
  return root;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sleepMs(ms) {
  Atomics.wait(SLEEP_SAB, 0, 0, ms);
}

function runHubStart(homeDir, port, { passPortArg = true } = {}) {
  return execFileSync(
    process.execPath,
    [
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
        TFX_CODEX_CONFIG_SYNC: "1",
        TFX_HUB_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function stopHubFromPidFile(homeDir) {
  const pidPath = join(homeDir, ".claude", "cache", "tfx-hub", "hub.pid");
  if (!existsSync(pidPath)) return;

  try {
    const info = readJson(pidPath);
    if (Number.isFinite(info?.pid)) {
      for (const signal of ["SIGTERM", "SIGKILL"]) {
        try {
          process.kill(info.pid, signal);
        } catch {}
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          try {
            process.kill(info.pid, 0);
            sleepMs(100);
          } catch {
            return;
          }
        }
      }
    }
  } catch {
    // best-effort cleanup only
  }
}

describe("tfx hub start re-enables Codex MCP config", () => {
  it("hub already running path should still flip tfx-hub back to enabled", () => {
    const homeDir = makeIsolatedHome("tfx-hub-codex-");
    const port = 28180 + Math.floor(Math.random() * 50);
    const configPath = join(homeDir, ".codex", "config.json");

    try {
      runHubStart(homeDir, port);

      let config = readJson(configPath);
      assert.equal(config.mcpServers["tfx-hub"].enabled, true);
      assert.equal(
        config.mcpServers["tfx-hub"].url,
        `http://127.0.0.1:${port}/mcp`,
      );

      config.mcpServers["tfx-hub"].enabled = false;
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");

      runHubStart(homeDir, port);

      config = readJson(configPath);
      assert.equal(config.mcpServers["tfx-hub"].enabled, true);
      assert.equal(
        config.mcpServers["tfx-hub"].url,
        `http://127.0.0.1:${port}/mcp`,
      );
    } finally {
      stopHubFromPidFile(homeDir);
      try {
        rmSync(homeDir, { recursive: true, force: true });
      } catch {
        // Windows may keep a transient handle on the temp home for a short time.
      }
    }
  });

  it("hub start without --port should honor TFX_HUB_PORT", () => {
    const homeDir = makeIsolatedHome("tfx-hub-env-port-");
    const port = 28230 + Math.floor(Math.random() * 50);
    const configPath = join(homeDir, ".codex", "config.json");

    try {
      runHubStart(homeDir, port, { passPortArg: false });

      const config = readJson(configPath);
      assert.equal(config.mcpServers["tfx-hub"].enabled, true);
      assert.equal(
        config.mcpServers["tfx-hub"].url,
        `http://127.0.0.1:${port}/mcp`,
      );
    } finally {
      stopHubFromPidFile(homeDir);
      try {
        rmSync(homeDir, { recursive: true, force: true });
      } catch {
        // Windows may keep a transient handle on the temp home for a short time.
      }
    }
  });
});
