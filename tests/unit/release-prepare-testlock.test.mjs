import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lockDir = resolve(REPO_ROOT, ".test-lock");
const lockFile = resolve(lockDir, "pid.lock");

describe("release:prepare preflight — stale test-lock cleanup", () => {
  beforeEach(() => {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockFile, "99999\n");
  });

  afterEach(() => {
    try {
      rmSync(lockFile, { force: true });
    } catch {}
  });

  it("stale lock 파일을 prepare 시작 시 제거한다", async () => {
    assert.ok(existsSync(lockFile));
    const mod = await import("../../scripts/release/prepare.mjs");
    mod.cleanupStaleTestLock();
    assert.ok(!existsSync(lockFile));
  });
});
