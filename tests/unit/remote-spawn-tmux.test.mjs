import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  __remoteSpawnTest,
  attachSession,
  buildRemoteSessionName,
  buildRemoteTmuxAttachCommand,
  buildRemoteTmuxCommand,
  buildRemoteTmuxStartScript,
  inferRemoteHostFromSessionName,
  killSpawnSession,
  monitorClaudeSession,
  resolveRemoteOsHint,
} from "../../scripts/remote-spawn.mjs";

const session = "tfx-spawn-m2-ts-net-unit";
const record = {
  host: "m2.ts.net",
  runId: "unit-run",
  remoteTmux: true,
  remoteSessionName: session,
  tmuxPath: "/opt/homebrew/bin/tmux",
  binDirs: ["/opt/homebrew/bin"],
};

async function withRecord(run) {
  const root = mkdtempSync(join(tmpdir(), "tfx-remote-tmux-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  const recordPath = join(root, "triflux", "remote-spawn", `${session}.json`);
  mkdirSync(join(root, "triflux", "remote-spawn"), { recursive: true });
  writeFileSync(recordPath, JSON.stringify(record));
  try {
    await run(recordPath, root);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

describe("원격 tmux 실행과 attach 명령", () => {
  it("호스트의 점과 콜론을 세션 이름에서만 정규화한다", async () => {
    assert.equal(buildRemoteSessionName("m2.ts.net", "unit"), session);
    assert.equal(
      buildRemoteSessionName("host:2222", "unit"),
      "tfx-spawn-host-2222-unit",
    );
    await withRecord(() => {
      assert.equal(
        inferRemoteHostFromSessionName(session, ["m2-ts-net"]),
        "m2.ts.net",
      );
    });
    assert.equal(
      inferRemoteHostFromSessionName(session, ["m2.ts.net"]),
      "m2.ts.net",
    );
  });

  it("단일 sh 스크립트가 작업 경로와 Claude 명령을 tmux에 안전하게 전달한다", async () => {
    await withRecord((_path, root) => {
      const log = join(root, "tmux-args.jsonl");
      const tmuxPath = join(root, "fake tmux");
      writeFileSync(
        tmuxPath,
        `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
        { mode: 0o700 },
      );
      const dir = "/home/unit/a b'c;$HOME";
      const promptFile = "/home/unit/prompt's file.md";
      const spec = {
        ...record,
        tmuxPath,
        sessionName: session,
        dir,
        claudePath: "/home/unit/claude's bin",
        promptFile,
        permissionFlags: "--dangerously-skip-permissions",
      };
      const script = buildRemoteTmuxStartScript(spec);
      execFileSync("sh", ["-n"], { input: script });
      execFileSync("sh", [], {
        input: script,
        env: { ...process.env, HOME: root },
      });
      const calls = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.deepEqual(calls[0].slice(0, -1), [
        "new-session",
        "-d",
        "-s",
        session,
        "-c",
        dir,
        "-x",
        "240",
        "-y",
        "60",
      ]);
      assert.match(
        calls[0].at(-1),
        /export PATH=.*claude.*--dangerously-skip-permissions.* < .* && rm -f /,
      );
      assert.ok(!calls[0].at(-1).includes("exit $?"));
      execFileSync("sh", ["-n"], { input: calls[0].at(-1) });
      assert.deepEqual(calls[1], [
        "set-option",
        "-t",
        `=${session}`,
        "@tfx_run_id",
        record.runId,
      ]);
      assert.deepEqual(calls[2], [
        "set-option",
        "-t",
        `=${session}`,
        "status",
        "off",
      ]);
      assert.equal(
        existsSync(join(root, "tfx-remote", session, "run-unit-run")),
        true,
      );
      assert.ok(
        !buildRemoteTmuxStartScript({ ...spec, promptFile: null }).includes(
          "rm -f",
        ),
      );
    });
  });

  it("attach는 대화형 SSH 옵션과 정확한 원격 target을 사용한다", () => {
    const command = buildRemoteTmuxAttachCommand(record.host, record, "darwin");
    execFileSync("sh", ["-n"], { input: command });
    assert.ok(command.includes("ServerAliveInterval=15"));
    assert.ok(command.includes("ControlMaster=auto"));
    assert.ok(!command.includes("BatchMode"));
    assert.ok(command.includes("m2.ts.net"));
    const script = buildRemoteTmuxCommand(record, "attach-session");
    assert.ok(script.startsWith(`export PATH='/opt/homebrew/bin':"$PATH"; `));
    assert.ok(script.includes(`show-options -qv -t '=${session}' @tfx_run_id`));
    assert.ok(
      script.endsWith(
        `exec '/opt/homebrew/bin/tmux' attach-session -t '=${session}'`,
      ),
    );
    const win = buildRemoteTmuxAttachCommand(record.host, record, "win32");
    assert.ok(!win.includes("ControlMaster"));
    assert.ok(win.includes(`-t ''=${session}''`));
    assert.ok(win.includes('"$PATH"'));
  });
});

it("명시된 OS만 프로브 힌트로 사용한다", () => {
  assert.equal(
    resolveRemoteOsHint("unit", { readHost: () => ({ os: "linux", raw: {} }) }),
    undefined,
  );
  assert.equal(
    resolveRemoteOsHint("unit", {
      readHost: () => ({ os: "darwin", raw: { os: "macos" } }),
    }),
    "darwin",
  );
});

it("동명 원격 세션의 runId가 다르면 attach와 kill을 실행하지 않는다", async () => {
  await withRecord((_recordPath, root) => {
    const log = join(root, "tmux-guard.jsonl");
    const tmuxPath = join(root, "tmux");
    writeFileSync(
      tmuxPath,
      `#!${process.execPath}\nconst args = process.argv.slice(2); require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n'); if (args[0] === 'show-options') console.log(process.env.TEST_RUN_ID);\n`,
      { mode: 0o700 },
    );
    for (const action of ["attach-session", "kill-session", "has-session"]) {
      const script = buildRemoteTmuxCommand({ ...record, tmuxPath }, action);
      execFileSync("sh", ["-n"], { input: script });
      const result = spawnSync("sh", ["-c", script], {
        encoding: "utf8",
        env: { ...process.env, TEST_RUN_ID: "another-run" },
      });
      assert.equal(result.status, 3);
      assert.match(result.stderr, /runId mismatch/);
    }
    const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((args) => args[0] === "show-options"));
    execFileSync(
      "sh",
      ["-c", buildRemoteTmuxCommand({ ...record, tmuxPath }, "kill-session")],
      { env: { ...process.env, TEST_RUN_ID: record.runId } },
    );
    assert.equal(
      JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1))[0],
      "kill-session",
    );
  });
});

describe("원격 tmux 기록 수명", () => {
  it("로컬 pane 정리와 monitor 종료가 재접속 기록을 보존한다", async () => {
    await withRecord(async (recordPath) => {
      let now = 0;
      await __remoteSpawnTest.watchSpawnSessionExit(session, {
        sessionExists: () => true,
        getPaneStatus: () => ({ isDead: true }),
        killSession: () => {},
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      });
      assert.equal(existsSync(recordPath), true);
      const result = await monitorClaudeSession(session, {
        sessionExists: () => false,
        emit: () => {},
      });
      assert.match(result.events[0].message, new RegExp(`--attach ${session}`));
      assert.equal(existsSync(recordPath), true);
    });
  });

  for (const platform of ["darwin", "win32"]) {
    it(`${platform}: 원격 has-session 성공 뒤 로컬 세션을 다시 만들고 attach한다`, async () => {
      await withRecord(async (recordPath) => {
        const calls = [];
        await attachSession(session, {
          platform,
          sessionExists: () => false,
          runRemote: (host, command) => {
            calls.push(["remote", host, command]);
            return { ok: true };
          },
          multiplexerExec: (args) => calls.push(["tmux", args]),
          createSession: (name) => calls.push(["psmux", name]),
          sendKeys: (pane, command) => calls.push(["send", pane, command]),
          startWatcher: () => {},
          openAttachTab: (name) => calls.push(["attach", name]),
        });
        assert.deepEqual(calls[0], [
          "remote",
          record.host,
          buildRemoteTmuxCommand(record, "has-session"),
        ]);
        assert.equal(calls[1][0], platform === "win32" ? "psmux" : "tmux");
        assert.ok(JSON.stringify(calls).includes("attach-session"));
        assert.deepEqual(calls.at(-1), ["attach", session]);
        assert.equal(existsSync(recordPath), true);
      });
    });
  }

  it("원격 세션 확인에 실패하면 로컬 세션을 만들지 않는다", async () => {
    await withRecord(async () => {
      await assert.rejects(
        attachSession(session, {
          sessionExists: () => false,
          runRemote: () => ({ ok: false, status: 1 }),
          multiplexerExec: () => assert.fail("unexpected creation"),
          openAttachTab: () => assert.fail("unexpected attach"),
        }),
        /remote tmux session not found/,
      );
    });
  });

  for (const status of [1, 3, 255]) {
    it(`kill-session 뒤 has-session exit ${status}를 확인하고 기록 삭제 여부를 결정한다`, async () => {
      await withRecord(async (recordPath) => {
        const calls = [];
        const result = await killSpawnSession(session, {
          killLocal: () => {},
          runRemote: (host, command) => {
            calls.push([host, command]);
            return command.includes("has-session")
              ? { ok: false, status }
              : { ok: true };
          },
        });
        assert.deepEqual(calls[0], [
          record.host,
          buildRemoteTmuxCommand(record, "kill-session"),
        ]);
        assert.deepEqual(calls[1], [
          record.host,
          buildRemoteTmuxCommand(record, "has-session"),
        ]);
        assert.equal(result.ok, status === 1);
        assert.equal(existsSync(recordPath), status !== 1);
        assert.ok(!calls.some(([, command]) => command.includes("pgrep")));
      });
    });
  }
});

describe("spawn CLI 실패 보고", () => {
  for (const failure of ["probe", "bootstrap", "lost-response", "pane-gone"]) {
    it(`${failure}: 원래 오류와 exit 1을 반환한다`, async () => {
      await withRecord((_recordPath, root) => {
        const scriptPath = fileURLToPath(
          new URL("../../scripts/remote-spawn.mjs", import.meta.url),
        );
        const fake = `
          import cp from 'node:child_process';
          import { syncBuiltinESMExports } from 'node:module';
          const fail = ${JSON.stringify(failure)};
          let captures = 0;
          cp.execFileSync = (file, args, options = {}) => {
            if (file === 'ssh') {
              if (fail === 'probe') throw new Error('probe fixture: access denied');
              if (args.includes('pwsh')) throw new Error('no pwsh');
              if (options.input?.includes('echo shell=')) return 'os=linux\\nhome=/home/unit\\nshell=bash\\nclaude=/bin/claude\\ntmux=/bin/tmux\\n';
              if (fail === 'bootstrap') throw Object.assign(new Error('duplicate session fixture'), { status: 1 });
              if (fail === 'lost-response') throw Object.assign(new Error('ssh response lost fixture'), { status: 255 });
              return '';
            }
            if (args[0] === 'capture-pane') return captures++ === 0 ? 'ssh fixture: connection lost' : '';
            if (args[0] === 'has-session') throw Object.assign(new Error('no session'), { status: 1 });
            return '';
          };
          cp.execSync = () => '';
          cp.spawn = () => ({ unref() {}, on() {}, once() {} });
          syncBuiltinESMExports();
          let clock = 1000000;
          Date.now = () => (clock += 20000);
          globalThis.setTimeout = (fn) => { fn(); return 0; };
          process.argv = ['node', ${JSON.stringify(scriptPath)}, '--host', 'cli-unit.ts.net', '--name', 'failure', '--no-attach'];
          await import(${JSON.stringify(new URL("../../scripts/remote-spawn.mjs", import.meta.url).href)});
        `;
        const result = spawnSync(
          process.execPath,
          ["--input-type=module", "-e", fake],
          {
            cwd: root,
            encoding: "utf8",
            timeout: 10000,
            env: {
              ...process.env,
              XDG_STATE_HOME: root,
              PSMUX_BIN: "fake-mux",
              TFX_SPAWN_TRACE: "0",
            },
          },
        );
        assert.equal(result.status, 1, result.stderr);
        assert.ok(!result.stderr.includes("Windows 원격만 지원"));
        if (failure === "probe") {
          assert.match(result.stderr, /probe fixture: access denied/);
        } else if (failure === "bootstrap") {
          assert.match(result.stderr, /duplicate session fixture/);
          assert.equal(
            existsSync(
              join(
                root,
                "triflux",
                "remote-spawn",
                "tfx-spawn-cli-unit-ts-net-failure.json",
              ),
            ),
            false,
          );
        } else if (failure === "lost-response") {
          assert.match(result.stderr, /ssh response lost fixture/);
          assert.equal(
            existsSync(
              join(
                root,
                "triflux",
                "remote-spawn",
                "tfx-spawn-cli-unit-ts-net-failure.json",
              ),
            ),
            true,
          );
        } else {
          assert.match(
            result.stderr,
            /spawn failed: local session disappeared/,
          );
          assert.match(result.stderr, /ssh fixture: connection lost/);
          assert.match(
            result.stderr,
            /--attach tfx-spawn-cli-unit-ts-net-failure/,
          );
          assert.equal(
            existsSync(
              join(
                root,
                "triflux",
                "remote-spawn",
                "tfx-spawn-cli-unit-ts-net-failure.json",
              ),
            ),
            true,
          );
        }
      });
    });
  }
});
