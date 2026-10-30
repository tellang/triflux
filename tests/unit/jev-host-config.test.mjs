import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  isJevEnabled,
  queryJev,
  queryJevBatch,
  resolveJevApiKey,
} from "../../hub/lib/jev-addon.mjs";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "tfx-jev-host-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const config = join(home, "xdg", "triflux", "jev.json");
  const key = join(home, "private.env");
  mkdirSync(join(home, "xdg", "triflux"), { recursive: true });
  writeFileSync(key, "TYPESAFE_API_KEY='FAKE_HOST_KEY'\n", { mode: 0o600 });
  writeFileSync(config, JSON.stringify({ enabled: true, apiKeyFile: key }));
  return {
    home,
    config,
    key,
    env: { HOME: home, XDG_CONFIG_HOME: join(home, "xdg"), TFX_JEV_STATS: "0" },
  };
}

test("Jev host config: env 격리와 명시 disable을 보존하고 호출마다 다시 읽는다", (t) => {
  const f = fixture(t);
  assert.equal(isJevEnabled({ env: f.env }), true);
  assert.equal(resolveJevApiKey(f.env), "FAKE_HOST_KEY");
  assert.equal(isJevEnabled({ env: {} }), false);
  assert.equal(resolveJevApiKey({}), null);
  for (const flag of ["0", "false", "off", " OFF "]) {
    assert.equal(isJevEnabled({ env: { ...f.env, TFX_JEV: flag } }), false);
    assert.equal(resolveJevApiKey({ ...f.env, TFX_JEV: flag }), null);
  }
  assert.equal(
    resolveJevApiKey({ ...f.env, JEV_API_KEY: "FAKE_ENV_KEY" }),
    "FAKE_ENV_KEY",
  );
  writeFileSync(
    f.config,
    JSON.stringify({ enabled: false, apiKeyFile: f.key }),
  );
  assert.equal(isJevEnabled({ env: f.env }), false);
  assert.equal(
    isJevEnabled({ env: { ...f.env, JEV_API_KEY: "FAKE_ENV_KEY" } }),
    true,
  );
  assert.equal(
    isJevEnabled({ env: { ...f.env, TFX_JEV_CLI: "/fake/jev" } }),
    true,
  );
});

test("Jev host config: private literal만 읽고 실패와 잘못된 권한은 null이다", (t) => {
  const f = fixture(t);
  for (const body of [
    "export JEV_API_KEY=FAKE_JEV_KEY\n",
    'JEV_API_KEY="FAKE_JEV_KEY"\nTYPESAFE_API_KEY=OTHER\n',
  ]) {
    writeFileSync(f.key, body);
    assert.equal(resolveJevApiKey(f.env), "FAKE_JEV_KEY");
  }
  for (const body of [
    "JEV_API_KEY=$(touch BAD)\n",
    'JEV_API_KEY="${OTHER}"\n',
    "JEV_API_KEY=x; echo bad\n",
    "JEV_API_KEY=one\nJEV_API_KEY=two\n",
    "JEV_API_KEY=\n",
    "x".repeat(65537),
  ]) {
    writeFileSync(f.key, body);
    assert.equal(resolveJevApiKey(f.env), null);
  }
  writeFileSync(f.key, "JEV_API_KEY=FAKE_JEV_KEY\n");
  chmodSync(f.key, 0o644);
  assert.equal(resolveJevApiKey(f.env), null);
  chmodSync(f.key, 0o600);
  if (process.getuid) {
    const uid = process.getuid();
    t.mock.method(process, "getuid", () => uid + 1);
    assert.equal(resolveJevApiKey(f.env), null);
    t.mock.restoreAll();
  }
  const link = join(f.home, "linked.env");
  symlinkSync(f.key, link);
  writeFileSync(f.config, JSON.stringify({ enabled: true, apiKeyFile: link }));
  assert.equal(resolveJevApiKey(f.env), null);
  for (const config of [
    "{",
    JSON.stringify({ enabled: true, apiKeyFile: "relative.env" }),
    "x".repeat(65537),
  ]) {
    writeFileSync(f.config, config);
    assert.equal(resolveJevApiKey(f.env), null);
  }
});

test("Jev host config: 명시 CLI가 host 키보다 우선한다", async (t) => {
  const f = fixture(t);
  let called = false;
  const response = await queryJev(
    { kind: "noul", query: "fixture" },
    {
      env: { ...f.env, TFX_JEV_CLI: "/fake/jev" },
      execFileImpl: async (bin, args, options) => {
        called = true;
        assert.equal(bin, "/fake/jev");
        assert.doesNotMatch(
          JSON.stringify({ args, env: options.env }),
          /FAKE_HOST_KEY/,
        );
        return { stdout: '{"value":true,"confidence":1}' };
      },
      fetchImpl: async () => {
        throw new Error("unexpected HTTP");
      },
    },
  );
  assert.equal(called, true);
  assert.deepEqual(response, { value: true, confidence: 1 });
});

test("Jev host config: mock HTTP만 사용하고 403과 timeout은 비밀 노출 없이 null이다", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const options = {
    env: f.env,
    fetchImpl: async (_url, init) => {
      calls += 1;
      assert.equal(init.headers.Authorization, "Bearer FAKE_HOST_KEY");
      assert.doesNotMatch(init.body, /FAKE_HOST_KEY/);
      return { ok: false, status: 403 };
    },
  };
  assert.equal(await queryJev({ kind: "noul", query: "safe" }, options), null);
  assert.equal(
    await queryJevBatch(
      { questions: { q: { kind: "noul", query: "safe" } } },
      options,
    ),
    null,
  );
  assert.equal(calls, 2);
  assert.equal(
    await queryJev(
      { kind: "noul", query: "safe" },
      {
        ...options,
        fetchImpl: async () => {
          throw new Error("FAKE_HOST_KEY timeout");
        },
      },
    ),
    null,
  );
  rmSync(f.key);
  assert.equal(isJevEnabled({ env: f.env }), true);
  assert.equal(await queryJev({ kind: "noul", query: "safe" }, options), null);
  assert.equal(calls, 2);
});

test("Jev host config: 부모 env 변경 없이 HUD와 shell guard가 hostenabled를 읽는다", (t) => {
  const f = fixture(t);
  const env = {
    PATH: process.env.PATH,
    ...f.env,
    CODEX_HOME: join(f.home, "codex"),
    BRIDGE_FIXTURE: join(process.cwd(), "hub", "bridge.mjs"),
  };
  const result = spawnSync(
    process.execPath,
    ["hud/hud-qos-status.mjs", "--cache-only"],
    {
      env,
      input: '{"product":"codex","terminal_width":120}',
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.replace(/\x1b\[[0-9;]*m/g, ""), /^c:.*\bj$/m);
  assert.doesNotMatch(result.stdout + result.stderr, /FAKE_HOST_KEY/);
  const route = readFileSync("scripts/tfx-route.sh", "utf8");
  const guard = route.slice(
    route.indexOf("jev_enabled() {"),
    route.indexOf("\nbridge_json_get()"),
  );
  assert.ok(guard.startsWith("jev_enabled() {"));
  const guarded = spawnSync(
    "bash",
    [
      "-c",
      `resolve_bridge_script() { printf '%s\\n' "$BRIDGE_FIXTURE"; }; ${guard}\njev_enabled`,
      "test",
      join(process.cwd(), "hub", "bridge.mjs"),
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.equal(guarded.stdout, "");
  assert.doesNotMatch(guarded.stdout + guarded.stderr, /FAKE_HOST_KEY/);
});
