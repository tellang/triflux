import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import * as tfxLive from "../../bin/tfx-live.mjs";

const exec = promisify(execFile);

test("iTerm AppleScript literals preserve quotes and backslashes without injection", () => {
  assert.equal(
    tfxLive.appleScriptString('리뷰 "팀" \\ path'),
    '"리뷰 \\"팀\\" \\\\ path"',
  );
  for (const control of [
    "\n",
    "\r",
    "\t",
    "\0",
    "\u007f",
    "\u0085",
    "\u2028",
  ]) {
    assert.throws(
      () => tfxLive.appleScriptString(`team${control}close`),
      /control characters/,
    );
  }
});

test("iTerm integration is limited to local macOS sessions inside iTerm2", () => {
  for (const env of [
    { LC_TERMINAL: "iTerm2" },
    { TERM_PROGRAM: "iTerm.app" },
  ]) {
    assert.equal(tfxLive.shouldUseIterm(undefined, "darwin", env), true);
    assert.equal(tfxLive.shouldUseIterm("host", "darwin", env), false);
    assert.equal(tfxLive.shouldUseIterm(undefined, "linux", env), false);
    assert.equal(tfxLive.shouldUseIterm(undefined, "win32", env), false);
  }
  assert.equal(tfxLive.shouldUseIterm(undefined, "darwin", {}), false);
  assert.equal(
    tfxLive.shouldUseIterm(undefined, "darwin", {
      TERM_PROGRAM: "Apple_Terminal",
    }),
    false,
  );
});

