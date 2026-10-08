import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import {
  cleanupTfxHub,
  findProjectHubEntries,
} from "../../scripts/lib/legacy-mcp-cleanup.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const HUB = { type: "http", url: "http://127.0.0.1:27888/mcp" };
const OTHER = { type: "http", url: "https://example.test/mcp" };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tfx-hub-cleanup-"));
  dirs.push(root);
  return { root, home: join(root, "home") };
}

function put(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

function read(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function commandError(status) {
  return Object.assign(new Error("exit"), { status, stderr: "" });
}

test("모든 설정 파일에서 tfx-hub 만 빠지고 다른 항목과 백업이 남는다", () => {
  const { root, home } = fixture();
  const claudeJson = join(home, ".claude.json");
  const settings = join(home, ".claude/settings.json");
  const gemini = join(home, ".gemini/settings.json");
  const codex = join(home, ".codex/config.toml");
  put(claudeJson, {
    mcpServers: { "tfx-hub": HUB, other: OTHER },
    projects: { sample: { mcpServers: { "tfx-hub": HUB } } },
  });
  put(settings, { theme: "dark", mcpServers: { "tfx-hub": HUB } });
  put(join(home, ".claude/mcp.json"), { mcpServers: { "tfx-hub": HUB } });
  put(join(home, ".codex/config.json"), { mcpServers: { "tfx-hub": HUB } });
  put(gemini, { mcpServers: { "tfx-hub": { url: HUB.url }, other: OTHER } });
  put(join(home, ".gemini/config/mcp_config.json"), {
    mcpServers: { "tfx-hub": { ...HUB }, other: OTHER },
  });
  put(
    codex,
    'model = "gpt"\n\n[mcp_servers.context7]\nurl = "https://mcp.context7.com/mcp"\n\n[mcp_servers.tfx-hub]\nurl = "http://127.0.0.1:27888/mcp"\nenabled = true\n\n[mcp_servers.tfx-hub.env]\nA = "1"\n\n# 내 프로필 설명\n[profiles.keep]\nmodel = "x"\n',
  );
  const pluginRoot = join(root, "pkg");
  put(join(pluginRoot, "references/gemini-snapshots/a.json"), {});
  put(join(pluginRoot, "references/codex-snapshots/b.json"), {});

  const run = () => {
    throw new Error("unexpected command");
  };
  const options = { home, platform: "darwin", run, pluginRoot };
  const result = cleanupTfxHub(options);

  assert.equal(result.ok, true);
  assert.equal(result.removed, 8);
  assert.equal(result.backups.length, 7);
  assert.deepEqual(read(claudeJson), {
    mcpServers: { other: OTHER },
    projects: { sample: { mcpServers: {} } },
  });
  assert.deepEqual(read(settings), { theme: "dark", mcpServers: {} });
  assert.deepEqual(read(gemini).mcpServers, { other: OTHER });
  assert.equal(
    readFileSync(codex, "utf8"),
    'model = "gpt"\n\n[mcp_servers.context7]\nurl = "https://mcp.context7.com/mcp"\n\n# 내 프로필 설명\n[profiles.keep]\nmodel = "x"\n',
  );
  assert.equal(
    existsSync(join(pluginRoot, "references/gemini-snapshots")),
    false,
  );
  assert.equal(
    existsSync(join(pluginRoot, "references/codex-snapshots")),
    false,
  );

  const second = cleanupTfxHub(options);
  assert.equal(second.removed, 0);
  assert.equal(second.changed, false);
  assert.equal(
    readdirSync(home).filter((name) => name.includes(".tfx-bak-")).length,
    1,
  );
});

test("HOME 의 .mcp.json 과 .claude/.mcp.json 도 정리하고 빈 파일은 건너뛴다", () => {
  const { home } = fixture();
  const homeMcp = join(home, ".mcp.json");
  const claudeDotMcp = join(home, ".claude/.mcp.json");
  put(homeMcp, { mcpServers: { "tfx-hub": HUB, other: OTHER } });
  put(claudeDotMcp, { mcpServers: { "tfx-hub": HUB } });
  put(join(home, ".gemini/config/mcp_config.json"), "");
  const result = cleanupTfxHub({
    home,
    platform: "darwin",
    run: () => {
      throw commandError(1);
    },
  });
  assert.equal(result.ok, true, result.warnings.join("\n"));
  assert.deepEqual(read(homeMcp).mcpServers, { other: OTHER });
  assert.deepEqual(read(claudeDotMcp).mcpServers, {});
});

test("허브 주소가 아닌 tfx-hub 항목은 건드리지 않고 경고한다", () => {
  const { home } = fixture();
  const file = join(home, ".claude.json");
  put(file, {
    mcpServers: { "tfx-hub": { command: "node", args: ["mine.js"] } },
  });
  const before = readFileSync(file, "utf8");
  const result = cleanupTfxHub({
    home,
    platform: "darwin",
    run: () => {
      throw new Error("unexpected command");
    },
  });
  assert.equal(result.removed, 0);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.ok(result.warnings.some((warning) => warning.includes("tfx-hub")));
});

function hubPidFixture(commandOfPid) {
  const { home } = fixture();
  const pidFile = join(home, ".claude/cache/tfx-hub/hub.pid");
  put(pidFile, { pid: 4321, port: 27888 });
  const calls = [];
  let killed = false;
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (command === "ps") {
      if (command === "ps" && killed) throw commandError(1);
      return `${commandOfPid}\n`;
    }
    if (command === "kill") {
      killed = true;
      return "";
    }
    throw new Error("unexpected command");
  };
  return { home, pidFile, calls, run };
}

test("hub.pid 가 hub/server.mjs 를 가리키면 종료하고 hub.pid 를 지운다", () => {
  const { home, pidFile, calls, run } = hubPidFixture(
    "/usr/local/bin/node /opt/triflux/hub/server.mjs",
  );
  const result = cleanupTfxHub({ home, platform: "darwin", run });
  assert.equal(result.hubStopped, true);
  assert.deepEqual(
    calls.filter(([command]) => command === "kill"),
    [["kill", "-TERM", "4321"]],
  );
  assert.equal(existsSync(pidFile), false);
});

test("hub.pid 가 다른 프로세스를 가리키면 종료하지 않고 파일만 지운다", () => {
  const { home, pidFile, calls, run } = hubPidFixture("/usr/bin/vim notes.md");
  const result = cleanupTfxHub({ home, platform: "darwin", run });
  assert.equal(result.hubStopped, false);
  assert.equal(
    calls.some(([command]) => command === "kill"),
    false,
  );
  assert.equal(existsSync(pidFile), false);
  assert.deepEqual(result.warnings, []);
});

const taskXml = (command, args, description = "") =>
  `<Task><RegistrationInfo><Description>${description}</Description></RegistrationInfo><Actions Context="Author"><Exec id="HubAction"><Command>${command}</Command><Arguments>${args}</Arguments></Exec></Actions></Task>`;

test("Windows 의 허브 예약 작업은 실행 명령으로만 판정해 지운다", () => {
  for (const [task, xml, deleted] of [
    [
      "TrifluxHubEnsure",
      taskXml("node", "C:\\pkg\\scripts\\hub-ensure.mjs"),
      true,
    ],
    ["TrifluxHubEnsure", taskXml("C:\\other\\backup.exe", ""), false],
    [
      "\\Triflux\\Hub",
      taskXml("powershell.exe", "-WindowStyle Hidden -Command tfx hub ensure"),
      true,
    ],
    [
      "\\Triflux\\Hub",
      taskXml(
        "C:\\Tools\\backup.exe",
        "",
        "Replaces the old tfx hub ensure task",
      ),
      false,
    ],
  ]) {
    const { home } = fixture();
    const calls = [];
    const run = (command, args) => {
      calls.push([command, ...args]);
      if (args[0] !== "/Query") return "";
      if (args[2] !== task) throw commandError(1);
      return xml;
    };
    cleanupTfxHub({ home, platform: "win32", run });
    assert.equal(
      calls.some((call) => call[1] === "/Delete" && call[3] === task),
      deleted,
      `${task}: ${xml}`,
    );
  }
});

test("Windows 에서 PowerShell 조회가 실패하면 종료하지 않고 hub.pid 를 보존한다", () => {
  const { home } = fixture();
  const pidFile = join(home, ".claude/cache/tfx-hub/hub.pid");
  put(pidFile, { pid: 4321 });
  const calls = [];
  const run = (command) => {
    calls.push(command);
    throw commandError(1);
  };
  const result = cleanupTfxHub({ home, platform: "win32", run });
  assert.equal(calls.includes("taskkill"), false);
  assert.equal(existsSync(pidFile), true);
  assert.ok(result.warnings.some((warning) => warning.includes("확인 실패")));
});

test("cwd 의 프로젝트 MCP 파일에서 허브 주소 tfx-hub 항목이 있는 파일만 찾는다", () => {
  const { root } = fixture();
  put(join(root, ".mcp.json"), { mcpServers: { "tfx-hub": HUB } });
  put(join(root, ".claude/mcp.json"), {
    mcpServers: { "tfx-hub": { command: "node" }, other: OTHER },
  });
  assert.deepEqual(findProjectHubEntries(root), [join(root, ".mcp.json")]);
});
