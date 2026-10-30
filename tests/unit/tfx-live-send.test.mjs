import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ADAPTERS,
  doSend,
  formatPeerReply,
  formatPeerSendMessage,
  parsePeerToSpec,
  resolvePeerSender,
} from "../../bin/tfx-live.mjs";

function makeFakeDeps({
  claudeSessions = [],
  codexSessions = [],
  agySessions = [],
  doAskImpl = null,
  isLocalClaude = false,
  senderName = null,
} = {}) {
  const askCalls = [];
  return {
    askCalls,
    deps: {
      discoverClaudeTmuxSessions: async () => ({
        ok: true,
        cli: "claude",
        sessions: claudeSessions,
      }),
      discoverCodexTmuxSessions: async () => ({
        ok: true,
        cli: "codex",
        sessions: codexSessions,
      }),
      discoverAgyTmuxSessions: async () => ({
        ok: true,
        cli: "agy",
        sessions: agySessions,
      }),
      isLocalClaudeCaller: () => isLocalClaude,
      resolveSenderName: async () => senderName,
      doAsk:
        doAskImpl ||
        (async (adapter, opts) => {
          askCalls.push({ adapter, opts });
          return {
            ok: true,
            cli: adapter.cli,
            transport:
              adapter.cli === "codex"
                ? "codex-queue"
                : adapter.cli === "agy"
                  ? "agy-tmux"
                  : "claude-tmux",
            status: opts.noWait ? "sent" : "completed",
            response: opts.noWait ? "" : `ack from ${adapter.cli}`,
          };
        }),
    },
  };
}

