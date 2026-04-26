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

import {
  syncCodexHubUrl,
  syncHubMcpSettings,
  syncProjectMcpJson,
} from "../../scripts/sync-hub-mcp-settings.mjs";

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
  const originalUserprofile = process.env.USERPROFILE;
  const originalTestHome = process.env.TRIFLUX_TEST_HOME;
  let homeDir;

  function settingsPath(...segments) {
    return join(homeDir, ...segments);
  }

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "tfx-mcp-sync-"));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.TRIFLUX_TEST_HOME = homeDir;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserprofile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserprofile;
    }
    if (originalTestHome === undefined) {
      delete process.env.TRIFLUX_TEST_HOME;
    } else {
      process.env.TRIFLUX_TEST_HOME = originalTestHome;
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

  it("case 2: tfx-hub.url과 type이 이미 일치하면 skipped에 포함한다", async () => {
    const geminiPath = settingsPath(".gemini", "settings.json");
    writeJson(geminiPath, {
      mcpServers: {
        "tfx-hub": {
          url: HUB_URL,
          type: "http",
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
      type: "http",
    });
  });
});

describe("syncCodexHubUrl", () => {
  const originalHome = process.env.HOME;
  let homeDir;

  function codexPath(...segments) {
    return join(homeDir, ...segments);
  }

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "tfx-codex-sync-"));
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

  it("case 1: config.toml이 없으면 생성하지 않고 skip한다", async () => {
    const configPath = codexPath(".codex", "config.toml");
    const result = await syncCodexHubUrl({
      hubUrl: HUB_URL,
      codexConfigPath: configPath,
      logger: createLogger(),
    });

    assert.deepEqual(result.updated, []);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.skipped, [configPath]);
    assert.equal(existsSync(configPath), false);
  });

  it("case 2: tfx-hub.url이 이미 일치하면 skipped에 포함한다", async () => {
    const configPath = codexPath(".codex", "config.toml");
    writeRaw(
      configPath,
      `[mcp_servers.tfx-hub]\nurl = "${HUB_URL}"\nenabled = true\n`,
    );

    const before = readFileSync(configPath, "utf8");
    const result = await syncCodexHubUrl({
      hubUrl: HUB_URL,
      codexConfigPath: configPath,
      logger: createLogger(),
    });

    assert.deepEqual(result.updated, []);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.skipped, [configPath]);
    assert.equal(readFileSync(configPath, "utf8"), before);
  });

  it("case 3: tfx-hub.url이 다르면 해당 라인만 갱신하고 다른 설정은 보존한다", async () => {
    const configPath = codexPath(".codex", "config.toml");
    writeRaw(
      configPath,
      [
        "[mcp_servers.tfx-hub]",
        'url = "http://127.0.0.1:39999/mcp" # stale port',
        "enabled = true",
        "",
        "[profiles.default]",
        'model = "gpt-5.4"',
        "",
      ].join("\n"),
    );

    const result = await syncCodexHubUrl({
      hubUrl: HUB_URL,
      codexConfigPath: configPath,
      logger: createLogger(),
    });

    assert.deepEqual(result.updated, [configPath]);
    assert.deepEqual(result.errors, []);
    assert.equal(
      readFileSync(configPath, "utf8"),
      [
        "[mcp_servers.tfx-hub]",
        `url = "${HUB_URL}" # stale port`,
        "enabled = true",
        "",
        "[profiles.default]",
        'model = "gpt-5.4"',
        "",
      ].join("\n"),
    );
  });

  it("case 4: dryRun=true면 updated에는 포함되지만 파일은 실제로 바뀌지 않는다", async () => {
    const configPath = codexPath(".codex", "config.toml");
    writeRaw(
      configPath,
      `[mcp_servers.tfx-hub]\nurl = "http://127.0.0.1:18888/mcp"\n`,
    );

    const before = readFileSync(configPath, "utf8");
    const result = await syncCodexHubUrl({
      hubUrl: HUB_URL,
      codexConfigPath: configPath,
      dryRun: true,
      logger: createLogger(),
    });

    assert.deepEqual(result.updated, [configPath]);
    assert.deepEqual(result.errors, []);
    assert.equal(readFileSync(configPath, "utf8"), before);
  });

  it("case 5: tfx-hub 섹션이 없으면 Codex 단독 시작을 위해 생성한다", async () => {
    const configPath = codexPath(".codex", "config.toml");
    writeRaw(
      configPath,
      `[mcp_servers.other]\nurl = "http://127.0.0.1:3000/mcp"\n`,
    );

    const result = await syncCodexHubUrl({
      hubUrl: HUB_URL,
      codexConfigPath: configPath,
      logger: createLogger(),
    });

    assert.deepEqual(result.updated, [configPath]);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.skipped, []);
    assert.equal(
      readFileSync(configPath, "utf8"),
      [
        "[mcp_servers.other]",
        'url = "http://127.0.0.1:3000/mcp"',
        "",
        "[mcp_servers.tfx-hub]",
        `url = "${HUB_URL}"`,
        "",
      ].join("\n"),
    );
  });

  it("case 6: tfx-hub.url 라인이 없으면 errors에 기록하고 원본 파일을 보존한다", async () => {
    const configPath = codexPath(".codex", "config.toml");
    writeRaw(configPath, `[mcp_servers.tfx-hub]\nenabled = true\n`);

    const before = readFileSync(configPath, "utf8");
    const result = await syncCodexHubUrl({
      hubUrl: HUB_URL,
      codexConfigPath: configPath,
      logger: createLogger(),
    });

    assert.deepEqual(result.updated, []);
    assert.deepEqual(result.errors, [
      { path: configPath, reason: "missing tfx-hub url" },
    ]);
    assert.deepEqual(result.skipped, []);
    assert.equal(readFileSync(configPath, "utf8"), before);
  });
});

