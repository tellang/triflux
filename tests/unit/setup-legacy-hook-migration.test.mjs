import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const setupUrl = new URL("../../scripts/setup.mjs", import.meta.url).href;
const cli = new URL("../../bin/triflux.mjs", import.meta.url);
test("실제 발행 패키지도 postinstall에서 설치 이주를 실행한다", () => {
  const manifest = JSON.parse(
    readFileSync(
      new URL("../../packages/triflux/package.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(manifest.scripts?.postinstall, "node scripts/setup.mjs");
  assert.equal(manifest.scripts?.prepare, undefined);
});
function fixture(t, content) {
  const home = mkdtempSync(join(tmpdir(), "tfx-setup-migration-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".claude"));
  const settings = join(home, ".claude", "settings.json");
  writeFileSync(settings, content);
  return {
    home,
    settings,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      TRIFLUX_TEST_HOME: home,
      TMPDIR: home,
      CI: "true",
      TFX_CODEX_CONFIG_SYNC: "0",
    },
  };
}
function runSetup(f, name) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(setupUrl)}); const result = await m.${name}({argv: []}); process.stdout.write(JSON.stringify(result));`,
    ],
    { env: f.env, encoding: "utf8", timeout: 30000 },
  );
}
for (const entry of ["runCritical", "runDeferred"]) {
  test(`${entry}: 깨진 settings JSON은 그대로 두고 실패를 보고한다`, (t) => {
    const f = fixture(t, "{ broken");
    const result = runSetup(f, entry);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.code, 1);
    assert.match(report.stderr, /정리 실패/);
    assert.equal(readFileSync(f.settings, "utf8"), "{ broken");
    assert.deepEqual(readdirSync(join(f.home, ".claude")), ["settings.json"]);
  });
}
test("critical setup은 기존 triflux hook을 지우고 사용자 hook을 보존한다", (t) => {
  const custom = { type: "command", command: "bash /user/hooks/custom.sh" };
  const f = fixture(
    t,
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command:
                  'node "/opt/node_modules/triflux/hooks/hook-orchestrator.mjs"',
              },
              custom,
            ],
          },
        ],
      },
    }),
  );
  const result = runSetup(f, "runCritical");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(f.settings, "utf8")).hooks, {
    SessionStart: [{ hooks: [custom] }],
  });
  assert.equal(
    readdirSync(join(f.home, ".claude")).filter((name) =>
      name.startsWith("settings.json.tfx-bak-"),
    ).length,
    1,
  );
});
test("tfx setup도 깨진 settings JSON을 덮어쓰지 않는다", (t) => {
  const f = fixture(t, "{ broken");
  const result = spawnSync(process.execPath, [cli.pathname, "setup"], {
    env: f.env,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(f.settings, "utf8"), "{ broken");
});
