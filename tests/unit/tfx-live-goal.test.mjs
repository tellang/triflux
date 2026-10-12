import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { codexGoal } from "../../bin/tfx-live.mjs";
import { readClaudeTranscript } from "../../hub/team/claude-transcript.mjs";

const exec = promisify(execFile);
const threadId = "11111111-1111-4111-8111-111111111111";

test("Claude uses the last goal_status through set, evaluation, completion and clear", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tfx-goal-"));
  const file = join(dir, "transcript.jsonl");
  const entry = (attachment) =>
    `${JSON.stringify({ type: "attachment", attachment: { type: "goal_status", condition: "goal", ...attachment }, timestamp: "2026-10-12T00:00:00.000Z" })}\n`;
  try {
    await writeFile(file, "");
    assert.equal((await readClaudeTranscript(file)).goal.state, "none");
    for (const [attachment, state] of [
      [{ met: false, sentinel: true }, "active"],
      [{ met: false, reason: "not yet" }, "active"],
      [{ met: true, reason: "verified", tokens: 123 }, "complete"],
      [{ met: true, sentinel: true }, "none"],
    ]) {
      await appendFile(file, entry(attachment));
      // 명령 기록과 일반 메시지가 마지막 판정을 덮어쓰면 안 된다.
      await appendFile(
        file,
        `${JSON.stringify({ type: "user", message: { content: "/goal old goal" } })}\n`,
      );
      const snapshot = await readClaudeTranscript(file);
      assert.equal(snapshot.goal.state, state);
      assert.equal(snapshot.goal.objective, state === "none" ? null : "goal");
      assert.equal(snapshot.goal.reason, attachment.reason);
      assert.equal(snapshot.goal.tokensUsed, attachment.tokens);
      assert.equal(snapshot.goal.judgedBy, "evaluator");
    }
    // 완료가 같은 판독 구간에 들어와도 새 set sentinel 확인 근거는 남는다.
    await appendFile(
      file,
      entry({ met: false, sentinel: true }) +
        entry({ met: true, reason: "done" }),
    );
    const snapshot = await readClaudeTranscript(file);
    assert.equal(snapshot.goal.state, "complete");
    assert.equal(snapshot.goalSentinel.met, false);
    assert.equal(snapshot.goalSentinel.count, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function daemon({ loaded = true, failSet = false } = {}) {
  const calls = [];
  let closed = false;
  const client = {
    async connect() {},
    notify() {},
    close() {
      closed = true;
    },
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/loaded/list")
        return { data: loaded ? [threadId] : [] };
      if (method === "thread/goal/clear") return { cleared: true };
      if (method === "thread/goal/set") {
        if (failSet) throw new Error("connection lost after write");
        return { goal: { ...params, tokensUsed: 0, updatedAt: 1791763200 } };
      }
      return {};
    },
  };
  return {
    calls,
    isClosed: () => closed,
    deps: { clientFactory: () => client, resolveSocket: () => "/fake.sock" },
  };
}

test("Codex replaces a goal with clear then active set, both authorized by user", async () => {
  const fake = daemon();
  const result = await codexGoal(
    "set",
    { threadId, objective: "new goal", tokenBudget: 500 },
    fake.deps,
  );
  assert.deepEqual(
    fake.calls.filter(({ method }) => method.startsWith("thread/goal/")),
    [
      { method: "thread/goal/clear", params: { threadId, origin: "user" } },
      {
        method: "thread/goal/set",
        params: {
          threadId,
          origin: "user",
          objective: "new goal",
          status: "active",
          tokenBudget: 500,
        },
      },
    ],
  );
  assert.equal(fake.calls[0].params.capabilities.experimentalApi, true);
  assert.equal(result.tokensUsed, 0);
  assert.equal(result.state, "active");
  assert.equal(result.judgedBy, "model");
  assert.equal(result.transport, "daemon");
  assert.equal(fake.isClosed(), true);
});

test("Unloaded Codex thread selects tmux for writes and sqlite for status, rejecting budget", async () => {
  for (const action of ["set", "clear", "status"]) {
    const fake = daemon({ loaded: false });
    const result = await codexGoal(
      action,
      { threadId, objective: "new" },
      {
        ...fake.deps,
        readGoal: async (id) => {
          assert.equal(id, threadId);
          return { state: "none", objective: null, judgedBy: "model" };
        },
      },
    );
    assert.equal(result.transport, action === "status" ? "sqlite" : "tmux");
    assert.equal(result.fallbackReason, "thread-not-loaded");
    assert.equal(
      fake.calls.some(({ method }) => method.startsWith("thread/goal/")),
      false,
    );
    assert.equal(fake.isClosed(), true);
  }
  const fake = daemon({ loaded: false });
  await assert.rejects(
    codexGoal(
      "set",
      { threadId, objective: "new", tokenBudget: 500 },
      fake.deps,
    ),
    /budget.*daemon/,
  );
  assert.equal(fake.isClosed(), true);
});

test("Codex write errors do not replay the goal through fallback", async () => {
  const fake = daemon({ failSet: true });
  await assert.rejects(
    codexGoal("set", { threadId, objective: "new" }, fake.deps),
    /connection lost.*clear was applied and there is currently no goal/,
  );
  assert.equal(fake.isClosed(), true);
});

test("goal CLI rejects Claude budget, agy and remote before contacting sessions", async () => {
  for (const [args, error] of [
    [
      ["set", "--cli", "claude", "--condition", "test", "--budget", "100"],
      /budget.*codex/,
    ],
    [["status", "--cli", "agy"], /agy has no native goal/],
    [["clear", "--remote", "host"], /does not support --remote/],
  ]) {
    await assert.rejects(
      exec(process.execPath, [
        resolve("bin/tfx-live.mjs"),
        "goal",
        ...args,
        "--session",
        "not-a-real-session",
      ]),
      (failure) => {
        assert.equal(failure.code, 1);
        assert.match(JSON.parse(failure.stdout).error, error);
        return true;
      },
    );
  }
});

test("goal set rejects reserved first words regardless of CLI and case", async () => {
  for (const cli of ["claude", "codex"]) {
    for (const condition of [
      "clear",
      "PAUSE later",
      "Resume\nwork",
      "eDiT goal",
    ]) {
      await assert.rejects(
        exec(process.execPath, [
          resolve("bin/tfx-live.mjs"),
          "goal",
          "set",
          "--cli",
          cli,
          "--session",
          "missing",
          "--condition",
          condition,
        ]),
        (failure) => {
          assert.match(JSON.parse(failure.stdout).error, /reserved command/);
          return true;
        },
      );
    }
  }
});

test("Codex tmux goals normalize whitespace and confirm fresh matching sqlite state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tfx-goal-tmux-"));
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(dir, "goals_1.sqlite"));
    db.exec(
      "CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, objective TEXT, status TEXT, token_budget INTEGER, tokens_used INTEGER, updated_at_ms INTEGER)",
    );
    db.close();
    await writeFile(
      join(dir, "tmux"),
      `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const root = process.env.CODEX_HOME;
const args = process.argv.slice(2);
appendFileSync(root + '/calls', JSON.stringify(args) + '\\n');
if (args[0] === 'capture-pane') console.log(existsSync(root + '/busy') ? 'esc to interrupt' : '›');
if (args[0] === 'set-buffer') writeFileSync(root + '/prompt', args.at(-1));
if (args[0] === 'send-keys' && args.at(-1) === 'Escape') {
  const { unlinkSync } = await import('node:fs');
  unlinkSync(root + '/busy');
}
if (args[0] === 'send-keys' && args.at(-1) === 'Enter' && process.env.GOAL_WRITE !== 'skip') {
  const db = new DatabaseSync(root + '/goals_1.sqlite');
  const prompt = readFileSync(root + '/prompt', 'utf8');
  if (prompt === '/goal clear') db.prepare('DELETE FROM thread_goals WHERE thread_id = ?').run('${threadId}');
  else db.prepare('INSERT OR REPLACE INTO thread_goals VALUES (?, ?, ?, NULL, 0, ?)').run('${threadId}', prompt.slice(6), 'active', Date.now());
  db.close();
}
`,
      { mode: 0o755 },
    );
    const run = async (action, args = [], write = "apply") => {
      const { stdout } = await exec(
        process.execPath,
        [
          resolve("bin/tfx-live.mjs"),
          "goal",
          action,
          "--cli",
          "codex",
          "--session",
          "fake",
          "--thread",
          threadId,
          "--codex-socket",
          join(dir, "missing.sock"),
          "--settle",
          "1",
          "--poll-interval",
          "10",
          "--timeout",
          "1",
          ...args,
        ],
        {
          env: {
            ...process.env,
            CODEX_HOME: dir,
            PATH: `${dir}${delimiter}${process.env.PATH}`,
            GOAL_WRITE: write,
          },
        },
      );
      return JSON.parse(stdout);
    };
    const condition = "  finish\r\n all\u2028 steps\u2029\t now  ";
    const set = await run("set", ["--condition", condition]);
    assert.equal(
      await readFile(join(dir, "prompt"), "utf8"),
      "/goal finish all steps now",
    );
    assert.equal(set.confirmed, true);
    assert.equal(set.state, "active");
    assert.equal(set.objective, "finish all steps now");
    assert.equal(set.transport, "tmux");

    await writeFile(join(dir, "busy"), "");
    await assert.rejects(run("clear", ["--if-busy", "fail"]), (error) => {
      assert.match(JSON.parse(error.stdout).error, /target busy/);
      return true;
    });
    const clear = await run("clear");
    assert.equal(clear.confirmed, true);
    assert.equal(clear.state, "none");
    const calls = (await readFile(join(dir, "calls"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.ok(calls.some((args) => args.at(-1) === "Escape"));

    for (const [objective, status, updatedAt] of [
      ["finish", "active", 0],
      ["other", "active", Date.now() + 60_000],
      ["finish", "paused", Date.now() + 60_000],
    ]) {
      const db = new DatabaseSync(join(dir, "goals_1.sqlite"));
      db.prepare(
        "INSERT OR REPLACE INTO thread_goals VALUES (?, ?, ?, NULL, 0, ?)",
      ).run(threadId, objective, status, updatedAt);
      db.close();
      await assert.rejects(
        run("set", ["--condition", "finish"], "skip"),
        (error) => {
          assert.match(
            JSON.parse(error.stdout).error,
            /No matching Codex goal/,
          );
          return true;
        },
      );
    }
    await assert.rejects(run("clear", [], "skip"), (error) => {
      assert.match(JSON.parse(error.stdout).error, /No matching Codex goal/);
      return true;
    });
    await rm(join(dir, "goals_1.sqlite"));
    const missing = await run("clear", [], "skip");
    assert.equal(missing.confirmed, false);
    assert.match(missing.warning, /Goal status unavailable/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude status does not mistake an undiscoverable transcript for no goal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tfx-goal-missing-"));
  try {
    await writeFile(
      join(dir, "tmux"),
      "#!/usr/bin/env node\nif (process.argv.includes('display-message')) console.log('%99');\n",
      { mode: 0o755 },
    );
    const { stdout } = await exec(
      process.execPath,
      [
        resolve("bin/tfx-live.mjs"),
        "goal",
        "status",
        "--cli",
        "claude",
        "--session",
        "missing",
        "--config-dir",
        dir,
      ],
      {
        env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` },
      },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.state, null);
    assert.match(result.warning, /transcript.*unavailable/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
