import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { syncHubMcpSettings } from "../../scripts/sync-hub-mcp-settings.mjs";

const HUB_URL = "http://127.0.0.1:27888/mcp";

function createLogger() {
  return {
    info() {},
    debug() {},
    error() {},
  };
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeRaw(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, "utf8");
}

describe("sync-hub-mcp-settings", () => {
  const originalHome = process.env.HOME;
  let homeDir;

  function settingsPath(...segments) {
    return join(homeDir, ...segments);
  }

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "tfx-mcp-sync-"));
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    if (homeDir && existsSync(homeDir)) {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("case 1: 대상 settings 파일이 없으면 생성하지 않고 skip한다", async () => {
    const result = await syncHubMcpSettings({
      hubUrl: HUB_URL,
      logger: createLogger(),
    });

    assert.deepEqual(result.updated, []);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.skipped, [
      settingsPath(".gemini", "settings.json"),
      settingsPath(".claude", "settings.json"),
      settingsPath(".claude", "settings.local.json"),
    ]);
  });

  it("case 2: tfx-hub.url이 이미 일치하면 skipped에 포함한다", async () => {
    const geminiPath = settingsPath(".gemini", "settings.json");
    writeJson(geminiPath, {
      mcpServers: {
        "tfx-hub": {
          url: HUB_URL,
          enabled: false,
        },
      },
    });

    const result = await syncHubMcpSettings({
      hubUrl: HUB_URL,
      logger: createLogger(),
    });

    assert.deepEqual(result.updated, []);
    assert.deepEqual(result.errors, []);
    assert.ok(result.skipped.includes(geminiPath));
    assert.equal(
      JSON.parse(readFileSync(geminiPath, "utf8")).mcpServers["tfx-hub"].url,
      HUB_URL,
    );
  });

  it("case 3: tfx-hub.url이 다르면 updated에 포함되고 파일이 실제로 바뀐다", async () => {
    const geminiPath = settingsPath(".gemini", "settings.json");
    writeJson(geminiPath, {
      mcpServers: {
        "tfx-hub": {
          url: "http://127.0.0.1:39999/mcp",
        },
      },
    });

    const result = await syncHubMcpSettings({
      hubUrl: HUB_URL,
      logger: createLogger(),
    });

    assert.deepEqual(result.updated, [geminiPath]);
    assert.deepEqual(result.errors, []);
    assert.equal(
      JSON.parse(readFileSync(geminiPath, "utf8")).mcpServers["tfx-hub"].url,
      HUB_URL,
    );
    assert.ok(readFileSync(geminiPath, "utf8").endsWith("\n"));
  });

  it("case 4: 다른 MCP 서버가 있어도 tfx-hub만 수정하고 나머지는 보존한다", async () => {
    const claudePath = settingsPath(".claude", "settings.json");
    writeJson(claudePath, {
      mcpServers: {
        other: {
          url: "http://127.0.0.1:4000/mcp",
          enabled: true,
        },
        "tfx-hub": {
          url: "http://127.0.0.1:49999/mcp",
          enabled: false,
        },
      },
      profile: "keep-me",
    });

    const result = await syncHubMcpSettings({
      hubUrl: HUB_URL,
      logger: createLogger(),
    });

    assert.ok(result.updated.includes(claudePath));
    const next = JSON.parse(readFileSync(claudePath, "utf8"));
    assert.deepEqual(next.mcpServers.other, {
      url: "http://127.0.0.1:4000/mcp",
      enabled: true,
    });
    assert.equal(next.mcpServers["tfx-hub"].url, HUB_URL);
    assert.equal(next.profile, "keep-me");
  });

  it("case 5: invalid JSON이면 errors에 기록하고 원본 파일을 보존한다", async () => {
    const claudePath = settingsPath(".claude", "settings.json");
    const original = "{ invalid json\n";
    writeRaw(claudePath, original);

    const result = await syncHubMcpSettings({
      hubUrl: HUB_URL,
      logger: createLogger(),
    });

    assert.deepEqual(result.updated, []);
    assert.deepEqual(result.errors, [
      { path: claudePath, reason: "invalid json" },
    ]);
    assert.equal(readFileSync(claudePath, "utf8"), original);
  });

  it("case 6: dryRun=true면 updated에는 포함되지만 파일은 실제로 바뀌지 않는다", async () => {
    const claudeLocalPath = settingsPath(".claude", "settings.local.json");
    writeJson(claudeLocalPath, {
      mcpServers: {
        "tfx-hub": {
          url: "http://127.0.0.1:18888/mcp",
        },
      },
    });

    const before = readFileSync(claudeLocalPath, "utf8");
    const result = await syncHubMcpSettings({
      hubUrl: HUB_URL,
      dryRun: true,
      logger: createLogger(),
    });

    assert.deepEqual(result.updated, [claudeLocalPath]);
    assert.equal(readFileSync(claudeLocalPath, "utf8"), before);
  });

  it("case 7: mcpServers는 있지만 tfx-hub 엔트리가 없으면 생성하지 않고 skip한다", async () => {
    const geminiPath = settingsPath(".gemini", "settings.json");
    writeJson(geminiPath, {
      mcpServers: {
        other: {
          url: "http://127.0.0.1:3000/mcp",
        },
      },
    });

    const before = readFileSync(geminiPath, "utf8");
    const result = await syncHubMcpSettings({
      hubUrl: HUB_URL,
      logger: createLogger(),
    });

    assert.deepEqual(result.updated, []);
    assert.deepEqual(result.errors, []);
    assert.ok(result.skipped.includes(geminiPath));
    assert.equal(readFileSync(geminiPath, "utf8"), before);
  });

  it("case 8: tfx-hub의 다른 필드(enabled, trust 등)는 보존한다", async () => {
    const claudePath = settingsPath(".claude", "settings.json");
    writeJson(claudePath, {
      mcpServers: {
        "tfx-hub": {
          url: "http://127.0.0.1:45555/mcp",
          enabled: true,
          trust: ["project-a"],
          timeout: 15000,
        },
      },
    });

    const result = await syncHubMcpSettings({
      hubUrl: HUB_URL,
      logger: createLogger(),
    });

    assert.deepEqual(result.updated, [claudePath]);
    assert.deepEqual(result.errors, []);

    const next = JSON.parse(readFileSync(claudePath, "utf8"));
    assert.deepEqual(next.mcpServers["tfx-hub"], {
      url: HUB_URL,
      enabled: true,
      trust: ["project-a"],
      timeout: 15000,
    });
  });
});
