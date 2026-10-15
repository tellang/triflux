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
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import * as remote from "../../scripts/remote-spawn.mjs";

const session = "tfx-spawn-win-unit";
const record = {
  host: "win-unit",
  runId: "unit-run",
  remoteTmux: true,
  remoteMux: "psmux",
  remoteSessionName: session,
  psmuxPath: "C:/tools' folder/psmux.exe",
  claudePath: "C:/npm's bin/claude.ps1",
  remoteRunDir: "C:/Users/example/tfx-remote/unit/run-unit-run",
};

it("경로의 줄바꿈은 pane 명령으로 보내기 전에 거부한다", () => {
  const moduleUrl = new URL("../../scripts/remote-spawn.mjs", import.meta.url);
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const { __remoteSpawnTest } = await import(${JSON.stringify(moduleUrl.href)});
    __remoteSpawnTest.parseArgs(['node', 'remote-spawn', '--dir', 'C:/work\\n']);
  `,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid directory path/);
});

async function withRecord(run) {
  const root = mkdtempSync(join(tmpdir(), "tfx-remote-psmux-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  const recordPath = join(root, "triflux", "remote-spawn", `${session}.json`);
  mkdirSync(join(root, "triflux", "remote-spawn"), { recursive: true });
  writeFileSync(recordPath, JSON.stringify(record));
  try {
    await run(recordPath);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

it("Windows 원격 psmux가 있을 때 mac/Linux 로컬 tmux 레인을 선택한다", () => {
  for (const platform of ["darwin", "linux"]) {
    assert.equal(
      remote.resolveSpawnLane({
        platform,
        multiplexerAvailable: true,
        remoteOs: "win32",
        remotePsmuxAvailable: true,
      }),
      "tmux",
    );
    assert.equal(
      remote.resolveSpawnLane({
        platform,
        multiplexerAvailable: true,
        remoteOs: "win32",
        remotePsmuxAvailable: false,
      }),
      "fallback",
    );
  }
});

it("psmux 시작은 경로를 PowerShell로 인용하고 프롬프트 본문을 argv에 넣지 않는다", () => {
  assert.equal(typeof remote.buildRemotePsmuxStartScript, "function");
  const script = remote.buildRemotePsmuxStartScript({
    ...record,
    sessionName: session,
    dir: "C:/work's dir/$literal",
    claudePath: record.claudePath,
    promptFile: "C:/stage's dir/prompt.md",
    permissionFlags: "--dangerously-skip-permissions",
  });
  assert.match(script, /& 'C:\/tools'' folder\/psmux.exe' new-session -d/);
  assert.match(script, /-c 'C:\/work''s dir\/\$literal'/);
  assert.match(script, /'@tfx_run_id' 'unit-run'/);
  const encoded = script.match(
    /pwsh -NoProfile -EncodedCommand ([A-Za-z0-9+/=]+)/,
  )?.[1];
  assert.ok(encoded);
  const launch = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(
    launch,
    /Get-Content -Raw -Encoding utf8 -LiteralPath 'C:\/stage''s dir\/prompt.md' \| & 'C:\/npm''s bin\/claude.ps1' --dangerously-skip-permissions/,
  );
  assert.ok(!launch.includes(" -p "));
  assert.ok(!launch.includes("$raw"));
});

it("attach 명령은 양쪽 로컬 셸에서 원격 PowerShell EncodedCommand를 전달한다", () => {
  for (const platform of ["darwin", "win32"]) {
    const command = remote.buildRemoteTmuxAttachCommand(
      record.host,
      record,
      platform,
    );
    assert.ok(!command.includes("BatchMode"));
    assert.equal(command.includes("ControlMaster"), platform !== "win32");
    execFileSync("sh", ["-n"], { input: command });
    const encoded = command.match(
      /pwsh -NoProfile -EncodedCommand ([A-Za-z0-9+/=]+)/,
    )?.[1];
    assert.ok(encoded);
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    assert.match(script, /has-session -t '=tfx-spawn-win-unit'/);
    assert.match(
      script,
      /show-options -qv -t '=tfx-spawn-win-unit:' '@tfx_run_id'/,
    );
    assert.match(script, /attach-session -t '=tfx-spawn-win-unit'/);
  }
});

for (const detachStatus of [0, 1, 2, 3, 255, null]) {
  it(`detach status ${detachStatus}: 성공 확인과 대기 뒤에만 kill한다`, async () => {
    await withRecord(async (path) => {
      const steps = [];
      let killed = false;
      const result = await remote.killSpawnSession(session, {
        killLocal: () => {},
        sleep: async () => steps.push("wait"),
        runRemote: (_host, command, os) => {
          assert.equal(os, "win32");
          if (command.includes("detach-client")) {
            steps.push("detach");
            assert.match(command, /detach-client -s 'tfx-spawn-win-unit'/);
            return { ok: detachStatus === 0, status: detachStatus };
          }
          if (command.includes("kill-session")) {
            steps.push("kill");
            killed = true;
            return { ok: true };
          }
          if (command.includes("has-session")) {
            steps.push("has");
            return killed
              ? {
                  ok: false,
                  status: 1,
                  stdout: "TFX_REMOTE_SESSION_ABSENT\r\n",
                }
              : { ok: true };
          }
          steps.push("cleanup");
          return { ok: true };
        },
      });
      assert.equal(result.ok, detachStatus === 0);
      assert.equal(existsSync(path), detachStatus !== 0);
      if (detachStatus === 0)
        assert.deepEqual(steps, ["detach", "wait", "kill", "has", "cleanup"]);
      else assert.ok(!steps.includes("kill"));
    });
  });
}

for (const [status, stdout] of [
  [1, "TFX_REMOTE_SESSION_ABSENT\r\n"],
  [1, ""],
  [2, ""],
  [3, ""],
  [127, ""],
  [255, ""],
  [null, ""],
]) {
  it(`Windows 원격 status ${status}, 부재 표식 ${Boolean(stdout)}: attach와 감시자는 세션 부재만 기록 삭제 근거로 쓴다`, async () => {
    for (const action of ["attach", "watch"]) {
      await withRecord(async (path) => {
        const options = {
          sessionExists: () => false,
          runRemote: (_host, command, os) => {
            assert.equal(os, "win32");
            if (command.includes("has-session"))
              throw Object.assign(new Error("remote fixture"), {
                status,
                stdout,
              });
            assert.match(
              command,
              /Remove-Item -LiteralPath 'C:\/Users\/example\/tfx-remote\/unit\/run-unit-run'/,
            );
            return { ok: true };
          },
          multiplexerExec: () => assert.fail("unexpected local create"),
          openAttachTab: () => assert.fail("unexpected attach"),
        };
        if (action === "attach")
          await assert.rejects(remote.attachSession(session, options));
        else
          await remote.__remoteSpawnTest.runSpawnCleanupWatcher(
            session,
            `${session}:0.0`,
            options,
          );
        assert.equal(existsSync(path), !stdout);
      });
    }
  });
}

for (const mode of ["psmux", "fallback", "start-error", "owner-mismatch"]) {
  it(`${mode}: CLI는 프로브 경로와 실행별 파일을 쓰고 복구할 기록을 보존한다`, () => {
    const root = mkdtempSync(join(tmpdir(), "tfx-win-cli-"));
    const moduleUrl = new URL(
      "../../scripts/remote-spawn.mjs",
      import.meta.url,
    );
    const script = `
      import cp from 'node:child_process';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const events = [];
      const mode = ${JSON.stringify(mode)};
      const prompt = 'LONG_PROMPT '.repeat(4000);
      cp.execFileSync = (file, args, options = {}) => {
        if (file === 'scp') {
          events.push(['upload', args.at(-1), fs.readFileSync(args.at(-2), 'utf8')]);
          return '';
        }
        if (file === 'ssh') {
          const cmd = args.at(-1);
          const decoded = cmd.startsWith('pwsh -NoProfile -EncodedCommand ')
            ? Buffer.from(cmd.split(' ').at(-1), 'base64').toString('utf16le') : cmd;
          if (decoded.includes("shell=pwsh")) return "os=win32\\nshell=pwsh\\nhome=C:/Users/example's home\\nclaude=C:/npm's bin/claude.ps1\\npsmux=" + (mode === 'fallback' ? 'notfound' : 'C:/mux bin/psmux.exe') + '\\n';
          events.push(['ssh', decoded]);
          if (decoded.includes('new-session') && mode !== 'psmux') throw Object.assign(new Error('start fixture'), { status: 1 });
          if (decoded.includes('has-session') && mode === 'owner-mismatch') throw Object.assign(new Error('owner fixture'), { status: 1, stdout: '' });
          return '';
        }
        if (file === 'git') return 'unit';
        if (args[0] === 'capture-pane') return '? for shortcuts';
        events.push(['mux', args]);
        return '';
      };
      cp.execSync = () => '';
      cp.spawn = (file, args) => { events.push(['spawn', file, args]); return { unref() {}, on() {}, once() {} }; };
      syncBuiltinESMExports();
      process.on('exit', () => fs.writeFileSync(${JSON.stringify(join(root, "events.json"))}, JSON.stringify(events)));
      process.argv = ['node', ${JSON.stringify(fileURLToPath(moduleUrl))}, '--host', 'win-unit', '--name', 'cli', '--dir', "C:/work's dir", '--prompt', prompt, '--no-attach'];
      await import(${JSON.stringify(moduleUrl.href)});
    `;
    try {
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", script],
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
      assert.equal(
        result.status,
        ["start-error", "owner-mismatch"].includes(mode) ? 1 : 0,
        result.stderr,
      );
      const events = JSON.parse(
        readFileSync(join(root, "events.json"), "utf8"),
      );
      const uploads = events.filter(([kind]) => kind === "upload");
      assert.ok(
        uploads.some(
          ([, target, content]) =>
            target.endsWith("/prompt.md") &&
            content === "LONG_PROMPT ".repeat(4000),
        ),
      );
      if (mode === "fallback") {
        const launcher = uploads.find(([, target]) =>
          /tfx-remote-spawn-[a-f0-9]{8}\.ps1$/.test(target),
        );
        assert.ok(launcher);
        assert.ok(launcher[2].includes("& 'C:/npm''s bin/claude.ps1'"));
        assert.ok(!launcher[2].includes("LONG_PROMPT"));
        const ssh = events.find(
          ([kind, file]) => kind === "spawn" && file === "ssh",
        );
        assert.match(
          ssh[2].at(-1),
          /^pwsh -NoProfile -File 'C:\/Users\/example''s home\/tfx-remote-spawn-[a-f0-9]{8}\.ps1'$/,
        );
        assert.equal(result.stderr.split("ssh가 끊기면").length - 1, 1);
      } else {
        const saved = JSON.parse(
          readFileSync(
            join(
              root,
              "triflux",
              "remote-spawn",
              "tfx-spawn-win-unit-cli.json",
            ),
            "utf8",
          ),
        );
        assert.equal(saved.remoteMux, "psmux");
        assert.equal(saved.psmuxPath, "C:/mux bin/psmux.exe");
        assert.ok(saved.remoteRunDir.endsWith(`/run-${saved.runId}`));
        if (mode === "psmux") {
          const localStart = events.find(
            ([kind, args]) => kind === "mux" && args[0] === "new-session",
          );
          assert.match(
            localStart[1].at(-1),
            /^ssh -t .*pwsh -NoProfile -EncodedCommand/,
          );
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
