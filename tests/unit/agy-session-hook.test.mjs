import assert from "node:assert/strict";
import { it } from "node:test";
import { runAgySessionHook } from "../../hooks/agy-session-hook.mjs";
import { emitParticipantSessionStarted } from "../../scripts/lib/session-presence.mjs";

it("agy 훅은 잘못된 입력에도 성공하고 시작 이벤트만 남긴다", async () => {
  const events = [];
  for (const mode of ["register", "heartbeat", ""]) {
    for (const input of [
      '{"conversationId":"conv-1","invocationNum":1}',
      "{invalid",
      "",
    ]) {
      assert.equal(
        await runAgySessionHook(input, {
          argvMode: mode,
          writeStdout: false,
          ancestorCommands: [],
          emitSessionStarted: (data) =>
            emitParticipantSessionStarted(data, {
              env: { TFX_CTO_AUTO_COLLECT: "1" },
              resolveLakeRoot: () => ({ lakeRoot: "/fixture/.triflux/lake" }),
              ctoAppend: (_root, event) => events.push(event),
            }),
        }),
        "{}\n",
      );
    }
  }
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(event.event, "session_started");
    assert.equal(event.actor.cli, "agy");
    assert.equal(event.session_id, "conv-1");
  }
});
