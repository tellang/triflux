import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const TFX_BIN = join(REPO_ROOT, "bin", "triflux.mjs");

function createFixture(name) {
  const root = join(
    tmpdir(),
    `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(project, { recursive: true });
  return { root, home, project };
}

function writeRegistry(filePath, home, project, server) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    JSON.stringify(
      {
        version: 1,
        defaults: {
          transport: "hub-url",
          hub_base: "http://127.0.0.1:27888",
        },
        servers: {
          "tfx-hub": {
            transport: "hub-url",
            url: "http://127.0.0.1:27888/mcp",
            safe: true,
            targets: ["codex", "claude"],
            description: "triflux Hub MCP 서버",
          },
          ...(server ? { auth: { safe: true, ...server } } : {}),
        },
        policies: {
          stdio_action: "replace-with-hub",
          watched_paths: [
            join(home, ".codex", "config.toml"),
            join(project, ".mcp.json"),
          ],
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

function runTfx(args, env, cwd) {
  return execFileSync(process.execPath, [TFX_BIN, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

describe("tfx mcp HTTP headers regression", () => {
  it("syncs HTTP headers and reports header status without leaking secrets", () => {
    const { root, home, project } = createFixture("tfx-mcp-http-headers");
    const registryPath = join(root, "mcp-registry.json");
    writeRegistry(registryPath, home, project, {
      transport: "http",
      url: "https://example.com/mcp",
      targets: ["codex", "claude"],
      headers: {
        Authorization: { env: "TFX_TEST_TOKEN", prefix: "Bearer " },
        "X-Client": { value: "triflux" },
      },
    });

    const env = {
      HOME: home,
      USERPROFILE: home,
      TFX_CODEX_CONFIG_SYNC: "1",
      TFX_MCP_REGISTRY_PATH: registryPath,
      TFX_TEST_TOKEN: "regression-secret",
    };

    const syncResult = JSON.parse(
      runTfx(["mcp", "sync", "--json"], env, project),
    );
    assert.ok(syncResult.actions.length >= 2);

    const codexToml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    assert.match(codexToml, /\[mcp_servers\.tfx-hub\]/);
    assert.match(codexToml, /url = "http:\/\/127\.0\.0\.1:27888\/mcp"/);
    assert.match(codexToml, /\[mcp_servers\.auth\]/);
    assert.match(codexToml, /bearer_token_env_var = "TFX_TEST_TOKEN"/);
    assert.doesNotMatch(codexToml, /regression-secret/);

    const projectConfig = JSON.parse(
      readFileSync(join(project, ".mcp.json"), "utf8"),
    );
    assert.deepEqual(projectConfig.mcpServers["tfx-hub"], {
      type: "http",
      url: "http://127.0.0.1:27888/mcp",
    });
    assert.equal(
      projectConfig.mcpServers.auth.headers.Authorization,
      "Bearer regression-secret",
    );

    const listResultRaw = runTfx(["mcp", "list", "--json"], env, project);
    assert.doesNotMatch(listResultRaw, /regression-secret/);
    const listResult = JSON.parse(listResultRaw);
    const authRows = listResult.rows.filter((row) => row.name === "auth");
    assert.ok(authRows.length >= 2);
    assert.ok(authRows.every((row) => row.headerStatus === "ok"));
    assert.ok(
      authRows.every((row) =>
        row.expectedHeaderNames.includes("Authorization"),
      ),
    );
  });

  it("keeps existing tfx-hub URL-only sync unchanged", () => {
    const { root, home, project } = createFixture("tfx-mcp-hub-url-only");
    const registryPath = join(root, "mcp-registry.json");
    writeRegistry(registryPath, home, project, null);

    const env = {
      HOME: home,
      USERPROFILE: home,
      TFX_CODEX_CONFIG_SYNC: "1",
      TFX_MCP_REGISTRY_PATH: registryPath,
    };

    runTfx(["mcp", "sync", "--json"], env, project);

    assert.equal(
      readFileSync(join(home, ".codex", "config.toml"), "utf8"),
      '[mcp_servers.tfx-hub]\nurl = "http://127.0.0.1:27888/mcp"\n',
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8")).mcpServers[
        "tfx-hub"
      ],
      {
        type: "http",
        url: "http://127.0.0.1:27888/mcp",
      },
    );
  });
});
