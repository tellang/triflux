import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI = path.resolve("bin/triflux.mjs");

test("doctor --json includes Claude runtime flag warning", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-doctor-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const repoRoot = path.join(root, "repo");
  await fs.mkdir(repoRoot, { recursive: true });
  const registryPath = path.join(home, "mcp-registry.json");
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

  const issuesPath = path.join(claudeDir, "cache/cli-issues.jsonl");
  await fs.mkdir(path.dirname(issuesPath), { recursive: true });
  const issueLog = `${JSON.stringify({ cli: "gemini", pattern: "deprecated_flag", ts: Date.now() })}\n`;
  await fs.writeFile(issuesPath, issueLog);
  for (const original of [null, "{broken"]) {
    if (original) await fs.writeFile(registryPath, original);
    const { stdout } = await execFileAsync(
      process.execPath,
      [CLI, "doctor", "--json"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          TRIFLUX_TEST_HOME: home,
          TFX_MCP_REGISTRY_PATH: registryPath,
          PATH: home,
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
    const registryCheck = report.checks.find(
      (entry) => entry.name === "mcp-registry",
    );
    assert.equal(registryCheck.status, original ? "invalid" : "missing");
    assert.equal(
      await fs.readFile(registryPath, "utf8").catch(() => null),
      original,
    );
    assert.equal(await fs.readFile(issuesPath, "utf8"), issueLog);
  }
});
