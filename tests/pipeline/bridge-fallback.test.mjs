// tests/pipeline/bridge-fallback.test.mjs — nativeProxy fallback 테스트
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { main } from "../../hub/bridge.mjs";

// Hub 미실행 상태에서 bridge CLI가 nativeProxy fallback으로 동작하는지 검증.
// 이 테스트는 Hub 서버가 꺼진 상태를 전제로 한다.

function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
}

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

describe("bridge team 커맨드 nativeProxy fallback", () => {
  it("team-info: 존재하지 않는 팀 → TEAM_NOT_FOUND (nativeProxy 경유)", async () => {
    const result = await withEnv("TFX_HUB_URL", "http://127.0.0.1:1", () =>
      captureJsonLog(() =>
        main(["team-info", "--team", "fallback-test-nonexistent"]),
      ),
    );
    // Hub 미실행 → nativeProxy fallback → 팀 없음 에러
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "TEAM_NOT_FOUND");
  });

  it("team-task-list: 존재하지 않는 팀 → TASKS_DIR_NOT_FOUND", async () => {
    const result = await withEnv("TFX_HUB_URL", "http://127.0.0.1:1", () =>
      captureJsonLog(() =>
        main(["team-task-list", "--team", "fallback-test-nonexistent"]),
      ),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "TASKS_DIR_NOT_FOUND");
  });

  it("team-task-update: 존재하지 않는 팀 → TASKS_DIR_NOT_FOUND", async () => {
    const result = await withEnv("TFX_HUB_URL", "http://127.0.0.1:1", () =>
      captureJsonLog(() =>
        main([
          "team-task-update",
          "--team",
          "fallback-test-nonexistent",
          "--task-id",
          "fake-task",
        ]),
      ),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "TASKS_DIR_NOT_FOUND");
  });

  it("team-send-message: 존재하지 않는 팀 → TEAM_NOT_FOUND", async () => {
    const result = await withEnv("TFX_HUB_URL", "http://127.0.0.1:1", () =>
      captureJsonLog(() =>
        main([
          "team-send-message",
          "--team",
          "fallback-test-nonexistent",
          "--from",
          "tester",
          "--text",
          "hello",
        ]),
      ),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "TEAM_NOT_FOUND");
  });
});

describe("bridge pipeline 커맨드", () => {
  it("pipeline-state: Hub DB 없으면 에러", async () => {
    const result = await withEnv(
      "TFX_HUB_URL",
      "http://127.0.0.1:1",
      async () => {
        // TFX_HUB_URL을 잘못된 포트로 설정하여 HTTP 실패 유도
        return await captureJsonLog(() =>
          main(["pipeline-state", "--team", "test"]),
        );
      },
    );
    // Hub DB가 있으면 pipeline_not_found, 없으면 hub_db_not_found
    assert.equal(result.ok, false);
  });
});
