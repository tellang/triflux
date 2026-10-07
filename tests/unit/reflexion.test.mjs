// tests/unit/reflexion.test.mjs — reflexion 에러 학습 엔진 테스트

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { normalizeError, recalcConfidence } from "../../hub/reflexion.mjs";
import { createStore } from "../../hub/store.mjs";
import { SQLITE_SKIP } from "../helpers/sqlite.mjs";

describe("reflexion", { skip: SQLITE_SKIP }, () => {
  let store, tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "reflexion-test-"));
    store = createStore(join(tmpDir, "test.db"));
  });

  after(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. normalizeError: 파일 경로 → <FILE> 치환
  it("normalizeError replaces file paths with <FILE>", () => {
    const msg = "Error in C:\\Users\\dev\\project\\src\\index.js at runtime";
    const norm = normalizeError(msg);
    assert.ok(norm.includes("<file>"), `Expected <file> in: ${norm}`);
    assert.ok(!norm.includes("index.js"), "File name should be replaced");
  });

  // 2. normalizeError: 줄 번호/UUID/숫자 치환
  it("normalizeError replaces line numbers, UUIDs, and large numbers", () => {
    const msg =
      "Error at line 42: 550e8400-e29b-41d4-a716-446655440000 failed with code 123456";
    const norm = normalizeError(msg);
    assert.ok(norm.includes("<line>"), `Expected <line> in: ${norm}`);
    assert.ok(norm.includes("<id>"), `Expected <id> in: ${norm}`);
    assert.ok(norm.includes("<num>"), `Expected <num> in: ${norm}`);
  });

  // 6. updateReflexionHit: hit_count 증가 + success 시 success_count 증가
  it("updateReflexionHit increments hit_count and success_count", () => {
    const entry = store.addReflexion({
      error_pattern: "test-hit-update",
      error_message: "test error",
      solution: "test solution",
    });
    assert.equal(entry.hit_count, 1);
    assert.equal(entry.success_count, 0);

    const updated = store.updateReflexionHit(entry.id, true);
    assert.equal(updated.hit_count, 2);
    assert.equal(updated.success_count, 1);

    const updated2 = store.updateReflexionHit(entry.id, false);
    assert.equal(updated2.hit_count, 3);
    assert.equal(updated2.success_count, 1);
  });

  // 7. recalcConfidence: success/hit 비율 기반 계산
  it("recalcConfidence calculates based on success/hit ratio with decay", () => {
    const conf = recalcConfidence({ hit_count: 10, success_count: 8 });
    // decay = min(1, 10/10) = 1.0, ratio = 0.8 → 0.8*1 + 0.5*0 = 0.8
    assert.equal(conf, 0.8);

    const confLow = recalcConfidence({ hit_count: 2, success_count: 2 });
    // decay = min(1, 2/10) = 0.2, ratio = 1.0 → 1.0*0.2 + 0.5*0.8 = 0.6
    assert.ok(Math.abs(confLow - 0.6) < 0.001, `Expected ~0.6, got ${confLow}`);
  });

  // 8. recalcConfidence: 0회 hit → 기본 0.5
  it("recalcConfidence returns 0.5 for zero hits", () => {
    assert.equal(recalcConfidence({ hit_count: 0, success_count: 0 }), 0.5);
    assert.equal(recalcConfidence(null), 0.5);
    assert.equal(recalcConfidence(undefined), 0.5);
    assert.equal(recalcConfidence({ hit_count: -1, success_count: 0 }), 0.5);
  });

  // 9. pruneReflexion: 오래된 + 낮은 confidence 항목 삭제
  it("pruneReflexion removes old low-confidence entries", () => {
    // 직접 DB에 오래된 항목 삽입
    const oldEntry = store.addReflexion({
      error_pattern: "prune-test-old",
      error_message: "old error",
      solution: "old solution",
    });
    // confidence를 낮게 설정 (recalcConfidence decay: 10회 실패 → conf=0)
    for (let i = 0; i < 9; i++) store.updateReflexionHit(oldEntry.id, false);
    // hit_count=10, success_count=0 → decay=1.0 → recalcConfidence=0

    // updated_at_ms를 강제로 과거로 수정
    store.db
      .prepare("UPDATE reflexion_entries SET updated_at_ms = ? WHERE id = ?")
      .run(Date.now() - 60 * 24 * 3600 * 1000, oldEntry.id); // 60일 전

    const pruned = store.pruneReflexion(30 * 24 * 3600 * 1000, 0.2);
    assert.ok(pruned >= 1, `Expected at least 1 pruned, got ${pruned}`);

    const after = store.getReflexion(oldEntry.id);
    assert.equal(after, null, "Pruned entry should be gone");
  });

  // 11. normalizeError: 빈 입력 처리
  it("normalizeError returns empty string for invalid input", () => {
    assert.equal(normalizeError(""), "");
    assert.equal(normalizeError(null), "");
    assert.equal(normalizeError(undefined), "");
    assert.equal(normalizeError(42), "");
  });
});
