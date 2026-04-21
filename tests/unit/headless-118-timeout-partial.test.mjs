// tests/unit/headless-118-timeout-partial.test.mjs
// Issue #118 (BUG-A P0): codex killed before HANDOFF flush 회귀 방지.
// 3 fix 지점을 전부 커버한다:
//   1) runHeadless + startHeadlessTeam default timeoutSec 300→900 (소스 assertion)
//   2) waitForCompletionWithStallDetect 타임아웃 시 ${resultFile}.partial persist
//   3) readResult fallback chain 에 .partial → [partial] prefix 포함

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
import {
  cleanStaleResultArtifacts,
  readResult,
  waitForCompletionWithStallDetect,
} from "../../hub/team/headless.mjs";

const TEST_DIR = join(tmpdir(), "tfx-118-partial-test");
const RESULT_FILE = join(TEST_DIR, "worker-1.txt");

/** 기본 mock deps — stall 유발 (frozen 출력) */
function createDeps(overrides = {}) {
  return {
    capturePsmuxPane: () => "codex partial work 진행 중\n...\nstill working",
    existsSync: () => false,
    statSync: () => ({ mtimeMs: 0 }),
    readFileSync: () => "",
    psmuxExec: () => "",
    dispatchCommand: () => {},
    startCapture: () => {},
    ...overrides,
  };
}

describe("issue #118 fix — default timeoutSec 900", () => {
  it("runHeadless default timeoutSec = 900 (source assertion)", () => {
    const src = readFileSync(
      new URL("../../hub/team/headless.mjs", import.meta.url),
      "utf8",
    );
    // runHeadless 의 opts destructure 첫 timeoutSec default
    assert.match(
      src,
      /export async function runHeadless\([^)]*\)[\s\S]{0,300}timeoutSec\s*=\s*900/,
      "runHeadless default timeoutSec 은 900 이어야 한다 (#118 BUG-A)",
    );
  });

  it("startHeadlessTeam default timeoutSec || 900 (source assertion)", () => {
    const src = readFileSync(
      new URL(
        "../../hub/team/cli/commands/start/start-headless.mjs",
        import.meta.url,
      ),
      "utf8",
    );
    assert.match(
      src,
      /timeoutSec:\s*timeoutSec\s*\|\|\s*900/,
      "startHeadlessTeam default timeoutSec || 900 이어야 한다 (#118 BUG-A)",
    );
  });
});

describe("issue #118 fix — .partial capture-pane fallback", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    try {
      rmSync(`${RESULT_FILE}.partial`);
    } catch {
      /* */
    }
  });
  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("completionTimeout 초과 시 .partial 파일에 capture-pane 출력 persist", async () => {
    const writes = [];
    const deps = createDeps({
      // writer 주입으로 실제 디스크 write 검증
      writeFileSync: (path, data) => {
        writes.push({ path, data });
      },
    });

    const result = await waitForCompletionWithStallDetect(
      "sess",
      "tfx:0.1",
      RESULT_FILE,
      {
        token: "tok-timeout",
        pollInterval: 20,
        stallTimeout: 10_000, // stall 은 발생하지 않도록
        completionTimeout: 100, // 짧은 완료 타임아웃
        maxRestarts: 0,
        _deps: deps,
      },
    );

    assert.equal(result.matched, false, "matched=false");
    assert.equal(result.timedOut, true, "timedOut=true");
    assert.ok(
      writes.some(
        (w) =>
          w.path === `${RESULT_FILE}.partial` &&
          w.data.includes("codex partial work"),
      ),
      ".partial 파일에 capture-pane 스냅샷이 저장되어야 한다",
    );
  });

  it("capture-pane 출력이 비어있으면 .partial 을 생성하지 않는다", async () => {
    const writes = [];
    const deps = createDeps({
      capturePsmuxPane: () => "   \n   ", // whitespace only
      writeFileSync: (path, data) => {
        writes.push({ path, data });
      },
    });

    const result = await waitForCompletionWithStallDetect(
      "sess",
      "tfx:0.1",
      RESULT_FILE,
      {
        token: "tok-empty",
        pollInterval: 20,
        stallTimeout: 10_000,
        completionTimeout: 100,
        maxRestarts: 0,
        _deps: deps,
      },
    );

    assert.equal(result.timedOut, true);
    assert.equal(
      writes.filter((w) => w.path.endsWith(".partial")).length,
      0,
      "empty snapshot 은 .partial 을 만들지 않아야 한다",
    );
  });
});

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

  it("파일이 없어도 throw 하지 않는다 (fresh 세션)", () => {
    assert.doesNotThrow(() => cleanStaleResultArtifacts(RESULT_FILE));
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

  it("non-ENOENT 에러 (locked 파일) 에서 throw 안 함 — R2 MEDIUM", () => {
    // Windows locked file 시뮬레이션: 존재하지 않는 부모 디렉토리 경로
    // → rmSync 가 ENOENT 와 다른 에러를 낼 수 있는 경로.
    // cleanStaleResultArtifacts 는 dispatch 진행을 막지 않기 위해
    // 모든 에러를 swallow (ENOENT 는 조용히, 나머지는 retry 후 warn).
    const originalWarn = console.warn;
    const warned = [];
    console.warn = (...args) => warned.push(args.join(" "));
    try {
      assert.doesNotThrow(() =>
        cleanStaleResultArtifacts("/non/existent/dir/that/cannot/be/removed"),
      );
    } finally {
      console.warn = originalWarn;
    }
  });
});
