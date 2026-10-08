// tests/unit/bridge-team.test.mjs: bridge team 하위 명령이 nativeProxy 를 직접 호출하는지 검증
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { main } from "../../hub/bridge.mjs";

function captureJsonLog(fn) {
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.log = original;
    })
    .then(() => {
      for (let index = logs.length - 1; index >= 0; index -= 1) {
        try {
          return JSON.parse(logs[index]);
        } catch {
          // ignore non-JSON noise
        }
      }
      throw new Error(`JSON log not found: ${logs.join("\n")}`);
    });
}

describe("bridge team 커맨드", () => {
  it("team-info: 존재하지 않는 팀 → TEAM_NOT_FOUND", async () => {
    const result = await captureJsonLog(() =>
      main(["team-info", "--team", "fallback-test-nonexistent"]),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "TEAM_NOT_FOUND");
  });

  it("team-task-list: 존재하지 않는 팀 → TASKS_DIR_NOT_FOUND", async () => {
    const result = await captureJsonLog(() =>
      main(["team-task-list", "--team", "fallback-test-nonexistent"]),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "TASKS_DIR_NOT_FOUND");
  });

  it("team-task-update: 존재하지 않는 팀 → TASKS_DIR_NOT_FOUND", async () => {
    const result = await captureJsonLog(() =>
      main([
        "team-task-update",
        "--team",
        "fallback-test-nonexistent",
        "--task-id",
        "fake-task",
      ]),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "TASKS_DIR_NOT_FOUND");
  });

  it("team-send-message: 존재하지 않는 팀 → TEAM_NOT_FOUND", async () => {
    const result = await captureJsonLog(() =>
      main([
        "team-send-message",
        "--team",
        "fallback-test-nonexistent",
        "--from",
        "tester",
        "--text",
        "hello",
      ]),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "TEAM_NOT_FOUND");
  });
});
