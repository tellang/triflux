import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { canAskUser, runConsentSteps } from "../../scripts/setup.mjs";

const SETUP_URL = new URL("../../scripts/setup.mjs", import.meta.url).href;
const TTY = { isTTY: true };

function fakeSteps({ interactive, answer, trusted = false }) {
  const calls = { asked: [], run: [], hooks: [], logs: [] };
  const options = {
    platform: "win32",
    interactive,
    ask: async (question) => {
      calls.asked.push(question);
      return answer;
    },
    hasCommand: () => false,
    run: (command, args) => calls.run.push([command, args]),
    ensureHooks: (opts) => {
      calls.hooks.push(opts);
      return { skipped: false, changedHooks: true, trusted };
    },
    log: (message) => calls.logs.push(message),
    warn: (message) => calls.logs.push(message),
  };
  return { calls, options };
}

describe("setup 동의 단계", () => {
  it("postinstall, CI, TTY 없음에서는 묻지 않는다", () => {
    const io = { input: TTY, output: TTY };
    assert.equal(canAskUser({ env: {}, ...io }), true);
    assert.equal(
      canAskUser({ env: { npm_lifecycle_event: "postinstall" }, ...io }),
      false,
    );
    assert.equal(canAskUser({ env: { CI: "1" }, ...io }), false);
    assert.equal(
      canAskUser({ env: {}, input: { isTTY: false }, output: TTY }),
      false,
    );
  });

  it("비대화형이면 winget 과 훅 승인을 하지 않고 안내만 남긴다", async () => {
    const { calls, options } = fakeSteps({ interactive: false });
    const result = await runConsentSteps(options);
    assert.deepEqual(result, { psmux: "deferred", codexHooks: "deferred" });
    assert.equal(calls.asked.length, 0);
    assert.equal(calls.run.length, 0);
    assert.deepEqual(calls.hooks, [{ trust: false }]);
    assert.ok(calls.logs.some((line) => line.includes("tfx setup")));
    assert.ok(calls.logs.some((line) => line.includes("Codex 가 직접 묻는다")));
  });

  it("동의하면 winget 을 --exact 로 실행하고 훅 승인을 기록한다", async () => {
    const { calls, options } = fakeSteps({ interactive: true, answer: true });
    const result = await runConsentSteps(options);
    assert.deepEqual(result, { psmux: "installed", codexHooks: "approved" });
    const [[command, args]] = calls.run;
    assert.equal(command, "winget");
    assert.deepEqual(args.slice(0, 4), [
      "install",
      "--exact",
      "--id",
      "marlocarlo.psmux",
    ]);
    assert.deepEqual(calls.hooks, [{ trust: false }, { trust: true }]);
  });

  it("거절하면 설치와 승인 기록을 하지 않는다", async () => {
    const { calls, options } = fakeSteps({ interactive: true, answer: false });
    const result = await runConsentSteps(options);
    assert.deepEqual(result, { psmux: "declined", codexHooks: "declined" });
    assert.equal(calls.run.length, 0);
    assert.deepEqual(calls.hooks, [{ trust: false }]);
  });

  it("이미 승인된 훅은 다시 묻지 않는다", async () => {
    const { calls, options } = fakeSteps({
      interactive: true,
      answer: true,
      trusted: true,
    });
    options.hasCommand = () => true;
    const result = await runConsentSteps(options);
    assert.deepEqual(result, { psmux: "present", codexHooks: "trusted" });
    assert.equal(calls.asked.length, 0);
  });
});

describe("setup 이 만드는 Codex 설정 파일 권한", () => {
  it("새로 만드는 config.toml 과 프로필 파일은 0600 이다", {
    skip: process.platform === "win32",
  }, () => {
    const home = mkdtempSync(join(tmpdir(), "tfx-setup-consent-"));
    try {
      const env = { ...process.env, HOME: home, TFX_CODEX_CONFIG_SYNC: "1" };
      delete env.TRIFLUX_TEST_HOME;
      delete env.CI;
      const script = `import(${JSON.stringify(SETUP_URL)}).then((m) => process.stdout.write(JSON.stringify(m.ensureCodexProfiles())));`;
      const child = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", script],
        { env, encoding: "utf8", timeout: 30000 },
      );
      assert.equal(child.status, 0, child.stderr);
      assert.equal(JSON.parse(child.stdout).ok, true);
      const codexDir = join(home, ".codex");
      const files = readdirSync(codexDir).filter((name) =>
        name.endsWith(".toml"),
      );
      assert.ok(files.includes("config.toml"));
      for (const name of files)
        assert.equal(statSync(join(codexDir, name)).mode & 0o777, 0o600, name);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