describe("tfx-live send", () => {
  it("Jev가 활성화되어도 다중 후보를 전송하지 않고 유일한 이름/ID 전송을 보존한다", async (t) => {
    let jevCalls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      jevCalls += 1;
      return {
        ok: true,
        json: async () => ({ choice: "candidate_0", confidence: 1 }),
      };
    });
    const { askCalls, deps } = makeFakeDeps({
      agySessions: [
        { name: "shared", target: "mock:0.1", conversationId: "unique-one" },
        { name: "shared", target: "mock:0.2", conversationId: "unique-two" },
        {
          name: "unique-name",
          target: "mock:0.3",
          conversationId: "unique-three",
        },
      ],
    });
    const opts = {
      to: "agy:shared",
      message: "전달",
      from: "codex:sender",
      env: { JEV_API_KEY: "mock-key", TFX_JEV_STATS: "0" },
    };
    const ambiguous = await doSend(opts, deps);
    assert.equal(ambiguous.reason, "ambiguous-target");
    assert.equal(askCalls.length, 0);
    assert.equal(jevCalls, 0);
    for (const to of ["agy:unique-name", "agy:unique-one"]) {
      assert.equal((await doSend({ ...opts, to }, deps)).ok, true);
    }
    assert.equal(askCalls.length, 2);
  });

  it("parsePeerToSpec separates optional cli prefix and query", () => {
    assert.deepEqual(parsePeerToSpec("codex:10.14 리뷰"), {
      cli: "codex",
      query: "10.14 리뷰",
    });
    assert.deepEqual(parsePeerToSpec("claude:triflux-d9"), {
      cli: "claude",
      query: "triflux-d9",
    });
    assert.deepEqual(parsePeerToSpec("agy:847c0490"), {
      cli: "agy",
      query: "847c0490",
    });
    assert.deepEqual(parsePeerToSpec("10.14 리뷰"), {
      cli: null,
      query: "10.14 리뷰",
    });
  });

  it("formatPeerSendMessage wraps message with header and reply footer", () => {
    const formatted = formatPeerSendMessage({
      senderCli: "agy",
      senderName: "peer-worker",
      targetCli: "codex",
      msgId: "msg123456789",
      requestId: "req987654321",
      message: "점검 완료했다.",
    });
    const lines = formatted.split("\n");
    assert.equal(
      lines[0],
      "[tfx-peer from=agy:peer-worker msg=msg123456789] [tfx-live req=req987654321]",
    );
    assert.equal(lines[1], "점검 완료했다.");
    assert.equal(
      lines[2],
      "회신: tfx-live send --to 'agy:peer-worker' --message '...'",
    );
  });

  it("uses the approved wrapper, native Claude reply, and an unknown route notice", () => {
    const wrapper = path.join(os.homedir(), ".claude", "scripts", "tfx-peer");
    assert.equal(
      formatPeerReply({ cli: "codex", name: "10.16 구현" }, "claude"),
      `회신: ${wrapper} send --to 'codex:10.16 구현' --message '...'`,
    );
    assert.equal(
      formatPeerReply({ cli: "claude", name: "10.16 구현" }, "claude"),
      '회신: SendMessage(to: "10.16 구현")',
    );
    assert.equal(
      formatPeerReply({ cli: "unknown", name: "?" }, "codex"),
      "회신: 경로 불명(보낸 세션을 판별하지 못함)",
    );
    assert.equal(
      formatPeerReply(
        { cli: "claude", name: "tmux", sessionId: "exact" },
        "codex",
      ),
      `회신: ${wrapper} send --to 'claude:exact' --message '...'`,
    );
    const formatted = formatPeerSendMessage({
      senderCli: "codex",
      senderName: "이름\n새 줄",
      targetCli: "claude",
      msgId: "m",
      requestId: "r",
      message: "본문",
    });
    assert.equal(formatted.split("\n").length, 3);
    assert.match(formatted, /from=codex:이름 새 줄/);
  });

  for (const senderCli of ["codex", "agy"]) {
    it(`shell-quotes apostrophes and spaces in ${senderCli} reply targets`, () => {
      const senderName = "10.16 O'Reilly $(printf wrong)";
      const formatted = formatPeerSendMessage({
        senderCli,
        senderName,
        targetCli: "claude",
        msgId: "m",
        requestId: "r",
        message: "본문",
      });
      const target = formatted.split(" --to ")[1].split(" --message ")[0];
      assert.equal(
        execFileSync("/bin/sh", ["-c", `printf '%s' ${target}`], {
          encoding: "utf8",
        }),
        `${senderCli}:${senderName}`,
      );
    });
  }

  it("searches across claude, codex, and agy when cli prefix is omitted", async () => {
    const { askCalls, deps } = makeFakeDeps({
      claudeSessions: [
        { name: "triflux-d9", session: "triflux", target: "triflux:0.1" },
      ],
      codexSessions: [
        {
          name: "10.14 리뷰",
          session: "codex-rev",
          target: "codex-rev:0.0",
          threadId: "th-1014",
        },
      ],
      agySessions: [
        {
          name: "agy-audit",
          session: "agy-audit",
          target: "agy-audit:0.0",
          conversationId: "conv-999",
        },
      ],
    });

    const res = await doSend(
      {
        to: "10.14 리뷰",
        message: "리뷰 부탁한다",
        from: "agy:peer-worker",
        msgId: "m1",
        requestId: "r1",
      },
      deps,
    );

    assert.equal(res.ok, false);
    assert.equal(res.to.cli, "codex");
    assert.equal(res.reason, "use-tfx-peer");
    assert.equal(res.inputSent, false);
    assert.match(res.error, /tfx-peer.*send/);
    assert.equal(askCalls.length, 0);
  });

  it("restricts search to the specified cli when cli:name is used", async () => {
    const { askCalls, deps } = makeFakeDeps({
      claudeSessions: [
        { name: "shared-name", session: "claude-s", target: "claude-s:0.0" },
      ],
      codexSessions: [
        {
          name: "shared-name",
          session: "codex-s",
          target: "codex-s:0.0",
          threadId: "th-shared",
        },
      ],
    });

    const res = await doSend(
      {
        to: "codex:shared-name",
        message: "코드 확인",
        from: "agy:sender",
        noWait: true,
      },
      deps,
    );

    assert.equal(res.ok, false);
    assert.equal(res.to.cli, "codex");
    assert.equal(res.reason, "use-tfx-peer");
    assert.equal(askCalls.length, 0);
  });

  it("fails with target-not-found and candidate list when 0 sessions match", async () => {
    const { askCalls, deps } = makeFakeDeps({
      claudeSessions: [
        { name: "triflux-d9", session: "triflux", target: "triflux:0.1" },
      ],
      agySessions: [
        {
          name: "agy-worker",
          session: "agy-worker",
          target: "agy-worker:0.0",
          conversationId: "conv-123",
        },
      ],
    });

    const res = await doSend(
      {
        to: "nonexistent",
        message: "ping",
        from: "codex:caller",
      },
      deps,
    );

    assert.equal(res.ok, false);
    assert.equal(res.status, "failed");
    assert.equal(res.reason, "target-not-found");
    assert.equal(res.candidates.length, 2);
    assert.equal(askCalls.length, 0);
  });

  it("fails with ambiguous-target and candidate list when 2 or more sessions match", async () => {
    const { askCalls, deps } = makeFakeDeps({
      claudeSessions: [
        { name: "리뷰", session: "claude-rev", target: "claude-rev:0.0" },
      ],
      codexSessions: [
        { name: "리뷰", session: "codex-rev", target: "codex-rev:0.0" },
      ],
    });

    const res = await doSend(
      {
        to: "리뷰",
        message: "ping",
        from: "agy:caller",
      },
      deps,
    );

    assert.equal(res.ok, false);
    assert.equal(res.status, "failed");
    assert.equal(res.reason, "ambiguous-target");
    assert.equal(res.candidates.length, 2);
    assert.equal(askCalls.length, 0);
  });

  it("rejects partial substring matches when neither name nor alias matches exactly", async () => {
    const { askCalls, deps } = makeFakeDeps({
      claudeSessions: [
        {
          name: "triflux-d9",
          session: "triflux-sess",
          target: "triflux-sess:0.1",
        },
      ],
    });

    const res = await doSend(
      {
        to: "triflux-d",
        message: "ping",
        from: "agy:caller",
      },
      deps,
    );

    assert.equal(res.ok, false);
    assert.equal(res.reason, "target-not-found");
    assert.equal(askCalls.length, 0);
  });

  it("blocks Claude-to-Claude on same machine with use-send-message", async () => {
    const { askCalls, deps } = makeFakeDeps({
      claudeSessions: [
        { name: "triflux-d9", session: "triflux", target: "triflux:0.1" },
      ],
      isLocalClaude: true,
      senderName: "claude-worker",
    });

    const res = await doSend(
      {
        to: "triflux-d9",
        message: "보고한다",
        env: { CLAUDECODE: "1" },
      },
      deps,
    );

    assert.equal(res.ok, false);
    assert.equal(res.reason, "use-send-message");
    assert.equal(res.sendMessageTo, "triflux-d9");
    assert.equal(res.inputSent, false);
    assert.equal(askCalls.length, 0);
  });

  it("blocks Claude-to-Claude when the sender is detected from tmux without CLAUDECODE", async () => {
    const { askCalls, deps } = makeFakeDeps({
      claudeSessions: [
        {
          name: "claude-worker",
          session: "claude-worker",
          target: "claude-worker:0.0",
          paneId: "%141",
        },
        { name: "triflux-d9", session: "triflux", target: "triflux:0.1" },
      ],
    });

    const res = await doSend(
      {
        to: "claude:triflux-d9",
        message: "보고한다",
        env: { TMUX_PANE: "%141" },
      },
      deps,
    );

    assert.deepEqual(res.from, { cli: "claude", name: "claude-worker" });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "use-send-message");
    assert.equal(res.sendMessageTo, "triflux-d9");
    assert.equal(res.inputSent, false);
    assert.equal(askCalls.length, 0);
  });

  it("rejects agy -> Claude with use-tfx-peer", async () => {
    const { askCalls, deps } = makeFakeDeps({
      claudeSessions: [
        {
          name: "triflux-d9",
          session: "triflux",
          target: "triflux:0.1",
          sessionId: "exact-target",
        },
      ],
      agySessions: [
        {
          name: "agy-sender",
          session: "agy-sender",
          target: "agy-sender:0.0",
          paneId: "%140",
          conversationId: "conv-sender",
        },
      ],
    });

    const res = await doSend(
      {
        to: "claude:triflux-d9",
        message: "작업 완료",
        noWait: true,
        env: {
          TMUX_PANE: "%140",
          ANTIGRAVITY_CONVERSATION_ID: "conv-sender",
        },
      },
      deps,
    );

    assert.equal(res.ok, false);
    assert.equal(res.to.cli, "claude");
    assert.equal(res.reason, "use-tfx-peer");
    assert.match(res.error, /--to claude:exact-target/);
    assert.equal(res.inputSent, false);
    assert.equal(askCalls.length, 0);
  });

  it("rejects agy caller with prefix-less --from to Claude", async () => {
    const { askCalls, deps } = makeFakeDeps({
      claudeSessions: [
        { name: "triflux-d9", session: "triflux", target: "triflux:0.1" },
      ],
    });

    const res = await doSend(
      {
        to: "claude:triflux-d9",
        message: "접두사 없는 발신",
        from: "peer-worker",
        noWait: true,
        env: { ANTIGRAVITY_CONVERSATION_ID: "conv-sender" },
      },
      deps,
    );

    assert.equal(res.ok, false);
    assert.equal(res.to.cli, "claude");
    assert.equal(res.reason, "use-tfx-peer");
    assert.equal(res.inputSent, false);
    assert.equal(askCalls.length, 0);
  });

  it("routes to agy by conversationId or session name", async () => {
    const { askCalls, deps } = makeFakeDeps({
      agySessions: [
        {
          name: "agy-peer",
          session: "agy-peer",
          target: "agy-peer:0.0",
          conversationId: "847c0490-8c04-443a-80af-c370837d48cb",
        },
      ],
    });

    const res = await doSend(
      {
        to: "847c0490-8c04-443a-80af-c370837d48cb",
        message: "agy 깨우기",
        from: "codex:lead",
      },
      deps,
    );

    assert.equal(res.ok, true);
    assert.equal(res.to.cli, "agy");
    assert.equal(res.to.name, "agy-peer");
    assert.equal(res.transport, "agy-tmux");
    assert.equal(askCalls.length, 1);
    assert.equal(askCalls[0].adapter, ADAPTERS.agy);
    assert.equal(
      askCalls[0].opts.conversationId,
      "847c0490-8c04-443a-80af-c370837d48cb",
    );
    assert.ok(
      askCalls[0].opts.prompt.endsWith(
        `회신: ${path.join(os.homedir(), ".claude", "scripts", "tfx-peer")} send --to 'codex:lead' --message '...'`,
      ),
    );
  });

  it("resolvePeerSender prioritizes --from over TFX_LIVE_FROM and env", async () => {
    const { deps } = makeFakeDeps({
      agySessions: [
        {
          name: "pane-agy",
          session: "pane-agy",
          target: "pane-agy:0.0",
          paneId: "%140",
          conversationId: "conv-140",
        },
      ],
    });

    const fromFlag = await resolvePeerSender({
      from: "codex:explicit-from",
      env: { TFX_LIVE_FROM: "claude:env-from", TMUX_PANE: "%140" },
      deps,
    });
    assert.deepEqual(fromFlag, { cli: "codex", name: "explicit-from" });

    const fromEnv = await resolvePeerSender({
      from: null,
      env: { TFX_LIVE_FROM: "claude:env-from", TMUX_PANE: "%140" },
      deps,
    });
    assert.deepEqual(fromEnv, { cli: "claude", name: "env-from" });

    const fromPane = await resolvePeerSender({
      from: null,
      env: { TMUX_PANE: "%140" },
      deps,
    });
    assert.deepEqual(fromPane, { cli: "agy", name: "pane-agy" });
  });
});

