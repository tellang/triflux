import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { collectInstallFiles } from "../../scripts/setup.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "iterm-layout-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      CODEX_HOME: join(root, "codex"),
      TMPDIR: root,
      TFX_JEV: "0",
      npm_config_cache: join(root, "npm-cache"),
    },
  };
}

function verifyRuntime(root, env) {
  const program = `
    import { runItermLayout } from ${JSON.stringify(pathToFileURL(join(root, "hub/team/iterm-layout.mjs")).href)};
    const result = await runItermLayout({action:'inspect',project:{key:'fixture'}}, {
      env: process.env, statePath: ${JSON.stringify(join(env.HOME, "state.json"))},
      bridge: async () => ({snapshot:{windows:[]}})
    });
    if (!result.ok || result.applied || result.plan.changed) process.exit(1);
    console.log('installed-runtime-ok');
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", program],
    { env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /installed-runtime-ok/);
}

test("setup SYNC_MAP의 Python bridge와 Node 의존성은 임시 설치본에서 실행된다", (t) => {
  const f = fixture(t);
  const files = collectInstallFiles();
  assert.ok(files.includes("hub/team/iterm-layout.py"));
  assert.ok(files.includes("hub/team/iterm-layout.mjs"));
  const installed = join(f.root, "home/.claude");
  for (const file of files) {
    const target = join(installed, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file, target);
  }
  verifyRuntime(installed, f.env);
});

test("npm tarball의 새 bridge는 개발 checkout 없이 로드된다", (t) => {
  const f = fixture(t);
  const packed = spawnSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", f.root],
    { cwd: "packages/triflux", env: f.env, encoding: "utf8", timeout: 30000 },
  );
  assert.equal(packed.status, 0, packed.stderr);
  const [info] = JSON.parse(packed.stdout);
  for (const path of [
    "hub/team/iterm-layout.mjs",
    "hub/team/iterm-layout.py",
    "bin/tfx-live.mjs",
  ])
    assert.ok(
      info.files.some((file) => file.path === path),
      path,
    );
  const extracted = spawnSync(
    "tar",
    ["-xzf", join(f.root, info.filename), "-C", f.root],
    { encoding: "utf8" },
  );
  assert.equal(extracted.status, 0, extracted.stderr);
  verifyRuntime(join(f.root, "package"), f.env);
});
