import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = resolve(import.meta.dirname, "../..");
export const version = JSON.parse(
  readFileSync(join(source, "package.json")),
).version;

export function snapshot(dir) {
  if (!existsSync(dir)) return null;
  return readdirSync(dir)
    .sort()
    .map((name) => {
      const path = join(dir, name);
      const stat = lstatSync(path);
      return [
        name,
        stat.mode,
        stat.mtimeMs,
        stat.isSymbolicLink()
          ? readlinkSync(path)
          : stat.isDirectory()
            ? snapshot(path)
            : createHash("sha256").update(readFileSync(path)).digest("hex"),
      ];
    });
}

export function cliFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "triflux-output-")));
  const home = join(root, "home");
  const pkg = join(root, "node_modules", "triflux");
  const temp = join(root, "tmp");
  const bin = join(root, "bin");
  for (const dir of [home, pkg, temp, bin]) mkdirSync(dir, { recursive: true });
  for (const path of [
    "bin",
    "scripts",
    "hub",
    "hud",
    "hooks",
    "config",
    "skills",
    "adapters",
    ".claude/rules",
    "package.json",
  ]) {
    cpSync(join(source, path), join(pkg, path), { recursive: true });
  }
  mkdirSync(join(home, ".codex"));
  writeFileSync(
    join(home, ".codex/config.toml"),
    `# ${"isolated setup fixture ".repeat(6)}\n`,
  );
  symlinkSync(join(source, "node_modules"), join(pkg, "node_modules"), "dir");
  for (const name of ["claude", "codex", "gtimeout", "tmr"])
    writeFileSync(join(bin, name), "");
  const trace = join(root, "trace.jsonl");
  const preload = join(root, "preload.cjs");
  writeFileSync(
    preload,
    String.raw`
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const root = process.env.FIXTURE_ROOT;
const pkg = process.env.FIXTURE_PACKAGE;
const record = (event) => {
  const fd = fs.openSync(process.env.FIXTURE_TRACE, 'a');
  fs.writeSync(fd, JSON.stringify(event) + '\n');
  fs.closeSync(fd);
};
record({ pid: process.pid, argv: process.argv.slice(2) });
for (const [name, indexes] of Object.entries({ writeFileSync: [0], appendFileSync: [0], mkdirSync: [0], rmSync: [0], unlinkSync: [0], chmodSync: [0], renameSync: [0, 1], copyFileSync: [1], cpSync: [1], symlinkSync: [1] })) {
  const original = fs[name];
  fs[name] = (...args) => {
    for (const index of indexes) {
      const target = path.resolve(String(args[index]));
      if (name === 'copyFileSync' && process.env.FIXTURE_COPY_FAIL_AT && target.endsWith(process.env.FIXTURE_COPY_FAIL_AT))
        throw new Error('fixture copy denied: ' + target);
      let existing = target;
      while (!fs.existsSync(existing)) existing = path.dirname(existing);
      const physical = fs.realpathSync(existing);
      if (!target.startsWith(root + path.sep) || !(physical === root || physical.startsWith(root + path.sep)) || process.argv.includes('--check')) {
        record({ blockedWrite: name, target });
        throw new Error('fixture blocked write: ' + target);
      }
    }
    record({ write: name, targets: indexes.map((index) => String(args[index])) });
    return original(...args);
  };
}
if (process.env.FIXTURE_PLATFORM) Object.defineProperty(process, 'platform', { value: process.env.FIXTURE_PLATFORM });
https.request = (_url, _options, callback) => {
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.end = () => callback({ resume() {} });
  return request;
};
cp.execSync = (command) => {
  record({ command });
  if (command === 'npm list -g triflux --depth=0') return 'triflux@' + JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'))).version;
  if (command === 'npm view triflux version') {
    if (process.env.FIXTURE_LATEST === 'error') throw new Error('registry unavailable');
    return process.env.FIXTURE_LATEST || JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'))).version;
  }
  if (command.startsWith('npm install -g triflux@latest')) {
    if (process.env.FIXTURE_INSTALL_FAIL) throw new Error('install denied');
    const file = path.join(pkg, 'package.json');
    const data = JSON.parse(fs.readFileSync(file));
    data.version = process.env.FIXTURE_LATEST;
    fs.writeFileSync(file, JSON.stringify(data));
    fs.appendFileSync(path.join(pkg, 'hud', 'renderers.mjs'), '\n// fixture update\n');
    fs.writeFileSync(path.join(pkg, 'hud', 'output-fixture-new.mjs'), 'export const added = true;\n');
    return 'fixture install complete';
  }
  if (/^(which|where) (codex|claude)/.test(command)) return path.join(process.env.PATH, command.split(' ')[1]);
  throw new Error('fixture unavailable command: ' + command);
};
global.fetch = async (url) => {
  record({ fetch: String(url) });
  if (process.env.FIXTURE_LATEST === 'error') throw new Error('registry unavailable');
  return {
    ok: true,
    async json() {
      return { version: process.env.FIXTURE_LATEST || JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'))).version };
    },
  };
};
const execFile = cp.execFileSync;
cp.execFileSync = (command, args, options) => {
  record({ command, args });
  if (args.includes('--from-update') && process.env.FIXTURE_SETUP_RESULT) {
    const error = new Error('setup failed');
    error.stdout = process.env.FIXTURE_SETUP_RESULT + '\n';
    throw error;
  }
  if (command === process.execPath && args[0] === path.join(pkg, 'bin', 'triflux.mjs')) return execFile(command, args, options);
  if (command === process.execPath && /(?:preflight-cache|mcp-check)\.mjs$/.test(args[0])) return '';
  if (command === 'claude') {
    if (args[0] === '--version') return '2.1.300 (Claude Code)';
    if (args.join(' ') === 'plugin marketplace list --json') return '[{"name":"triflux"}]';
    if (args.join(' ') === 'plugin list --json') return JSON.stringify([{id: 'triflux-mods@triflux', scope: 'user', version: process.env.FIXTURE_MODS || JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'))).version}]);
  }
  if (command === 'ps') return '';
  if (command === 'npm') return JSON.stringify({ dependencies: { triflux: { version: JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'))).version } } });
  throw new Error('fixture unavailable executable: ' + command + ' ' + args.join(' '));
};
cp.spawn = () => ({ unref() {} });
cp.spawnSync = () => ({ status: 1, stdout: '', stderr: '' });
process.kill = () => { throw new Error('fixture forbids process kill'); };
syncBuiltinESMExports();
`,
  );
  const env = {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    XDG_CONFIG_HOME: join(home, ".config"),
    APPDATA: join(home, "AppData"),
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    PATH: bin,
    NODE_OPTIONS: `--require=${preload}`,
    TFX_CODEX_CONFIG_SYNC: "1",
    FIXTURE_ROOT: root,
    FIXTURE_PACKAGE: pkg,
    FIXTURE_TRACE: trace,
  };
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  t?.after(cleanup);
  return {
    root,
    home,
    pkg,
    temp,
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
    trace() {
      return readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse);
    },
    setVersion(next) {
      const file = join(pkg, "package.json");
      const data = JSON.parse(readFileSync(file));
      data.version = next;
      writeFileSync(file, JSON.stringify(data));
    },
    trustHooks() {
      const run = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { ensureCodexHooks } from ${JSON.stringify(join(pkg, "scripts/ensure-codex-hooks.mjs"))}; ensureCodexHooks({trust:true});`,
        ],
        { cwd: home, env, encoding: "utf8" },
      );
      if (run.status !== 0) throw new Error(run.stderr);
    },
  };
}
