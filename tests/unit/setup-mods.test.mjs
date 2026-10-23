import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "tfx-mods-"));
const previousEnv = { ...process.env };
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.TRIFLUX_TEST_HOME = home;
const {
  applyAgyStatusLine,
  applyStatusLine,
  ensureTrifluxMods,
  inspectTrifluxMods,
} = await import("../../scripts/setup.mjs");
process.env = previousEnv;
after(() => rmSync(home, { recursive: true, force: true }));

const PKG = "10.54.0";
const READS = [
  "--version",
  "plugin marketplace list --json",
  "plugin list --json",
];
const ADD = "plugin marketplace add tellang/triflux";
const INSTALL = "plugin install triflux-mods@triflux";
const REFRESH = "plugin marketplace update triflux";
const UPDATE = [REFRESH, "plugin update triflux-mods@triflux --scope user"];
const REGISTERED = [{ name: "triflux" }];
const installedAt = (version) => [
  { id: "triflux-mods@triflux", scope: "user", version },
];

async function runMods({
  env = {},
  install = false,
  interactive = false,
  answer = false,
  version = "2.1.287 (Claude Code)",
  marketplaces = [],
  plugins = [],
  failAt,
} = {}) {
  const calls = [];
  const asked = [];
  const logs = [];
  const warnings = [];
  const notices = [];
  const status = await ensureTrifluxMods({
    install,
    interactive,
    ask: async (question) => {
      asked.push(question);
      return answer;
    },
    pkgVersion: PKG,
    env: { HOME: home, USERPROFILE: home, ...env },
    log: (message) => logs.push(message),
    warn: (message) => warnings.push(message),
    notice: (message) => notices.push(message),
    execFileSyncFn(command, args, options) {
      assert.equal(command, "claude");
      assert.equal(options.env.HOME, home);
      const call = args.join(" ");
      calls.push(call);
      if (call === failAt) throw new Error("fixture failure");
      if (call === "--version") return version;
      if (call === "plugin marketplace list --json")
        return JSON.stringify(marketplaces);
      if (call === "plugin list --json") return JSON.stringify(plugins);
      assert.ok([ADD, INSTALL, ...UPDATE].includes(call), call);
      return "";
    },
  });
  return { status, calls, asked, logs, warnings, notices };
}

test("보호 환경, 옛 CLI, claude 없음은 아무것도 하지 않고 실패는 경고만 남긴다", async () => {
  for (const env of [
    { NODE_ENV: "test" },
    { CI: "true" },
    { TRIFLUX_TEST_HOME: home },
    { NODE_TEST_CONTEXT: "child-v8" },
    { npm_lifecycle_event: "postinstall" },
  ]) {
    const { status, calls } = await runMods({ env, install: true });
    assert.equal(status, "not-needed");
    assert.deepEqual(calls, []);
  }
  for (const version of ["2.1.286", "2.0.999", "unknown"]) {
    const { status, calls } = await runMods({ version, install: true });
    assert.equal(status, "not-needed");
    assert.deepEqual(calls, ["--version"]);
  }
  const missing = await runMods({ failAt: "--version", install: true });
  assert.equal(missing.status, "not-needed");
  assert.deepEqual(missing.warnings, []);
  for (const failAt of [...READS.slice(1), ADD, INSTALL]) {
    const { status, calls, warnings } = await runMods({
      failAt,
      install: true,
    });
    assert.equal(status, "failed");
    assert.equal(calls.at(-1), failAt);
    assert.equal(warnings.length, 1);
  }
});

