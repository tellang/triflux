import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  __remoteSpawnTest,
  attachSpawnedSession,
  buildRemoteClaudeProcessCountCommand,
  buildRemoteDaemonStopCommand,
  buildRemotePathExportCommand,
  buildRemotePosixSpawnCommands,
  buildTmuxAttachSplitArgs,
  buildTmuxRemoteLaneCommand,
  buildTmuxSpawnSessionArgs,
  classifyClaudeScreen,
  collectRemoteBinDirs,
  formatMonitorEvent,
  inferRemoteHostFromSessionName,
  killSpawnSession,
  monitorClaudeSession,
  parseRemoteProcessCount,
  resolveRemoteBinDirs,
  resolveSpawnLane,
  resolveStallThresholdSec,
  waitForClaudeScreenState,
} from "../../scripts/remote-spawn.mjs";

const { parseArgs } = __remoteSpawnTest;

// claude 2.1.239 실측 캡처를 줄인 픽스처. 각 화면의 결정 신호만 남겼다.
const CAPTURE_HOME = [
  " ▐▛███▜▌  Claude Code v2.1.239",
  "",
  "   Sessions",
  "   > tfx-remote-lifecycle          2m ago",
  "",
  "   describe a task for a new session",
  "",
].join("\n");

const CAPTURE_REPL = [
  "╭──────────────────────────────────────────╮",
  "│ >                                        │",
  "╰──────────────────────────────────────────╯",
  "  ? for shortcuts                bypass permissions on",
].join("\n");

const CAPTURE_TRUST = [
  "╭─ Do you trust the files in this folder? ─╮",
  "│ Is this a project you created or trust?  │",
  "│ > 1. Yes, proceed                        │",
  "╰──────────────────────────────────────────╯",
].join("\n");

const CAPTURE_NEEDS_INPUT = [
  "   Sessions",
  "   > remote-lifecycle       Needs input        4m ago",
  "",
  "   describe a task for a new session",
].join("\n");

const CAPTURE_BUSY = [
  "✻ Compacting conversation… (18s · esc to interrupt)",
].join("\n");

describe("classifyClaudeScreen()", () => {
  it("홈 화면을 REPL로 오판하지 않는다", () => {
    assert.equal(classifyClaudeScreen(CAPTURE_HOME), "home");
  });

  it("REPL 프롬프트 박스를 repl로 판정한다", () => {
    assert.equal(classifyClaudeScreen(CAPTURE_REPL), "repl");
  });

  it("trust 프롬프트를 trust_prompt로 판정한다", () => {
    assert.equal(classifyClaudeScreen(CAPTURE_TRUST), "trust_prompt");
  });

  it("홈 화면의 Needs input을 needs_input으로 우선 판정한다", () => {
    assert.equal(classifyClaudeScreen(CAPTURE_NEEDS_INPUT), "needs_input");
  });

  it("실행 중 화면을 busy로 판정한다", () => {
    assert.equal(classifyClaudeScreen(CAPTURE_BUSY), "busy");
  });

  it("빈 캡처와 미지의 화면은 unknown이다", () => {
    assert.equal(classifyClaudeScreen(""), "unknown");
    assert.equal(classifyClaudeScreen("   \n  \n"), "unknown");
    assert.equal(classifyClaudeScreen("Last login: Tue Sep 2"), "unknown");
  });
});

describe("waitForClaudeScreenState()", () => {
  it("목표 상태에 도달하면 상태를 구분해 반환한다", async () => {
    const frames = ["", CAPTURE_BUSY, CAPTURE_HOME];
    let index = 0;
    let nowMs = 0;

    const result = await waitForClaudeScreenState({
      capture: () => frames[Math.min(index++, frames.length - 1)],
      now: () => nowMs,
      pollMs: 100,
      sleep: async (ms) => {
        nowMs += ms;
      },
      targetStates: ["repl", "home"],
      timeoutMs: 5000,
    });

    assert.equal(result.ready, true);
    assert.equal(result.state, "home");
    assert.deepEqual(result.states, ["unknown", "busy", "home"]);
  });

  it("호출자가 지정한 목표 상태만 준비로 인정한다", async () => {
    let nowMs = 0;
    const result = await waitForClaudeScreenState({
      capture: () => CAPTURE_HOME,
      now: () => nowMs,
      pollMs: 100,
      sleep: async (ms) => {
        nowMs += ms;
      },
      targetStates: ["repl"],
      timeoutMs: 300,
    });

    assert.equal(result.ready, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.state, "home");
  });
});

