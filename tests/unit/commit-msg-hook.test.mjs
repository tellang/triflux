import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";

const hook = resolve(".githooks/commit-msg");
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function check(message) {
  const dir = mkdtempSync(join(tmpdir(), "tfx-commit-msg-"));
  dirs.push(dir);
  const path = join(dir, "message.txt");
  writeFileSync(path, message);
  return spawnSync(hook, [path], { encoding: "utf8" });
}

test("AI attribution trailer를 거부한다", () => {
  for (const trailer of [
    "Co-Authored-By: Bot <bot@example.test>",
    "Claude-Session: abc",
    "Generated with [Claude Code]",
    "🤖 Generated with [Claude Code](https://claude.ai/code)",
  ]) {
    const result = check(`Chore: 테스트\n\n${trailer}\n`);
    assert.equal(result.status, 1, trailer);
    assert.match(result.stderr, /AI attribution trailer/u);
  }
});

test("일반 커밋 메시지를 허용한다", () => {
  assert.equal(check("Chore: 정상 메시지\n\n검증 완료\n").status, 0);
});
