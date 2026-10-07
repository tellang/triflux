import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { makeIsolatedCodexConfig } from "../helpers/codex-config-fixture.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

it("Codex MCP 설정은 파일 변경 없이 실행 인자로 전달한다", (t) => {
  const fixture = makeIsolatedCodexConfig();
  t.after(fixture.cleanup);
  const home = join(fixture.dir, "home");
  const bin = join(fixture.dir, "bin");
  const argsFile = join(fixture.dir, "args.json");
  mkdirSync(join(home, ".claude", "cache"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(
    join(home, ".claude", "cache", "mcp-inventory.json"),
    JSON.stringify({
      codex: {
        servers: ["context7", "exa", "computer-history", "cua_repl"].map(
          (name) => ({ name, status: "enabled" }),
        ),
      },
    }),
  );
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const codex = join(bin, "codex");
  writeFileSync(
    codex,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2)));
fs.copyFileSync(process.env.TFX_CODEX_CONFIG, process.env.CONFIG_DURING);
fs.writeFileSync(process.env.BACKUP_DURING, String(fs.existsSync(process.env.TFX_CODEX_CONFIG + ".pre-exec")));
console.log("fixture result");
`,
    { mode: 0o755 },
  );
  const original = readFileSync(fixture.path);
  const result = spawnSync(
    "/bin/bash",
    [
      join(repoRoot, "scripts", "tfx-route.sh"),
      "executor",
      "config probe",
      "executor",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: join(home, ".codex"),
        TFX_CODEX_HOME: join(home, ".codex"),
        TFX_CODEX_AUTH_FILE: "",
        XDG_CONFIG_HOME: join(home, ".config"),
        TFX_MACHINE_PROFILE_PATH: join(home, "machine-profile.env"),
        TMPDIR: fixture.dir,
        PATH: `${bin}:${process.env.PATH}`,
        CODEX_BIN: codex,
        TFX_CODEX_CONFIG: fixture.path,
        TFX_PREFLIGHT_LOADED: "1",
        TFX_CODEX_OK: "1",
        TFX_CLI_MODE: "codex",
        TFX_DISABLE_CODEX: "0",
        TFX_TEAM_NAME: "",
        TFX_RETRY_SNAPSHOT: "",
        TFX_RETRY_SNAPSHOT_FILE: "",
        TFX_INJECT_SKILL: "",
        TFX_MCP_HEALTH_CHECK: "0",
        TFX_HUB_ENSURE_SCRIPT: join(
          repoRoot,
          "tests",
          "fixtures",
          "no-op-hub-ensure.mjs",
        ),
        TFX_HEARTBEAT: "0",
        TFX_HARD_CEILING_SEC: "0",
        TFX_QUOTA_REROUTE: "0",
        ARGS_FILE: argsFile,
        CONFIG_DURING: join(fixture.dir, "config-during.toml"),
        BACKUP_DURING: join(fixture.dir, "backup-during.txt"),
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(fixture.path), original);
  assert.deepEqual(
    readFileSync(join(fixture.dir, "config-during.toml")),
    original,
  );
  assert.equal(existsSync(`${fixture.path}.pre-exec`), false);
  assert.equal(
    readFileSync(join(fixture.dir, "backup-during.txt"), "utf8"),
    "false",
  );
  const args = JSON.parse(readFileSync(argsFile, "utf8"));
  assert.equal(args[0], "exec");
  const overrides = args.filter((_, i) => args[i - 1] === "-c");
  assert.ok(overrides.includes("mcp_servers.exa.enabled=false"));
  assert.ok(overrides.includes("mcp_servers.context7.enabled=true"));
  assert.ok(
    overrides.includes(
      'mcp_servers.context7.enabled_tools=["resolve-library-id","query-docs"]',
    ),
  );
  assert.ok(
    !args.some((arg) => /mcp_servers\.(computer-history|cua_repl)\./.test(arg)),
  );
});
