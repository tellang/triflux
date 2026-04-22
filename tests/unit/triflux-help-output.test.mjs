import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const binPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bin",
  "triflux.mjs",
);

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("tfx --help 출력", () => {
  it("Commands 섹션에 tfx swarm 포함", () => {
    const raw = execSync(`node "${binPath}" --help`, { encoding: "utf8" });
    const out = stripAnsi(raw);
    assert.match(out, /tfx swarm/);
  });

  it("tfx swarm --help 가 sub-help 출력", () => {
    const raw = execSync(`node "${binPath}" swarm --help`, {
      encoding: "utf8",
    });
    const out = stripAnsi(raw);
    assert.match(out, /PRD|shard|worktree/i);
  });
});
