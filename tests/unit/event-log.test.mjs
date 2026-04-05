import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { createEventLog } from "../../hub/team/event-log.mjs";

const TEST_DIR = join(tmpdir(), "tfx-test-event-log-" + process.pid);

function setup() {
  mkdirSync(TEST_DIR, { recursive: true });
  return join(TEST_DIR, `test-${Date.now()}.jsonl`);
}

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("event-log", () => {
  it("append()는 JSONL 한 줄을 기록해야 한다", async () => {
    const path = setup();
    const log = createEventLog(path);

    log.append("spawn", { agent: "codex", pid: 1234 });
    await log.flush();
    await log.close();

    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);

    const entry = JSON.parse(lines[0]);
    assert.equal(entry.event, "spawn");
    assert.equal(entry.agent, "codex");
    assert.equal(entry.pid, 1234);
    assert.ok(entry.ts);
  });

  it("sessionId가 설정되면 모든 이벤트에 session 필드가 포함되어야 한다", async () => {
    const path = setup();
    const log = createEventLog(path, { sessionId: "abc-123" });

    log.append("health", { level: "L0" });
    log.append("kill", { reason: "test" });
    await log.flush();
    await log.close();

    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);

    for (const line of lines) {
      const entry = JSON.parse(line);
      assert.equal(entry.session, "abc-123");
    }
  });

  it("close() 후 append()는 무시되어야 한다", async () => {
    const path = setup();
    const log = createEventLog(path);

    log.append("before", {});
    await log.close();
    log.append("after", {});

    const content = readFileSync(path, "utf8").trim();
    const lines = content.split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).event, "before");
  });

  it("filePath getter는 생성 시 전달한 경로를 반환해야 한다", async () => {
    const path = setup();
    const log = createEventLog(path);
    assert.equal(log.filePath, path);
    await log.close();
  });
});
