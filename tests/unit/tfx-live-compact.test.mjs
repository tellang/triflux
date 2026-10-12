/** biome-ignore-all lint/suspicious/noThenProperty: CLI 계약의 then은 함수가 아닌 지시 문자열이다. */
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { doCompact } from "../../bin/tfx-live.mjs";

const threadId = "11111111-1111-4111-8111-111111111111";

async function fixture(cli, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "tfx-compact-"));
  const file = join(dir, "transcript.jsonl");
  const tokenCount = (tokens) => ({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { last_token_usage: { total_tokens: tokens } },
    },
  });
  await writeFile(
    file,
    cli === "codex"
      ? `${JSON.stringify({ type: "compacted", payload: {} })}\n${JSON.stringify(tokenCount(1000))}\n`
      : `${JSON.stringify({ type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 2000, postTokens: 1000 } })}\n`,
  );

  const calls = [];
  let prompt = "";
  let enters = 0;
  let started = false;
  let nextSent = false;
  const finish = async () => {
    await appendFile(
      file,
      `${JSON.stringify(
        cli === "claude"
          ? {
              type: "system",
              subtype: "compact_boundary",
              compactMetadata: { preTokens: 1000, postTokens: 100 },
            }
          : { type: "compacted", payload: {} },
      )}\n`,
    );
    if (cli === "codex")
      await appendFile(file, `${JSON.stringify(tokenCount(100))}\n`);
  };
  const deps = {
    claudeTmuxTranscript: async () => file,
    resolveCodexTmuxThread: async () => ({ threadId }),
    findCodexRollout: async () => file,
    sleep: async () => {},
    capturePane: async () => "",
    captureVisible: async () => {
      if (nextSent) return "Press up to edit queued messages";
      if (started) {
        calls.push("submission-confirmed");
        return cli === "claude"
          ? "Compacting conversation…"
          : "Compacting context";
      }
      return "›";
    },
    runTmux: async (_remote, args) => {
      if (args[0] === "set-buffer") {
        prompt = args.at(-1);
        calls.push(prompt);
      }
      if (args[0] === "show-buffer") return { stdout: prompt };
      if (args[0] === "send-keys" && args.at(-1) === "Enter") {
        if (prompt.startsWith("/compact")) {
          enters += 1;
          calls.push(`compact-enter-${enters}`);
          if (enters >= (options.startAfter ?? 1)) {
            started = true;
            if (options.finishOnSubmit) await finish();
          }
        } else {
          assert.equal(started, true);
          assert.match(prompt, /\[tfx-live req=[a-f0-9]+\]/);
          calls.push("then-tmux");
          nextSent = true;
          await appendFile(
            file,
            `${JSON.stringify(options.finishOnSubmit ? { type: "user", message: { content: prompt } } : { type: "queue-operation", operation: "enqueue", content: prompt })}\n`,
          );
          if (options.finishAfterThen) await finish();
        }
      }
      return { stdout: "" };
    },
    queueCodexMessage: async ({ message }) => {
      assert.equal(started, true);
      assert.ok(calls.includes("submission-confirmed"));
      assert.match(message, /\[tfx-live req=[a-f0-9]+\]/);
      calls.push("then-queue");
      if (options.queueError) throw options.queueError;
      if (options.finishAfterThen) await finish();
      return { queuedMessageId: "q1", via: "app-server" };
    },
  };
  return {
    calls,
    deps,
    flags: {
      cli,
      session: "fake",
      timeout: "0.02",
      settle: "1",
      "poll-interval": "1",
      "no-wait": "1",
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("Codex 제출을 확인하지 못하면 Enter를 다시 보내고 확인 뒤에만 then을 큐에 넣는다", async () => {
  const fake = await fixture("codex", { startAfter: 2 });
  try {
    const result = await doCompact(
      { ...fake.flags, then: "다음 작업" },
      fake.deps,
    );
    assert.equal(result.compact.submitted, true);
    assert.equal(result.compact.done, false);
    assert.equal(result.then.queued, true);
    assert.equal(result.then.transport, "queue");
    assert.match(result.then.requestId, /^[a-f0-9]+$/);
    assert.ok(
      fake.calls.indexOf("compact-enter-2") < fake.calls.indexOf("then-queue"),
    );
    assert.equal(fake.calls.includes("then-tmux"), false);
  } finally {
    await fake.cleanup();
  }
});

test("Codex 제출을 두 번 확인하지 못하면 then을 보내지 않고 오류로 끝낸다", async () => {
  const fake = await fixture("codex", { startAfter: Infinity });
  try {
    await assert.rejects(
      doCompact({ ...fake.flags, then: "다음 작업" }, fake.deps),
      /compact.*submission/i,
    );
    assert.equal(
      fake.calls.filter((call) => call.startsWith("compact-enter-")).length,
      2,
    );
    assert.equal(fake.calls.includes("then-queue"), false);
  } finally {
    await fake.cleanup();
  }
});

test("슬래시 then은 어느 CLI에서도 compact 전송 전에 거부한다", async () => {
  for (const cli of ["claude", "codex"]) {
    const fake = await fixture(cli);
    try {
      await assert.rejects(
        doCompact({ ...fake.flags, then: "  /clear" }, fake.deps),
        /--then.*slash/i,
      );
      assert.deepEqual(fake.calls, []);
    } finally {
      await fake.cleanup();
    }
  }
});

test("no-wait는 완료 기록 없이 제출 확인 뒤 반환한다", async () => {
  for (const cli of ["claude", "codex"]) {
    const fake = await fixture(cli);
    try {
      const result = await doCompact(fake.flags, fake.deps);
      assert.equal(result.compact.submitted, true);
      assert.equal(result.compact.done, false);
      assert.equal(result.compacted, false);
      assert.equal(result.timedOut, undefined);
    } finally {
      await fake.cleanup();
    }
  }
});

test("Claude는 제출 확인 뒤 바쁜 TUI에 then을 넣고 enqueue를 보고한다", async () => {
  const fake = await fixture("claude", { finishAfterThen: true });
  try {
    delete fake.flags["no-wait"];
    const result = await doCompact(
      { ...fake.flags, then: "변경 파일과 검증 명령" },
      fake.deps,
    );
    assert.equal(result.then.queued, true);
    assert.equal(result.then.transport, "tmux");
    assert.equal(result.then.confirmedBy, "enqueue");
    assert.ok(
      fake.calls.indexOf("submission-confirmed") <
        fake.calls.indexOf("then-tmux"),
    );
    assert.equal(result.compacted, true);
    assert.equal(result.preTokens, 1000);
    assert.equal(result.postTokens, 100);
    assert.equal(result.compact.done, true);
  } finally {
    await fake.cleanup();
  }
});

test("Codex 큐 오류는 바쁜 tmux로 then을 재전송하지 않는다", async () => {
  const fake = await fixture("codex", {
    queueError: new Error("queue unavailable"),
  });
  try {
    await assert.rejects(
      doCompact({ ...fake.flags, then: "다음 작업" }, fake.deps),
      /queue unavailable/,
    );
    assert.equal(fake.calls.includes("then-tmux"), false);
  } finally {
    await fake.cleanup();
  }
});

test("Codex의 새 compacted 기록도 제출과 완료를 확인한다", async () => {
  const fake = await fixture("codex", { finishOnSubmit: true });
  try {
    fake.deps.captureVisible = async () => "›";
    delete fake.flags["no-wait"];
    const result = await doCompact(fake.flags, fake.deps);
    assert.equal(result.compact.submitted, true);
    assert.equal(result.compact.done, true);
    assert.equal(result.compacted, true);
    assert.equal(result.preTokens, 1000);
    assert.equal(result.postTokens, 100);
  } finally {
    await fake.cleanup();
  }
});

test("Codex 보존 지침 인자는 모델 입력이 되기 전에 거부한다", async () => {
  const fake = await fixture("codex");
  try {
    await assert.rejects(
      doCompact({ ...fake.flags, instructions: "상태를 보존하라" }, fake.deps),
      /does not accept --instructions/,
    );
    assert.deepEqual(fake.calls, []);
  } finally {
    await fake.cleanup();
  }
});

test("Claude 압축이 빨리 끝나 then이 이미 소비됐으면 큐 실패로 보고하지 않는다", async () => {
  const fake = await fixture("claude", { finishOnSubmit: true });
  try {
    const result = await doCompact(
      { ...fake.flags, then: "다음 작업" },
      fake.deps,
    );
    assert.equal(result.compact.done, true);
    assert.equal(result.then.queued, false);
    assert.equal(result.then.delivered, true);
    assert.equal(result.then.confirmedBy, "user");
    assert.equal(result.ok, undefined);
  } finally {
    await fake.cleanup();
  }
});