it("explicit --via-tmux remains available for a Codex target", async () => {
  const { askCalls, deps } = makeFakeDeps({
    codexSessions: [{ name: "target", session: "cx", target: "cx:0.0" }],
  });
  assert.equal(
    (
      await doSend(
        {
          to: "codex:target",
          message: "hello",
          from: "agy:caller",
          viaTmux: true,
        },
        deps,
      )
    ).ok,
    true,
  );
  assert.equal(askCalls[0].opts.transport, "tmux");
});

it("sender name resolver receives the env options contract", async () => {
  const env = { CLAUDECODE: "1", CLAUDE_PID: "123" };
  await resolvePeerSender({
    env,
    allCandidates: [],
    deps: {
      resolveSenderName: async (options) => {
        assert.equal(options.env, env);
        return "sender";
      },
    },
  });
});

for (const cli of ["claude", "agy"]) {
  it(`${cli} identity takes precedence over an inherited Codex thread`, async () => {
    const env = {
      TMUX_PANE: "%7",
      CODEX_THREAD_ID: "inherited",
      ...(cli === "claude"
        ? { CLAUDECODE: "1" }
        : { ANTIGRAVITY_CONVERSATION_ID: "current" }),
    };
    const options = {
      env,
      allCandidates: [
        { cli: "codex", name: "wrong", paneId: "%7", threadId: "inherited" },
        { cli, name: "sender", paneId: "%7", conversationId: "current" },
      ],
      deps: { resolveSenderName: async () => null },
    };
    assert.deepEqual(await resolvePeerSender(options), { cli, name: "sender" });
    assert.deepEqual(
      await resolvePeerSender({ ...options, from: "explicit" }),
      {
        cli,
        name: "explicit",
      },
    );
  });
}

