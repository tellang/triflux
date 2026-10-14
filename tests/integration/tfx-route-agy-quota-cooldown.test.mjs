import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BASH_EXE, toBashPath } from "../helpers/bash-path.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const route = toBashPath(join(root, "scripts/tfx-route.sh"));
const quota =
  "Quota pool exhausted. Contact your administrator to enable overages. Resets in 118h56m34s.\nError ID: fixture-error\n";
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(TFX_|CODEX_|CLAUDE_|CLAUDECODE|GEMINI_|XDG_CONFIG_HOME|NODE_BIN|AGY_BIN)/.test(
        key,
      ),
  ),
);

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "tfx-agy-cooldown-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const temp = join(home, "tmp");
  const stateDir =
    process.platform === "win32"
      ? temp
      : join(temp, `triflux-${process.getuid()}`);
  const stateFile = join(stateDir, "tfx-agy-quota-reset");
  const callsFile = join(home, "calls.jsonl");
  mkdirSync(join(home, ".codex"));
  mkdirSync(join(home, ".claude/cache"), { recursive: true });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".codex/config.toml"), 'model = "gpt-6-sol"\n');
  writeFileSync(
    join(home, ".claude/cache/claude-usage-cache.json"),
    JSON.stringify({ data: { weeklyPercent: 85 } }),
  );
  const fakeClaude = pathToFileURL(
    join(root, "tests/fixtures/fake-claude-cli.mjs"),
  ).href;
  for (const provider of ["agy", "codex", "claude"]) {
    writeFileSync(
      join(home, provider),
      String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('--print --dangerously-skip-permissions'); }
else if (args.includes('models')) { console.log(''); }
else {
  fs.appendFileSync(process.env.CALLS_FILE, JSON.stringify({ provider: '${provider}', from: process.env.TFX_REROUTED_FROM }) + '\n');
  if ('${provider}' === 'claude') { import(${JSON.stringify(fakeClaude)}); }
  else if ('${provider}' === 'agy') {
    const output = process.env.FAKE_AGY_OUTPUT;
    if (process.env.FAKE_AGY_STDERR === '1') process.stderr.write(output);
    else process.stdout.write(output);
    process.exit(Number(process.env.FAKE_AGY_EXIT));
  } else {
    console.log(process.env.FAKE_CODEX_QUOTA === '1' ? 'quota exceeded' : 'codex fixture result');
    process.exit(process.env.FAKE_CODEX_QUOTA === '1' ? 1 : 0);
  }
}
`,
      { mode: 0o755 },
    );
  }
  return {
    stateFile,
    stateDir,
    calls: () =>
      existsSync(callsFile)
        ? readFileSync(callsFile, "utf8").trim().split("\n").map(JSON.parse)
        : [],
    run({ role = "writer", env = {} } = {}) {
      const r = spawnSync(BASH_EXE, [route, role, "fixture task", "minimal"], {
        cwd: home,
        encoding: "utf8",
        timeout: 20_000,
        env: {
          ...baseEnv,
          HOME: home,
          USERPROFILE: home,
          CODEX_HOME: join(home, ".codex"),
          XDG_CONFIG_HOME: join(home, ".config"),
          TFX_MACHINE_PROFILE_PATH: join(home, "machine-profile.env"),
          TMPDIR: temp,
          TMP: temp,
          TEMP: temp,
          NODE_BIN: process.execPath,
          CODEX_BIN: toBashPath(join(home, "codex")),
          AGY_BIN: toBashPath(join(home, "agy")),
          CLAUDE_BIN: toBashPath(join(home, "claude")),
          CALLS_FILE: callsFile,
          GH_TOKEN: "fixture-token",
          TFX_PREFLIGHT_LOADED: "1",
          TFX_CODEX_OK: "1",
          TFX_ANTIGRAVITY_OK: "1",
          TFX_DISABLE_CODEX: "0",
          TFX_DISABLE_ANTIGRAVITY: "0",
          TFX_HEARTBEAT: "0",
          TFX_HARD_CEILING_SEC: "0",
          TFX_MCP_HEALTH_CHECK: "0",
          TFX_GEMINI_NO_MODEL: "1",
          FAKE_AGY_OUTPUT: quota,
          FAKE_AGY_EXIT: "0",
          ...env,
        },
      });
      assert.ifError(r.error);
      return { ...r, output: `${r.stdout}\n${r.stderr}` };
    },
  };
}

for (const fallback of ["claude", "codex"]) {
  for (const exit of ["0", "1"]) {
    for (const stream of ["stdout", "stderr"]) {
      test(`agy quota (${stream}, exit ${exit}) immediately retries with ${fallback}`, (t) => {
        const f = fixture(t);
        const started = Math.floor(Date.now() / 1000);
        const r = f.run({
          role: "executor",
          env: {
            TFX_CLI_MODE: "antigravity",
            TFX_ANTIGRAVITY_FALLBACK: fallback,
            FAKE_AGY_EXIT: exit,
            FAKE_AGY_STDERR: stream === "stderr" ? "1" : "0",
          },
        });
        assert.equal(r.status, 0, r.output);
        assert.deepEqual(f.calls(), [
          { provider: "agy" },
          { provider: fallback, from: "antigravity" },
        ]);
        const reset = Number(readFileSync(f.stateFile, "utf8"));
        const delay = 118 * 3600 + 56 * 60 + 34;
        assert.ok(reset >= started + delay);
        assert.ok(reset <= Math.floor(Date.now() / 1000) + delay);
        assert.match(
          r.stderr,
          new RegExp(`agy 쿼터 소진, .+까지 ${fallback}으로`),
        );
        assert.match(r.output, /rerouted_from=antigravity/);
        if (process.platform !== "win32") {
          assert.equal(statSync(f.stateDir).mode & 0o777, 0o700);
          assert.equal(statSync(f.stateFile).mode & 0o777, 0o600);
        }
      });
    }
  }

  test(`cooldown skips agy with ${fallback} and expires back to agy`, (t) => {
    const f = fixture(t);
    writeFileSync(f.stateFile, `${Math.floor(Date.now() / 1000) + 3600}\n`);
    const env = {
      TFX_ANTIGRAVITY_FALLBACK: fallback,
      FAKE_AGY_OUTPUT: "agy recovered\n",
    };
    const blocked = f.run({ env });
    assert.equal(blocked.status, 0, blocked.output);
    assert.deepEqual(f.calls(), [{ provider: fallback }]);
    assert.match(
      blocked.stderr,
      new RegExp(`agy 쿼터 소진, .+까지 ${fallback}으로`),
    );
    writeFileSync(f.stateFile, `${Math.floor(Date.now() / 1000) - 1}\n`);
    const recovered = f.run({ env });
    assert.equal(recovered.status, 0, recovered.output);
    assert.deepEqual(f.calls(), [{ provider: fallback }, { provider: "agy" }]);
    assert.match(recovered.stdout, /agy recovered/);
    assert.doesNotMatch(recovered.stderr, /agy 쿼터 소진/);
  });
}

for (const [output, delay] of [
  ["Quota pool exhausted.\nError ID: fixture-error\n", 3600],
  ["Quota pool exhausted. Resets in 008h09m07s.\n", 8 * 3600 + 9 * 60 + 7],
]) {
  test(`records reset delay ${delay} even when rerouting is disabled`, (t) => {
    const f = fixture(t);
    const started = Math.floor(Date.now() / 1000);
    const r = f.run({
      env: { FAKE_AGY_OUTPUT: output, TFX_QUOTA_REROUTE: "0" },
    });
    assert.notEqual(r.status, 0, r.output);
    assert.doesNotMatch(r.output, /status: success/);
    const reset = Number(readFileSync(f.stateFile, "utf8"));
    assert.ok(reset >= started + delay);
    assert.ok(reset <= Math.floor(Date.now() / 1000) + delay);
    assert.deepEqual(f.calls(), [{ provider: "agy" }]);
  });
}

test("successful quota discussion is not a quota refusal", (t) => {
  const f = fixture(t);
  const r = f.run({
    env: { FAKE_AGY_OUTPUT: `${quota}Implemented quota handling.\n` },
  });
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(f.calls(), [{ provider: "agy" }]);
  assert.ok(!existsSync(f.stateFile));
});

test("auto mode cannot revive cooling agy when Codex is unavailable", (t) => {
  const f = fixture(t);
  writeFileSync(f.stateFile, `${Math.floor(Date.now() / 1000) + 3600}\n`);
  const r = f.run({
    role: "executor",
    env: { TFX_CODEX_OK: "0", TFX_ANTIGRAVITY_FALLBACK: "claude" },
  });
  assert.equal(r.status, 78, r.output);
  assert.deepEqual(f.calls(), []);
});

test("Argon quota retry and subsequent cooldown exclude the Codex author", (t) => {
  const f = fixture(t);
  const env = { TFX_REVIEW_AUTHOR: "codex" };
  const retry = f.run({ role: "code-reviewer", env });
  assert.equal(retry.status, 0, retry.output);
  assert.deepEqual(f.calls(), [
    { provider: "agy" },
    { provider: "claude", from: "antigravity" },
  ]);
  const blocked = f.run({ role: "quality-reviewer", env });
  assert.equal(blocked.status, 0, blocked.output);
  assert.deepEqual(
    f.calls().map((call) => call.provider),
    ["agy", "claude", "claude"],
  );
  assert.match(blocked.stderr, /agy 쿼터 소진, .+까지 claude으로/);
});

test("Argon quota cannot retry with the Claude author", (t) => {
  const f = fixture(t);
  const r = f.run({
    role: "code-reviewer",
    env: {
      TFX_REVIEW_AUTHOR: "claude",
      TFX_CODEX_OK: "0",
      TFX_ANTIGRAVITY_FALLBACK: "claude",
    },
  });
  assert.equal(r.status, 78, r.output);
  assert.deepEqual(f.calls(), [{ provider: "agy" }]);
});

test("a second quota failure cannot recursively reroute", (t) => {
  const f = fixture(t);
  const r = f.run({ env: { FAKE_CODEX_QUOTA: "1" } });
  assert.notEqual(r.status, 0, r.output);
  assert.deepEqual(f.calls(), [
    { provider: "agy" },
    { provider: "codex", from: "antigravity" },
  ]);
});
