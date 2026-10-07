import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "tfx-mods-"));
const previousEnv = { ...process.env };
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.TRIFLUX_TEST_HOME = home;
const { ensureTrifluxMods } = await import("../../scripts/setup.mjs");
process.env = previousEnv;
after(() => rmSync(home, { recursive: true, force: true }));

function runMods({
  env = {},
  install = false,
  version = "2.1.287 (Claude Code)",
  marketplaces = [],
  plugins = [],
  failAt,
} = {}) {
  const calls = [];
  const logs = [];
  const warnings = [];
  const result = ensureTrifluxMods({
    install,
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
      assert.ok(
        [
          "plugin marketplace add tellang/triflux",
          "plugin install triflux-mods@triflux",
        ].includes(call),
      );
      return "";
    },
  });
  return { result, calls, logs, warnings };
}

test("mods skips protected environments and old/missing CLIs; failures only warn", () => {
  for (const env of [
    { NODE_ENV: "test" },
    { CI: "true" },
    { TFX_TEST: "1" },
    { TRIFLUX_TEST_HOME: home },
    { TEST_LOCK_PID: "1" },
    { NODE_TEST_CONTEXT: "child-v8" },
    { NODE_TEST_WORKER_ID: "1" },
    { npm_lifecycle_event: "postinstall" },
  ]) {
    const { result, calls } = runMods({ env, install: true });
    assert.equal(result.reason, "protected-env");
    assert.deepEqual(calls, []);
  }
  for (const version of [
    "2.1.286",
    "2.1.99",
    "2.0.999",
    "1.9.999",
    "unknown",
  ]) {
    const { result, calls, logs } = runMods({ version, install: true });
    assert.equal(result.reason, "unsupported-version");
    assert.deepEqual(calls, ["--version"]);
    assert.deepEqual(logs, []);
  }
  const missing = runMods({ failAt: "--version", install: true });
  assert.equal(missing.result.reason, "claude-unavailable");
  assert.deepEqual(missing.warnings, []);
  for (const failAt of [
    "plugin marketplace list --json",
    "plugin list --json",
    "plugin marketplace add tellang/triflux",
    "plugin install triflux-mods@triflux",
  ]) {
    const { result, calls, warnings } = runMods({ failAt, install: true });
    assert.equal(result.ok, false);
    assert.equal(calls.at(-1), failAt);
    assert.equal(warnings.length, 1);
  }
});

test("mods registers once, installs only on opt-in, and skips installed plugins", () => {
  const reads = [
    "--version",
    "plugin marketplace list --json",
    "plugin list --json",
  ];
  const add = "plugin marketplace add tellang/triflux";
  const install = "plugin install triflux-mods@triflux";
  const hint = "mods 설치: tfx setup --mods";
  const defaultSetup = runMods();
  assert.equal(defaultSetup.result.ok, true);
  assert.deepEqual(defaultSetup.calls, [...reads, add]);
  assert.deepEqual(defaultSetup.logs, [hint]);
  const optedIn = runMods({ install: true });
  assert.equal(optedIn.result.installed, true);
  assert.deepEqual(optedIn.calls, [...reads, add, install]);
  const marketplaces = [{ name: "triflux" }];
  for (const version of ["2.1.287", "2.1.300", "2.2.0", "3.0.0"]) {
    const registered = runMods({ version, marketplaces });
    assert.deepEqual(registered.calls, reads);
    assert.deepEqual(registered.logs, [hint]);
    const requested = runMods({ version, marketplaces, install: true });
    assert.deepEqual(requested.calls, [...reads, install]);
  }
  for (const installRequested of [false, true]) {
    const installed = runMods({
      marketplaces,
      plugins: [{ id: "triflux-mods@triflux", scope: "user" }],
      install: installRequested,
    });
    assert.deepEqual(installed.calls, reads);
    assert.deepEqual(installed.logs, []);
  }
  const other = runMods({
    marketplaces: [{ name: "other", repo: "tellang/triflux" }],
    plugins: [{ id: "triflux@triflux" }, { id: "triflux-mods@other" }],
  });
  assert.deepEqual(other.calls, [...reads, add]);
  assert.deepEqual(other.logs, [hint]);
});
