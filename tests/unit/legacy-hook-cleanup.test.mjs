import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
    typeof settings === "string"
      ? settings
      : `${JSON.stringify(settings, null, 2)}\n`,
  );
  return { dir, settingsPath };
}

const hook = (command) => ({ type: "command", command });
const entry = (...hooks) => ({ matcher: "*", hooks });

test("triflux hook만 제거하고 빈 이벤트를 지운다", () => {
  const { settingsPath, dir } = fixture({
    theme: "dark",
    hooks: {
      SessionStart: [entry(hook('node "/opt/triflux/scripts/setup.mjs"'))],
      UserPromptSubmit: [
        entry(
          hook(
            'node "${PLUGIN_ROOT}/scripts/run.cjs" "${PLUGIN_ROOT}/scripts/keyword-detector.mjs"',
          ),
        ),
      ],
    },
  });
  const original = readFileSync(settingsPath, "utf8");
  const result = cleanupLegacyHooks({ settingsPath });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.removed, 2);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
    theme: "dark",
  });
  assert.equal(readFileSync(result.backupPath, "utf8"), original);
  assert.equal(
    readdirSync(dir).filter((name) => name.includes("tfx-bak-")).length,
    1,
  );
});

test("혼합 엔트리의 다른 hook과 gstack, session-vault hook을 보존한다", () => {
  const gstack = hook("node /opt/gstack/hooks/session-start.mjs");
  const vault = hook("bash /opt/session-vault/scripts/start_hook.sh");
  const user = hook("node /opt/my-hooks/hook-orchestrator.mjs");
  const unrelated = hook(
    "node /opt/triflux/launcher.mjs /opt/other/hooks/safety-guard.mjs",
  );
  const otherPlugin = hook("node /opt/triflux/other-plugin/scripts/setup.mjs");
  const genericRoot = hook('node "${PLUGIN_ROOT}/scripts/setup.mjs"');
  const echo = hook("echo /opt/triflux/hooks/pipeline-stop.mjs");
  const quotedData = hook(
    'node -e "console.log(/opt/triflux/hooks/pipeline-stop.mjs"',
  );
  const argumentData = hook(
    'node /opt/other/report.mjs "/opt/triflux/hooks/safety-guard.mjs"',
  );
  const settings = {
    hooks: {
      SessionStart: [
        entry(hook('node "/opt/triflux/hooks/hook-orchestrator.mjs"'), gstack),
        entry(vault),
      ],
      Stop: [
        entry(
          user,
          unrelated,
          otherPlugin,
          genericRoot,
          echo,
          quotedData,
          argumentData,
        ),
      ],
    },
  };
  const { settingsPath } = fixture(settings);
  const result = cleanupLegacyHooks({ settingsPath });
  assert.equal(result.removed, 1);
  settings.hooks.SessionStart[0].hooks.shift();
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), settings);
});

test("공백이 있는 패키지 경로와 설치된 gate hook을 제거한다", () => {
  const { settingsPath } = fixture({
    hooks: {
      PreToolUse: [
        entry(
          hook('node "/Users/a/My Projects/triflux/hooks/safety-guard.mjs"'),
          hook('node "${HOME}/.claude/scripts/tfx-gate-activate.mjs"'),
        ),
      ],
    },
  });
  assert.equal(cleanupLegacyHooks({ settingsPath }).removed, 2);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {});
});

test("다른 사용자의 같은 이름 gate hook은 보존한다", () => {
  const unrelated = hook(
    'node "/opt/another-user/.claude/scripts/tfx-gate-activate.mjs"',
  );
  const installed = hook(
    `node "${join(homedir(), ".claude/scripts/tfx-gate-activate.mjs")}"`,
  );
  const { settingsPath } = fixture({
    hooks: { PreToolUse: [entry(unrelated, installed)] },
  });
  assert.equal(cleanupLegacyHooks({ settingsPath }).removed, 1);
  assert.deepEqual(
    JSON.parse(readFileSync(settingsPath, "utf8")).hooks.PreToolUse[0].hooks,
    [unrelated],
  );
});

