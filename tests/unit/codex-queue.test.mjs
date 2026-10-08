import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  codexThreadIdByName,
  deleteCodexQueueItems,
  findCodexThreadByCwd,
  listCodexQueue,
  queueCodexMessage,
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
  const meta = (id, source = "cli") =>
    `${JSON.stringify({ type: "session_meta", payload: { id, cwd: home, timestamp: "2026-10-08T00:00:00Z", source } })}\n`;
  await fs.writeFile(path.join(day, `rollout-a-${THREAD}.jsonl`), meta(THREAD));
  assert.deepEqual(await findCodexThreadByCwd(home, { env }), {
    threadId: THREAD,
  });
  await fs.writeFile(
    path.join(day, "rollout-c-01a11894-ec17-7313-8bf2-d379b4fcff03.jsonl"),
    meta("01a11894-ec17-7313-8bf2-d379b4fcff03", "exec"),
  );
  assert.equal((await findCodexThreadByCwd(home, { env })).threadId, THREAD);
  const other = "01a11894-ec17-7313-8bf2-d379b4fcff02";
  await fs.writeFile(path.join(day, `rollout-b-${other}.jsonl`), meta(other));
  assert.equal(
    (await findCodexThreadByCwd(home, { env })).reason,
    "thread-ambiguous",
  );
});

// 받은 요청을 기록하고 메서드별 고정 응답을 돌려주는 가짜 app-server.
async function fakeAppServer(dir, responses) {
  const log = path.join(dir, "requests.jsonl");
  await fs.writeFile(
    path.join(dir, "codex"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const responses = ${JSON.stringify(responses)};
const counts = {};
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(log)}, line + "\\n");
  if (msg.id === undefined) return;
  const list = responses[msg.method] ?? [{}];
  const n = (counts[msg.method] = (counts[msg.method] ?? 0) + 1);
  process.stdout.write(JSON.stringify({ id: msg.id, ...list[Math.min(n, list.length) - 1] }) + "\\n");
});
`,
    { mode: 0o755 },
  );
  return {
    env: { HOME: dir, PATH: `${dir}${path.delimiter}${process.env.PATH}` },
    requests: async () =>
      (await fs.readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((msg) => msg.id !== undefined && msg.method !== "initialize"),
  };
}

test("queue 조회는 요청 표식을 뽑고 삭제는 이미 가져간 항목을 missing 으로 나눈다", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-app-server-"));
  try {
    const server = await fakeAppServer(dir, {
      initialize: [{ result: {} }],
      "thread/queue/list": [
        {
          result: {
            data: [
              {
                id: "q1",
                input: [{ type: "text", text: "[tfx-live req=r1] 일" }],
              },
            ],
            nextCursor: null,
          },
        },
      ],
      "thread/queue/delete": [
        { result: { deleted: true } },
        { result: { deleted: false } },
      ],
    });
    assert.deepEqual(await listCodexQueue(THREAD, { env: server.env }), [
      { id: "q1", requestId: "r1", text: "[tfx-live req=r1] 일" },
    ]);
    assert.deepEqual(
      await deleteCodexQueueItems(THREAD, ["q1", "q2"], { env: server.env }),
      { deleted: ["q1"], missing: ["q2"] },
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ask --cli codex 는 app-server queue add 로 보내고 보낸 세션 이름을 첫 줄에 붙인다", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-queue-cli-"));
  try {
    const server = await fakeAppServer(dir, {
      initialize: [{ result: {} }],
      "thread/queue/add": [{ result: { queuedSubmission: { id: "m1" } } }],
    });
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
          ...server.env,
          CODEX_HOME: path.join(dir, "codex-home"),
        },
      },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.transport, "queue");
    assert.equal(result.status, "queued");
    assert.equal(result.queuedMessageId, "m1");
    assert.equal(result.queueVia, "app-server");
    const [add] = await server.requests();
    assert.equal(add.method, "thread/queue/add");
    assert.equal(add.params.threadId, THREAD);
    assert.deepEqual(add.params.input, [
      {
        type: "text",
        text: `[from 10.8 리드] [tfx-live req=${result.requestId}]\n안녕`,
        text_elements: [],
      },
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("add 를 못 쓰면 codex queue 로 폴백하고, 쌓였을 수 있으면 재전송을 막는다", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-queue-add-"));
  try {
    const noAdd = await fakeAppServer(dir, {
      initialize: [{ result: {} }],
      "thread/queue/add": [
        { error: { code: -32601, message: "method not found" } },
      ],
    });
    const fail = (fields) => async () => {
      throw Object.assign(new Error("codex failed"), fields);
    };
    let argv;
    const queued = await queueCodexMessage({
      threadId: THREAD,
      message: "m",
      env: noAdd.env,
      execFn: async (_file, args) => {
        argv = args;
        return { stdout: "Queued message m3 for thread x.\n" };
      },
    });
    assert.equal(queued.queuedMessageId, "m3");
    assert.equal(queued.via, "codex-queue-argv");
    assert.deepEqual(argv, ["queue", `--thread=${THREAD}`, "--message=m"]);
    const fallback = (execFn) =>
      queueCodexMessage({
        threadId: THREAD,
        message: "m",
        env: noAdd.env,
        execFn,
      });
    assert.equal(
      (
        await fallback(
          fail({ code: 1, stdout: "Queued message m2 for thread x.\n" }),
        )
      ).queuedMessageId,
      "m2",
    );
    await assert.rejects(
      fallback(fail({ killed: true, stdout: "" })),
      (error) => error.maybeQueued === true,
    );
    await assert.rejects(
      fallback(fail({ code: 2, stdout: "" })),
      (error) => error.maybeQueued !== true,
    );
    // add 가 오류 응답 없이 끝나면 이미 쌓였을 수 있어 argv 로 다시 보내지 않는다.
    const odd = await fakeAppServer(dir, {
      initialize: [{ result: {} }],
      "thread/queue/add": [{}],
    });
    await assert.rejects(
      queueCodexMessage({
        threadId: THREAD,
        message: "m",
        env: odd.env,
        execFn: fail({ code: 2, stdout: "" }),
      }),
      (error) => error.maybeQueued === true,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
