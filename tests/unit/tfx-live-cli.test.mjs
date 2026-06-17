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

async function writeFakeBridge(dir, handlersSource) {
  const bridgePath = path.join(dir, "fake-bridge.mjs");
  await fs.writeFile(
    bridgePath,
    [
      "#!/usr/bin/env node",
      "import fs from 'node:fs/promises';",
      "const [,, verb] = process.argv;",
      "const payloadIndex = process.argv.indexOf('--payload');",
      "const payloadFileIndex = process.argv.indexOf('--payload-file');",
      "let payload = {};",
      "if (payloadIndex >= 0) payload = JSON.parse(process.argv[payloadIndex + 1]);",
      "if (payloadFileIndex >= 0) payload = JSON.parse(await fs.readFile(process.argv[payloadFileIndex + 1], 'utf8'));",
      "const logPath = process.env.FAKE_BRIDGE_LOG;",
      "const prior = logPath ? JSON.parse(await fs.readFile(logPath, 'utf8').catch(() => '[]')) : [];",
      "prior.push({ verb, payload });",
      "if (logPath) await fs.writeFile(logPath, JSON.stringify(prior));",
      handlersSource,
    ].join("\n"),
    "utf8",
  );
  await fs.chmod(bridgePath, 0o755);
  return bridgePath;
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
    assert.ok(Object.hasOwn(report.probe, "daemon"));
    assert.ok(Object.hasOwn(report.probe, "daemons"));
    assert.ok(Object.hasOwn(report.probe, "candidateResults"));
    assert.ok(Object.hasOwn(report.probe, "callerProvenance"));
  } finally {
    await fs.rm(bugReportDir, { recursive: true, force: true });
  }
});