test("미설치: --mods 는 묻지 않고 설치, 대화형은 동의할 때만, 비대화형은 안내만", async () => {
  const deferred = await runMods();
  assert.equal(deferred.status, "deferred");
  assert.deepEqual(deferred.calls, [...READS, ADD]);
  assert.deepEqual(deferred.warnings, []);
  assert.deepEqual(deferred.notices, ["mods 설치: tfx setup --mods"]);
  assert.deepEqual(deferred.asked, []);

  const forced = await runMods({ install: true, marketplaces: REGISTERED });
  assert.equal(forced.status, "installed");
  assert.deepEqual(forced.calls, [...READS, INSTALL]);
  assert.deepEqual(forced.asked, []);

  const yes = await runMods({ interactive: true, answer: true });
  assert.equal(yes.status, "installed");
  assert.deepEqual(yes.calls, [...READS, ADD, INSTALL]);
  assert.equal(yes.asked.length, 1);

  const no = await runMods({ interactive: true, marketplaces: REGISTERED });
  assert.equal(no.status, "declined");
  assert.deepEqual(no.calls, READS);

  const other = await runMods({
    marketplaces: [{ name: "other", repo: "tellang/triflux" }],
    plugins: [{ id: "triflux@triflux" }, { id: "triflux-mods@other" }],
  });
  assert.equal(other.status, "deferred");
});

test("설치됨: 같은 버전이나 버전을 모르면 묻지 않고, 다르면 동의 뒤에만 업데이트한다", async () => {
  for (const plugins of [installedAt(PKG), installedAt(undefined)]) {
    for (const install of [false, true]) {
      const current = await runMods({
        interactive: true,
        install,
        marketplaces: REGISTERED,
        plugins,
      });
      assert.equal(current.status, "present");
      assert.deepEqual(current.calls, READS);
      assert.deepEqual(current.asked, []);
    }
  }
  const old = { marketplaces: REGISTERED, plugins: installedAt("10.50.2") };
  const outdated = await runMods(old);
  assert.equal(outdated.status, "outdated");
  assert.deepEqual(outdated.calls, READS);
  assert.ok(outdated.warnings[0].includes("claude plugin update"));

  const declined = await runMods({ ...old, interactive: true });
  assert.equal(declined.status, "update-declined");
  assert.deepEqual(declined.calls, READS);
  assert.ok(declined.asked[0].includes("10.50.2"));

  for (const consent of [
    { interactive: true, answer: true },
    { install: true },
  ]) {
    const updated = await runMods({ ...old, ...consent });
    assert.equal(updated.status, "updated");
    assert.deepEqual(updated.calls, [...READS, ...UPDATE]);
  }

  // project/local 설치는 다른 프로젝트 것일 수 있어 보지 않는다.
  const project = (version) => ({
    ...installedAt(version)[0],
    scope: "project",
  });
  const userCurrent = await runMods({
    marketplaces: REGISTERED,
    plugins: [project("10.50.2"), ...installedAt(PKG)],
    install: true,
  });
  assert.equal(userCurrent.status, "present");
  assert.deepEqual(userCurrent.calls, READS);
  const projectOnly = await runMods({
    marketplaces: REGISTERED,
    plugins: [project(PKG)],
    install: true,
  });
  assert.equal(projectOnly.status, "installed");
  assert.deepEqual(projectOnly.calls, [...READS, INSTALL]);
});

test("doctor 판정은 읽기만 하고 상태와 두 버전을 돌려준다", () => {
  const run = (plugins) => (args) => {
    const call = args.join(" ");
    if (call === "--version") return "2.1.292 (Claude Code)";
    if (call === "plugin marketplace list --json")
      return JSON.stringify(REGISTERED);
    if (call === "plugin list --json") return JSON.stringify(plugins);
    throw new Error(`쓰기 호출: ${call}`);
  };
  const env = { HOME: home };
  assert.equal(
    inspectTrifluxMods({ env, pkgVersion: PKG, run: run([]) }).status,
    "missing",
  );
  assert.deepEqual(
    inspectTrifluxMods({
      env,
      pkgVersion: PKG,
      run: run(installedAt("10.50.2")),
    }),
    {
      status: "outdated",
      installedVersion: "10.50.2",
      pkgVersion: PKG,
      hasMarketplace: true,
    },
  );
});

