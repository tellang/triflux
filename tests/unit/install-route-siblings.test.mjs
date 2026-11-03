import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { collectInstallFiles, PLUGIN_ROOT } from "../../scripts/setup.mjs";
import { BASH_EXE, toBashPath } from "../helpers/bash-path.mjs";

// 설치본 tfx-route.sh 는 ~/.claude/scripts 에서 돈다. 자기 옆에서 찾는 파일이 복사되지 않으면 조용히 건너뛴다.
test("tfx-route.sh 가 자기 옆에서 찾는 파일은 설치 목록에 있다", () => {
  const route = readFileSync(join(PLUGIN_ROOT, "scripts/tfx-route.sh"), "utf8");
  const siblings = [...route.matchAll(/\$\{route_dir\}\/([\w.-]+)/g)].map(
    ([, name]) => `scripts/${name}`,
  );
  assert.ok(siblings.length > 0);
  const installed = new Set(collectInstallFiles());
  assert.deepEqual(
    siblings.filter((file) => !installed.has(file)),
    [],
  );
});

test("설치된 MCP 필터는 의존성이 있는 package root를 우선하고 override와 폴백을 보존한다", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tfx-installed-mcp-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home");
  const host = join(home, ".claude");
  const pkg = join(dir, "package root");
  const cwd = join(dir, "workspace");
  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: join(home, ".codex"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    TMPDIR: join(dir, "tmp"),
    NODE_PATH: "",
    NODE_OPTIONS: "",
    TFX_JEV: "0",
  };
  for (const path of [
    cwd,
    env.HOME,
    env.CODEX_HOME,
    env.XDG_CONFIG_HOME,
    env.XDG_CACHE_HOME,
    env.TMPDIR,
  ])
    mkdirSync(path, { recursive: true });

  const entries = [
    "scripts/lib/mcp-filter.mjs",
    "hub/lib/mcp-recommendations.mjs",
    "hub/lib/worker-mcp.mjs",
  ];
  for (const file of collectInstallFiles(PLUGIN_ROOT, entries)) {
    for (const root of [host, pkg]) {
      const dest = join(root, file);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(join(PLUGIN_ROOT, file), dest);
    }
  }
  const require = createRequire(import.meta.url);
  const tomlDir = dirname(require.resolve("@iarna/toml/package.json"));
  // 심볼릭 링크 없이 복사해 개발 root의 node_modules와 분리한다.
  cpSync(tomlDir, join(pkg, "node_modules/@iarna/toml"), { recursive: true });
  assert.equal(existsSync(join(host, "node_modules")), false);

  const route = readFileSync(join(PLUGIN_ROOT, "scripts/tfx-route.sh"), "utf8");
  const breadcrumb = route.match(
    /^TFX_PKG_ROOT=""\n[\s\S]*?^unset _tfx_breadcrumb$/m,
  );
  assert.ok(breadcrumb);
  const functions = [
    "normalize_script_path",
    "_get_script_dir",
    "_resolve_script",
    "resolve_mcp_filter_script",
  ].map((name) => {
    const match = route.match(
      new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"),
    );
    assert.ok(match, name);
    return match[0];
  });
  const harness = join(host, "scripts/resolve-filter.sh");
  writeFileSync(
    harness,
    [
      "set -eu",
      breadcrumb[0],
      '_tfx_script_dir=""',
      'MCP_FILTER_SCRIPT="${1:-}"',
      ...functions,
      "selected=$(resolve_mcp_filter_script)",
      'printf "%s\\n" "$selected"',
      'if [[ "${2:-}" == run ]]; then exec "$3" "$selected" json --agent executor --profile reviewer --cli-type codex --codex-config "$4"; fi',
    ].join("\n"),
  );
  const breadcrumbFile = join(host, "scripts/.tfx-pkg-root");
  writeFileSync(breadcrumbFile, `${toBashPath(pkg)}\n`);
  const hostFilter = join(host, entries[0]);
  const pkgFilter = join(pkg, entries[0]);
  const config = join(env.CODEX_HOME, "config.toml");
  writeFileSync(
    config,
    [
      "[mcp_servers.context7]",
      'url = "https://fixture.invalid/mcp"',
      'enabled_tools = ["resolve-library-id"]',
      "[mcp_servers.playwright]",
      'url = "https://fixture.invalid/mcp"',
    ].join("\n"),
  );

  const broken = spawnSync(process.execPath, [hostFilter, "json"], {
    cwd,
    env,
    encoding: "utf8",
  });
  assert.notEqual(broken.status, 0);
  assert.match(broken.stderr, /Cannot find module '@iarna\/toml'/);
  const run = (override = "", mode = "") =>
    spawnSync(
      BASH_EXE,
      [
        toBashPath(harness),
        toBashPath(override),
        mode,
        toBashPath(process.execPath),
        toBashPath(config),
      ],
      { cwd, env, encoding: "utf8", timeout: 10_000 },
    );
  const installed = run("", "run");
  assert.equal(installed.status, 0, installed.stderr);
  const [selected, ...json] = installed.stdout.trim().split("\n");
  assert.equal(selected, toBashPath(pkgFilter));
  const policy = JSON.parse(json.join("\n"));
  assert.equal(policy.requestedProfile, "reviewer");
  assert.equal(policy.resolvedProfile, "reviewer");
  assert.deepEqual(policy.allowedServers, ["context7"]);
  assert.deepEqual(policy.codexConfig.mcp_servers, {
    context7: { enabled: true, enabled_tools: ["resolve-library-id"] },
    playwright: { enabled: false },
  });
  const dependencies = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { pathToFileURL } from "node:url"; for (const path of process.argv.slice(1)) await import(pathToFileURL(path));',
      ...entries.slice(1).map((file) => join(pkg, file)),
    ],
    { cwd, env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(dependencies.status, 0, dependencies.stderr);

  assert.equal(run(hostFilter).stdout.trim(), toBashPath(hostFilter));
  assert.equal(
    run(join(dir, "missing override")).stdout.trim(),
    toBashPath(pkgFilter),
  );
  rmSync(pkgFilter);
  for (const root of [pkg, "", join(dir, "missing package")]) {
    writeFileSync(breadcrumbFile, `${toBashPath(root)}\n`);
    const fallback = run();
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.equal(fallback.stdout.trim(), toBashPath(hostFilter));
  }
  rmSync(breadcrumbFile);
  assert.equal(run().stdout.trim(), toBashPath(hostFilter));
  rmSync(hostFilter);
  for (const file of ["scripts/lib/mcp-filter.mjs", "lib/mcp-filter.mjs"]) {
    const fallback = join(cwd, file);
    mkdirSync(dirname(fallback), { recursive: true });
    writeFileSync(fallback, "");
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), toBashPath(fallback));
    rmSync(fallback);
  }
});
