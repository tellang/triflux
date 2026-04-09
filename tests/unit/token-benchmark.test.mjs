import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
// ── pipeline benchmark hooks ──
import { benchmarkEnd, benchmarkStart } from "../../hub/pipeline/index.mjs";
// ── token-snapshot 모듈 (named exports) ──
import {
  computeDiff,
  DIFFS_DIR,
  estimateSavings,
  formatCost,
  formatTokenCount,
  STATE_DIR,
  takeSnapshot,
} from "../../scripts/token-snapshot.mjs";

// ── 테스트 격리: 스냅샷/diff 디렉토리를 임시로 사용 ──
const SNAPSHOTS_DIR = join(STATE_DIR, "snapshots");

describe("token-benchmark hooks", () => {
  let origFiles = [];

  beforeEach(() => {
    // 기존 스냅샷/diff 파일 목록 기록 (정리용)
    mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    mkdirSync(DIFFS_DIR, { recursive: true });
    origFiles = {
      snapshots: new Set(
        existsSync(SNAPSHOTS_DIR) ? readdirSync(SNAPSHOTS_DIR) : [],
      ),
      diffs: new Set(existsSync(DIFFS_DIR) ? readdirSync(DIFFS_DIR) : []),
    };
  });

  afterEach(() => {
    // 테스트가 생성한 파일만 삭제
    try {
      for (const f of readdirSync(SNAPSHOTS_DIR)) {
        if (!origFiles.snapshots.has(f)) {
          rmSync(join(SNAPSHOTS_DIR, f), { force: true });
        }
      }
      for (const f of readdirSync(DIFFS_DIR)) {
        if (!origFiles.diffs.has(f)) {
          rmSync(join(DIFFS_DIR, f), { force: true });
        }
      }
    } catch {
      /* 무시 */
    }
  });

  describe("takeSnapshot()", () => {
    it("스냅샷 파일을 생성하고 summary를 포함한다", () => {
      const label = `__test_snap_${Date.now()}`;
      const snap = takeSnapshot(label);

      assert.ok(snap, "takeSnapshot은 객체를 반환해야 한다");
      assert.equal(snap.label, label);
      assert.ok(snap.timestamp);
      assert.ok(snap.summary);
      assert.ok("codex_files" in snap.summary);
      assert.ok("gemini_files" in snap.summary);
      assert.ok("claude_files" in snap.summary);

      // 파일이 실제로 기록됨
      const snapPath = join(SNAPSHOTS_DIR, `${label}.json`);
      assert.ok(existsSync(snapPath), "스냅샷 JSON 파일이 존재해야 한다");

      // cleanup
      rmSync(snapPath, { force: true });
    });
  });

  describe("computeDiff()", () => {
    it("두 스냅샷 간 diff를 계산하고 저장한다", () => {
      const pre = `__test_pre_${Date.now()}`;
      const post = `__test_post_${Date.now()}`;
      const diffId = `__test_diff_${Date.now()}`;

      takeSnapshot(pre);
      takeSnapshot(post);

      const result = computeDiff(pre, post, { id: diffId });

      assert.ok(result, "computeDiff는 객체를 반환해야 한다");
      assert.equal(result.preLabel, pre);
      assert.equal(result.postLabel, post);
      assert.ok(result.delta);
      assert.ok(result.savings);
      assert.ok("claudeCost" in result.savings);
      assert.ok("actualCost" in result.savings);
      assert.ok("saved" in result.savings);

      // diff 파일이 DIFFS_DIR에 저장됨
      const diffPath = join(DIFFS_DIR, `${diffId}.json`);
      assert.ok(existsSync(diffPath), "diff JSON 파일이 존재해야 한다");

      // cleanup
      rmSync(join(SNAPSHOTS_DIR, `${pre}.json`), { force: true });
      rmSync(join(SNAPSHOTS_DIR, `${post}.json`), { force: true });
      rmSync(diffPath, { force: true });
    });
  });

  describe("estimateSavings()", () => {
    it("토큰 사용량에서 절약액을 계산한다", () => {
      const tokens = { input: 100_000, output: 50_000, total: 150_000 };
      const result = estimateSavings(tokens, "executor", "codex");

      assert.ok(result);
      assert.equal(result.claudeModel, "claude_sonnet");
      assert.equal(result.actualModel, "codex");
      assert.ok(result.claudeCost > 0, "Claude 비용이 0보다 커야 한다");
      assert.equal(result.cliCost, 0, "Codex 비용은 0이어야 한다");
      assert.ok(result.saved > 0, "절약액이 0보다 커야 한다");
    });
  });

  describe("formatTokenSummary()", () => {
    it("diff 결과를 포맷된 문자열로 반환한다", () => {
      // formatTokenSummary는 hud-qos-status 내부 함수이므로
      // 개별 포맷터로 검증
      assert.equal(formatTokenCount(1_500_000), "1.5M");
      assert.equal(formatTokenCount(50_000), "50K");
      assert.equal(formatTokenCount(999), "999");
      assert.equal(formatCost(0.005), "$0.00");
      assert.equal(formatCost(1.234), "$1.23");
      assert.equal(formatCost(99.999), "$100.00");
    });
  });

  describe("benchmarkStart()", () => {
    it("벤치마크 시작 시 스냅샷을 캡처한다", async () => {
      const label = `__test_bench_start_${Date.now()}`;
      const result = await benchmarkStart(label);

      assert.ok(result, "benchmarkStart은 결과를 반환해야 한다");
      assert.equal(result.label, label);
      assert.ok(result.snapshot);

      // cleanup
      rmSync(join(SNAPSHOTS_DIR, `${label}.json`), { force: true });
    });
  });

  describe("benchmarkEnd()", () => {
    it("벤치마크 종료 시 diff를 계산하고 타임스탬프 파일을 저장한다", async () => {
      const pre = `__test_benchE_pre_${Date.now()}`;
      const post = `__test_benchE_post_${Date.now()}`;

      // 시작 스냅샷
      await benchmarkStart(pre);

      // 종료 + diff
      const diff = await benchmarkEnd(pre, post, {
        id: `__test_benchE_${Date.now()}`,
      });

      assert.ok(diff, "benchmarkEnd은 diff를 반환해야 한다");
      assert.ok(diff.savings);
      assert.ok(diff.delta);

      // 타임스탬프 파일 확인
      const allDiffs = readdirSync(DIFFS_DIR).filter((f) =>
        f.endsWith(".json"),
      );
      assert.ok(allDiffs.length > 0, "diffs 디렉토리에 파일이 있어야 한다");

      // cleanup
      rmSync(join(SNAPSHOTS_DIR, `${pre}.json`), { force: true });
      rmSync(join(SNAPSHOTS_DIR, `${post}.json`), { force: true });
    });
  });
});