test("iTerm project identity unites worktrees and resolves non-git cwd", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-iterm-project-"));
  try {
    const repo = path.join(dir, "project");
    const worktree = path.join(dir, "worktree");
    const plain = path.join(dir, "plain");
    await fs.mkdir(repo);
    await fs.mkdir(plain);
    await exec("git", ["init", repo]);
    await exec("git", [
      "-C",
      repo,
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "test",
    ]);
    await exec("git", [
      "-C",
      repo,
      "worktree",
      "add",
      "-b",
      "test-worktree",
      worktree,
    ]);
    const expected = {
      key: await fs.realpath(path.join(repo, ".git")),
      name: "project",
    };
    assert.deepEqual(await tfxLive.itermProject(repo), expected);
    assert.deepEqual(await tfxLive.itermProject(worktree), expected);
    const separateRepo = path.join(dir, "separate-project");
    const separateGit = path.join(dir, "metadata");
    await exec("git", [
      "init",
      "--separate-git-dir",
      separateGit,
      separateRepo,
    ]);
    assert.deepEqual(await tfxLive.itermProject(separateRepo), {
      key: await fs.realpath(separateGit),
      name: "separate-project",
    });
    const link = path.join(dir, "link");
    await fs.symlink(plain, link);
    assert.deepEqual(await tfxLive.itermProject(link), {
      key: await fs.realpath(plain),
      name: "plain",
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("iTerm opening script chooses project window and limits group splits", async () => {
  let script;
  const result = await tfxLive.openItermSession(
    "session-a",
    "discussion",
    { key: "/repo/.git", name: "repo" },
    {
      env: { ITERM_SESSION_ID: "w:leader-id" },
      execFile: async (command, args) => {
        if (command === "which") return { stdout: process.execPath };
        assert.equal(command, "/usr/bin/osascript");
        script = args[1];
        return { stdout: "pane-id\ntrue\n" };
      },
    },
  );
  assert.equal(result.sessionId, "pane-id");
  assert.equal(result.split, true);
  assert.match(
    script,
    /if candidateProject is "\/repo\/\.git" and projectWindow is missing value then set projectWindow to candidateWindow/,
  );
  assert.match(
    script,
    /if projectWindow is not missing value then\s+set targetWindow to projectWindow\s+else/,
  );
  assert.match(
    script,
    /if candidateProject is not "" and candidateProject is not missing value and candidateProject is not "\/repo\/\.git" then set leaderHasOtherProject to true/,
  );
  assert.match(
    script,
    /if leaderHasOtherProject then\s+set targetWindow to create window with default profile command/,
  );
  assert.match(
    script,
    /return \(id of newSession\)[\s\S]*?end if\s+set targetWindow to leaderWindow/,
  );
  assert.match(script, /if \(count of sessions of candidateTab\) < 4 then/);
  assert.match(script, /if candidateGroup is "discussion" then/);
  assert.match(
    script,
    /if rightCount is 0 then\s+set splitSession to leftSession\s+set splitDirection to "vertical"\s+set newColumn to "R"/,
  );
  assert.match(
    script,
    /else if rightCount < leftCount then\s+set splitSession to rightSession\s+set splitDirection to "horizontal"/,
  );
  assert.match(
    script,
    /if splitDirection is "vertical" then\s+tell splitSession .*split vertically[^\n]*\s+else\s+tell splitSession .*split horizontally/,
  );
  assert.match(script, /set variable named "user.tfx_column" to newColumn/);
  assert.match(
    script,
    /if unmarkedCount > 0 and leftCount \+ rightCount > 1 then\s+set leftCount to 0\s+set rightCount to 0/,
  );
  assert.doesNotMatch(script, /columns of|tfx_split_side/);
  assert.match(
    script,
    /end if\s+else\s+tell targetWindow .*create tab with default profile command/,
  );
  for (const key of ["project", "group", "session"])
    assert.match(script, new RegExp(`set variable named "user.tfx_${key}"`));
});

test("stop closes a recorded iTerm pane anywhere and searches by name only inside iTerm", async () => {
  for (const [id, ttys, env, closes, fallback] of [
    ["stale-id", [], {}, true, false],
    ["", [], { LC_TERMINAL: "iTerm2" }, true, true],
    ["", [], {}, false, false],
    ["", ["/dev/ttys004", "/dev/ttys007"], {}, true, false],
  ]) {
    const calls = [];
    await tfxLive.doStop(
      tfxLive.ADAPTERS.claude,
      { session: "session-a" },
      {
        platform: "darwin",
        env,
        runTmux: async (_remote, args) => {
          calls.push(args[0]);
          if (args[0] !== "list-clients") return { stdout: id };
          assert.deepEqual(args.slice(1, 3), ["-t", "session-a"]);
          return { stdout: ttys.map((tty) => `${tty}\n`).join("") };
        },
        closeItermSession: async (...args) => {
          assert.deepEqual(args, [id, "session-a", fallback, ttys]);
          calls.push("close");
        },
      },
    );
    // 죽인 세션의 클라이언트는 kill 뒤에 조회되지 않으므로 순서가 동작의 일부다.
    assert.deepEqual(calls, [
      "show-options",
      "list-clients",
      "kill-session",
      ...(closes ? ["close"] : []),
    ]);
  }
});

test("iTerm close script prefers stored ID then session variable and preserves ambiguous tabs", async () => {
  let script;
  await tfxLive.closeItermSession("stale-id", "session-a", true, [], {
    runTmux: async () => ({ stdout: "/dev/ttys003\n" }),
    execFile: async (command, args) => {
      assert.equal(command, "/usr/bin/osascript");
      script = args[1];
      return { stdout: "" };
    },
  });
  assert.match(script, /id of candidateSession is "stale-id"/);
  assert.match(script, /variable named "user.tfx_session"/);
  assert.match(script, /candidateName is "session-a"/);
  assert.ok(
    script.indexOf("set targetSession to idSession") <
      script.indexOf("set targetSession to fallbackSession"),
  );
  assert.match(script, /is at shell prompt/);
  assert.match(script, /attachedTtys contains/);
  assert.match(script, /set shellsOnly to false/);
  assert.match(script, /if shellsOnly then tell targetTab to close/);
});

test("peer shares one generated or explicit group across all participants", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tfx-iterm-peer-"));
  try {
    const groups = [];
    for (const group of [undefined, undefined, "chosen-group"]) {
      const starts = [];
      await tfxLive.peer(
        {
          "cli-a": "claude",
          "cli-b": "claude",
          "cli-c": "claude",
          group,
          rounds: "1",
        },
        {
          peerArtifactPaths: () => ({
            transcriptPath: path.join(dir, "transcript.json"),
            statusPath: path.join(dir, "status.json"),
          }),
          doStart: async (_adapter, opts) => starts.push(opts),
          doAsk: async () => ({
            transport: "tmux",
            done: true,
            response: "ok",
          }),
          stopAfterLifecycle: async () => {},
          printJson: () => {},
        },
      );
      assert.equal(starts.length, 3);
      assert.ok(starts[0].group);
      assert.ok(starts.every((opts) => opts.group === starts[0].group));
      if (group) assert.equal(starts[0].group, group);
      groups.push(starts[0].group);
    }
    assert.notEqual(groups[0], groups[1]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("project lookup reports git failures instead of splitting repository identity", async () => {
  for (const error of [
    Object.assign(new Error("git timed out"), { killed: true }),
    Object.assign(new Error("git inaccessible"), { code: "EACCES" }),
  ]) {
    await assert.rejects(
      tfxLive.itermProject(process.cwd(), {
        execFile: async () => {
          throw error;
        },
      }),
      (actual) => actual === error,
    );
  }
});

test("iTerm close skips the name search outside iTerm and keeps tabs with user panes", async () => {
  let script;
  await tfxLive.closeItermSession("stale-id", "session-a", false, [], {
    runTmux: async () => ({ stdout: "" }),
    execFile: async (_command, args) => {
      script = args[1];
      return { stdout: "" };
    },
  });
  assert.match(script, /if false and candidateName is "session-a"/);
  assert.match(
    script,
    /remainingName is missing value or remainingName is "" then set shellsOnly to false/,
  );
});

test("iTerm close also closes unmarked panes attached to the killed session", async () => {
  let script;
  await tfxLive.closeItermSession("", "session-a", false, ["/dev/ttys004"], {
    runTmux: async () => ({ stdout: "" }),
    execFile: async (_command, args) => {
      script = args[1];
      return { stdout: "" };
    },
  });
  assert.match(script, /set killedTtys to \{"\/dev\/ttys004"\}/);
  assert.doesNotMatch(script, /^\s*return$/m);
  // 순번 참조를 들고 있다 닫으면 옆 패인이 닫히므로 ID 로 다시 찾은 세션만 닫아야 한다.
  assert.match(script, /set end of killedIds to \(id of candidateSession\)/);
  assert.match(
    script,
    /if id of candidateSession is killedId then tell candidateSession to close/,
  );
});

test("peer side options carry the run group to lazily started sessions", () => {
  const base = tfxLive.peerSideBaseOpts(
    { group: "peer:a:b:c:1234", "transport-a": "tmux" },
    "a",
    tfxLive.ADAPTERS.claude,
    "peerA",
  );
  assert.equal(base.group, "peer:a:b:c:1234");
});
