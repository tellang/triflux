import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI = path.resolve("bin/tfx-live.mjs");

async function runTfxLive(args, options = {}) {
  const result = await execFileAsync(process.execPath, [CLI, ...args], {
    timeout: 20_000,
    maxBuffer: 5 * 1024 * 1024,
    ...options,
  });
  return result.stdout;
}

test("tfx-live help documents UDS-first auto default", async () => {
  const stdout = await runTfxLive(["--help"]);

  assert.match(stdout, /tfx-live ask/);
  assert.match(stdout, /tfx-live interrupt/);
  assert.match(stdout, /tfx-live probe/);
  assert.match(
    stdout,
    /auto is the default for Claude when --short\/--session-id is present/,
  );
});

test("tfx-live probe returns daemon-probe JSON through bundled bridge", async () => {
  const stdout = await runTfxLive([
    "probe",
    "--short",
    "00000000",
    "--timeout",
    "1",
  ]);
  const result = JSON.parse(stdout);

  assert.equal(typeof result.ok, "boolean");
  assert.ok(
    Array.isArray(result.sessions) || result.error || result.reason,
    "probe output should include sessions or a structured failure reason",
  );
});

test("tfx-live ask defaults Claude daemon refs to auto transport and reports fallback", async () => {
  const bugReportDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "tfx-live-bugs-"),
  );

  try {
    const stdout = await runTfxLive(
      [
        "ask",
        "--cli",
        "claude",
        "--short",
        "00000000",
        "--prompt",
        "noop",
        "--timeout",
        "1",
      ],
      {
        env: {
          ...process.env,
          TFX_LIVE_BUG_REPORT_DIR: bugReportDir,
        },
      },
    );
    const result = JSON.parse(stdout);

    assert.equal(result.cli, "claude");
    assert.equal(result.transport, "auto");
    assert.equal(result.transportSelected, "none");
    assert.equal(result.done, false);
    assert.match(result.error, /no --session for tmux fallback/);

    const reports = await fs.readdir(bugReportDir);
    assert.equal(reports.length, 1);
    assert.match(reports[0], /^uds-fallback-/);
    const report = JSON.parse(
      await fs.readFile(path.join(bugReportDir, reports[0]), "utf8"),
    );
    assert.equal(report.kind, "uds-fallback");
    assert.equal(report.target.short, "00000000");
    assert.equal(report.bridgePath, path.resolve("hub/bridge.mjs"));
  } finally {
    await fs.rm(bugReportDir, { recursive: true, force: true });
  }
});

test("tfx-live interrupt returns the common abort contract through UDS bridge", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-bridge-"));
  try {
    const bridgePath = path.join(dir, "fake-bridge.mjs");
    await fs.writeFile(
      bridgePath,
      [
        "#!/usr/bin/env node",
        "const [,, verb] = process.argv;",
        "if (verb !== 'daemon-interrupt') process.exit(2);",
        "console.log(JSON.stringify({ok:true,done:false,aborted:true,reason:'user_interrupt',transport:'uds',inputSent:true}));",
      ].join("\n"),
      "utf8",
    );

    const stdout = await runTfxLive([
      "interrupt",
      "--cli",
      "claude",
      "--transport",
      "uds",
      "--short",
      "facefeed",
      "--bridge",
      bridgePath,
      "--timeout",
      "1",
    ]);
    const result = JSON.parse(stdout);

    assert.equal(result.cli, "claude");
    assert.equal(result.transport, "uds");
    assert.equal(result.done, false);
    assert.equal(result.aborted, true);
    assert.equal(result.reason, "user_interrupt");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tfx-live interrupt returns the common abort contract through tmux Escape", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-tmux-"));
  try {
    const logPath = path.join(dir, "tmux-args.json");
    const tmuxPath = path.join(dir, "tmux");
    await fs.writeFile(
      tmuxPath,
      [
        "#!/usr/bin/env node",
        "await import('node:fs/promises').then(({writeFile}) => writeFile(process.env.TMUX_LOG, JSON.stringify(process.argv.slice(2))));",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(tmuxPath, 0o755);

    const stdout = await runTfxLive(
      [
        "interrupt",
        "--cli",
        "claude",
        "--transport",
        "tmux",
        "--session",
        "live-peer",
      ],
      {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          TMUX_LOG: logPath,
        },
      },
    );
    const result = JSON.parse(stdout);
    const tmuxArgs = JSON.parse(await fs.readFile(logPath, "utf8"));

    assert.equal(result.cli, "claude");
    assert.equal(result.transport, "tmux");
    assert.equal(result.done, false);
    assert.equal(result.aborted, true);
    assert.equal(result.reason, "user_interrupt");
    assert.deepEqual(tmuxArgs, ["send-keys", "-t", "live-peer", "Escape"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
