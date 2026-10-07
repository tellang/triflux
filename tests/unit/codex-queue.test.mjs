import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  codexThreadIdByName,
  findCodexThreadByCwd,
  waitCodexRequest,
} from "../../hub/team/codex-queue.mjs";

const execFileAsync = promisify(execFile);
const CLI = path.resolve("bin/tfx-live.mjs");
const THREAD = "01a11894-ec17-7313-8bf2-d379b4fcff01";

const line = (type, payload) =>
  JSON.stringify({ timestamp: "2026-10-08T00:00:00Z", type, payload });

test("waitCodexRequest는 표식이 든 턴의 완료 응답만 돌려준다", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-queue-"));
  const rollout = path.join(dir, "rollout.jsonl");
  const findRollout = async () => rollout;
  await fs.writeFile(
    rollout,
    `${[
      line("event_msg", { type: "task_started", turn_id: "t1" }),
      line("event_msg", {
        type: "task_complete",
        turn_id: "t1",
        last_agent_message: "남의 답",
      }),
      line("event_msg", { type: "task_started", turn_id: "t2" }),
      line("event_msg", {
        type: "item_completed",
        turn_id: "t2",
        item: {
          type: "UserMessage",
          content: [{ text: "[from 리드] [tfx-live req=abc]\n일" }],
        },
      }),
    ].join("\n")}\n`,
  );
  const working = await waitCodexRequest({
    threadId: THREAD,
    requestId: "abc",
    findRollout,
  });
  assert.equal(working.status, "working");
  assert.equal(working.timedOut, true);

  await fs.appendFile(
    rollout,
    `${line("event_msg", { type: "task_complete", turn_id: "t2", last_agent_message: "끝" })}\n`,
  );
  const done = await waitCodexRequest({
    threadId: THREAD,
    requestId: "abc",
    findRollout,
  });
  assert.equal(done.status, "completed");
  assert.equal(done.response, "끝");

  const queued = await waitCodexRequest({
    threadId: THREAD,
    requestId: "zzz",
    findRollout,
  });
  assert.equal(queued.status, "queued");
  assert.equal(queued.delivered, false);
});

test("thread 찾기는 이름의 등록 시각과 cwd 유일성을 지킨다", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-home-"));
  const env = { CODEX_HOME: home };
  await fs.writeFile(
    path.join(home, "session_index.jsonl"),
    `${JSON.stringify({ id: THREAD, thread_name: "10.8 a", updated_at: "2026-10-08T00:00:00Z" })}\n`,
  );
  assert.equal(await codexThreadIdByName("10.8 a", { env }), THREAD);
  assert.equal(
    await codexThreadIdByName("10.8 a", {
      env,
      sinceMs: Date.parse("2026-10-09"),
    }),
    null,
  );

  const day = path.join(home, "sessions", "2026", "10", "08");
  await fs.mkdir(day, { recursive: true });
  const meta = (id) =>
    `${JSON.stringify({ type: "session_meta", payload: { id, cwd: home, timestamp: "2026-10-08T00:00:00Z" } })}\n`;
  await fs.writeFile(path.join(day, `rollout-a-${THREAD}.jsonl`), meta(THREAD));
  assert.deepEqual(await findCodexThreadByCwd(home, { env }), {
    threadId: THREAD,
  });
  const other = "01a11894-ec17-7313-8bf2-d379b4fcff02";
  await fs.writeFile(path.join(day, `rollout-b-${other}.jsonl`), meta(other));
  assert.equal(
    (await findCodexThreadByCwd(home, { env })).reason,
    "thread-ambiguous",
  );
});

test("ask --cli codex 는 queue 로 보내고 보낸 세션 이름을 첫 줄에 붙인다", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-queue-cli-"));
  const log = path.join(dir, "codex.json");
  await fs.writeFile(
    path.join(dir, "codex"),
    [
      "#!/usr/bin/env node",
      "require('node:fs').writeFileSync(process.env.CODEX_LOG, JSON.stringify(process.argv.slice(2)));",
      "console.log(`Queued message m1 for thread ${process.argv[4]}.`);",
    ].join("\n"),
    { mode: 0o755 },
  );
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      CLI,
      "ask",
      "--cli",
      "codex",
      "--thread",
      THREAD,
      "--prompt",
      "안녕",
      "--from",
      "10.8 리드",
      "--no-wait",
    ],
    {
      env: {
        ...process.env,
        PATH: `${dir}${path.delimiter}${process.env.PATH}`,
        HOME: dir,
        CODEX_HOME: path.join(dir, "codex-home"),
        CODEX_LOG: log,
      },
    },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.transport, "queue");
  assert.equal(result.status, "queued");
  assert.equal(result.queuedMessageId, "m1");
  const argv = JSON.parse(await fs.readFile(log, "utf8"));
  assert.deepEqual(argv.slice(0, 3), ["queue", "--thread", THREAD]);
  assert.equal(
    argv[4],
    `[from 10.8 리드] [tfx-live req=${result.requestId}]\n안녕`,
  );
});
