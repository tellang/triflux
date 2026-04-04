import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'triflux-codex-adapter-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  return { root, home, bin };
}

function installFakeCodex(binDir) {
  const jsPath = join(binDir, 'codex.js');
  const shPath = join(binDir, 'codex');
  const cmdPath = join(binDir, 'codex.cmd');

  writeFileSync(jsPath, [
    '#!/usr/bin/env node',
    "import { writeFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "if (args[0] === '--version') { process.stdout.write('codex 0.119.0\\n'); process.exit(0); }",
    "if (args[0] !== 'exec') { process.stderr.write(`unsupported:${args[0] || 'none'}`); process.exit(64); }",
    "if (process.env.FAKE_CODEX_FAIL === '1') { process.stderr.write('exec failed'); process.exit(5); }",
    "const outIndex = args.indexOf('--output-last-message');",
    'const resultFile = outIndex >= 0 ? args[outIndex + 1] : "";',
    'const prompt = args.at(-1) || "";',
    "const output = `EXEC:${prompt}`;",
    "if (resultFile) writeFileSync(resultFile, output, 'utf8');",
    'process.stdout.write(output);',
  ].join('\n'), 'utf8');
  writeFileSync(shPath, `#!/bin/sh\nnode "${jsPath.replace(/\\/g, '/')}" "$@"\n`, 'utf8');
  writeFileSync(cmdPath, `@echo off\r\nnode "${jsPath}" %*\r\n`, 'utf8');
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
    FAKE_CODEX_FAIL: process.env.FAKE_CODEX_FAIL,
  };

  process.env.PATH = `${sandbox.bin}${delimiter}${process.env.PATH || ''}`;
  process.env.HOME = sandbox.home;
  process.env.USERPROFILE = sandbox.home;
  delete process.env.FAKE_CODEX_FAIL;

  try {
    await fn(sandbox);
  } finally {
    process.env.PATH = previous.PATH;
    process.env.HOME = previous.HOME;
    process.env.USERPROFILE = previous.USERPROFILE;
    if (previous.FAKE_CODEX_FAIL == null) delete process.env.FAKE_CODEX_FAIL;
    else process.env.FAKE_CODEX_FAIL = previous.FAKE_CODEX_FAIL;
    rmSync(sandbox.root, { recursive: true, force: true });
  }
}

function importFresh(relativePath) {
  return import(`${relativePath}?t=${Date.now()}-${Math.random()}`);
}

test('runPreflight marks unreachable MCP servers for exclusion', async () => {
  await withSandbox(async ({ home }) => {
    writeFileSync(join(home, '.codex', 'config.toml'), [
      'approval_mode = "full-auto"',
      'sandbox = "danger-full-access"',
      '',
      '[mcp_servers.context7]',
      'command = "missing-context7"',
      '',
    ].join('\n'), 'utf8');

    const { runPreflight } = await importFresh('../../hub/codex-preflight.mjs');
    const result = await runPreflight({ mcpServers: ['context7'], subcommand: 'exec' });

    assert.equal(result.ok, true);
    assert.equal(result.version, 119);
    assert.equal(result.needsBypass, true);
    assert.deepEqual(result.excludeMcpServers, ['context7']);
    assert.match(result.warnings.join('\n'), /missing-context7/);
  });
});

test('buildLaunchScript emits headless codex exec wrapper', async () => {
  const { buildLaunchScript } = await importFresh('../../hub/codex-adapter.mjs');
  const scriptPath = buildLaunchScript({
    id: 'unit-test',
    workdir: 'C:\\work\\demo',
    promptFile: 'C:\\work\\prompt.txt',
    profile: 'codex53_high',
    timeout: 1234,
  });
  const script = readFileSync(scriptPath, 'utf8');

  assert.match(script, /--dangerously-bypass-approvals-and-sandbox/);
  assert.match(script, /--skip-git-repo-check/);
  assert.match(script, /\$\(cat "\$PROMPT_FILE"\)/);
  assert.match(script, /--profile "codex53_high"/);
});

test('execute returns stdout for successful codex exec', async () => {
  await withSandbox(async ({ home, root }) => {
    writeFileSync(join(home, '.codex', 'config.toml'), 'approval_mode = "full-auto"\n', 'utf8');
    const { execute } = await importFresh('../../hub/codex-adapter.mjs');
    const result = await execute({
      prompt: 'hello',
      workdir: root,
      retryOnFail: false,
      fallbackToClaude: false,
      timeout: 5000,
    });

    assert.equal(result.ok, true);
    assert.equal(result.fellBack, false);
    assert.equal(result.retried, false);
    assert.equal(result.failureMode, null);
    assert.match(result.output, /^EXEC:hello$/);
  });
});

test('execute opens the circuit after repeated crashes', async () => {
  await withSandbox(async ({ home, root }) => {
    writeFileSync(join(home, '.codex', 'config.toml'), 'approval_mode = "full-auto"\n', 'utf8');
    process.env.FAKE_CODEX_FAIL = '1';

    const { execute, getCircuitState } = await importFresh('../../hub/codex-adapter.mjs');
    for (let i = 0; i < 3; i += 1) {
      const result = await execute({ prompt: 'fail', workdir: root, timeout: 1000 });
      assert.equal(result.ok, false);
      assert.equal(result.retried, true);
      assert.equal(result.fellBack, true);
      assert.equal(result.failureMode, 'crash');
    }

    assert.equal(getCircuitState().state, 'open');
    const blocked = await execute({ prompt: 'blocked', workdir: root, timeout: 1000 });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.fellBack, true);
    assert.equal(blocked.failureMode, 'circuit_open');
  });
});
