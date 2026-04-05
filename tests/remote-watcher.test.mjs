import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createRemoteWatcher,
  listSpawnSessions,
} from "../hub/team/remote-watcher.mjs";

function createExecStub(resolver) {
  const calls = [];
  const execFileSync = (command, args, options) => {
    calls.push({ args: [...args], command, options });
    return resolver({ args, command, options });
  };
  return { calls, execFileSync };
}

describe("remote-watcher: listSpawnSessions", () => {
  it("로컬 psmux list-sessions 결과에서 tfx-spawn-* 세션만 반환해야 한다", () => {
    const stub = createExecStub(({ command, args }) => {
      assert.equal(command, "psmux");
      assert.deepEqual(args, ["list-sessions"]);
      return [
        "tfx-spawn-alpha: 1 windows (created Sat Apr 04 22:00:00 2026)",
        "tfx-multi-ignore: 1 windows (created Sat Apr 04 22:00:01 2026)",
        "tfx-spawn-beta: 1 windows (created Sat Apr 04 22:00:02 2026)",
        "",
      ].join("\n");
    });

    const sessions = listSpawnSessions({ deps: { execFileSync: stub.execFileSync } });

    assert.deepEqual(sessions, ["tfx-spawn-alpha", "tfx-spawn-beta"]);
    assert.equal(stub.calls.length, 1);
  });

  it("host 옵션이 있으면 ssh를 통해 원격 세션을 조회해야 한다", () => {
    const stub = createExecStub(({ command, args }) => {
      assert.equal(command, "ssh");
      assert.equal(args[4], "remote-box");
      assert.match(args[5], /^psmux 'list-sessions'$/u);
      return "tfx-spawn-remote: 1 windows (created Sat Apr 04 22:00:03 2026)\n";
    });

    const sessions = listSpawnSessions({
      host: "remote-box",
      deps: { execFileSync: stub.execFileSync },
    });

    assert.deepEqual(sessions, ["tfx-spawn-remote"]);
  });
});

