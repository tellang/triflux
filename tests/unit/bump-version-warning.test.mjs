import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUMP_VERSION = join(ROOT, "scripts", "release", "bump-version.mjs");

describe("bump-version CLI warnings", () => {
  it("prints a stderr warning when --write is missing", () => {
    const result = spawnSync(
      process.execPath,
      [BUMP_VERSION, "--version", "10.99.0"],
      {
        cwd: ROOT,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0);
    assert.equal(result.error, undefined);
    assert.match(
      result.stderr,
      /\[bump-version\] --write 플래그 누락 — dry-run 모드\. 실제 변경 없음\./,
    );
    assert.match(
      result.stderr,
      /\[bump-version\] 변경하려면 --write 추가하세요\./,
    );
    assert.equal(result.stdout, "");
  });
});