describe("syncProjectMcpJson", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "tfx-project-mcp-sync-"));
  });

  afterEach(() => {
    if (projectRoot && existsSync(projectRoot)) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("case 1: tfx-hub.url이 다르면 updated에 포함되고 파일이 실제로 바뀐다", async () => {
    const projectMcpPath = join(projectRoot, ".claude", "mcp.json");
    const rootMcpPath = join(projectRoot, ".mcp.json");
    writeJson(projectMcpPath, {
      mcpServers: {
        "tfx-hub": {
          type: "url",
          url: "http://127.0.0.1:39999/mcp",
        },
      },
    });

    const result = await syncProjectMcpJson({
      hubUrl: HUB_URL,
      projectRoot,
      logger: createLogger(),
    });

    assert.deepEqual(result.updated, [projectMcpPath]);
    assert.deepEqual(result.skipped, [rootMcpPath]);
    assert.deepEqual(result.errors, []);
    assert.equal(
      JSON.parse(readFileSync(projectMcpPath, "utf8")).mcpServers["tfx-hub"]
        .url,
      HUB_URL,
    );
  });

  it("case 2: url이 같아도 type이 legacy(url)이면 type:http로 rewrite한다", async () => {
    // Claude Code 현재 스키마는 type:"http" 만 허용. 과거 type:"url" 는 parse 실패
    // → MCP 전체 단절. url 일치만으로 skip 하면 legacy 가 영원히 안 고쳐짐.
    const projectMcpPath = join(projectRoot, ".claude", "mcp.json");
    const rootMcpPath = join(projectRoot, ".mcp.json");
    writeJson(projectMcpPath, {
      mcpServers: {
        "tfx-hub": {
          type: "url",
          url: HUB_URL,
        },
      },
    });

    const result = await syncProjectMcpJson({
      hubUrl: HUB_URL,
      projectRoot,
      logger: createLogger(),
    });

    assert.deepEqual(result.updated, [projectMcpPath]);
    assert.deepEqual(result.skipped, [rootMcpPath]);
    assert.deepEqual(result.errors, []);
    const after = JSON.parse(readFileSync(projectMcpPath, "utf8"));
    assert.equal(after.mcpServers["tfx-hub"].type, "http");
    assert.equal(after.mcpServers["tfx-hub"].url, HUB_URL);
  });

  it("case 2b: type:http + 동일 url이면 skipped에 포함한다 (true idempotent)", async () => {
    const projectMcpPath = join(projectRoot, ".claude", "mcp.json");
    const rootMcpPath = join(projectRoot, ".mcp.json");
    writeJson(projectMcpPath, {
      mcpServers: {
        "tfx-hub": {
          type: "http",
          url: HUB_URL,
        },
      },
    });

    const before = readFileSync(projectMcpPath, "utf8");
    const result = await syncProjectMcpJson({
      hubUrl: HUB_URL,
      projectRoot,
      logger: createLogger(),
    });

    assert.deepEqual(result.updated, []);
    assert.deepEqual(result.skipped, [projectMcpPath, rootMcpPath]);
    assert.deepEqual(result.errors, []);
    assert.equal(readFileSync(projectMcpPath, "utf8"), before);
  });

  it("case 3: 파일이 없으면 생성하지 않고 skipped에 포함한다", async () => {
    const projectMcpPath = join(projectRoot, ".claude", "mcp.json");
    const rootMcpPath = join(projectRoot, ".mcp.json");

    const result = await syncProjectMcpJson({
      hubUrl: HUB_URL,
      projectRoot,
      logger: createLogger(),
    });

    assert.deepEqual(result.updated, []);
    assert.deepEqual(result.skipped, [projectMcpPath, rootMcpPath]);
    assert.deepEqual(result.errors, []);
    assert.equal(existsSync(projectMcpPath), false);
    assert.equal(existsSync(rootMcpPath), false);
  });

  it("case 4: tfx-hub 키가 없으면 생성하지 않고 skipped에 포함한다", async () => {
    const projectMcpPath = join(projectRoot, ".claude", "mcp.json");
    const rootMcpPath = join(projectRoot, ".mcp.json");
    writeJson(projectMcpPath, {
      mcpServers: {
        other: {
          url: "http://127.0.0.1:3000/mcp",
        },
      },
    });

    const before = readFileSync(projectMcpPath, "utf8");
    const result = await syncProjectMcpJson({
      hubUrl: HUB_URL,
      projectRoot,
      logger: createLogger(),
    });

    assert.deepEqual(result.updated, []);
    assert.deepEqual(result.skipped, [projectMcpPath, rootMcpPath]);
    assert.deepEqual(result.errors, []);
    assert.equal(readFileSync(projectMcpPath, "utf8"), before);
  });

  it("case 5: root-level .mcp.json 만 있을 때도 sync 된다 (#152)", async () => {
    // Claude Code 는 `.mcp.json` (root) 과 `.claude/mcp.json` 두 곳을 모두 읽는다.
    // 과거 구현은 `.claude/mcp.json` 만 봐서 research-fold7-terminal 처럼 root-only
    // 레이아웃은 sync 가 작동하지 않았음. 이제 둘 다 처리한다.
    const projectMcpPath = join(projectRoot, ".claude", "mcp.json");
    const rootMcpPath = join(projectRoot, ".mcp.json");
    writeJson(rootMcpPath, {
      mcpServers: {
        "tfx-hub": {
          type: "url",
          url: "http://127.0.0.1:39999/mcp",
        },
      },
    });

    const result = await syncProjectMcpJson({
      hubUrl: HUB_URL,
      projectRoot,
      logger: createLogger(),
    });

    assert.deepEqual(result.updated, [rootMcpPath]);
    assert.deepEqual(result.skipped, [projectMcpPath]);
    assert.deepEqual(result.errors, []);
    const after = JSON.parse(readFileSync(rootMcpPath, "utf8"));
    assert.equal(after.mcpServers["tfx-hub"].type, "http");
    assert.equal(after.mcpServers["tfx-hub"].url, HUB_URL);
  });

  it("case 6: 두 경로 모두 있으면 둘 다 업데이트된다 (#152)", async () => {
    const projectMcpPath = join(projectRoot, ".claude", "mcp.json");
    const rootMcpPath = join(projectRoot, ".mcp.json");
    writeJson(projectMcpPath, {
      mcpServers: {
        "tfx-hub": {
          type: "url",
          url: "http://127.0.0.1:39999/mcp",
        },
      },
    });
    writeJson(rootMcpPath, {
      mcpServers: {
        "tfx-hub": {
          type: "url",
          url: "http://127.0.0.1:39999/mcp",
        },
      },
    });

    const result = await syncProjectMcpJson({
      hubUrl: HUB_URL,
      projectRoot,
      logger: createLogger(),
    });

    assert.deepEqual(result.updated, [projectMcpPath, rootMcpPath]);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.errors, []);
    assert.equal(
      JSON.parse(readFileSync(projectMcpPath, "utf8")).mcpServers["tfx-hub"]
        .url,
      HUB_URL,
    );
    assert.equal(
      JSON.parse(readFileSync(rootMcpPath, "utf8")).mcpServers["tfx-hub"].url,
      HUB_URL,
    );
  });

  // Issue #155 — commit 657771a cross-review low finding (Codex). for-of + try/catch
  // 구조가 실제로 per-file 격리를 보장하는지 테스트로 고정한다.
  it("case 7: 한 경로 invalid JSON 이어도 다른 경로는 정상 처리 (per-file 격리)", async () => {
    const projectMcpPath = join(projectRoot, ".claude", "mcp.json");
    const rootMcpPath = join(projectRoot, ".mcp.json");
    // .claude/mcp.json 은 깨진 JSON — 이 파일 때문에 .mcp.json 처리가 막히면 안 됨.
    writeRaw(projectMcpPath, "{ invalid json");
    writeJson(rootMcpPath, {
      mcpServers: {
        "tfx-hub": {
          type: "url",
          url: "http://127.0.0.1:39999/mcp",
        },
      },
    });

    const result = await syncProjectMcpJson({
      hubUrl: HUB_URL,
      projectRoot,
      logger: createLogger(),
    });

    // rootMcpPath 는 성공적으로 업데이트, projectMcpPath 는 errors 에 기록.
    assert.deepEqual(result.updated, [rootMcpPath]);
    assert.deepEqual(result.errors, [
      { path: projectMcpPath, reason: "invalid json" },
    ]);
    assert.deepEqual(result.skipped, []);

    // 깨진 파일은 보존 (rewrite 시도 없음).
    assert.equal(readFileSync(projectMcpPath, "utf8"), "{ invalid json");
    // 정상 경로는 type:http + 새 url 로 rewrite.
    const after = JSON.parse(readFileSync(rootMcpPath, "utf8"));
    assert.equal(after.mcpServers["tfx-hub"].type, "http");
    assert.equal(after.mcpServers["tfx-hub"].url, HUB_URL);
  });

  it("case 8: 동기화된 상태에서 연속 2회 호출해도 updated 0 유지 (idempotent)", async () => {
    const projectMcpPath = join(projectRoot, ".claude", "mcp.json");
    const rootMcpPath = join(projectRoot, ".mcp.json");
    // 두 경로 모두 이미 정상 상태 (type:http + 같은 url).
    const canonicalEntry = {
      mcpServers: {
        "tfx-hub": {
          type: "http",
          url: HUB_URL,
        },
      },
    };
    writeJson(projectMcpPath, canonicalEntry);
    writeJson(rootMcpPath, canonicalEntry);

    const before = {
      project: readFileSync(projectMcpPath, "utf8"),
      root: readFileSync(rootMcpPath, "utf8"),
    };

    const first = await syncProjectMcpJson({
      hubUrl: HUB_URL,
      projectRoot,
      logger: createLogger(),
    });
    assert.deepEqual(first.updated, []);
    assert.deepEqual(first.skipped, [projectMcpPath, rootMcpPath]);
    assert.deepEqual(first.errors, []);

    const second = await syncProjectMcpJson({
      hubUrl: HUB_URL,
      projectRoot,
      logger: createLogger(),
    });
    // 2회차도 동일하게 skipped — 진짜 idempotent.
    assert.deepEqual(second.updated, []);
    assert.deepEqual(second.skipped, [projectMcpPath, rootMcpPath]);
    assert.deepEqual(second.errors, []);

    // 파일도 byte-for-byte 동일.
    assert.equal(readFileSync(projectMcpPath, "utf8"), before.project);
    assert.equal(readFileSync(rootMcpPath, "utf8"), before.root);
  });
});
