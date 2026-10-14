import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ADAPTERS,
  doSend,
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
      '회신: tfx-live send --to agy:peer-worker --message "..."',
    );
  });

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

    assert.equal(res.ok, true);
    assert.equal(res.to.cli, "codex");
    assert.equal(res.to.name, "10.14 리뷰");
    assert.equal(res.transport, "codex-queue");
    assert.equal(res.msgId, "m1");
    assert.equal(res.requestId, "r1");
    assert.equal(res.status, "completed");
    assert.equal(res.response, "ack from codex");
    assert.equal(askCalls.length, 1);
    assert.equal(askCalls[0].adapter, ADAPTERS.codex);
    assert.equal(askCalls[0].opts.threadId, "th-1014");
    assert.equal(askCalls[0].opts.noRelayTag, false);
    assert.match(
      askCalls[0].opts.prompt,
      /^\[tfx-peer from=agy:peer-worker msg=m1\] \[tfx-live req=r1\]\n리뷰 부탁한다\n회신: tfx-live send --to agy:peer-worker --message "\.\.\."$/,
    );
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

    assert.equal(res.ok, true);
    assert.equal(res.to.cli, "codex");
    assert.equal(res.status, "sent");
    assert.equal("response" in res, false);
    assert.equal(askCalls.length, 1);
    assert.equal(askCalls[0].adapter, ADAPTERS.codex);
    assert.equal(askCalls[0].opts.noWait, true);
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

  it("routes Codex or agy -> Claude via claude ask path", async () => {
    const { askCalls, deps } = makeFakeDeps({
      claudeSessions: [
        { name: "triflux-d9", session: "triflux", target: "triflux:0.1" },
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

    assert.equal(res.ok, true);
    assert.equal(res.to.cli, "claude");
    assert.equal(res.to.name, "triflux-d9");
    assert.deepEqual(res.from, { cli: "agy", name: "agy-sender" });
    assert.equal(res.transport, "claude-tmux");
    assert.equal(askCalls.length, 1);
    assert.equal(askCalls[0].adapter, ADAPTERS.claude);
    assert.equal(askCalls[0].opts.session, "triflux:0.1");
  });

  it("routes agy caller with prefix-less --from to Claude via tmux", async () => {
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

    assert.equal(res.ok, true);
    assert.equal(res.to.cli, "claude");
    assert.deepEqual(res.from, { cli: "agy", name: "peer-worker" });
    assert.equal(res.transport, "claude-tmux");
    assert.equal(askCalls.length, 1);
    assert.equal(askCalls[0].adapter, ADAPTERS.claude);
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
