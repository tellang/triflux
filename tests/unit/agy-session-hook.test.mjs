import assert from "node:assert/strict";
import { it } from "node:test";
import { runAgySessionHook } from "../../hooks/agy-session-hook.mjs";

it("agy 훅은 어떤 입력에도 빈 성공 응답만 돌려준다", async () => {
  for (const input of ['{"conversationId":"conv-1"}', "{invalid", ""]) {
    assert.equal(
      await runAgySessionHook(input, { writeStdout: false }),
      "{}\n",
    );
  }
});