describe("collectRemoteBinDirs() / spawn 명령 조립", () => {
  const m2Host = {
    os: "darwin",
    raw: {
      capabilities_v2: {
        claude: "/Users/tellang/.nvm/versions/node/v22.22.2/bin/claude",
        codex: "/Users/tellang/.nvm/versions/node/v22.22.2/bin/codex",
        tmux: "/opt/homebrew/bin/tmux",
      },
    },
  };

  it("claude 경로 디렉터리를 맨 앞에 두고 중복을 제거한다", () => {
    assert.deepEqual(collectRemoteBinDirs(m2Host), [
      "/Users/tellang/.nvm/versions/node/v22.22.2/bin",
      "/opt/homebrew/bin",
    ]);
  });

  it("windows 호스트와 비-posix 경로는 대상이 아니다", () => {
    assert.deepEqual(
      collectRemoteBinDirs({
        os: "windows",
        raw: {
          capabilities_v2: {
            claude: "C:\\Users\\tellang\\AppData\\Roaming\\npm\\claude.ps1",
          },
        },
      }),
      [],
    );
    assert.deepEqual(
      collectRemoteBinDirs({
        os: "linux",
        raw: { capabilities_v2: { claude: true, codex: "relative/claude" } },
      }),
      [],
    );
  });

  it("capabilities_v2가 없으면 PATH를 주입하지 않는다", () => {
    const host = { os: "darwin", raw: { capabilities: ["claude"] } };
    assert.deepEqual(collectRemoteBinDirs(host), []);
    assert.equal(buildRemotePathExportCommand([]), "");

    const commands = buildRemotePosixSpawnCommands({
      binDirs: collectRemoteBinDirs(host),
      claudePath: "/usr/local/bin/claude",
      dir: "/Users/tellang/projects/triflux",
      permissionFlags: "--dangerously-skip-permissions",
    });
    assert.equal(commands.length, 2);
    assert.equal(commands[0], "cd '/Users/tellang/projects/triflux'");
    assert.ok(!commands.some((command) => command.includes("export PATH")));
  });

  it("posix spawn 명령은 PATH prefix → cd → claude 순서다", () => {
    const commands = buildRemotePosixSpawnCommands({
      binDirs: collectRemoteBinDirs(m2Host),
      claudePath: "/Users/tellang/.nvm/versions/node/v22.22.2/bin/claude",
      dir: "/Users/tellang/projects/triflux",
      permissionFlags: "--dangerously-skip-permissions",
    });

    assert.equal(commands.length, 3);
    assert.match(commands[0], /^export PATH=/);
    assert.match(
      commands[0],
      /'\/Users\/tellang\/\.nvm\/versions\/node\/v22\.22\.2\/bin'/,
    );
    assert.match(commands[0], /:"\$PATH"$/);
    assert.equal(commands[1], "cd '/Users/tellang/projects/triflux'");
    assert.match(commands[2], /--dangerously-skip-permissions/);
    assert.match(commands[2], /exit \$\?$/);
  });

  it("프롬프트 파일이 있으면 리다이렉트 + 정리를 붙인다", () => {
    const commands = buildRemotePosixSpawnCommands({
      binDirs: [],
      claudePath: "/usr/local/bin/claude",
      dir: "~",
      promptFile: "/tmp/tfx-remote/session/prompt.md",
    });
    assert.match(commands.at(-1), /< '\/tmp\/tfx-remote\/session\/prompt\.md'/);
    assert.match(
      commands.at(-1),
      /rm -f '\/tmp\/tfx-remote\/session\/prompt\.md'/,
    );
  });

  it("호스트 조회 실패는 빈 목록으로 흡수한다", () => {
    const dirs = resolveRemoteBinDirs("missing-host", {
      readHost: () => {
        throw new Error("hosts.json unreadable");
      },
    });
    assert.deepEqual(dirs, []);
  });
});

