import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import childProcess from "../../hub/lib/spawn-trace.mjs";

const restorers = [];

function registerRestore(restore) {
  restorers.push(restore);
}

function mockExecFileSync(handler) {
  const tracker = mock.method(
    childProcess,
    "execFileSync",
    (file, args, opts) =>
      handler(file, Array.isArray(args) ? [...args] : [], opts),
  );
  registerRestore(() => tracker.mock.restore());
}

async function importFreshPsmux() {
  const stamp = `${Date.now()}-${Math.random()}`;
  return import(
    new URL(`../../hub/team/psmux.mjs?safe-api=${stamp}`, import.meta.url)
  );
}

afterEach(() => {
  while (restorers.length > 0) {
    restorers.pop()();
  }
});

describe("psmux safe wrapper API", () => {
  it("listSessions는 list-sessions -F 출력을 파싱한다", async () => {
    const nowMs = 1_710_007_200_000;
    const nowTracker = mock.method(Date, "now", () => nowMs);
    registerRestore(() => nowTracker.mock.restore());

    const calls = [];
    mockExecFileSync((_file, args) => {
      calls.push(args);
      switch (args[0]) {
        case "-V":
          return "psmux 3.3.1";
        case "list-sessions":
          assert.deepEqual(args.slice(0, 3), [
            "list-sessions",
            "-F",
            "#{session_name}\t#{session_created}\t#{session_activity}\t#{session_attached}",
          ]);
          return [
            "alpha-main\t1710000000\t1710003600\t1",
            "beta-worker\t1709996400\t1709998200\t0",
          ].join("\n");
        default:
          throw new Error(`unexpected command: ${args.join(" ")}`);
      }
    });

    const { listSessions } = await importFreshPsmux();
    const sessions = listSessions();

    assert.equal(sessions.length, 2);
    assert.deepEqual(
      sessions.map((session) => ({
        sessionName: session.sessionName,
        attachedCount: session.attachedCount,
        ageMs: session.ageMs,
        idleMs: session.idleMs,
      })),
      [
        {
          sessionName: "alpha-main",
          attachedCount: 1,
          ageMs: 7_200_000,
          idleMs: 3_600_000,
        },
        {
          sessionName: "beta-worker",
          attachedCount: 0,
          ageMs: 10_800_000,
          idleMs: 9_000_000,
        },
      ],
    );
    assert.ok(calls.some((args) => args[0] === "list-sessions"));
  });

  it("killSessionByTitle는 title 패턴으로 세션을 역조회해 종료한다", async () => {
    const calls = [];
    mockExecFileSync((_file, args) => {
      calls.push(args);
      switch (args[0]) {
        case "-V":
          return "psmux 3.3.1";
        case "list-sessions":
          return [
            "team-alpha\t1710000000\t1710000000\t0",
            "team-beta\t1710000000\t1710000000\t0",
            "misc\t1710000000\t1710000000\t0",
          ].join("\n");
        case "kill-session":
          return "";
        default:
          throw new Error(`unexpected command: ${args.join(" ")}`);
      }
    });

    const { killSessionByTitle } = await importFreshPsmux();
    const result = killSessionByTitle(/^team-(alpha|beta)$/);

    assert.deepEqual(result, {
      matchedCount: 2,
      killedCount: 2,
      sessions: ["team-alpha", "team-beta"],
    });
    assert.deepEqual(
      calls.filter((args) => args[0] === "kill-session"),
      [
        ["kill-session", "-t", "team-alpha"],
        ["kill-session", "-t", "team-beta"],
      ],
    );
  });

  it("pruneStale는 detached + idle 세션만 필터링한다", async () => {
    const nowMs = 1_710_007_200_000;
    const nowTracker = mock.method(Date, "now", () => nowMs);
    registerRestore(() => nowTracker.mock.restore());

    const calls = [];
    mockExecFileSync((_file, args) => {
      calls.push(args);
      switch (args[0]) {
        case "-V":
          return "psmux 3.3.1";
        case "list-sessions":
          return [
            "stale-detached\t1710000000\t1710000000\t0",
            "stale-attached\t1710000000\t1710000000\t1",
            "fresh-detached\t1710000000\t1710006600\t0",
          ].join("\n");
        default:
          throw new Error(`unexpected command: ${args.join(" ")}`);
      }
    });

    const { pruneStale } = await importFreshPsmux();
    const result = pruneStale({ olderThanMs: 3_600_000, dryRun: true });

    assert.deepEqual(result, {
      dryRun: true,
      matchedCount: 1,
      killedCount: 0,
      sessions: ["stale-detached"],
    });
    assert.equal(
      calls.some((args) => args[0] === "kill-session"),
      false,
      "dryRun에서는 kill-session을 호출하면 안 된다",
    );
  });
});
