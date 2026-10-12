import assert from "node:assert/strict";
import { test } from "node:test";
import { isSlashCommand } from "../../bin/tfx-live.mjs";

test("슬래시 명령과 실제 경로로 시작하는 문장을 구분한다", () => {
  for (const prompt of ["/rename 새 이름", "/clear", "/tfx-review 봐줘"])
    assert.equal(isSlashCommand(prompt), true, prompt);
  for (const prompt of [
    "/tmp 내용을 확인해줘",
    "/Users/me/a.txt 열어",
    "안녕 /clear",
  ])
    assert.equal(isSlashCommand(prompt), false, prompt);
});
