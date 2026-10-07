import assert from "node:assert/strict";
import { it } from "node:test";
import { runAgySessionHook } from "../../hooks/agy-session-hook.mjs";
import { emitParticipantSessionStarted } from "../../scripts/lib/session-presence.mjs";

it("agy 훅의 기존 입력과 모드는 허브 호출 없이 성공한다", async () => {
  let calls = 0;
  const events = [];
  const remote = () => calls++;
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
          hubEnsureRun: remote,
          registerInteractiveSession: remote,
          heartbeatInteractiveSession: remote,
          drainPendingSynapse: remote,
        }),
        "{}\n",
      );
    }
  }
  assert.equal(calls, 0);
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(event.event, "session_started");
    assert.equal(event.actor.cli, "agy");
    assert.equal(event.session_id, "conv-1");
  }
});
