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
  cleanupLegacyMcp,
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

// 프로세스 목록 ps 출력을 흉내 낸다. kill 된 pid 는 다음 조회부터 사라진다.
function processFixture() {
  const { root, home } = fixture();
  const pidFile = join(home, ".claude/cache/tfx-hub/hub.pid");
  put(pidFile, { pid: 4321, port: 27888 });
  const lines = [];
  const calls = [];
  const killed = new Set();
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (command === "ps" && args[0] === "-axo") return lines.join("\n");
    if (command === "ps" && args[0] === "-p") {
      const line = lines.find((entry) =>
        entry.trim().startsWith(`${args[1]} `),
      );
      if (killed.has(args[1]) || !line) throw commandError(1);
      return `${line.trim().replace(/^\d+\s+/, "")}\n`;
    }
    if (command === "kill") {
      killed.add(args[1]);
      return "";
    }
    throw new Error("unexpected command");
  };
  return { root, home, pidFile, lines, calls, run };
}

test("triflux 패키지의 허브는 설치본, 체크아웃 구분 없이 종료하고 hub.pid 를 지운다", () => {
  const { root, home, pidFile, lines, calls, run } = processFixture();
  const installed = join(root, "npm/node_modules/triflux");
  const checkout = join(root, "checkout/triflux");
  const other = join(root, "other");
  put(join(installed, "package.json"), { name: "triflux" });
  put(join(checkout, "package.json"), { name: "triflux" });
  put(join(other, "package.json"), { name: "not-triflux" });
  lines.push(
    `  11 /usr/local/bin/node ${installed}/hub/server.mjs`,
    `  12 node --no-warnings ${checkout}/hub/server.mjs`,
    `  13 node ${other}/hub/server.mjs`,
    `  14 /usr/bin/vim ${installed}/hub/server.mjs`,
    `  15 node reader.mjs --input ${installed}/hub/server.mjs`,
    // macOS ps 는 인자 경계가 없어 값 옵션이 붙은 명령은 허브로 판정하지 않는다.
    `  16 node --require ./trace.cjs ${installed}/hub/server.mjs`,
    `  17 node --eval=setTimeout(()=>{},800) ${installed}/hub/server.mjs`,
    `  18 node --require /tmp/trace.cjs /tmp/reader.mjs ${installed}/hub/server.mjs`,
    `  19 /bin/sh /tmp/reader.sh /opt/bin/node ${installed}/hub/server.mjs`,
    `  21 node --conditions ${installed}/hub/server.mjs /tmp/reader.mjs`,
    `  22 node --unknown-flag ${installed}/hub/server.mjs`,
    `  23 node --conditions custom ${installed}/hub/server.mjs /tmp/reader.mjs`,
    `  24 node --conditions=custom ${installed}/hub/server.mjs /tmp/reader.mjs`,
    `  25 node ${installed}/hub/server.mjs copy.mjs`,
    `  26 node ${installed}/hub/server.mjs --port 27888`,
    // macOS ps 는 공백이 든 node 경로를 구분할 수 없어 종료하지 않는다.
    `  20 ${root}/my tools/bin/node ${installed}/hub/server.mjs`,
  );
  const logs = [];
  const result = cleanupTfxHub({
    home,
    platform: "darwin",
    run,
    log: (message) => logs.push(message),
  });
  assert.equal(result.hubStopped, true);
  assert.deepEqual(
    calls.filter(([command]) => command === "kill").map((call) => call[2]),
    ["11", "12"],
  );
  assert.deepEqual(logs.slice(0, 2), [
    `허브 종료: pid 11 (${installed})`,
    `허브 종료: pid 12 (${checkout})`,
  ]);
  assert.equal(existsSync(pidFile), false);
});

test("허브로 판정하지 못한 hub/server.mjs 프로세스가 hub.pid 에 있으면 hub.pid 를 둔다", () => {
  const { home, pidFile, lines, calls, run } = processFixture();
  lines.push("  4321 node /unverified/hub/server.mjs");
  const result = cleanupTfxHub({ home, platform: "darwin", run });
  assert.equal(
    calls.some(([command]) => command === "kill"),
    false,
  );
  assert.equal(existsSync(pidFile), true);
  assert.ok(result.warnings.some((warning) => warning.includes("보존")));
});

test("Windows 에서는 따옴표 친 체크아웃 경로의 허브를 taskkill 로 종료한다", () => {
  const { root, home } = fixture();
  const checkout = join(root, "Desktop Projects", "triflux");
  put(join(checkout, "package.json"), { name: "triflux" });
  const calls = [];
  let killed = false;
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (command === "taskkill") {
      killed = true;
      return "";
    }
    const script = args.at(-1);
    if (script.includes("ConvertTo-Json -InputObject $items"))
      return JSON.stringify([
        { pid: "4832", command: `"node.exe" "${checkout}\\hub\\server.mjs"` },
        {
          pid: "4835",
          command: `node.exe --run=probe ${checkout}\\hub\\server.mjs`,
        },
        {
          pid: "4834",
          command: `node.exe ${checkout}\\hub\\"server.mjs"\u00a0copy.mjs`,
        },
        {
          pid: "4833",
          command: `node.exe "--conditions=custom "${checkout}\\hub\\server.mjs C:\\tools\\reader.mjs`,
        },
      ]);
    if (script.includes("CommandLine")) return killed ? "" : "node";
    throw commandError(1);
  };
  const result = cleanupTfxHub({ home, platform: "win32", run });
  assert.equal(result.hubStopped, true);
  assert.deepEqual(
    calls.filter((call) => call[0] === "taskkill").map((call) => call.at(-1)),
    ["4832"],
  );
});

test("허브 프로세스가 없으면 죽은 pid 를 가리키는 hub.pid 만 지운다", () => {
  const { home, pidFile, lines, calls, run } = processFixture();
  lines.push("  99 /usr/bin/vim notes.md");
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
  assert.ok(result.warnings.some((warning) => warning.includes("조회 실패")));
});

test("cwd 의 프로젝트 MCP 파일에서 허브 주소 tfx-hub 항목이 있는 파일만 찾는다", () => {
  const { root } = fixture();
  put(join(root, ".mcp.json"), { mcpServers: { "tfx-hub": HUB } });
  put(join(root, ".claude/mcp.json"), {
    mcpServers: { "tfx-hub": { command: "node" }, other: OTHER },
  });
  assert.deepEqual(findProjectHubEntries(root), [join(root, ".mcp.json")]);
});

test("게이트웨이 이주와 허브 정리가 같은 파일을 바꿔도 백업은 한 벌이다", () => {
  const { root, home } = fixture();
  const claude = join(home, ".claude.json");
  put(claude, {
    mcpServers: {
      context7: { url: "http://127.0.0.1:8100/mcp" },
      "tfx-hub": HUB,
    },
  });
  const run = (command) => {
    if (command === "ps") return "";
    throw new Error("unexpected command");
  };
  const backups = new Map();
  const migrated = cleanupLegacyMcp({
    home,
    repoRoot: join(root, "repo"),
    platform: "darwin",
    run,
    uid: 500,
    env: {},
    backups,
  });
  const hub = cleanupTfxHub({ home, platform: "darwin", run, backups });
  assert.equal(migrated.ok && hub.ok, true);
  assert.deepEqual(hub.backups, migrated.backups);
  const servers = JSON.parse(readFileSync(claude, "utf8")).mcpServers;
  assert.equal(servers["tfx-hub"], undefined);
  assert.equal(servers.context7.command, "npx");
  assert.equal(
    readdirSync(home).filter((name) => name.includes(".tfx-bak-")).length,
    1,
  );
});