describe("monitorClaudeSession()", () => {
  function fakeClock() {
    let nowMs = 0;
    return {
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
      },
    };
  }

  it("needs_input을 임계 대기 없이 즉시 보고한다", async () => {
    const clock = fakeClock();
    const emitted = [];
    let polls = 0;

    await monitorClaudeSession("tfx-spawn-m2-lifecycle", {
      capture: () => CAPTURE_NEEDS_INPUT,
      emit: (event) => emitted.push(event),
      now: clock.now,
      pollMs: 1000,
      sessionExists: () => polls++ < 2,
      sleep: clock.sleep,
      stallThresholdSec: 1200,
    });

    const needsInput = emitted.find((event) => event.event === "needs_input");
    assert.ok(needsInput, "needs_input 이벤트가 있어야 한다");
    assert.ok(needsInput.at < 1200 * 1000);
    assert.equal(
      emitted.some((event) => event.event === "stall"),
      false,
    );
  });

  it("상태 전이 없이 임계를 넘기면 stall을 한 번 보고한다", async () => {
    const clock = fakeClock();
    const emitted = [];
    let polls = 0;

    await monitorClaudeSession("tfx-spawn-m2-lifecycle", {
      capture: () => CAPTURE_BUSY,
      emit: (event) => emitted.push(event),
      now: clock.now,
      pollMs: 1000,
      sessionExists: () => polls++ < 10,
      sleep: clock.sleep,
      stallThresholdSec: 3,
    });

    const stalls = emitted.filter((event) => event.event === "stall");
    assert.equal(stalls.length, 1);
    assert.equal(stalls[0].state, "busy");
    assert.equal(stalls[0].thresholdMs, 3000);
  });

  it("--auto-trust off가 기본이라 Enter를 보내지 않는다", async () => {
    const clock = fakeClock();
    const emitted = [];
    const sent = [];
    let polls = 0;

    await monitorClaudeSession("tfx-spawn-m2-lifecycle", {
      capture: () => CAPTURE_TRUST,
      emit: (event) => emitted.push(event),
      now: clock.now,
      pollMs: 1000,
      sendEnter: (name) => sent.push(name),
      sessionExists: () => polls++ < 2,
      sleep: clock.sleep,
    });

    const trust = emitted.find((event) => event.event === "trust_prompt");
    assert.ok(trust);
    assert.equal(trust.autoTrust, false);
    assert.deepEqual(sent, []);
  });

  it("--auto-trust on일 때만 Enter를 자동 전송한다", async () => {
    const clock = fakeClock();
    const sent = [];
    let polls = 0;

    await monitorClaudeSession("tfx-spawn-m2-lifecycle", {
      autoTrust: true,
      capture: () => CAPTURE_TRUST,
      emit: () => {},
      now: clock.now,
      pollMs: 1000,
      sendEnter: (name) => sent.push(name),
      sessionExists: () => polls++ < 2,
      sleep: clock.sleep,
    });

    assert.deepEqual(sent, ["tfx-spawn-m2-lifecycle"]);
  });

  it("구조화 보고 라인은 prefix + JSON이다", () => {
    const line = formatMonitorEvent({ event: "stall", state: "busy" });
    assert.match(line, /^TFX_REMOTE_EVENT \{/);
    assert.deepEqual(JSON.parse(line.slice("TFX_REMOTE_EVENT ".length)), {
      event: "stall",
      state: "busy",
    });
  });

  it("TFX_STALL_THRESHOLD를 존중하고 무효값은 기본으로 되돌린다", () => {
    assert.equal(resolveStallThresholdSec({ TFX_STALL_THRESHOLD: "60" }), 60);
    assert.equal(resolveStallThresholdSec({}), 1200);
    assert.equal(resolveStallThresholdSec({ TFX_STALL_THRESHOLD: "0" }), 1200);
  });
});