test("statusLine 을 sh 래퍼로 등록하고 예전 node 명령도 triflux 것으로 알아본다", () => {
  const hudDir = join(home, "hud");
  mkdirSync(hudDir, { recursive: true });
  const hudPath = join(hudDir, "hud-qos-status.mjs");
  writeFileSync(hudPath, "");
  writeFileSync(join(hudDir, "hud-statusline.sh"), "");
  const opts = { hudPath, warn() {} };
  const fresh = {};
  assert.equal(applyStatusLine(fresh, opts), true);
  if (process.platform !== "win32")
    assert.match(fresh.statusLine.command, /^sh \S*hud-statusline\.sh \S*node/);
  const legacy = {
    statusLine: {
      type: "command",
      command: `/opt/homebrew/bin/node "${hudPath.replace(/\\/g, "/")}"`,
    },
  };
  assert.equal(applyStatusLine(legacy, opts), true);
  assert.equal(legacy.statusLine.command, fresh.statusLine.command);
  assert.equal(applyStatusLine(legacy, opts), false);
  const custom = { statusLine: { type: "command", command: "my-status" } };
  assert.equal(applyStatusLine(custom, opts), false);
});

test("agy statusLine 에 HUD 를 붙이고 사용자 명령은 남기며 다시 돌려도 같다", () => {
  const hudDir = join(home, "hud");
  mkdirSync(hudDir, { recursive: true });
  const hudPath = join(hudDir, "hud-qos-status.mjs");
  writeFileSync(hudPath, "");
  writeFileSync(join(hudDir, "hud-statusline.sh"), "");
  const binDir = join(home, "bin");
  mkdirSync(binDir, { recursive: true });
  for (const name of ["agy", "agy.cmd"]) writeFileSync(join(binDir, name), "");
  const agyDir = join(home, ".gemini", "antigravity-cli");
  const settingsPath = join(agyDir, "settings.json");
  const opts = { hudPath, warn() {} };
  const savedPath = process.env.PATH;
  process.env.PATH = binDir;
  try {
    assert.equal(applyAgyStatusLine(opts), false);
    assert.equal(existsSync(settingsPath), false);

    mkdirSync(agyDir, { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        model: "Gemini 4 Argon",
        statusLine: { type: "", command: "", enabled: true },
      }),
    );
    assert.equal(applyAgyStatusLine(opts), true);
    const first = readFileSync(settingsPath, "utf8");
    const written = JSON.parse(first);
    assert.equal(written.model, "Gemini 4 Argon");
    const claude = {};
    applyStatusLine(claude, opts);
    assert.deepEqual(written.statusLine, {
      type: "command",
      command: claude.statusLine.command,
      enabled: true,
      stack_with_default: true,
    });
    assert.equal(applyAgyStatusLine(opts), false);
    assert.equal(readFileSync(settingsPath, "utf8"), first);

    const custom = JSON.stringify({
      statusLine: { type: "command", command: "my-status" },
    });
    writeFileSync(settingsPath, custom);
    assert.equal(applyAgyStatusLine(opts), false);
    assert.equal(readFileSync(settingsPath, "utf8"), custom);
  } finally {
    process.env.PATH = savedPath;
  }
});

test("agy 설정 JSON 이 깨져도 setup --dry-run 은 skip 항목을 내고 성공한다", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "tfx-dry-"));
  try {
    const binDir = join(fakeHome, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "agy"), "");
    const agyDir = join(fakeHome, ".gemini", "antigravity-cli");
    mkdirSync(agyDir, { recursive: true });
    writeFileSync(join(agyDir, "settings.json"), '{"statusLine":{');
    const result = spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, "../../bin/triflux.mjs"),
        "setup",
        "--dry-run",
        "--json",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          TRIFLUX_TEST_HOME: fakeHome,
          PATH: `${binDir}:${process.env.PATH}`,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const action = JSON.parse(result.stdout).actions.find(
      (a) => a.type === "agyStatusLine",
    );
    assert.equal(action.change, "skip");
    assert.ok(action.error);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
