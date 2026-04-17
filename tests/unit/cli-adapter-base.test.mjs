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
  const root = mkdtempSync(join(tmpdir(), "triflux-cli-adapter-base-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  return { root, home, bin };
}

function installFakeCodex(binDir) {
  const jsPath = join(binDir, "codex.js");
  const shPath = join(binDir, "codex");
  const cmdPath = join(binDir, "codex.cmd");

  writeFileSync(
    jsPath,
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === '--version') { process.stdout.write('codex 0.119.0\\n'); process.exit(0); }",
      "process.exit(0);",
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
  installFakeCodex(sandbox.bin);
  const previous = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };

  process.env.PATH = `${sandbox.bin}${delimiter}${process.env.PATH || ""}`;
  process.env.HOME = sandbox.home;
  process.env.USERPROFILE = sandbox.home;

  try {
    await fn(sandbox);
  } finally {
    process.env.PATH = previous.PATH;
    process.env.HOME = previous.HOME;
    process.env.USERPROFILE = previous.USERPROFILE;
    rmSync(sandbox.root, { recursive: true, force: true });
  }
}

function importFresh(relativePath) {
  return import(`${relativePath}?t=${Date.now()}-${Math.random()}`);
}

test("cli-adapter-base exports the shared codex exec builder and codex-compat re-exports it", async () => {
  await withSandbox(async () => {
    const base = await importFresh("../../hub/cli-adapter-base.mjs");
    const compat = await importFresh("../../hub/codex-compat.mjs");

    const command = base.buildExecCommand("hello", "/tmp/result.txt", {
      profile: "codex53_high",
      cwd: "C:/work/it's-me",
    });

    assert.equal(
      compat.buildExecCommand("hello", "/tmp/result.txt", {
        profile: "codex53_high",
        cwd: "C:/work/it's-me",
      }),
      command,
    );
    assert.match(command, /^codex --profile codex53_high exec /);
    assert.match(command, /--dangerously-bypass-approvals-and-sandbox/);
    assert.match(command, /--skip-git-repo-check/);
    assert.match(command, /--output-last-message \/tmp\/result\.txt/);
    assert.match(command, /--color never/);
    assert.ok(
      !command.includes("--cwd"),
      `codex exec should not receive --cwd directly: ${command}`,
    );
    assert.ok(command.endsWith('"hello"'));

    assert.equal(base.escapePwshSingleQuoted("it's"), "it''s");
    assert.equal(compat.escapePwshSingleQuoted("it's"), "it''s");
    assert.equal(base.CODEX_MCP_TRANSPORT_EXIT_CODE, 70);
    assert.equal(base.CODEX_MCP_EXECUTION_EXIT_CODE, 1);
    assert.equal(compat.CODEX_MCP_TRANSPORT_EXIT_CODE, 70);
    assert.equal(compat.CODEX_MCP_EXECUTION_EXIT_CODE, 1);
  });
});
