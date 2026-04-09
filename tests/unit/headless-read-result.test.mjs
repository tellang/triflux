// tests/unit/headless-read-result.test.mjs — readResult stderr fallback 로직 검증

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const TEST_DIR = join(tmpdir(), "tfx-readresult-test");
const RESULT_FILE = join(TEST_DIR, "test-result.txt");
const ERR_FILE = `${RESULT_FILE}.err`;

// readResult 로직 재현 (내부 함수라 직접 import 불가)
function readResultLike(resultFile) {
  if (existsSync(resultFile)) {
    return readFileSync(resultFile, "utf8").trim();
  }
  const errFile = `${resultFile}.err`;
  if (existsSync(errFile)) {
    const stderr = readFileSync(errFile, "utf8").trim();
    if (stderr) return `[stderr] ${stderr}`;
  }
  return "";
}

describe("headless readResult fallback logic", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    try {
      rmSync(RESULT_FILE);
    } catch {}
    try {
      rmSync(ERR_FILE);
    } catch {}
  });

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true });
    } catch {}
  });

  it("resultFile 존재 시 내용 반환", () => {
    writeFileSync(RESULT_FILE, "success output", "utf8");
    assert.equal(readResultLike(RESULT_FILE), "success output");
  });

  it("resultFile 없고 .err 존재 시 [stderr] prefix로 반환", () => {
    writeFileSync(ERR_FILE, "codex auth failed", "utf8");
    assert.ok(!existsSync(RESULT_FILE));
    assert.equal(readResultLike(RESULT_FILE), "[stderr] codex auth failed");
  });

  it("resultFile도 .err도 없으면 빈 문자열", () => {
    assert.ok(!existsSync(RESULT_FILE));
    assert.ok(!existsSync(ERR_FILE));
    assert.equal(readResultLike(RESULT_FILE), "");
  });

  it(".err 파일이 비어있으면 빈 문자열", () => {
    writeFileSync(ERR_FILE, "  \n  ", "utf8");
    assert.equal(readResultLike(RESULT_FILE), "");
  });
});
