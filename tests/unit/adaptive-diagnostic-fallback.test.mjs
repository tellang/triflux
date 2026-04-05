// tests/unit/adaptive-diagnostic-fallback.test.mjs — loadKnownErrors 파일 누락/손상 fallback 테스트
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

import { loadKnownErrors } from "../../hub/adaptive-diagnostic.mjs";

const TEST_DIR = join(tmpdir(), "tfx-diag-test");

describe("adaptive-diagnostic loadKnownErrors fallback", () => {
  it("존재하지 않는 파일 → 빈 catalog 반환", () => {
    const result = loadKnownErrors("/nonexistent/path/known-errors.json");
    assert.equal(result.version, 0);
    assert.deepEqual(result.signatures, []);
    assert.equal(result.path, "/nonexistent/path/known-errors.json");
  });

  it("손상된 JSON → 빈 catalog 반환", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const badFile = join(TEST_DIR, "bad.json");
    writeFileSync(badFile, "{{not valid json}}", "utf8");

    const result = loadKnownErrors(badFile);
    assert.equal(result.version, 0);
    assert.deepEqual(result.signatures, []);

    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("빈 파일 → 빈 catalog 반환", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const emptyFile = join(TEST_DIR, "empty.json");
    writeFileSync(emptyFile, "", "utf8");

    const result = loadKnownErrors(emptyFile);
    assert.equal(result.version, 0);
    assert.deepEqual(result.signatures, []);

    rmSync(TEST_DIR, { recursive: true, force: true });
  });
});
