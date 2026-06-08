import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");

// dynamic import to pick up fresh module state
const {
  detectDevMode,
  SYNC_MAP,
  BREADCRUMB_PATH,
  ensureHooksInSettings,
  ensureCodexHubServerConfig,
  isSetupUserStateFile,
  SETUP_USER_STATE_FILES,
  getWorkerPackageSyncEntries,
  syncWorkerPackages,
} = await import("../../scripts/setup.mjs");

// ── helpers ──

const TMP_DIR = join(PROJECT_ROOT, "tests", ".tmp-setup-sync");

function ensureTmpDir() {
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
}

function cleanTmpDir() {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
}

// ── tests ──

describe("setup-sync: detectDevMode", () => {
  before(ensureTmpDir);
  after(cleanTmpDir);

  it(".git 디렉토리가 존재하면 true를 반환한다", () => {
    const fakeRoot = join(TMP_DIR, "with-git");
    mkdirSync(join(fakeRoot, ".git"), { recursive: true });
    assert.equal(detectDevMode(fakeRoot), true);
  });

  it(".git 디렉토리가 없으면 false를 반환한다", () => {
    const fakeRoot = join(TMP_DIR, "without-git");
    mkdirSync(fakeRoot, { recursive: true });
    assert.equal(detectDevMode(fakeRoot), false);
  });
});

describe("setup-sync: BREADCRUMB_PATH", () => {
  it("breadcrumb 경로는 ~/.claude/scripts/.tfx-pkg-root 형식이다", () => {
    // BREADCRUMB_PATH는 절대 경로
    assert.ok(BREADCRUMB_PATH.length > 0, "BREADCRUMB_PATH must not be empty");
    // .claude/scripts/.tfx-pkg-root 패턴 확인 (OS 구분자 무관)
    const normalized = BREADCRUMB_PATH.replace(/\\/g, "/");
    assert.ok(
      normalized.endsWith(".claude/scripts/.tfx-pkg-root"),
      `Expected path ending with .claude/scripts/.tfx-pkg-root, got: ${normalized}`,
    );
  });
});

