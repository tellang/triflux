import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { resolveHubPort } from "../../hub/server.mjs";
import { syncCodexHubUrl } from "../../scripts/sync-hub-mcp-settings.mjs";

const DEFAULT_CODEX_HUB_URL = "http://127.0.0.1:27888/mcp";

function createLogger() {
  return {
    info() {},
    debug() {},
    error() {},
  };
}

function writeConfig(filePath, url) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `[mcp_servers.tfx-hub]\nurl = "${url}"\n`, "utf8");
}

describe("codex config MCP port stability", () => {
  const originalEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    TRIFLUX_TEST_HOME: process.env.TRIFLUX_TEST_HOME,
    TFX_HUB_PORT: process.env.TFX_HUB_PORT,
  };
  let homeDir;
  let configPath;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "tfx-codex-port-stable-"));
    configPath = join(homeDir, ".codex", "config.toml");
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.TRIFLUX_TEST_HOME = homeDir;
    delete process.env.TFX_HUB_PORT;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("skips Codex config writes when startup reports a non-default hub port but config is already 27888", async () => {
    writeConfig(configPath, DEFAULT_CODEX_HUB_URL);
    const beforeRaw = readFileSync(configPath, "utf8");
    const beforeStat = statSync(configPath);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await syncCodexHubUrl({
        hubUrl: "http://127.0.0.1:29059/mcp",
        codexConfigPath: configPath,
        logger: createLogger(),
      });
      assert.deepEqual(result.updated, []);
      assert.deepEqual(result.skipped, [configPath]);
      assert.deepEqual(result.errors, []);
    }

    const afterStat = statSync(configPath);
    assert.equal(readFileSync(configPath, "utf8"), beforeRaw);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
  });

  it("heals stale Codex tfx-hub ports back to the default URL instead of persisting the runtime port", async () => {
    writeConfig(configPath, "http://127.0.0.1:29059/mcp");

    const result = await syncCodexHubUrl({
      hubUrl: "http://127.0.0.1:29059/mcp",
      codexConfigPath: configPath,
      logger: createLogger(),
    });

    assert.deepEqual(result.updated, [configPath]);
    assert.equal(
      readFileSync(configPath, "utf8"),
      `[mcp_servers.tfx-hub]\nurl = "${DEFAULT_CODEX_HUB_URL}"\n`,
    );
  });

  it("does not reuse live pid-file ports as the hub start target", () => {
    const livePeer = {
      alive: true,
      pid: process.pid,
      port: 29059,
      host: "127.0.0.1",
      url: "http://127.0.0.1:29059/mcp",
      reason: "alive",
    };

    assert.equal(resolveHubPort({}, { detectPeer: () => livePeer }), 27888);
  });
});
