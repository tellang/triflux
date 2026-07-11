// tests/unit/timeout-shim.test.mjs — Windows Git Bash timeout shim contract

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";

const SHIM_PATH = join(process.cwd(), "tests", "fixtures", "bin", "timeout");

function runTimeout(args) {
  return spawnSync(process.execPath, [SHIM_PATH, ...args], {
    encoding: "utf8",
    timeout: 5000,
  });
}

describe("timeout fixture shim", () => {
  it("자식 종료 코드를 그대로 전달한다", () => {
    const result = runTimeout(["5", process.execPath, "-e", "process.exit(7)"]);
    assert.equal(result.status, 7);
  });

  it("duration 초과 시 SIGTERM 후 124로 종료한다", () => {
    const startedAt = Date.now();
    const result = runTimeout([
      "0.3",
      process.execPath,
      "-e",
      "setTimeout(() => {}, 10000)",
    ]);
    assert.equal(result.status, 124);
    assert.ok(Date.now() - startedAt < 5000);
  });

  it("-s로 지정한 signal도 timeout 종료에 사용한다", () => {
    const result = runTimeout([
      "-s",
      "SIGKILL",
      "0.3",
      process.execPath,
      "-e",
      "setTimeout(() => {}, 10000)",
    ]);
    assert.equal(result.status, 124);
  });

  it("-k kill-after를 파싱하고 SIGKILL 승격 뒤 124로 종료한다", () => {
    const result = runTimeout([
      "-k",
      "0.3",
      "0.3",
      process.execPath,
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    ]);
    assert.equal(result.status, 124);
  });

  it("duration 0은 무제한 passthrough다", () => {
    const result = runTimeout(["0", process.execPath, "-e", "process.exit(0)"]);
    assert.equal(result.status, 0);
  });

  it("사용법 오류는 125를 반환한다", () => {
    assert.equal(runTimeout([]).status, 125);
    assert.equal(runTimeout(["abc", process.execPath, "-e", "0"]).status, 125);
    assert.equal(
      runTimeout(["-x", "5", process.execPath, "-e", "0"]).status,
      125,
    );
  });

  it("자식 spawn 실패는 127을 반환한다", () => {
    assert.equal(runTimeout(["1", "definitely-not-a-cmd-xyz"]).status, 127);
  });

  it("--kill-after=VALUE 형식을 지원한다", () => {
    const result = runTimeout([
      "--kill-after=5",
      "5",
      process.execPath,
      "-e",
      "process.exit(0)",
    ]);
    assert.equal(result.status, 0);
  });
});
