import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const SETUP_URL = new URL("../../scripts/setup.mjs", import.meta.url).href;

function runCriticalWithHome(home) {
  const script = `
    import(${JSON.stringify(SETUP_URL)}).then(async (m) => {
      const result = await m.runCritical({ argv: [] });
      process.stdout.write(JSON.stringify(result));
    }).catch((err) => {
      process.stderr.write(String(err?.stack || err?.message || err));
      process.exit(1);
    });
  `;

  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      TRIFLUX_TEST_HOME: home,
      CI: "true",
      TFX_CODEX_CONFIG_SYNC: "0",
    },
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("setup stable node command (#253)", () => {
  it("refreshes stale Homebrew Cellar node paths in persisted Claude commands", () => {
    const home = mkdtempSync(join(tmpdir(), "tfx-setup-node-cmd-"));
    const claudeDir = join(home, ".claude");
    const hudPath = join(claudeDir, "hud", "hud-qos-status.mjs");
    const gatePath = join(claudeDir, "scripts", "tfx-gate-activate.mjs");
    const settingsPath = join(claudeDir, "settings.json");
    const staleNode = "/opt/homebrew/Cellar/node/25.9.0_3/bin/node";

    mkdirSync(join(claudeDir, "hud"), { recursive: true });
    mkdirSync(join(claudeDir, "scripts"), { recursive: true });
    writeFileSync(hudPath, "#!/usr/bin/env node\n", "utf8");
    writeFileSync(gatePath, "#!/usr/bin/env node\n", "utf8");
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          statusLine: {
            type: "command",
            command: `"${staleNode}" "${hudPath}"`,
          },
          hooks: {
            SessionStart: [
              {
                matcher: "*",
                hooks: [
                  {
                    type: "command",
                    command: `"${staleNode}" "/Users/tellang/Projects/tools/triflux/scripts/setup.mjs"`,
                    timeout: 10,
                  },
                  {
                    type: "command",
                    command: `"${staleNode}" "/Users/tellang/Projects/tools/triflux/scripts/hub-ensure.mjs"`,
                    timeout: 8,
                  },
                ],
              },
            ],
            PreToolUse: [
              {
                matcher: "Skill",
                hooks: [
                  {
                    type: "command",
                    command: `"${staleNode}" "${gatePath}"`,
                    timeout: 2,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    try {
      const result = runCriticalWithHome(home);
      assert.equal(
        result.status,
        0,
        `setup failed: stdout=${result.stdout} stderr=${result.stderr}`,
      );

      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const commands = [
        settings.statusLine.command,
        ...settings.hooks.SessionStart.flatMap((entry) =>
          entry.hooks.map((hook) => hook.command),
        ),
        ...settings.hooks.PreToolUse.flatMap((entry) =>
          entry.hooks.map((hook) => hook.command),
        ),
      ];

      assert.ok(
        commands.some((command) => command.includes("hud-qos-status.mjs")),
        "statusLine command must still point at the HUD script",
      );
      assert.ok(
        commands.every((command) => !command.includes("/Cellar/node/")),
        `stale Homebrew Cellar node path remained in: ${commands.join("\n")}`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
