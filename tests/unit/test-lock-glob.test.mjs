import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { expandTestArgs } from "../../scripts/test-lock.mjs";

function withTempTree(fn) {
  const dir = mkdtempSync(join(tmpdir(), "triflux-test-lock-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function touch(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    "import { test } from 'node:test';\ntest('ok', () => {});\n",
  );
}

test("expandTestArgs expands glob tokens and preserves flags", () => {
  withTempTree((cwd) => {
    touch(join(cwd, "tests", "alpha.test.mjs"));
    touch(join(cwd, "tests", "unit", "beta.test.mjs"));
    touch(join(cwd, "scripts", "__tests__", "gamma.test.mjs"));

    const expanded = expandTestArgs(
      [
        "--test",
        "--test-force-exit",
        "--test-concurrency=8",
        "tests/**/*.test.mjs",
        "scripts/__tests__/**/*.test.mjs",
      ],
      { cwd },
    );

    assert.deepEqual(expanded, [
      "--test",
      "--test-force-exit",
      "--test-concurrency=8",
      "tests/alpha.test.mjs",
      "tests/unit/beta.test.mjs",
      "scripts/__tests__/gamma.test.mjs",
    ]);
  });
});

test("expandTestArgs keeps unmatched glob tokens literal", () => {
  withTempTree((cwd) => {
    const expanded = expandTestArgs(["--test", "tests/**/*.test.mjs"], {
      cwd,
    });

    assert.deepEqual(expanded, ["--test", "tests/**/*.test.mjs"]);
  });
});