describe("killSpawnSession()", () => {
  const hostNames = ["m2", "ryzen"];

  it("세션명에서 원격 호스트를 역추론한다", () => {
    assert.equal(
      inferRemoteHostFromSessionName("tfx-spawn-m2-lifecycle", hostNames),
      "m2",
    );
    assert.equal(
      inferRemoteHostFromSessionName("tfx-spawn-local-branch", hostNames),
      null,
    );
    assert.equal(
      inferRemoteHostFromSessionName("other-session", hostNames),
      null,
    );
  });

  it("pgrep 카운트를 파싱하고 실패는 null로 남긴다", () => {
    assert.equal(parseRemoteProcessCount("       0\n"), 0);
    assert.equal(parseRemoteProcessCount("3"), 3);
    assert.equal(parseRemoteProcessCount(""), null);
    assert.equal(parseRemoteProcessCount(undefined), null);
  });

  it("readback이 0이면 양측 성공으로 보고한다", async () => {
    const commands = [];
    const result = await killSpawnSession("tfx-spawn-m2-lifecycle", {
      binDirs: ["/opt/homebrew/bin"],
      claudePath: "/opt/homebrew/bin/claude",
      hostNames,
      killLocal: () => {},
      runRemote: (host, command) => {
        commands.push([host, command]);
        return { ok: true, stdout: command.includes("pgrep") ? "0\n" : "" };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.local.ok, true);
    assert.equal(result.remote.host, "m2");
    assert.equal(result.remote.remaining, 0);
    assert.equal(commands.length, 2);
    assert.match(commands[0][1], /daemon stop --any$/);
    assert.match(commands[0][1], /^export PATH='\/opt\/homebrew\/bin'/);
    assert.equal(commands[1][1], buildRemoteClaudeProcessCountCommand());
  });

  it("잔존 프로세스가 있으면 ok:false와 남은 수를 명시한다", async () => {
    const result = await killSpawnSession("tfx-spawn-m2-lifecycle", {
      hostNames,
      killLocal: () => {},
      runRemote: (_host, command) => ({
        ok: true,
        stdout: command.includes("pgrep") ? "2\n" : "",
      }),
      sleep: async () => {},
    });

    assert.equal(result.ok, false);
    assert.equal(result.local.ok, true);
    assert.equal(result.remote.remaining, 2);
    assert.equal(result.remote.ok, false);
  });

  it("readback 실패를 성공으로 보고하지 않는다", async () => {
    const result = await killSpawnSession("tfx-spawn-m2-lifecycle", {
      hostNames,
      killLocal: () => {},
      runRemote: (_host, command) => {
        if (command.includes("pgrep")) throw new Error("ssh: connect timeout");
        return { ok: true, stdout: "" };
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.remote.remaining, null);
    assert.match(result.remote.readbackError, /connect timeout/);
  });

  it("원격 정리 실패가 로컬 정리를 막지 않는다", async () => {
    let localKilled = 0;
    const result = await killSpawnSession("tfx-spawn-m2-lifecycle", {
      hostNames,
      killLocal: () => {
        localKilled += 1;
      },
      runRemote: () => {
        throw new Error("ssh unreachable");
      },
    });

    assert.equal(localKilled, 1);
    assert.equal(result.local.ok, true);
    assert.equal(result.remote.daemonStop.ok, false);
    assert.equal(result.ok, false);
  });

  it("로컬 전용 세션은 원격 단계를 건너뛴다", async () => {
    const result = await killSpawnSession("tfx-spawn-local-branch", {
      hostNames,
      killLocal: () => {},
      runRemote: () => {
        throw new Error("원격 실행이 호출되면 안 된다");
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.remote, null);
  });

  it("로컬 정리 실패를 별도로 보고한다", async () => {
    const result = await killSpawnSession("tfx-spawn-local-branch", {
      hostNames,
      killLocal: () => {
        throw new Error("session not found");
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.local.error, /session not found/);
  });
});

describe("attachSpawnedSession()", () => {
  it("tmux 안에서는 현재 창을 분할해 attach한다", async () => {
    const calls = [];
    const result = await attachSpawnedSession("tfx-spawn-m2-lifecycle", "m2", {
      env: { TMUX: "/tmp/tmux-501/default,123,0" },
      multiplexerExec: (args) => calls.push(args),
      openAttachTab: () => {
        throw new Error("tmux 경로에서 탭 attach를 쓰면 안 된다");
      },
    });

    assert.equal(result.mode, "tmux-split");
    assert.deepEqual(calls, [
      buildTmuxAttachSplitArgs("tfx-spawn-m2-lifecycle"),
    ]);
    assert.match(calls[0][1], /^env -u TMUX tmux attach -t /);
  });

  it("tmux 밖에서는 기존 탭 attach 경로를 유지한다", async () => {
    const opened = [];
    const result = await attachSpawnedSession("tfx-spawn-local", "local", {
      env: {},
      openAttachTab: (name, title) => opened.push([name, title]),
    });

    assert.equal(result.mode, "tab");
    assert.deepEqual(opened, [["tfx-spawn-local", "local"]]);
  });

  it("--no-attach는 attach를 건너뛴다", async () => {
    const result = await attachSpawnedSession("tfx-spawn-local", null, {
      attach: false,
      env: { TMUX: "x" },
      multiplexerExec: () => {
        throw new Error("attach가 호출되면 안 된다");
      },
    });

    assert.equal(result.attached, false);
    assert.equal(result.mode, "skipped");
  });
});

describe("parseArgs() 수명주기 플래그", () => {
  it("--auto-trust 기본값은 off, --no-attach 기본값은 attach on", () => {
    const parsed = parseArgs(["node", "remote-spawn.mjs", "--host", "m2"]);
    assert.equal(parsed.autoTrust, false);
    assert.equal(parsed.attach, true);
  });

  it("--auto-trust / --no-attach 를 인식한다", () => {
    const parsed = parseArgs([
      "node",
      "remote-spawn.mjs",
      "--host",
      "m2",
      "--auto-trust",
      "--no-attach",
    ]);
    assert.equal(parsed.autoTrust, true);
    assert.equal(parsed.attach, false);
  });

  it("--kill / --monitor 를 커맨드로 인식한다", () => {
    const killArgs = parseArgs([
      "node",
      "remote-spawn.mjs",
      "--kill",
      "tfx-spawn-m2-lifecycle",
    ]);
    assert.equal(killArgs.command, "kill");
    assert.equal(killArgs.sessionName, "tfx-spawn-m2-lifecycle");

    const monitorArgs = parseArgs([
      "node",
      "remote-spawn.mjs",
      "--monitor",
      "tfx-spawn-m2-lifecycle",
    ]);
    assert.equal(monitorArgs.command, "monitor");
    assert.equal(monitorArgs.sessionName, "tfx-spawn-m2-lifecycle");
  });

  it("buildRemoteDaemonStopCommand는 PATH 미주입 시 PATH 구문을 넣지 않는다", () => {
    assert.equal(
      buildRemoteDaemonStopCommand([], null),
      "claude daemon stop --any",
    );
  });
});

describe("resolveSpawnLane() 레인 선택", () => {
  it("darwin + tmux + posix 원격은 tmux 레인이다", () => {
    assert.equal(
      resolveSpawnLane({
        multiplexerAvailable: true,
        platform: "darwin",
        remoteOs: "darwin",
      }),
      "tmux",
    );
    assert.equal(
      resolveSpawnLane({
        multiplexerAvailable: true,
        platform: "linux",
        remoteOs: "linux",
      }),
      "tmux",
    );
  });

  it("windows 로컬은 psmux 레인을 그대로 유지한다", () => {
    assert.equal(
      resolveSpawnLane({
        multiplexerAvailable: true,
        platform: "win32",
        remoteOs: "darwin",
      }),
      "psmux",
    );
    assert.equal(
      resolveSpawnLane({
        multiplexerAvailable: true,
        platform: "win32",
        remoteOs: "win32",
      }),
      "psmux",
    );
  });

  it("windows 로컬에 psmux가 없으면 기존 fallback이다", () => {
    assert.equal(
      resolveSpawnLane({
        multiplexerAvailable: false,
        platform: "win32",
        remoteOs: "darwin",
      }),
      "fallback",
    );
  });

  it("tmux 부재 darwin은 기존 fallback이다", () => {
    assert.equal(
      resolveSpawnLane({
        multiplexerAvailable: false,
        platform: "darwin",
        remoteOs: "darwin",
      }),
      "fallback",
    );
  });

  it("원격 호스트가 windows거나 미확인이면 fallback이다", () => {
    assert.equal(
      resolveSpawnLane({
        multiplexerAvailable: true,
        platform: "darwin",
        remoteOs: "win32",
      }),
      "fallback",
    );
    assert.equal(
      resolveSpawnLane({
        multiplexerAvailable: true,
        platform: "darwin",
        remoteOs: null,
      }),
      "fallback",
    );
  });
});

describe("tmux 원격 레인 명령 조립", () => {
  const posixCommands = buildRemotePosixSpawnCommands({
    binDirs: ["/Users/tellang/.nvm/versions/node/v22.22.2/bin"],
    claudePath: "/Users/tellang/.nvm/versions/node/v22.22.2/bin/claude",
    dir: "/Users/tellang/projects/triflux",
    permissionFlags: "--dangerously-skip-permissions",
  });

  it("pane 명령은 ssh -t 안에 PATH prefix 스크립트를 담는다", () => {
    const command = buildTmuxRemoteLaneCommand("m2", posixCommands);
    assert.match(command, /^ssh -t m2 '/);
    assert.ok(command.includes("export PATH="));
    assert.ok(command.includes("cd "));
    assert.ok(command.includes("--dangerously-skip-permissions"));
    assert.ok(!command.includes("pwsh"));
    assert.ok(!command.includes("$env:"));
  });

  it("detached 세션 인자는 new-session -d -s 뒤에 pane 명령을 둔다", () => {
    const command = buildTmuxRemoteLaneCommand("m2", posixCommands);
    const args = buildTmuxSpawnSessionArgs("tfx-spawn-m2-lifecycle", command);
    assert.deepEqual(args.slice(0, 4), [
      "new-session",
      "-d",
      "-s",
      "tfx-spawn-m2-lifecycle",
    ]);
    assert.equal(args[4], command);
  });

  it("세션명 규약이 같아 kill 이 원격 호스트를 그대로 역추론한다", () => {
    const args = buildTmuxSpawnSessionArgs(
      "tfx-spawn-m2-lifecycle",
      buildTmuxRemoteLaneCommand("m2", posixCommands),
    );
    assert.equal(
      inferRemoteHostFromSessionName(args[3], ["m2", "ryzen"]),
      "m2",
    );
  });

  it("원격 명령이 비면 조립을 거부한다", () => {
    assert.throws(
      () => buildTmuxRemoteLaneCommand("m2", []),
      /requires remote/,
    );
  });
});

describe("killSpawnSession() readback 재시도", () => {
  it("첫 측정이 잔존이어도 재측정이 0이면 ok:true + retried", async () => {
    const slept = [];
    const counts = ["1\n", "0\n"];
    let probeIndex = 0;

    const result = await killSpawnSession("tfx-spawn-m2-lifecycle", {
      hostNames: ["m2"],
      killLocal: () => {},
      runRemote: (_host, command) => {
        if (!command.includes("pgrep")) return { ok: true, stdout: "" };
        return { ok: true, stdout: counts[Math.min(probeIndex++, 1)] };
      },
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.remote.ok, true);
    assert.equal(result.remote.retried, true);
    assert.equal(result.remote.firstRemaining, 1);
    assert.equal(result.remote.remaining, 0);
    assert.deepEqual(slept, [5000]);
    assert.equal(probeIndex, 2);
  });

  it("재측정도 잔존이면 ok:false로 남는다", async () => {
    const result = await killSpawnSession("tfx-spawn-m2-lifecycle", {
      hostNames: ["m2"],
      killLocal: () => {},
      runRemote: (_host, command) => ({
        ok: true,
        stdout: command.includes("pgrep") ? "2\n" : "",
      }),
      sleep: async () => {},
    });

    assert.equal(result.ok, false);
    assert.equal(result.remote.retried, true);
    assert.equal(result.remote.firstRemaining, 2);
    assert.equal(result.remote.remaining, 2);
  });

  it("첫 측정이 0이면 재측정하지 않는다", async () => {
    let probeCount = 0;
    let sleepCount = 0;

    const result = await killSpawnSession("tfx-spawn-m2-lifecycle", {
      hostNames: ["m2"],
      killLocal: () => {},
      runRemote: (_host, command) => {
        if (command.includes("pgrep")) probeCount += 1;
        return { ok: true, stdout: command.includes("pgrep") ? "0\n" : "" };
      },
      sleep: async () => {
        sleepCount += 1;
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.remote.retried, undefined);
    assert.equal(probeCount, 1);
    assert.equal(sleepCount, 0);
  });
});
