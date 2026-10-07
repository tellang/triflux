import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { cleanupLegacyHooks } from "../../scripts/lib/legacy-hook-cleanup.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fixture(settings) {
  const dir = mkdtempSync(join(tmpdir(), "tfx-legacy-hook-test-"));
  dirs.push(dir);
  const settingsPath = join(dir, "settings.json");
  writeFileSync(
    settingsPath,
    typeof settings === "string" ? settings : JSON.stringify(settings),
  );
  return { dir, settingsPath };
}

const hook = (command) => ({ type: "command", command });
const entry = (...hooks) => ({ hooks });
const readSettings = (path) => JSON.parse(readFileSync(path, "utf8"));

test("직접 경로, PLUGIN_ROOT fallback, inline bootstrap을 제거한다", () => {
  const commands = [
    'node "/opt/triflux/hooks/hook-orchestrator.mjs"',
    'node "${PLUGIN_ROOT:-/opt/triflux}/scripts/setup.mjs"',
    "node -e \"const root=fs.readFileSync(path.join(os.homedir(),'.claude','scripts','.tfx-pkg-root'));cp.spawnSync(process.execPath,[path.join(root,'hooks','hook-orchestrator.mjs')]);\"",
  ];
  for (const command of commands) {
    const { settingsPath } = fixture({
      theme: "dark",
      hooks: { Stop: [entry(hook(command))] },
    });
    const original = readFileSync(settingsPath, "utf8");
    const result = cleanupLegacyHooks({ settingsPath });
    assert.equal(result.ok, true, command);
    assert.equal(result.removed, 1, command);
    assert.deepEqual(readSettings(settingsPath), { theme: "dark" });
    assert.equal(readFileSync(result.backupPath, "utf8"), original);
  }
});

test("혼합 엔트리의 gstack과 사용자 hook을 보존한다", () => {
  const gstack = hook("node /opt/gstack/hooks/session-start.mjs");
  const user = hook("bash /user/hooks/custom.sh");
  const { settingsPath } = fixture({
    hooks: {
      Stop: [
        entry(hook("node /opt/triflux/hooks/pipeline-stop.mjs"), gstack, user),
      ],
    },
  });
  assert.equal(cleanupLegacyHooks({ settingsPath }).removed, 1);
  assert.deepEqual(readSettings(settingsPath).hooks.Stop[0].hooks, [
    gstack,
    user,
  ]);
});

test("깨진 JSON은 백업도 쓰기도 하지 않는다", () => {
  const { settingsPath, dir } = fixture("{bad json");
  const result = cleanupLegacyHooks({ settingsPath });
  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  assert.equal(readFileSync(settingsPath, "utf8"), "{bad json");
  assert.deepEqual(readdirSync(dir), ["settings.json"]);
});

test("두 번째 실행은 무변경이며 백업을 추가하지 않는다", () => {
  const { settingsPath, dir } = fixture({
    hooks: { Stop: [entry(hook("node /opt/triflux/hooks/pipeline-stop.mjs"))] },
  });
  assert.equal(cleanupLegacyHooks({ settingsPath }).changed, true);
  const once = readFileSync(settingsPath, "utf8");
  const second = cleanupLegacyHooks({ settingsPath });
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
  assert.equal(second.removed, 0);
  assert.equal(readFileSync(settingsPath, "utf8"), once);
  assert.equal(
    readdirSync(dir).filter((name) => name.includes("tfx-bak-")).length,
    1,
  );
});

test("triflux를 언급만 하는 다른 command는 보존한다", () => {
  const commands = [
    "node /opt/other/report.mjs /opt/triflux/hooks/safety-guard.mjs",
    "echo /opt/triflux/hooks/pipeline-stop.mjs",
    "node /opt/triflux/other-plugin/scripts/setup.mjs",
  ];
  const { settingsPath, dir } = fixture({
    hooks: { Stop: [entry(...commands.map(hook))] },
  });
  const original = readFileSync(settingsPath, "utf8");
  const result = cleanupLegacyHooks({ settingsPath });
  assert.equal(result.removed, 0);
  assert.equal(result.changed, false);
  assert.equal(readFileSync(settingsPath, "utf8"), original);
  assert.deepEqual(readdirSync(dir), ["settings.json"]);
});
