import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), "triflux-gemini-adapter-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  return { root, bin };
}

function installFakeAntigravity(binDir) {
  const jsPath = join(binDir, "agy.js");
  const shPath = join(binDir, "agy");
  const cmdPath = join(binDir, "agy.cmd");

  writeFileSync(
    jsPath,
    [
      "#!/usr/bin/env node",
      "if (process.env.FAKE_GEMINI_FAIL === '1') { process.stderr.write('agy failed'); process.exit(5); }",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => { process.stdout.write(`AGY:${input}`); });",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    shPath,
    `#!/bin/sh\nnode "${jsPath.replace(/\\/g, "/")}" "$@"\n`,
    "utf8",
  );
  writeFileSync(cmdPath, `@echo off\r\nnode "${jsPath}" %*\r\n`, "utf8");
  chmodSync(jsPath, 0o755);
  chmodSync(shPath, 0o755);
}

async function withSandbox(fn) {
  const sandbox = makeSandbox();
  installFakeAntigravity(sandbox.bin);
  const previous = {
    PATH: process.env.PATH,
    FAKE_GEMINI_FAIL: process.env.FAKE_GEMINI_FAIL,
  };

  process.env.PATH = `${sandbox.bin}${delimiter}${process.env.PATH || ""}`;
  delete process.env.FAKE_GEMINI_FAIL;

  try {
    await fn(sandbox);
  } finally {
    process.env.PATH = previous.PATH;
    if (previous.FAKE_GEMINI_FAIL == null) delete process.env.FAKE_GEMINI_FAIL;
    else process.env.FAKE_GEMINI_FAIL = previous.FAKE_GEMINI_FAIL;
    rmSync(sandbox.root, { recursive: true, force: true });
  }
}

function importFresh(relativePath) {
  return import(`${relativePath}?t=${Date.now()}-${Math.random()}`);
}

test("buildExecArgs produces agy stdin print command for legacy gemini adapter", async () => {
  const { buildExecArgs } = await importFresh("../../hub/gemini-adapter.mjs");
  const cmd = buildExecArgs({
    prompt: "hello world",
    model: "gemini-3-flash-preview",
  });

  assert.match(cmd, /agy --print/);
  assert.match(cmd, /--dangerously-skip-permissions/);
  assert.doesNotMatch(cmd, /gemini --/);
  assert.doesNotMatch(cmd, /--prompt/);
});

test("execute returns stdout for successful agy run", async () => {
  await withSandbox(async ({ root }) => {
    const { execute } = await importFresh("../../hub/gemini-adapter.mjs");
    const result = await execute({
      prompt: "hello",
      workdir: root,
      retryOnFail: false,
      fallbackToClaude: false,
      timeout: 5000,
    });

    assert.equal(result.ok, true);
    assert.equal(result.fellBack, false);
    assert.equal(result.retried, false);
    assert.equal(result.failureMode, null);
    assert.match(result.output, /AGY:hello/);
  });
});

test("execute opens the circuit after repeated crashes", async () => {
  await withSandbox(async ({ root }) => {
    process.env.FAKE_GEMINI_FAIL = "1";

    // set up HOME + accounts.json so broker tracks gemini circuit
    const home = join(root, "home");
    const brokerDir = join(home, ".claude", "cache", "tfx-hub");
    mkdirSync(brokerDir, { recursive: true });
    writeFileSync(
      join(brokerDir, "accounts.json"),
      JSON.stringify({
        gemini: [{ id: "test-gemini", mode: "profile", profile: "default" }],
      }),
      "utf8",
    );
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    const brokerMod = await import("../../hub/account-broker.mjs");
    brokerMod.reloadBroker();

    const { execute, getCircuitState } = await importFresh(
      "../../hub/gemini-adapter.mjs",
    );
    for (let i = 0; i < 3; i += 1) {
      const result = await execute({
        prompt: "fail",
        workdir: root,
        timeout: 1000,
      });
      assert.equal(result.ok, false);
      assert.equal(result.retried, true);
      assert.equal(result.fellBack, true);
      assert.equal(result.failureMode, "crash");
    }

    assert.equal((await getCircuitState()).state, "open");
    const blocked = await execute({
      prompt: "blocked",
      workdir: root,
      timeout: 1000,
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.fellBack, true);
    assert.equal(blocked.failureMode, "circuit_open");

    // restore HOME
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUserProfile;
    brokerMod.reloadBroker();
  });
});