it("unnamed Claude sender preserves its sessionId when the display name falls back to tmux", async () => {
  const { deps } = makeFakeDeps({
    claudeSessions: [
      { session: "tmux-name", paneId: "%7", sessionId: "exact-session" },
    ],
  });
  const sender = await resolvePeerSender({ env: { TMUX_PANE: "%7" }, deps });
  assert.equal(sender.sessionId, "exact-session");
  assert.match(formatPeerReply(sender, "codex"), /--to 'claude:exact-session'/);
});

for (const paneCli of ["claude", "codex"]) {
  it(`Codex thread identity overrides an inherited ${paneCli} pane`, async () => {
    const sender = await resolvePeerSender({
      env: { TMUX_PANE: "%91", CODEX_THREAD_ID: "wanted" },
      allCandidates: [
        { cli: paneCli, name: "wrong", paneId: "%91", threadId: "other" },
        { cli: "codex", name: "worker", paneId: "%92", threadId: "wanted" },
      ],
    });
    assert.deepEqual(sender, { cli: "codex", name: "worker" });
  });
}

it("an unmatched Codex thread never falls back to the daemon pane", async () => {
  const sender = await resolvePeerSender({
    env: { TMUX_PANE: "%91", CODEX_THREAD_ID: "wanted" },
    allCandidates: [{ cli: "claude", name: "wrong", paneId: "%91" }],
    deps: { resolveSenderName: async () => null },
  });
  assert.equal(sender.cli, "codex");
  assert.notEqual(sender.name, "wrong");
});

