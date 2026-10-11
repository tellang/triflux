import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findTrifluxPluginEntry, runUpdatedSetup } from "../../bin/triflux.mjs";
import { SYNC_MAP } from "../../scripts/setup.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "tfx updated package "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts", "setup.mjs"), "");
  return root;
}

test("업데이트 후 새 CLI 파일을 별도 프로세스에서 setup --from-update로 실행한다", (t) => {
  const root = fixture(t);
  const result = join(root, "result.json");
  const cli = join(root, "bin", "triflux.mjs");
  writeFileSync(
    cli,
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(result)}, JSON.stringify({pid: process.pid, argv: process.argv.slice(2)}));\n`,
  );
  runUpdatedSetup({ packageRoot: root });
  const actual = JSON.parse(readFileSync(result, "utf8"));
  assert.notEqual(actual.pid, process.pid);
  assert.deepEqual(actual.argv, ["setup", "--from-update"]);
});

test("update 는 triflux-mods 플러그인을 triflux 본체 플러그인 설치로 보지 않는다", () => {
  const mods = { installPath: "/plugins/cache/triflux/triflux-mods/10.57.1" };
  const core = { installPath: "/plugins/cache/triflux/triflux/10.57.1" };
  assert.equal(
    findTrifluxPluginEntry({ plugins: { "triflux-mods@triflux": [mods] } }),
    null,
  );
  assert.equal(
    findTrifluxPluginEntry({
      plugins: { "triflux-mods@triflux": [mods], "triflux@triflux": [core] },
    }),
    core,
  );
});

function cliFixture(
  t,
  { latest = "current", installFails = false, platform } = {},
) {
  const home = fixture(t);
  const log = join(home, "npm-commands.jsonl");
  const preload = join(home, "npm-fixture.mjs");
  mkdirSync(join(home, ".codex"));
  writeFileSync(
    join(home, ".codex", "config.toml"),
    `# ${"isolated setup fixture ".repeat(6)}\n`,
  );
  const version = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ).version;
  writeFileSync(
    preload,
    `import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import https from 'node:https';
https.request = (_url, _options, callback) => {
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.end = () => callback({ resume() {} });
  return request;
};
const original = childProcess.execSync;
${platform ? `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });` : ""}
childProcess.execSync = (command, options) => {
  if (!command.startsWith('npm ')) return original(command, options);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(command) + '\\n');
  if (command === 'npm list -g triflux --depth=0') return 'triflux@${version}';
  if (command === 'npm view triflux version') {
    ${latest === "error" ? "throw new Error('registry unavailable');" : `return ${JSON.stringify(latest === "current" ? version : latest)};`}
  }
  if (command.startsWith('npm install -g triflux@latest')) {
    ${installFails ? "throw new Error('install denied');" : "return 'fixture install complete';"}
  }
  throw new Error('unexpected npm command: ' + command);
};
syncBuiltinESMExports();
`,
  );
  return {
    home,
    run(command) {
      return execFileSync(
        process.execPath,
        [
          "--import",
          preload,
          join(import.meta.dirname, "../../bin/triflux.mjs"),
          command,
        ],
        {
          cwd: home,
          encoding: "utf8",
          timeout: 60000,
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            TRIFLUX_TEST_HOME: home,
            CODEX_HOME: join(home, ".codex"),
            TFX_CODEX_CONFIG_SYNC: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      ).replace(/\x1b\[[0-9;]*m/g, "");
    },
    commands() {
      return readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    },
  };
}

test("npm global 최신 버전이면 재설치 없이 setup 동기화를 실행한다", (t) => {
  const cli = cliFixture(t);
  const output = cli.run("update");
  assert.deepEqual(cli.commands(), [
    "npm list -g triflux --depth=0",
    "npm view triflux version",
  ]);
  assert.match(output, /triflux setup/);
  assert.match(output, /파일 \d+개 확인, [1-9]\d*개 반영/);
  assert.equal(output.split("런타임 캐시 갱신").length - 1, 1);
  assert.ok(
    output.indexOf("triflux setup") < output.indexOf("런타임 캐시 갱신"),
  );
});

test("레지스트리 버전 조회 실패 시 기존 npm 설치 경로를 유지한다", (t) => {
  const cli = cliFixture(t, { latest: "error" });
  assert.match(cli.run("update"), /triflux setup/);
  assert.ok(cli.commands().includes("npm install -g triflux@latest"));
});

test("macOS와 Linux 설치 실패는 --force 재시도 없이 보고한다", async (t) => {
  for (const platform of ["darwin", "linux"]) {
    await t.test(platform, (t) => {
      const cli = cliFixture(t, {
        latest: "0.0.0",
        installFails: true,
        platform,
      });
      const output = cli.run("update");
      assert.match(output, /업데이트 실패:.*install denied/);
      assert.doesNotMatch(output, /triflux setup|업데이트 완료/);
      assert.deepEqual(
        cli.commands().filter((command) => command.includes("install")),
        ["npm install -g triflux@latest"],
      );
    });
  }
});

test("Windows 설치 실패는 --force로 한 번 재시도한다", (t) => {
  const cli = cliFixture(t, {
    latest: "0.0.0",
    installFails: true,
    platform: "win32",
  });
  assert.match(cli.run("update"), /업데이트 실패:.*install denied/);
  assert.deepEqual(
    cli.commands().filter((command) => command.includes("install")),
    ["npm install -g triflux@latest", "npm install -g triflux@latest --force"],
  );
});

test("setup 재실행은 변경 파일만 표시하고 반영 건수를 요약한다", (t) => {
  const cli = cliFixture(t);
  cli.run("setup");
  const unchanged = cli.run("setup");
  assert.match(unchanged, /파일 \d+개 확인, 0개 반영/);
  assert.doesNotMatch(unchanged, /: 최신 상태/);
  const changedFile = join(
    cli.home,
    ".claude",
    "scripts",
    "tfx-route-post.mjs",
  );
  writeFileSync(changedFile, "stale file\n");
  const changed = cli.run("setup");
  assert.match(changed, /파일 \d+개 확인, 1개 반영/);
  assert.equal(changed.split(": 업데이트됨").length - 1, 1);
  assert.equal(
    readFileSync(changedFile, "utf8"),
    readFileSync(
      SYNC_MAP.find((target) => target.label === "scripts/tfx-route-post.mjs")
        .src,
      "utf8",
    ),
  );
});
