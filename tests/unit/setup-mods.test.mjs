import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "tfx-mods-"));
const previousEnv = { ...process.env };
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.TRIFLUX_TEST_HOME = home;
const { applyStatusLine, ensureTrifluxMods, inspectTrifluxMods } = await import(
  "../../scripts/setup.mjs"
);
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
  return { status, calls, asked, logs, warnings };
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
  assert.deepEqual(deferred.logs, ["mods 설치: tfx setup --mods"]);
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
  assert.ok(outdated.logs[0].includes("claude plugin update"));

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

test("mods band 가 HUD 를 그리면 비어 있는 statusLine 을 다시 등록하지 않는다", () => {
  const hudPath = join(home, "hud-qos-status.mjs");
  writeFileSync(hudPath, "");
  const opts = { hudPath, warn() {} };
  const enabled = { enabledPlugins: { "triflux-mods@triflux": true } };
  assert.equal(applyStatusLine({ ...enabled }, opts), false);
  const statusline = {
    ...enabled,
    pluginConfigs: {
      "triflux-mods@triflux": { options: { position: "statusline" } },
    },
  };
  assert.equal(applyStatusLine(statusline, opts), true);
  assert.equal(applyStatusLine({}, opts), true);
});