it("Claude without a real name or sessionId gets an unknown reply route", async () => {
  const { deps } = makeFakeDeps();
  const sender = await resolvePeerSender({ env: { CLAUDECODE: "1" }, deps });
  assert.equal(sender.cli, "claude");
  for (const targetCli of ["claude", "codex", "agy"])
    assert.equal(
      formatPeerReply(sender, targetCli),
      "회신: 경로 불명(보낸 세션을 판별하지 못함)",
    );
});

it("a Claude pane without name or sessionId cannot advertise its tmux name as a reply target", async () => {
  const { deps } = makeFakeDeps({
    claudeSessions: [{ session: "shell", paneId: "%7" }],
  });
  const sender = await resolvePeerSender({ env: { TMUX_PANE: "%7" }, deps });
  assert.equal(
    formatPeerReply(sender, "codex"),
    "회신: 경로 불명(보낸 세션을 판별하지 못함)",
  );
});

it("Windows Claude reply uses node in PowerShell and quotes the exact target", () => {
  assert.equal(
    formatPeerReply({ cli: "claude", name: "O'Brien & 10%" }, "agy", {
      platform: "win32",
    }),
    String.raw`회신: node "$env:APPDATA\npm\node_modules\triflux\bin\tfx-peer.mjs" send --to 'claude:O''Brien & 10%' --message '...'`,
  );
  assert.equal(
    formatPeerReply({ cli: "codex", name: "lead" }, "claude", {
      platform: "win32",
    }),
    "회신: Windows 에서는 Codex 대상을 아직 지원하지 않는다",
  );
});
