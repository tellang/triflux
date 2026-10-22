// tests/unit/multiplexer-resolution.test.mjs
//
// hub/team/psmux.mjs 의 PSMUX_BIN resolution 이 OS 별 primary multiplexer 로
// 명시 분기되는지 (silent fallback 아님) 검증. mac/Linux 의 codex worker 가
// tmux 환경에서 silent fallback path 로 흘러가던 회귀 가드.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";

const ROOT = pathFromHere("../..");

function pathFromHere(rel) {
  const here = new URL(import.meta.url).pathname;
  const dir = here.substring(0, here.lastIndexOf("/"));
  return join(dir, rel);
}

function runSessionProbe({
  platform,
  execFileOk = {},
  execSyncOk = {},
  gitBash = false,
  command = null,
  trace = false,
}) {
  const script = `
    import childProcess from "node:child_process";
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";

    Object.defineProperty(process, "platform", {
      value: ${JSON.stringify(platform)},
      configurable: true,
    });

    delete process.env.PSMUX_BIN;
    const calls = [];
    if (${gitBash}) {
      fs.existsSync = (path) => path === "C:/Program Files/Git/bin/bash.exe";
    }
    const execFileOk = new Set(${JSON.stringify(Object.keys(execFileOk))});
    const execSyncOk = new Set(${JSON.stringify(Object.keys(execSyncOk))});

    childProcess.execFileSync = (file, args = []) => {
      const key = [file, ...args].join(" ");
      calls.push(key);
      if (execFileOk.has(key)) return Buffer.from(key + "\\n");
      throw Object.assign(new Error("mock missing execFileSync: " + key), {
        status: 1,
      });
    };

    childProcess.execSync = (command) => {
      calls.push(command);
      if (execSyncOk.has(command)) return command + "\\n";
      throw Object.assign(new Error("mock missing execSync: " + command), {
        status: 1,
      });
    };

    childProcess.spawnSync = (file, args = []) => {
      const key = [file, ...args].join(" ");
      calls.push(key);
      if (${gitBash} && file === "C:/Program Files/Git/bin/bash.exe") {
        return { status: 0, stdout: "ok", stderr: "" };
      }
      if (execFileOk.has(key)) {
        return { status: 0, stdout: key, stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "mock missing spawnSync: " + key };
    };

    syncBuiltinESMExports();

    const session = await import("./hub/team/session.mjs");
    const psmux = await import("./hub/team/psmux.mjs");
    const importCalls = [...calls];
    const output = ${JSON.stringify(command)} ? session.tmuxExec(${JSON.stringify(command)}) : null;
    console.log(JSON.stringify({
      detectMultiplexer: session.detectMultiplexer(),
      hasPsmuxAlias: psmux.hasPsmux(),
      multiplexerType: psmux.getMultiplexerType(),
      ...(${trace} ? { importCalls, calls, output } : {}),
    }));
  `;

  const result = spawnSync(process.execPath, ["--input-type=module"], {
    cwd: ROOT,
    input: script,
    encoding: "utf8",
  });

  assert.equal(
    result.status,
    0,
    result.stderr || result.stdout || "session probe failed",
  );
  return JSON.parse(result.stdout.trim());
}

describe("session.mjs: literal multiplexer identity", () => {
  it("darwin + tmux available + psmux absent resolves to tmux", () => {
    const probe = runSessionProbe({
      platform: "darwin",
      execFileOk: { "tmux -V": true },
      execSyncOk: { "tmux -V": true },
    });

    assert.deepEqual(probe, {
      detectMultiplexer: "tmux",
      hasPsmuxAlias: true,
      multiplexerType: "tmux",
    });
  });

  it("linux + tmux available resolves to tmux", () => {
    const probe = runSessionProbe({
      platform: "linux",
      execFileOk: { "tmux -V": true },
      execSyncOk: { "tmux -V": true },
    });

    assert.equal(probe.detectMultiplexer, "tmux");
  });

  it("Windows primary remains psmux when psmux is available", () => {
    const probe = runSessionProbe({
      platform: "win32",
      execFileOk: { "psmux -V": true },
    });

    assert.equal(probe.detectMultiplexer, "psmux");
  });
});

describe("multiplexer platform boundaries", () => {
  for (const platform of ["darwin", "linux"]) {
    it(`${platform} import는 probe 없이 끝나고 tmux 부재 시 psmux를 탐색하지 않는다`, () => {
      const probe = runSessionProbe({
        platform,
        execFileOk: { "psmux -V": true },
        trace: true,
      });
      assert.deepEqual(probe.importCalls, []);
      assert.equal(probe.multiplexerType, "tmux");
      assert.equal(probe.detectMultiplexer, null);
      assert.ok(probe.calls.every((call) => !call.includes("psmux")));
    });
  }

  it("Windows Git Bash tmux 명령은 감지한 bash 실행 파일을 재사용한다", () => {
    const probe = runSessionProbe({
      platform: "win32",
      gitBash: true,
      command: "display-message -p test",
      trace: true,
    });
    assert.equal(probe.detectMultiplexer, "git-bash-tmux");
    assert.equal(probe.output, "ok");
    assert.ok(
      probe.calls.includes(
        "C:/Program Files/Git/bin/bash.exe -lc tmux display-message -p test",
      ),
    );
  });
});
