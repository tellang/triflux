import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { collectInstallFiles } from "../../scripts/setup.mjs";

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("Jev 배포 tarball과 공유 설치 경로에서 bridge가 개발 root 없이 실행된다", (t) => {
  const root = process.cwd();
  const temp = mkdtempSync(join(tmpdir(), "tfx-jev-pack-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH,
    HOME: temp,
    CODEX_HOME: join(temp, "codex"),
    XDG_CONFIG_HOME: join(temp, "config"),
    npm_config_cache: join(temp, "npm-cache"),
    TFX_JEV: "off",
  };
  for (const name of ["core", "triflux"]) {
    const output = JSON.parse(
      run(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", temp],
        join(root, "packages", name),
        env,
      ),
    );
    const extracted = join(temp, name);
    mkdirSync(extracted);
    run(
      "tar",
      ["-xzf", join(temp, output[0].filename), "-C", extracted],
      root,
      env,
    );
    const packageRoot = join(extracted, "package");
    mkdirSync(join(temp, "config", "triflux"), { recursive: true });
    const keyFile = join(temp, "private.env");
    writeFileSync(keyFile, "TYPESAFE_API_KEY=FAKE_PACK_KEY\n", { mode: 0o600 });
    writeFileSync(
      join(temp, "config", "triflux", "jev.json"),
      JSON.stringify({ enabled: true, apiKeyFile: keyFile }),
    );
    const preload = join(temp, "mock-http.mjs");
    writeFileSync(
      preload,
      `globalThis.fetch = async (_url, init) => {
      if (init.headers.Authorization !== "Bearer FAKE_PACK_KEY") throw new Error("mock auth mismatch");
      return { ok: true, json: async () => ({ answers: {
        complexity: { choice: "standard", confidence: 1 },
        execution_mode: { choice: "workspace_auto", confidence: 1 },
        mcp_profile: { choice: "none", confidence: 1 }
      } }) };
    };`,
    );
    const hostEnv = { ...env };
    delete hostEnv.TFX_JEV;
    const mockArgs = [
      "--import",
      preload,
      join(packageRoot, "hub/bridge.mjs"),
      "judge-route",
      "--prompt",
      "fixture",
    ];
    const hostOutput = run(process.execPath, mockArgs, temp, hostEnv);
    const mocked = JSON.parse(hostOutput);
    assert.equal(mocked.enabled, true);
    assert.equal(mocked.routing.complexity, "standard");
    assert.doesNotMatch(hostOutput, /FAKE_PACK_KEY|Authorization/);

    for (const file of [
      "hub/bridge.mjs",
      "hub/lib/jev-addon.mjs",
      "hub/lib/jev-host-config.mjs",
    ])
      assert.ok(existsSync(join(packageRoot, file)), file);
    const stdout = run(
      process.execPath,
      [
        join(packageRoot, "hub/bridge.mjs"),
        "judge-route",
        "--prompt",
        "fixture",
      ],
      temp,
      env,
    );
    assert.deepEqual(JSON.parse(stdout), {
      ok: true,
      enabled: false,
      routing: null,
    });
    if (name !== "triflux") continue;
    const installed = join(temp, "installed", ".claude");
    const files = collectInstallFiles(packageRoot);
    assert.ok(files.includes("hub/bridge.mjs"));
    for (const file of files) {
      const target = join(installed, file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(packageRoot, file), target);
    }
    rmSync(extracted, { recursive: true, force: true });
    const bridge = join(installed, "hub/bridge.mjs");
    assert.deepEqual(
      JSON.parse(
        run(
          process.execPath,
          [bridge, "judge-route", "--prompt", "fixture"],
          temp,
          env,
        ),
      ),
      { ok: true, enabled: false, routing: null },
    );
    mockArgs[2] = bridge;
    assert.equal(
      JSON.parse(run(process.execPath, mockArgs, temp, hostEnv)).routing
        .complexity,
      "standard",
    );
    // 개발 breadcrumb 없이 shell이 설치 사본을 선택하는지 확인한다.
    const route = readFileSync(join(installed, "scripts/tfx-route.sh"), "utf8");
    const guard = route.slice(
      route.indexOf("jev_enabled() {"),
      route.indexOf("\nbridge_json_get()"),
    );
    const script = `resolve_bridge_script() { printf '%s\\n' "$INSTALLED_BRIDGE"; }; ${guard}\njev_enabled`;
    const result = spawnSync("bash", ["-c", script], {
      cwd: temp,
      env: { ...hostEnv, INSTALLED_BRIDGE: bridge },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout + result.stderr, "");
    const disabled = spawnSync("bash", ["-c", script], {
      cwd: temp,
      env: { ...hostEnv, INSTALLED_BRIDGE: bridge, TFX_JEV: "false" },
      encoding: "utf8",
    });
    assert.equal(disabled.status, 1);
    assert.equal(disabled.stdout + disabled.stderr, "");
    const apply = route.match(/^apply_jev_pre_route\(\) \{[\s\S]*?^\}/m)[0];
    const preRoute = `${script.slice(0, script.lastIndexOf("\njev_enabled"))}
      bridge_cli() { "$NODE_BIN" --import "$MOCK_HTTP" "$INSTALLED_BRIDGE" "$@"; }
      ${apply}
      AGENT_TYPE=executor
      PROMPT=fixture
      TFX_CODEX_PROFILE=auto
      TFX_GEMINI_PROFILE=
      TFX_EXECUTION_MODE=auto
      MCP_PROFILE=auto
      apply_jev_pre_route
      printf '%s' "$TFX_CODEX_PROFILE"`;
    const routed = spawnSync("bash", ["-c", preRoute], {
      cwd: temp,
      env: {
        ...hostEnv,
        INSTALLED_BRIDGE: bridge,
        NODE_BIN: process.execPath,
        MOCK_HTTP: preload,
      },
      encoding: "utf8",
    });
    assert.equal(routed.status, 0, routed.stderr);
    assert.equal(routed.stdout, "sol_high");
    assert.doesNotMatch(
      routed.stdout + routed.stderr,
      /FAKE_PACK_KEY|Authorization/,
    );
  }
});
