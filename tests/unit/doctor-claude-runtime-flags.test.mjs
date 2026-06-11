import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI = path.resolve("bin/triflux.mjs");

test("doctor --json includes Claude runtime flag warning", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-doctor-home-"));
  const claudeDir = path.join(home, ".claude");
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.writeFile(
    path.join(claudeDir, "settings.json"),
    JSON.stringify({
      disableBundledSkills: true,
      allowedMcpServers: ["context7"],
    }),
    "utf8",
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [CLI, "doctor", "--json"],
    {
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_CODE_SAFE_MODE: "1",
        NO_COLOR: "1",
      },
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const report = JSON.parse(stdout);
  const check = report.checks.find(
    (entry) => entry.name === "claude-runtime-flags",
  );

  assert.equal(check.status, "warning");
  assert.equal(check.safe_mode, true);
  assert.equal(check.disable_bundled_skills, true);
  assert.equal(check.managed_mcp_policy.active, true);
  assert.match(check.summary, /safe mode/i);
});
