import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = resolve(import.meta.dirname, "../..");
export const version = JSON.parse(
  fs.readFileSync(join(source, "package.json")),
).version;

export function cliFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "tfx-out-")));
  const home = join(root, "home");
  const pkg = join(root, "node_modules", "triflux");
  const temp = join(root, "tmp");
  const bin = join(root, "bin");
  for (const dir of [home, pkg, temp, bin])
    fs.mkdirSync(dir, { recursive: true });
  const assets =
    "bin scripts hub hud hooks config skills adapters .claude/rules package.json".split(
      " ",
    );
  for (const path of assets)
    fs.cpSync(join(source, path), join(pkg, path), { recursive: true });
  fs.mkdirSync(join(home, ".codex"));
  fs.writeFileSync(join(home, ".codex/config.toml"), "#".repeat(101));
  const dependencies = join(source, "node_modules");
  fs.symlinkSync(dependencies, join(pkg, "node_modules"), "dir");
  for (const name of ["claude", "codex", "gtimeout", "tmr"])
    fs.writeFileSync(join(bin, name), "");
  const trace = join(root, "trace.jsonl");
  const preload = join(root, "preload.cjs");
  fs.writeFileSync(
    preload,
    String.raw`
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const { EventEmitter } = require('node:events');
const pkg = process.env.FIXTURE_PACKAGE, root = process.env.FIXTURE_ROOT;
const trace = (event) => {
  const fd = fs.openSync(process.env.FIXTURE_TRACE, 'a');
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, ...event }) + '\n'); fs.closeSync(fd);
};
trace({ argv: process.argv.slice(2) });
for (const [name, indexes] of Object.entries({ writeFileSync: [0], appendFileSync: [0], mkdirSync: [0], rmSync: [0], unlinkSync: [0], chmodSync: [0], renameSync: [0, 1], copyFileSync: [1], cpSync: [1], symlinkSync: [1] })) {
  const original = fs[name];
  fs[name] = (...args) => {
    for (const index of indexes) {
      let existing = path.resolve(String(args[index]));
      while (!fs.existsSync(existing)) existing = path.dirname(existing);
      if (!fs.realpathSync(existing).startsWith(root + path.sep)) throw new Error('fixture write outside HOME: ' + args[index]);
    }
    trace({ write: name });
    return original(...args);
  };
}
const current = () => JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'))).version;
require('node:https').request = (_url, _options, callback) => {
  const request = new EventEmitter(); request.setTimeout = () => request;
  request.end = () => callback({ resume() {} }); return request;
};
cp.execSync = (command) => {
  if (command === 'npm list -g triflux --depth=0') return 'triflux@' + current();
  if (command === 'npm view triflux version') return process.env.FIXTURE_LATEST || current();
  if (command.startsWith('npm install -g triflux@latest')) {
    if (process.env.FIXTURE_INSTALL_FAIL) throw Object.assign(new Error('Command failed: ' + command), { stderr: '\n npm ERR! EACCES: permission denied\nmore detail\n' });
    const file = path.join(pkg, 'package.json'), data = JSON.parse(fs.readFileSync(file));
    data.version = process.env.FIXTURE_LATEST; fs.writeFileSync(file, JSON.stringify(data));
    fs.appendFileSync(path.join(pkg, 'hud/renderers.mjs'), '\n// fixture update\n');
    return '';
  }
  throw new Error('fixture unavailable command: ' + command);
};
const execFile = cp.execFileSync;
cp.execFileSync = (command, args, options) => {
  if (command === process.execPath && args[0] === path.join(pkg, 'bin/triflux.mjs')) return execFile(command, args, options);
  if (command === process.execPath && /(?:preflight-cache|mcp-check)\.mjs$/.test(args[0])) return '';
  if (command === 'claude') {
    if (args[0] === '--version') return '2.1.300 (Claude Code)';
    if (args.join(' ') === 'plugin marketplace list --json') return '[{"name":"triflux"}]';
    if (args.join(' ') === 'plugin list --json') return JSON.stringify([{ id: 'triflux-mods@triflux', scope: 'user', version: process.env.FIXTURE_MODS || current() }]);
    if (args[0] === 'plugin') return '';
  }
  if (command === 'ps') return '';
  if (command === 'npm') return JSON.stringify({ dependencies: { triflux: { version: current() } } });
  throw new Error('fixture unavailable executable: ' + command);
};
if (process.env.FIXTURE_TTY) {
  for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, 'isTTY', { value: true });
  require('node:readline/promises').createInterface = () => ({ question: async (question) => { trace({ question }); return 'y'; }, close() {} });
}
cp.spawn = () => ({ unref() {} });
cp.spawnSync = () => ({ status: 1, stdout: '', stderr: '' });
process.kill = () => { throw new Error('fixture forbids process kill'); };
syncBuiltinESMExports();
`,
  );
  const env = {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temp,
    PATH: bin,
    NODE_OPTIONS: `--require=${preload}`,
    TFX_CODEX_CONFIG_SYNC: "1",
    FIXTURE_ROOT: root,
    FIXTURE_PACKAGE: pkg,
    FIXTURE_TRACE: trace,
  };
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  t?.after(cleanup);
  return {
    root,
    home,
    pkg,
    env,
    cleanup,
    run(args, extraEnv = {}, script = "bin/triflux.mjs") {
      return spawnSync(process.execPath, [resolve(pkg, script), ...args], {
        cwd: home,
        encoding: "utf8",
        timeout: 30000,
        env: { ...env, ...extraEnv },
        stdio: ["ignore", "pipe", "pipe"],
      });
    },
    trace: () =>
      fs.readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse),
    setVersion(next) {
      const file = join(pkg, "package.json");
      fs.writeFileSync(
        file,
        JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), version: next }),
      );
    },
  };
}
