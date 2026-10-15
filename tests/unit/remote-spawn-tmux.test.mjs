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
  buildRemotePosixSpawnCommands,
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
};
const hasTmux = spawnSync("tmux", ["-V"]).status === 0;

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
        "m2-ts-net",
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
        binDirs: ["/opt/homebrew/bin"],
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
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].slice(0, 10), [
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
        calls[0][10],
        /export PATH=.*claude.*--dangerously-skip-permissions.* < .* && rm -f /,
      );
      assert.ok(!calls[0][10].includes("exit $?"));
      execFileSync("sh", ["-n"], { input: calls[0][10] });
      assert.deepEqual(calls[0].slice(11), [
        ";",
        "set-option",
        "-t",
        `=${session}:`,
        "@tfx_run_id",
        record.runId,
        ";",
        "set-option",
        "-t",
        `=${session}:`,
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
    assert.ok(!script.includes("export PATH="));
    assert.ok(
      script.includes(`show-options -qv -t '=${session}:' @tfx_run_id`),
    );
    assert.ok(
      script.endsWith(
        `exec '/opt/homebrew/bin/tmux' attach-session -t '=${session}'`,
      ),
    );
    const win = buildRemoteTmuxAttachCommand(record.host, record, "win32");
    assert.ok(!win.includes("ControlMaster"));
    assert.ok(win.includes(`-t ''=${session}''`));
    assert.ok(!win.includes('"$PATH"'));
  });
});

it("실제 tmux에서 생성, 소유 확인, 정확 매칭, 종료 상태를 확인한다", {
  skip: !hasTmux,
}, async () => {
  await withRecord((_recordPath, root) => {
    const socket = join(root, "sock");
    const tmuxPath = join(root, "tmux-wrapper");
    writeFileSync(
      tmuxPath,
      `#!/bin/sh\nexec tmux -S '${socket}' -f /dev/null "$@"\n`,
      { mode: 0o700 },
    );
    const liveRecord = { ...record, tmuxPath };
    const run = (action, override = {}) =>
      spawnSync(
        "sh",
        ["-c", buildRemoteTmuxCommand({ ...liveRecord, ...override }, action)],
        { encoding: "utf8" },
      );
    try {
      assert.equal(
        run("has-session", { tmuxPath: join(root, "missing-tmux") }).status,
        127,
      );
      const start = spawnSync("sh", [], {
        input: buildRemoteTmuxStartScript({
          ...liveRecord,
          sessionName: session,
          dir: root,
          claudePath: "/bin/sleep",
          permissionFlags: "60",
        }),
        encoding: "utf8",
        env: { ...process.env, HOME: root },
      });
      assert.equal(start.status, 0, start.stderr);
      assert.equal(run("has-session").status, 0);
      assert.equal(run("kill-session", { runId: "another-run" }).status, 3);
      assert.equal(run("has-session").status, 0);
      execFileSync(tmuxPath, [
        "new-session",
        "-d",
        "-s",
        `${session}-extra`,
        "sleep 60",
      ]);
      assert.equal(run("kill-session").status, 0);
      assert.equal(run("has-session").status, 1);
      execFileSync(tmuxPath, ["kill-server"]);
      assert.equal(run("has-session").status, 1);
    } finally {
      spawnSync(tmuxPath, ["kill-server"]);
    }
  });
});

