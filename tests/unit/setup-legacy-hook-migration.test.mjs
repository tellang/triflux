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
test("setup이 이전 hook을 정리하고 백업을 남긴다", (t) => {
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
            ],
          },
        ],
      },
    }),
  );
  const original = readFileSync(f.settings, "utf8");
  const result = runSetup(f, "runCritical");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).code, 0);
  assert.equal(JSON.parse(readFileSync(f.settings, "utf8")).hooks, undefined);
  const backups = readdirSync(join(f.home, ".claude")).filter((name) =>
    name.startsWith("settings.json.tfx-bak-"),
  );
  assert.equal(backups.length, 1);
  assert.equal(
    readFileSync(join(f.home, ".claude", backups[0]), "utf8"),
    original,
  );
});