test("tfx-live probe forwards --config-dir to daemon-probe", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-probe-"));
  try {
    const logPath = path.join(dir, "bridge-log.json");
    const configDir = path.join(dir, "claude-config");
    const bridgePath = await writeFakeBridge(
      dir,
      [
        "if (verb !== 'daemon-probe') process.exit(2);",
        "console.log(JSON.stringify({ok:true,sessions:[],daemon:{configDir:payload.configDir},candidateResults:[],callerProvenance:{codexLauncher:'codex'}}));",
      ].join("\n"),
    );

    const stdout = await runTfxLive(
      [
        "probe",
        "--short",
        "facefeed",
        "--config-dir",
        configDir,
        "--bridge",
        bridgePath,
        "--timeout",
        "1",
      ],
      { env: { ...process.env, FAKE_BRIDGE_LOG: logPath } },
    );
    const result = JSON.parse(stdout);
    const log = JSON.parse(await fs.readFile(logPath, "utf8"));

    assert.equal(result.ok, true);
    assert.deepEqual(log, [
      {
        verb: "daemon-probe",
        payload: { short: "facefeed", configDir },
      },
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tfx-live ask --transport auto forwards --config-dir to probe and selected attach", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-ask-auto-"));
  try {
    const logPath = path.join(dir, "bridge-log.json");
    const configDir = path.join(dir, "claude-config");
    const bridgePath = await writeFakeBridge(
      dir,
      [
        "if (verb === 'daemon-probe') {",
        "  console.log(JSON.stringify({ok:true,sessions:[{short:'facefeed',sessionId:'sess-1'}],target:{short:'facefeed',sessionId:'sess-1'},daemon:{configDir:payload.configDir,configDirSource:'explicit'},candidateResults:[{configDirSource:'explicit',ok:true,sessionCount:1}],callerProvenance:{codexLauncher:'omx'}}));",
        "} else if (verb === 'daemon-attach') {",
        "  console.log(JSON.stringify({ok:true,text:'ATTACH_OK',raw:'ATTACH_OK',matchedCompletion:true,timedOut:false,closed:false,inputSent:true,daemon:{configDir:payload.configDir,configDirSource:'explicit'},candidateResults:[{configDirSource:'explicit',ok:true,sessionCount:1}],callerProvenance:{codexLauncher:'omx'}}));",
        "} else process.exit(2);",
      ].join("\n"),
    );

    const stdout = await runTfxLive(
      [
        "ask",
        "--cli",
        "claude",
        "--transport",
        "auto",
        "--short",
        "facefeed",
        "--prompt",
        "hello",
        "--config-dir",
        configDir,
        "--bridge",
        bridgePath,
        "--timeout",
        "1",
      ],
      { env: { ...process.env, FAKE_BRIDGE_LOG: logPath } },
    );
    const result = JSON.parse(stdout);
    const log = JSON.parse(await fs.readFile(logPath, "utf8"));

    assert.equal(result.done, true);
    assert.equal(result.response, "ATTACH_OK");
    assert.equal(result.transportSelected, "uds");
    assert.equal(result.daemon.configDir, configDir);
    assert.deepEqual(
      log.map((entry) => entry.payload.configDir),
      [configDir, configDir],
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tfx-live interrupt forwards --config-dir to daemon-interrupt and returns provenance", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-interrupt-"));
  try {
    const logPath = path.join(dir, "bridge-log.json");
    const configDir = path.join(dir, "claude-config");
    const bridgePath = await writeFakeBridge(
      dir,
      [
        "if (verb !== 'daemon-interrupt') process.exit(2);",
        "console.log(JSON.stringify({ok:true,done:false,aborted:true,reason:'user_interrupt',inputSent:true,daemon:{configDir:payload.configDir,configDirSource:'explicit'},candidateResults:[{configDirSource:'explicit',ok:true,sessionCount:1}],callerProvenance:{codexLauncher:'omx'}}));",
      ].join("\n"),
    );

    const stdout = await runTfxLive(
      [
        "interrupt",
        "--cli",
        "claude",
        "--transport",
        "uds",
        "--short",
        "facefeed",
        "--config-dir",
        configDir,
        "--bridge",
        bridgePath,
        "--timeout",
        "1",
      ],
      { env: { ...process.env, FAKE_BRIDGE_LOG: logPath } },
    );
    const result = JSON.parse(stdout);
    const log = JSON.parse(await fs.readFile(logPath, "utf8"));

    assert.equal(result.aborted, true);
    assert.equal(result.daemon.configDir, configDir);
    assert.deepEqual(log[0].payload, {
      timeoutMs: 1000,
      short: "facefeed",
      configDir,
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
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

test("tfx-live cto-hygiene-notify notifies once for actionable unchanged hygiene state", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-live-cto-hygiene-"));
  try {
    const lakeDir = path.join(dir, ".triflux", "lake");
    await fs.mkdir(lakeDir, { recursive: true });
    await fs.writeFile(path.join(lakeDir, "current.json"), "{}", "utf8");
    await fs.writeFile(
      path.join(lakeDir, "ledger.jsonl"),
      `${JSON.stringify({
        ts: "2026-06-17T00:00:00.000Z",
        event: "task_claimed",
        summary: "Open item",
        ref: { task_id: "G005", status: "active", actor: { cli: "codex" } },
      })}\n`,
      "utf8",
    );
    const stateFile = path.join(dir, "notify-state.json");

    const first = JSON.parse(
      await runTfxLive([
        "cto-hygiene-notify",
        "--root",
        dir,
        "--state-file",
        stateFile,
        "--json",
      ]),
    );
    const second = JSON.parse(
      await runTfxLive([
        "cto-hygiene-notify",
        "--root",
        dir,
        "--state-file",
        stateFile,
        "--json",
      ]),
    );

    assert.equal(first.ok, true);
    assert.equal(first.actionable, true);
    assert.equal(first.notified, true);
    assert.equal(first.reason, "changed-actionable-state");
    assert.equal(second.ok, true);
    assert.equal(second.actionable, true);
    assert.equal(second.notified, false);
    assert.equal(second.reason, "unchanged-state");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