test("명시된 triflux fallback 경로만 제거한다", () => {
  const { settingsPath } = fixture({
    hooks: {
      SessionStart: [
        entry(
          hook('node "${PLUGIN_ROOT:-/opt/triflux}/scripts/setup.mjs"'),
          hook(
            'node "${PLUGIN_ROOT:-/opt/triflux/.worktrees/infra-slim}/scripts/setup.mjs"',
          ),
          hook('node "${PLUGIN_ROOT:-/opt/triflux/10.49.0}/scripts/setup.mjs"'),
          hook('node "${PLUGIN_ROOT:-/opt/other}/scripts/setup.mjs"'),
        ),
      ],
    },
  });
  assert.equal(cleanupLegacyHooks({ settingsPath }).removed, 3);
  assert.equal(
    JSON.parse(readFileSync(settingsPath, "utf8")).hooks.SessionStart[0].hooks
      .length,
    1,
  );
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

test("symlink settings의 실제 파일을 교체하고 링크와 백업을 보존한다", () => {
  const { dir, settingsPath } = fixture({ theme: "unused" });
  const targetDir = join(dir, "shared");
  mkdirSync(targetDir);
  const targetPath = join(targetDir, "settings.json");
  const original = `${JSON.stringify({
    theme: "dark",
    hooks: { Stop: [entry(hook("node /opt/triflux/hooks/pipeline-stop.mjs"))] },
  })}\n`;
  writeFileSync(targetPath, original);
  rmSync(settingsPath);
  symlinkSync(targetPath, settingsPath);

  const first = cleanupLegacyHooks({ settingsPath });
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.equal(lstatSync(settingsPath).isSymbolicLink(), true);
  assert.equal(readlinkSync(settingsPath), targetPath);
  assert.deepEqual(JSON.parse(readFileSync(targetPath, "utf8")), {
    theme: "dark",
  });
  assert.equal(readFileSync(first.backupPath, "utf8"), original);
  const second = cleanupLegacyHooks({ settingsPath });
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
  assert.equal(second.removed, 0);
  assert.equal(
    readdirSync(dir).filter((name) => name.includes("tfx-bak-")).length,
    1,
  );
});

test("symlink의 깨진 JSON 대상과 링크를 그대로 보존한다", () => {
  const { dir, settingsPath } = fixture({ theme: "unused" });
  const targetPath = join(dir, "broken-settings.json");
  writeFileSync(targetPath, "{broken json");
  rmSync(settingsPath);
  symlinkSync(targetPath, settingsPath);
  const result = cleanupLegacyHooks({ settingsPath });
  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  assert.equal(lstatSync(settingsPath).isSymbolicLink(), true);
  assert.equal(readlinkSync(settingsPath), targetPath);
  assert.equal(readFileSync(targetPath, "utf8"), "{broken json");
  assert.equal(result.backupPath, null);
  assert.equal(
    readdirSync(dir).filter((name) => name.includes("tfx-bak-")).length,
    0,
  );
});

test("끊어진 settings symlink를 무변경 성공으로 취급하지 않는다", () => {
  const { dir, settingsPath } = fixture({ theme: "unused" });
  const targetPath = join(dir, "missing-settings.json");
  rmSync(settingsPath);
  symlinkSync(targetPath, settingsPath);
  const result = cleanupLegacyHooks({ settingsPath });
  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  assert.equal(lstatSync(settingsPath).isSymbolicLink(), true);
  assert.equal(readlinkSync(settingsPath), targetPath);
  assert.equal(result.backupPath, null);
});

test("점검 모드는 남은 hook만 보고하고 파일을 바꾸지 않는다", () => {
  const { settingsPath, dir } = fixture({
    hooks: { Stop: [entry(hook("node /opt/triflux/hooks/pipeline-stop.mjs"))] },
  });
  const original = readFileSync(settingsPath, "utf8");
  const result = cleanupLegacyHooks({ settingsPath, dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.wouldChange, true);
  assert.equal(result.removed, 1);
  assert.equal(readFileSync(settingsPath, "utf8"), original);
  assert.deepEqual(readdirSync(dir), ["settings.json"]);
});

test("옛 node -e bootstrap을 제거하되 단순 파일명 언급은 보존한다", () => {
  const bootstrap =
    "node -e \"const root=fs.readFileSync(path.join(os.homedir(),'.claude','scripts','.tfx-pkg-root'));cp.spawnSync(process.execPath,[path.join(root,'hooks','hook-orchestrator.mjs')]);\"";
  const unrelated = hook("node /opt/other/hooks/safety-guard.mjs");
  const { settingsPath } = fixture({
    hooks: { Stop: [entry(hook(bootstrap), unrelated)] },
  });
  assert.equal(cleanupLegacyHooks({ settingsPath }).removed, 1);
  assert.deepEqual(
    JSON.parse(readFileSync(settingsPath, "utf8")).hooks.Stop[0].hooks,
    [unrelated],
  );
});

test("전환 stub 두 개는 입력을 읽고 출력 없이 성공하며 self-cleanup한다", () => {
  for (const filename of [
    "hook-orchestrator.mjs",
    "claude-cwd-projection-refresh.mjs",
  ]) {
    const { dir, settingsPath } = fixture({
      hooks: { Stop: [entry(hook(`node /opt/triflux/hooks/${filename}`))] },
    });
    const stub = resolve("hooks", filename);
    const run = spawnSync(process.execPath, [stub], {
      input: '{"hook_event_name":"Stop"}',
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "");
    assert.equal(run.stderr, "");
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {});
  }
});

test("전환 stub은 정리 실패에도 조용히 성공한다", () => {
  const { dir } = fixture("{bad json");
  const run = spawnSync(
    process.execPath,
    [resolve("hooks/hook-orchestrator.mjs")],
    {
      input: "{}",
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    },
  );
  assert.equal(run.status, 0);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, "");
});