describe("remote-watcher: createRemoteWatcher", () => {
  it("completion token(exit=0)을 감지하면 sessionCompleted를 emit해야 한다", () => {
    let nowMs = 1_000;
    let intervalCallback = null;
    const stub = createExecStub(({ command, args }) => {
      assert.equal(command, "psmux");
      if (args[0] === "list-sessions") {
        return "tfx-spawn-alpha: 1 windows (created Sat Apr 04 22:10:00 2026)\n";
      }
      if (args[0] === "capture-pane") {
        return "running\n__TRIFLUX_DONE__:token-1:0\n";
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });

    const events = [];
    const watcher = createRemoteWatcher({
      deps: {
        clearInterval: () => {},
        execFileSync: stub.execFileSync,
        now: () => nowMs,
        setInterval: (callback) => {
          intervalCallback = callback;
          return { unref() {} };
        },
      },
    });

    watcher.on("sessionCompleted", (payload) => events.push(payload));
    watcher.start();

    const status = watcher.getStatus();
    assert.equal(typeof intervalCallback, "function");
    assert.equal(events.length, 1);
    assert.equal(events[0].sessionName, "tfx-spawn-alpha");
    assert.equal(events[0].reason, "completion_token");
    assert.equal(status.sessions["tfx-spawn-alpha"].state, "completed");
    assert.equal(status.sessions["tfx-spawn-alpha"].exitCode, 0);
    assert.equal(status.sessions["tfx-spawn-alpha"].lastProbeLevel, "prompt_ack");
  });

  it("completion token(exit!=0)을 감지하면 sessionFailed를 emit해야 한다", () => {
    const stub = createExecStub(({ args }) => {
      if (args[0] === "list-sessions") {
        return "tfx-spawn-failed: 1 windows (created Sat Apr 04 22:20:00 2026)\n";
      }
      if (args[0] === "capture-pane") {
        return "error\n__TRIFLUX_DONE__:token-2:7\n";
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });

    const events = [];
    const watcher = createRemoteWatcher({
      deps: {
        clearInterval: () => {},
        execFileSync: stub.execFileSync,
        now: () => 2_000,
        setInterval: () => ({ unref() {} }),
      },
    });

    watcher.on("sessionFailed", (payload) => events.push(payload));
    watcher.start();

    assert.equal(events.length, 1);
    assert.equal(events[0].sessionName, "tfx-spawn-failed");
    assert.equal(events[0].reason, "completion_token_nonzero");
    assert.equal(events[0].exitCode, 7);
    assert.equal(watcher.getStatus().sessions["tfx-spawn-failed"].state, "failed");
  });

  it("detectInputWait 패턴을 감지하면 sessionInputWait를 emit해야 한다", () => {
    const stub = createExecStub(({ args }) => {
      if (args[0] === "list-sessions") {
        return "tfx-spawn-wait: 1 windows (created Sat Apr 04 22:30:00 2026)\n";
      }
      if (args[0] === "capture-pane") {
        return "Apply changes? (y/n)\n";
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });

    const events = [];
    const watcher = createRemoteWatcher({
      deps: {
        clearInterval: () => {},
        execFileSync: stub.execFileSync,
        now: () => 3_000,
        setInterval: () => ({ unref() {} }),
      },
    });

    watcher.on("sessionInputWait", (payload) => events.push(payload));
    watcher.start();

    assert.equal(events.length, 1);
    assert.equal(events[0].sessionName, "tfx-spawn-wait");
    assert.equal(events[0].reason, "input_wait");
    assert.equal(events[0].inputWaitPattern.includes("y\\/n"), true);
    assert.equal(watcher.getStatus().sessions["tfx-spawn-wait"].state, "input_wait");
  });

  it("status snapshot은 immutable이어야 한다", () => {
    const stub = createExecStub(({ args }) => {
      if (args[0] === "list-sessions") {
        return "tfx-spawn-immut: 1 windows (created Sat Apr 04 22:40:00 2026)\n";
      }
      if (args[0] === "capture-pane") {
        return "build finished\nPS C:\\Users\\runner>\n";
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });

    const watcher = createRemoteWatcher({
      deps: {
        clearInterval: () => {},
        execFileSync: stub.execFileSync,
        now: () => 4_000,
        setInterval: () => ({ unref() {} }),
      },
    });

    watcher.start();

    const status = watcher.getStatus();
    assert.equal(Object.isFrozen(status), true);
    assert.equal(Object.isFrozen(status.sessions), true);
    assert.equal(Object.isFrozen(status.sessions["tfx-spawn-immut"]), true);
    assert.throws(() => {
      status.running = false;
    }, TypeError);
    assert.equal(status.sessions["tfx-spawn-immut"].state, "completed");
    assert.equal(status.sessions["tfx-spawn-immut"].reason, "prompt_idle");
  });

  it("원격 watcher는 ssh + capture-pane 조합으로 폴링해야 한다", () => {
    const stub = createExecStub(({ command, args }) => {
      assert.equal(command, "ssh");
      if (args[5].startsWith("psmux 'list-sessions'")) {
        return "tfx-spawn-ssh: 1 windows (created Sat Apr 04 22:50:00 2026)\n";
      }
      if (args[5].startsWith("psmux 'capture-pane'")) {
        return "done\n__TRIFLUX_DONE__:token-3:0\n";
      }
      throw new Error(`unexpected ssh command: ${args[5]}`);
    });

    const events = [];
    const watcher = createRemoteWatcher({
      host: "ssh-box",
      deps: {
        clearInterval: () => {},
        execFileSync: stub.execFileSync,
        now: () => 5_000,
        setInterval: () => ({ unref() {} }),
      },
    });

    watcher.on("sessionCompleted", (payload) => events.push(payload));
    watcher.start();

    assert.equal(events.length, 1);
    assert.equal(events[0].host, "ssh-box");
    assert.equal(events[0].sessionName, "tfx-spawn-ssh");
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[0].command, "ssh");
    assert.equal(stub.calls[1].command, "ssh");
  });
});
