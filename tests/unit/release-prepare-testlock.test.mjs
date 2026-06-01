import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Hermetic: never touch the real repo-root .test-lock/pid.lock. During
// `npm test` / `release:prepare` the live scripts/test-lock.mjs wrapper OWNS
// that file as its concurrency singleton lock. Writing/deleting it from a
// test deletes the live lock mid-run and defeats the guard that prevents the
// WT ConPTY / RAM explosion (reproduced hazard). So we point
// cleanupStaleTestLock() at a temp lock path via DI and assert the real lock
// is never touched.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL_LOCK = resolve(REPO_ROOT, ".test-lock", "pid.lock");

describe("release:prepare preflight — stale test-lock cleanup", () => {
  let tmpRoot;
  let lockFile;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "triflux-prepare-testlock-"));
    lockFile = join(tmpRoot, ".test-lock", "pid.lock");
    mkdirSync(dirname(lockFile), { recursive: true });
    writeFileSync(lockFile, "99999\n");
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("stale lock 파일을 prepare 시작 시 제거한다 (실제 repo 락 무접촉)", async () => {
    assert.ok(existsSync(lockFile));
    const realLockBefore = existsSync(REAL_LOCK);

    const mod = await import("../../scripts/release/prepare.mjs");
    mod.cleanupStaleTestLock(lockFile);

    assert.ok(!existsSync(lockFile));
    // Hermeticity guard: the live repo-root lock must be untouched.
    assert.equal(existsSync(REAL_LOCK), realLockBefore);
  });
});