describe("setup-sync: --sync 플래그 파싱", () => {
  it("--sync 플래그 전달 시 [sync] 메시지를 출력한다", () => {
    const result = execFileSync(
      process.execPath,
      [join(PROJECT_ROOT, "scripts", "setup.mjs"), "--sync"],
      {
        timeout: 15000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.ok(
      result.includes("[sync]"),
      `Expected [sync] in output, got: ${result}`,
    );
  });

  it("--sync 플래그 없이 실행 시 [sync] 메시지가 출력되지 않는다", () => {
    const result = execFileSync(
      process.execPath,
      [join(PROJECT_ROOT, "scripts", "setup.mjs")],
      {
        timeout: 15000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.ok(
      !result.includes("[sync]"),
      `Expected no [sync] in output, got: ${result}`,
    );
  });
});

describe("setup-sync: SYNC_MAP", () => {
  it("SYNC_MAP은 최소 3개 항목을 포함한다", () => {
    assert.ok(Array.isArray(SYNC_MAP), "SYNC_MAP must be an array");
    assert.ok(
      SYNC_MAP.length >= 3,
      `Expected >= 3 entries, got ${SYNC_MAP.length}`,
    );
  });

  it("각 항목은 src, dst, label 필드를 가진다", () => {
    for (const entry of SYNC_MAP) {
      assert.ok(
        typeof entry.src === "string",
        `src must be string: ${JSON.stringify(entry)}`,
      );
      assert.ok(
        typeof entry.dst === "string",
        `dst must be string: ${JSON.stringify(entry)}`,
      );
      assert.ok(
        typeof entry.label === "string",
        `label must be string: ${JSON.stringify(entry)}`,
      );
    }
  });

  it("headless-guard-fast.sh가 SYNC_MAP에 포함되어 있다", () => {
    const hasFastSh = SYNC_MAP.some(
      (e) => e.label === "headless-guard-fast.sh",
    );
    assert.ok(hasFastSh, "SYNC_MAP must include headless-guard-fast.sh");
  });

  it("scripts/lib/*.sh도 SYNC_MAP에 포함한다 (#227)", () => {
    const entry = SYNC_MAP.find((e) => e.label === "lib/codex-recovery.sh");
    assert.ok(entry, "SYNC_MAP must include lib/codex-recovery.sh");
    assert.ok(
      entry.src.replace(/\\/g, "/").endsWith("/scripts/lib/codex-recovery.sh"),
      "src path must reference scripts/lib/codex-recovery.sh",
    );
    assert.ok(
      entry.dst
        .replace(/\\/g, "/")
        .endsWith("/.claude/scripts/lib/codex-recovery.sh"),
      "dst path must sync codex-recovery.sh into ~/.claude/scripts/lib",
    );
  });

  it("agent-map.json이 SYNC_MAP에 포함되어 있다", () => {
    const entry = SYNC_MAP.find((e) => e.label === "hub/team/agent-map.json");
    assert.ok(entry, "SYNC_MAP must include hub/team/agent-map.json");
    assert.ok(
      entry.src.replace(/\\/g, "/").includes("hub/team/agent-map.json"),
      "src path must reference agent-map.json",
    );
  });

  it("worker-utils.mjs가 SYNC_MAP에 포함되어 있다", () => {
    const entry = SYNC_MAP.find(
      (e) => e.label === "hub/workers/worker-utils.mjs",
    );
    assert.ok(entry, "SYNC_MAP must include hub/workers/worker-utils.mjs");
    assert.ok(
      entry.src.replace(/\\/g, "/").includes("hub/workers/worker-utils.mjs"),
      "src path must reference worker-utils.mjs",
    );
    assert.ok(
      entry.dst
        .replace(/\\/g, "/")
        .endsWith("/scripts/hub/workers/worker-utils.mjs"),
      "dst path must sync worker-utils.mjs into ~/.claude/scripts",
    );
  });

  it("agent-map.json의 synced 경로가 tfx-route.sh 상대경로와 일치한다", () => {
    const routeEntry = SYNC_MAP.find((e) => e.label === "tfx-route.sh");
    const mapEntry = SYNC_MAP.find(
      (e) => e.label === "hub/team/agent-map.json",
    );
    assert.ok(routeEntry && mapEntry, "both entries must exist");
    // tfx-route.sh: ../hub/team/agent-map.json relative to its synced dir
    const expected = join(
      dirname(routeEntry.dst),
      "..",
      "hub",
      "team",
      "agent-map.json",
    );
    const normalized = (p) => p.replace(/\\/g, "/");
    assert.equal(
      normalized(mapEntry.dst),
      normalized(expected),
      `agent-map.json dst must resolve from tfx-route.sh relative path`,
    );
  });
});

describe("setup-sync: worker package mirrors", () => {
  before(ensureTmpDir);
  after(cleanTmpDir);

  it("syncs @triflux package code into Claude worker node_modules", () => {
    const pluginRoot = join(TMP_DIR, "worker-package-root");
    const workerNodeModules = join(TMP_DIR, "claude-worker-node-modules");

    const coreSrc = join(pluginRoot, "packages", "core");
    const remoteSrc = join(pluginRoot, "packages", "remote");
    mkdirSync(join(coreSrc, "scripts", "lib"), { recursive: true });
    mkdirSync(join(remoteSrc, "hub", "team", "cli", "services"), {
      recursive: true,
    });
    mkdirSync(join(remoteSrc, "node_modules", "transitive"), {
      recursive: true,
    });

    writeFileSync(join(coreSrc, "package.json"), '{"name":"@triflux/core"}\n');
    writeFileSync(join(coreSrc, "scripts", "lib", "psmux-info.mjs"), "core\n");
    writeFileSync(
      join(remoteSrc, "package.json"),
      '{"name":"@triflux/remote"}\n',
    );
    writeFileSync(
      join(remoteSrc, "hub", "team", "cli", "services", "runtime-mode.mjs"),
      "remote\n",
    );
    writeFileSync(
      join(remoteSrc, "node_modules", "transitive", "stale.txt"),
      "skip\n",
    );

    const staleRemoteFile = join(
      workerNodeModules,
      "@triflux",
      "remote",
      "stale.txt",
    );
    mkdirSync(dirname(staleRemoteFile), { recursive: true });
    writeFileSync(staleRemoteFile, "old\n");

    const entries = getWorkerPackageSyncEntries({
      pluginRoot,
      workerNodeModules,
    });
    assert.deepEqual(entries.map((entry) => entry.label).sort(), [
      "@triflux/core worker package",
      "@triflux/remote worker package",
    ]);

    assert.equal(
      syncWorkerPackages({ pluginRoot, workerNodeModules }),
      2,
      "both worker packages should be refreshed",
    );
    assert.equal(
      readFileSync(
        join(
          workerNodeModules,
          "@triflux",
          "remote",
          "hub",
          "team",
          "cli",
          "services",
          "runtime-mode.mjs",
        ),
        "utf8",
      ),
      "remote\n",
    );
    assert.equal(existsSync(staleRemoteFile), false);
    assert.equal(
      existsSync(
        join(
          workerNodeModules,
          "@triflux",
          "remote",
          "node_modules",
          "transitive",
          "stale.txt",
        ),
      ),
      false,
      "nested package node_modules must not be copied",
    );
  });
});

describe("setup-sync: user-state file exclusions", () => {
  it("hosts.json is treated as user-state and excluded from setup asset sync", () => {
    assert.ok(
      SETUP_USER_STATE_FILES.has("hosts.json"),
      "hosts.json must be listed as user-state",
    );
    assert.equal(isSetupUserStateFile("hosts.json"), true);
    assert.equal(isSetupUserStateFile("SKILL.md"), false);
  });

  it("tfx setup CLI path also skips user-state references", () => {
    const source = readFileSync(
      join(PROJECT_ROOT, "bin", "triflux.mjs"),
      "utf8",
    );
    assert.match(source, /isSetupUserStateFile/u);
    assert.match(source, /if \(isSetupUserStateFile\(refFile\)\) continue;/u);
  });
});

describe("setup-sync: dry-run 실행", () => {
  // 훅 설치기(ensureCodexHooks/ensureAgyHooks)는 TEST_LOCK_PID 가 설정된 테스트
  // 실행 중에는 explicit seam 없이 실제 HOME 에 쓰지 않도록 자체 가드되어 있다
  // (scripts/ensure-*-hooks.mjs 참조). spawn 된 setup.mjs 도 TEST_LOCK_PID 를
  // 상속하므로 이 dry-run 은 실제 CLI config 를 오염시키지 않는다. setup.mjs 가
  // 백그라운드 hub 데몬을 띄우기 때문에 HOME 자체를 tmp 로 격리하면 정리 race
  // (ENOTEMPTY) 가 발생하므로 가드 방식을 쓴다.
  it("setup.mjs를 --help 없이 실행해도 에러 없이 종료된다", () => {
    // setup.mjs는 main()이 process.argv[1] 매칭 시에만 실행되므로
    // 직접 node로 실행하여 exit code 0 확인
    const _result = execFileSync(
      process.execPath,
      [join(PROJECT_ROOT, "scripts", "setup.mjs")],
      {
        timeout: 15000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    // 정상 종료 — execFileSync는 non-zero exit 시 throw
    assert.ok(true, "setup.mjs exited successfully");
  });

  it("--sync 플래그로 실행해도 에러 없이 종료된다", () => {
    const _result = execFileSync(
      process.execPath,
      [join(PROJECT_ROOT, "scripts", "setup.mjs"), "--sync"],
      {
        timeout: 15000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.ok(true, "setup.mjs --sync exited successfully");
  });
});

describe("setup-sync: managed hook registration", () => {
  before(ensureTmpDir);
  after(cleanTmpDir);

  function writeRegistry(registryPath, hooks) {
    writeFileSync(
      registryPath,
      JSON.stringify({ events: { Stop: hooks } }, null, 2) + "\n",
      "utf8",
    );
  }

  function readStopCommands(settingsPath) {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    return (settings.hooks?.Stop || [])
      .flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : []))
      .map((hook) => String(hook.command || ""));
  }

  it("requires 경로가 없으면 managed hook 등록을 건너뛴다 (#231)", () => {
    const settingsPath = join(TMP_DIR, "settings-requires-missing.json");
    const registryPath = join(TMP_DIR, "registry-requires-missing.json");

    writeRegistry(registryPath, [
      {
        id: "external-missing",
        matcher: "*",
        command: 'bash "${HOME}/missing-tool/hook.sh"',
        enabled: true,
        requires: "$HOME/missing-tool",
      },
    ]);

    const result = ensureHooksInSettings({ settingsPath, registryPath });

    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.deepEqual(result.added, []);
    assert.equal(existsSync(settingsPath), false);
  });

  it("requires 경로가 있으면 managed hook을 등록한다 (#231)", () => {
    const settingsPath = join(TMP_DIR, "settings-requires-present.json");
    const registryPath = join(TMP_DIR, "registry-requires-present.json");
    const requiredDir = join(TMP_DIR, "present-tool");
    mkdirSync(requiredDir, { recursive: true });

    writeRegistry(registryPath, [
      {
        id: "external-present",
        matcher: "*",
        command: 'bash "${HOME}/present-tool/hook.sh"',
        enabled: true,
        requires: requiredDir,
      },
    ]);

    const result = ensureHooksInSettings({ settingsPath, registryPath });

    assert.equal(result.ok, true);
    assert.deepEqual(result.added, ["external-present"]);
    assert.ok(
      readStopCommands(settingsPath).some((command) =>
        command.includes("present-tool"),
      ),
    );
  });

  it("requires 없는 managed hook은 기존처럼 등록한다 (#231)", () => {
    const settingsPath = join(TMP_DIR, "settings-no-requires.json");
    const registryPath = join(TMP_DIR, "registry-no-requires.json");

    writeRegistry(registryPath, [
      {
        id: "internal-hook",
        matcher: "*",
        command: 'node "${PLUGIN_ROOT}/hooks/pipeline-stop.mjs"',
        enabled: true,
      },
    ]);

    const result = ensureHooksInSettings({ settingsPath, registryPath });

    assert.equal(result.ok, true);
    assert.deepEqual(result.added, ["internal-hook"]);
    assert.ok(
      readStopCommands(settingsPath).some((command) =>
        command.includes("pipeline-stop.mjs"),
      ),
    );
  });

  it("유효하지 않은 CLAUDE_PLUGIN_ROOT는 무시하고 실제 패키지 루트를 사용한다", () => {
    const settingsPath = join(TMP_DIR, "settings.json");
    const registryPath = join(PROJECT_ROOT, "hooks", "hook-registry.json");
    const invalidPluginRoot = join(TMP_DIR, "empty-worktree");
    mkdirSync(invalidPluginRoot, { recursive: true });

    const prevPluginRoot = process.env.PLUGIN_ROOT;
    const prevClaudePluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.PLUGIN_ROOT = invalidPluginRoot;
    process.env.CLAUDE_PLUGIN_ROOT = invalidPluginRoot;

    try {
      const result = ensureHooksInSettings({ settingsPath, registryPath });
      assert.equal(result.ok, true);

      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const stopEntries = settings.hooks?.Stop || [];
      const stopCommands = stopEntries
        .flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : []))
        .map((hook) => String(hook.command || ""));

      assert.ok(
        stopCommands.some((command) => command.includes("pipeline-stop.mjs")),
        "pipeline-stop hook must be registered",
      );
      assert.ok(
        stopCommands.every(
          (command) => !command.includes(invalidPluginRoot.replace(/\\/g, "/")),
        ),
        "invalid plugin root must not leak into settings",
      );
      assert.ok(
        stopCommands.some((command) => command.includes("${PLUGIN_ROOT:-")),
        "registered hook must include a ${PLUGIN_ROOT:-...} fallback",
      );
    } finally {
      if (prevPluginRoot === undefined) delete process.env.PLUGIN_ROOT;
      else process.env.PLUGIN_ROOT = prevPluginRoot;
      if (prevClaudePluginRoot === undefined)
        delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = prevClaudePluginRoot;
    }
  });
});

describe("setup-sync: codex tfx-hub config normalization", () => {
  before(ensureTmpDir);
  after(cleanTmpDir);

  it("createIfMissing=true면 tfx-hub를 disabled 기본값으로 생성한다", () => {
    const configPath = join(TMP_DIR, "codex-create.json");
    const result = ensureCodexHubServerConfig({
      configFile: configPath,
      mcpUrl: "http://127.0.0.1:27888/mcp",
      createIfMissing: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.changed, true);

    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(config.mcpServers["tfx-hub"], {
      url: "http://127.0.0.1:27888/mcp",
      enabled: false,
    });
  });

  it("기존 tfx-hub 엔트리는 URL을 갱신하고 enabled=false로 정규화한다", () => {
    const configPath = join(TMP_DIR, "codex-update.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            "tfx-hub": {
              url: "http://127.0.0.1:9999/mcp",
              enabled: true,
              note: "keep-me",
            },
            other: { url: "http://127.0.0.1:3000/mcp" },
          },
        },
        null,
        2,
      ),
    );

    const result = ensureCodexHubServerConfig({
      configFile: configPath,
      mcpUrl: "http://127.0.0.1:27888/mcp",
      createIfMissing: false,
    });

    assert.equal(result.ok, true);
    assert.equal(result.changed, true);

    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(config.mcpServers["tfx-hub"], {
      url: "http://127.0.0.1:27888/mcp",
      enabled: false,
      note: "keep-me",
    });
    assert.deepEqual(config.mcpServers.other, {
      url: "http://127.0.0.1:3000/mcp",
    });
  });

  it("enabled=true를 요청하면 명시적으로 활성화 상태를 기록한다", () => {
    const configPath = join(TMP_DIR, "codex-enable.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            "tfx-hub": { url: "http://127.0.0.1:27888/mcp", enabled: false },
          },
        },
        null,
        2,
      ),
    );

    const result = ensureCodexHubServerConfig({
      configFile: configPath,
      mcpUrl: "http://127.0.0.1:27888/mcp",
      createIfMissing: false,
      enabled: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.changed, true);

    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(config.mcpServers["tfx-hub"], {
      url: "http://127.0.0.1:27888/mcp",
      enabled: true,
    });
  });
});