it("capabilities가 없어도 Claude 디렉터리의 node로 npm 셔뱅을 실행한다", async () => {
  await withRecord((_recordPath, root) => {
    const bin = join(root, "bin's $(not-a-command)");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "node"),
      "#!/bin/sh\nprintf 'node from claude bin'\n",
      { mode: 0o700 },
    );
    writeFileSync(join(bin, "claude"), "#!/usr/bin/env node\n", {
      mode: 0o700,
    });
    const script = buildRemotePosixSpawnCommands({
      claudePath: join(bin, "claude"),
    }).join("\n");
    const result = spawnSync("sh", [], {
      input: script,
      encoding: "utf8",
      env: { ...process.env, PATH: "/usr/bin:/bin" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "node from claude bin");
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
  for (const os of ["Windows 11", "linxu", "not-darwin"]) {
    assert.equal(
      resolveRemoteOsHint("unit", {
        readHost: () => ({ os: "linux", raw: { os } }),
      }),
      undefined,
    );
  }
  assert.equal(
    resolveRemoteOsHint("unit", {
      readHost: () => {
        throw new Error("invalid hosts.json");
      },
    }),
    undefined,
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
    assert.equal(calls.length, 6);
    assert.ok(
      calls.every((args) => ["has-session", "show-options"].includes(args[0])),
    );
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
  for (const remoteTmux of [true, false]) {
    it(`remoteTmux=${remoteTmux}: 1시간 뒤 종료 시 원격 tmux 감시자만 기록을 정리한다`, async () => {
      await withRecord(async (recordPath) => {
        writeFileSync(recordPath, JSON.stringify({ ...record, remoteTmux }));
        let now = 0;
        await __remoteSpawnTest.runSpawnCleanupWatcher(
          session,
          `${session}:0.0`,
          {
            now: () => now,
            sleep: async () => {
              now += 2 * 60 * 60 * 1000;
            },
            sessionExists: () => {
              if (!remoteTmux) assert.equal(now, 0);
              return now === 0;
            },
            getPaneStatus: () => ({ isDead: false }),
            runRemote: () => ({ ok: false, status: 1 }),
          },
        );
        assert.equal(existsSync(recordPath), !remoteTmux);
      });
    });
  }

  for (const status of [1, 3, 127, 255, null]) {
    it(`attach의 실제 throw status ${status}: 세션 부재일 때만 기록을 정리한다`, async () => {
      await withRecord(async (recordPath) => {
        const commands = [];
        await assert.rejects(
          attachSession(session, {
            sessionExists: () => false,
            runRemote: (_host, command) => {
              commands.push(command);
              if (command.includes("has-session"))
                throw Object.assign(new Error("probe fixture"), { status });
              return { ok: true };
            },
            multiplexerExec: () => assert.fail("unexpected creation"),
            openAttachTab: () => assert.fail("unexpected attach"),
          }),
          status === 1
            ? /remote tmux session ended/
            : /remote tmux session check failed.*probe fixture/,
        );
        assert.equal(existsSync(recordPath), status !== 1);
        assert.equal(
          commands.some((command) => command.includes("rmdir")),
          status === 1,
        );
      });
    });

    for (const localState of ["session-missing", "pane-dead"]) {
      it(`감시자 ${localState}, 원격 status ${status}: 세션 부재일 때만 기록을 정리한다`, async () => {
        await withRecord(async (recordPath) => {
          const commands = [];
          await __remoteSpawnTest.runSpawnCleanupWatcher(
            session,
            `${session}:0.0`,
            {
              sessionExists: () => localState === "pane-dead",
              getPaneStatus: () => ({ isDead: true }),
              killSession: () => {},
              sleep: async () => {},
              runRemote: (_host, command) => {
                commands.push(command);
                if (command.includes("has-session"))
                  throw Object.assign(new Error("probe fixture"), { status });
                return { ok: true };
              },
            },
          );
          assert.equal(existsSync(recordPath), status !== 1);
          assert.equal(
            commands.filter((command) => command.includes("has-session"))
              .length,
            1,
          );
          assert.equal(
            commands.some((command) => command.includes("rmdir")),
            status === 1,
          );
        });
      });
    }
  }

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
        /remote tmux session ended/,
      );
    });
  });

  for (const status of [1, 3, 127, 255]) {
    it(`kill-session 뒤 has-session exit ${status}를 확인하고 기록 삭제 여부를 결정한다`, async () => {
      await withRecord(async (recordPath) => {
        const calls = [];
        const result = await killSpawnSession(session, {
          runId: "ignored-run",
          killLocal: () => {},
          runRemote: (host, command) => {
            calls.push([host, command]);
            return command.endsWith(`has-session -t '=${session}'`)
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
  for (const failure of [
    "probe",
    "bootstrap",
    "lost-response",
    "pane-gone",
    "pane-gone-at-timeout",
  ]) {
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
          let waitedOnce = false;
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
            if (args[0] === 'has-session') {
              if (fail === 'pane-gone-at-timeout' && !waitedOnce) return '';
              throw Object.assign(new Error('no session'), { status: 1 });
            }
            return '';
          };
          cp.execSync = () => '';
          cp.spawn = () => ({ unref() {}, on() {}, once() {} });
          syncBuiltinESMExports();
          let clock = 1000000;
          Date.now = () => (clock += 20000);
          globalThis.setTimeout = (fn) => {
            if (fail !== 'pane-gone-at-timeout') throw new Error('unexpected readiness wait');
            waitedOnce = true;
            clock += 60000;
            fn();
            return 0;
          };
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
