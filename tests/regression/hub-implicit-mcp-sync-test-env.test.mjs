import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

async function getUnusedPort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function readHubUrl(settingsPath) {
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  return settings.mcpServers["tfx-hub"].url;
}

test("startHub does not rewrite user MCP settings in protected test environments", async () => {
  const tempHome = mkdtempSync(join(tmpdir(), "triflux-hub-mcp-home-"));
  const dbDir = mkdtempSync(join(tmpdir(), "triflux-hub-mcp-db-"));
  const settingsPath = join(tempHome, ".gemini", "settings.json");
  const oldEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    NODE_ENV: process.env.NODE_ENV,
    TFX_TEST: process.env.TFX_TEST,
  };
  let hub;

  try {
    mkdirSync(join(tempHome, ".gemini"), { recursive: true });
    writeFileSync(
      settingsPath,
      `${JSON.stringify(
        {
          mcpServers: {
            "tfx-hub": {
              type: "http",
              url: "http://127.0.0.1:27888/mcp",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.NODE_ENV = "test";
    process.env.TFX_TEST = "1";

    const before = readHubUrl(settingsPath);
    const { startHub } = await import("../../hub/server.mjs");
    const port = await getUnusedPort();
    hub = await startHub({
      port,
      host: "127.0.0.1",
      dbPath: join(dbDir, "hub.db"),
    });

    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(readHubUrl(settingsPath), before);
  } finally {
    if (hub?.stop) await hub.stop();
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});
