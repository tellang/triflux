import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  cleanStaleResultArtifacts,
  readResult,
} from "../../hub/team/headless.mjs";

const TEST_DIR = join(tmpdir(), "tfx-118-partial-test");
const RESULT_FILE = join(TEST_DIR, "worker-1.txt");

describe("issue #118 fix — readResult .partial fallback chain (real fn)", () => {
  // Review R1 MEDIUM 반영: readResult 를 module export 로 바꾸고 실제 함수를 테스트.
  // paneId 를 empty 로 주면 capturePsmuxPane 은 빈 문자열을 반환하도록 psmux.mjs 가 보장.
  const PANE_EMPTY = "";

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    cleanStaleResultArtifacts(RESULT_FILE);
  });

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it(".partial 존재 시 [partial] prefix 로 반환", () => {
    writeFileSync(`${RESULT_FILE}.partial`, "partial codex output", "utf8");
    assert.equal(
      readResult(RESULT_FILE, PANE_EMPTY),
      "[partial] partial codex output",
    );
  });

  it(".partial 이 .err 보다 우선한다 (더 풍부한 정보)", () => {
    writeFileSync(`${RESULT_FILE}.partial`, "meaningful partial", "utf8");
    writeFileSync(`${RESULT_FILE}.err`, "stderr noise", "utf8");
    assert.equal(
      readResult(RESULT_FILE, PANE_EMPTY),
      "[partial] meaningful partial",
    );
  });

  it("resultFile 이 있으면 .partial 을 무시한다 (정상 완료 경로)", () => {
    writeFileSync(RESULT_FILE, "completed output", "utf8");
    writeFileSync(`${RESULT_FILE}.partial`, "stale partial", "utf8");
    assert.equal(readResult(RESULT_FILE, PANE_EMPTY), "completed output");
  });

  it(".partial 이 비어있으면 .err 로 fallback", () => {
    writeFileSync(`${RESULT_FILE}.partial`, "   \n   ", "utf8");
    writeFileSync(`${RESULT_FILE}.err`, "codex exit 1", "utf8");
    assert.equal(readResult(RESULT_FILE, PANE_EMPTY), "[stderr] codex exit 1");
  });
});

describe("issue #118 review R1 HIGH — cleanStaleResultArtifacts", () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("이전 run 의 .txt / .partial / .err 를 모두 제거한다", () => {
    writeFileSync(RESULT_FILE, "prev completed", "utf8");
    writeFileSync(`${RESULT_FILE}.partial`, "prev partial", "utf8");
    writeFileSync(`${RESULT_FILE}.err`, "prev stderr", "utf8");

    cleanStaleResultArtifacts(RESULT_FILE);

    assert.equal(existsSync(RESULT_FILE), false, ".txt 제거 확인");
    assert.equal(
      existsSync(`${RESULT_FILE}.partial`),
      false,
      ".partial 제거 확인",
    );
    assert.equal(existsSync(`${RESULT_FILE}.err`), false, ".err 제거 확인");
  });

  it("cleanup 후 readResult 는 empty capture-pane 으로 fallback (stale leak 없음)", () => {
    // 이전 run 의 stale partial 이 있었는데 cleanup 후 새 run 시작
    writeFileSync(`${RESULT_FILE}.partial`, "STALE from prev run", "utf8");
    cleanStaleResultArtifacts(RESULT_FILE);
    // paneId empty → capturePsmuxPane 빈 문자열. stale [partial] leak 되지 않아야 함
    const result = readResult(RESULT_FILE, "");
    assert.doesNotMatch(
      result,
      /STALE from prev run/,
      "cleanup 후 stale partial 이 readResult 에 새 run 결과로 오인되면 안 됨",
    );
  });
});
