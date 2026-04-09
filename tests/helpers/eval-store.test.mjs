import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  compareEvalResults,
  EvalCollector,
  extractToolSummary,
  findPreviousRun,
  generateCommentary,
  judgePassed,
} from "./eval-store.mjs";

// --- extractToolSummary ---

describe("extractToolSummary", () => {
  it("빈 transcript에서 빈 객체를 반환한다", () => {
    assert.deepEqual(extractToolSummary([]), {});
  });

  it("assistant 메시지에서 tool_use 항목을 카운트한다", () => {
    const transcript = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Bash" },
            { type: "tool_use", name: "Read" },
            { type: "tool_use", name: "Bash" },
            { type: "text", text: "some text" },
          ],
        },
      },
    ];
    assert.deepEqual(extractToolSummary(transcript), { Bash: 2, Read: 1 });
  });

  it("non-assistant 이벤트는 무시한다", () => {
    const transcript = [
      {
        type: "user",
        message: { content: [{ type: "tool_use", name: "Bash" }] },
      },
      { type: "system", content: "ignore me" },
    ];
    assert.deepEqual(extractToolSummary(transcript), {});
  });

  it("tool_use name이 없을 경우 unknown으로 카운트한다", () => {
    const transcript = [
      {
        type: "assistant",
        message: { content: [{ type: "tool_use" }] },
      },
    ];
    assert.deepEqual(extractToolSummary(transcript), { unknown: 1 });
  });
});

// --- judgePassed ---

describe("judgePassed", () => {
  it("모든 조건을 충족하면 true를 반환한다", () => {
    assert.equal(
      judgePassed(
        { detection_rate: 0.8, false_positives: 1, evidence_quality: 3 },
        { minimum_detection: 0.7, max_false_positives: 2 },
      ),
      true,
    );
  });

  it("detection_rate가 미달이면 false를 반환한다", () => {
    assert.equal(
      judgePassed(
        { detection_rate: 0.5, false_positives: 0, evidence_quality: 3 },
        { minimum_detection: 0.7, max_false_positives: 2 },
      ),
      false,
    );
  });

  it("false_positives 초과 시 false를 반환한다", () => {
    assert.equal(
      judgePassed(
        { detection_rate: 0.9, false_positives: 3, evidence_quality: 3 },
        { minimum_detection: 0.7, max_false_positives: 2 },
      ),
      false,
    );
  });

  it("evidence_quality가 2 미만이면 false를 반환한다", () => {
    assert.equal(
      judgePassed(
        { detection_rate: 0.9, false_positives: 0, evidence_quality: 1 },
        { minimum_detection: 0.7, max_false_positives: 2 },
      ),
      false,
    );
  });
});

// --- compareEvalResults ---

function makeResult(overrides = {}) {
  return {
    schema_version: 1,
    version: "1.0.0",
    branch: "main",
    git_sha: "abc1234",
    timestamp: "2024-01-01T00:00:00.000Z",
    hostname: "host",
    tier: "e2e",
    total_tests: 1,
    passed: 1,
    failed: 0,
    total_cost_usd: 0.1,
    total_duration_ms: 5000,
    tests: [],
    ...overrides,
  };
}

describe("compareEvalResults", () => {
  it("unchanged: 두 결과 모두 pass인 경우", () => {
    const before = makeResult({
      tests: [
        { name: "test-a", passed: true, cost_usd: 0.05, duration_ms: 2000 },
      ],
    });
    const after = makeResult({
      tests: [
        { name: "test-a", passed: true, cost_usd: 0.06, duration_ms: 2200 },
      ],
    });
    const cmp = compareEvalResults(before, after, "before.json", "after.json");
    assert.equal(cmp.unchanged, 1);
    assert.equal(cmp.improved, 0);
    assert.equal(cmp.regressed, 0);
    assert.equal(cmp.deltas[0].status_change, "unchanged");
  });

  it("improved: before fail → after pass", () => {
    const before = makeResult({
      tests: [
        { name: "test-b", passed: false, cost_usd: 0.1, duration_ms: 3000 },
      ],
    });
    const after = makeResult({
      tests: [
        { name: "test-b", passed: true, cost_usd: 0.08, duration_ms: 2500 },
      ],
    });
    const cmp = compareEvalResults(before, after, "before.json", "after.json");
    assert.equal(cmp.improved, 1);
    assert.equal(cmp.regressed, 0);
    assert.equal(cmp.deltas[0].status_change, "improved");
  });

  it("regressed: before pass → after fail", () => {
    const before = makeResult({
      tests: [
        { name: "test-c", passed: true, cost_usd: 0.05, duration_ms: 2000 },
      ],
    });
    const after = makeResult({
      tests: [
        { name: "test-c", passed: false, cost_usd: 0.07, duration_ms: 2100 },
      ],
    });
    const cmp = compareEvalResults(before, after, "before.json", "after.json");
    assert.equal(cmp.regressed, 1);
    assert.equal(cmp.improved, 0);
    assert.equal(cmp.deltas[0].status_change, "regressed");
  });

  it("after에 없는 테스트는 removed로 표시된다", () => {
    const before = makeResult({
      tests: [
        { name: "old-test", passed: true, cost_usd: 0.05, duration_ms: 1000 },
      ],
    });
    const after = makeResult({ tests: [] });
    const cmp = compareEvalResults(before, after, "before.json", "after.json");
    assert.equal(cmp.deltas.length, 1);
    assert.ok(cmp.deltas[0].name.includes("(removed)"));
  });

  it("after에만 있는 신규 테스트는 unchanged로 처리된다", () => {
    const before = makeResult({ tests: [] });
    const after = makeResult({
      tests: [
        { name: "new-test", passed: true, cost_usd: 0.03, duration_ms: 1500 },
      ],
    });
    const cmp = compareEvalResults(before, after, "before.json", "after.json");
    assert.equal(cmp.unchanged, 1);
    assert.equal(cmp.deltas[0].before.passed, false);
    assert.equal(cmp.deltas[0].before.cost_usd, 0);
  });

  it("cost delta를 올바르게 계산한다", () => {
    const before = makeResult({
      total_cost_usd: 0.1,
      tests: [{ name: "x", passed: true, cost_usd: 0.1, duration_ms: 1000 }],
    });
    const after = makeResult({
      total_cost_usd: 0.15,
      tests: [{ name: "x", passed: true, cost_usd: 0.15, duration_ms: 1000 }],
    });
    const cmp = compareEvalResults(before, after, "before.json", "after.json");
    assert.ok(Math.abs(cmp.total_cost_delta - 0.05) < 0.0001);
  });

  it("transcript의 tool 카운트를 집계한다", () => {
    const transcript = [
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash" }] },
      },
    ];
    const before = makeResult({
      tests: [
        {
          name: "tx",
          passed: true,
          cost_usd: 0.01,
          duration_ms: 500,
          transcript,
        },
      ],
    });
    const after = makeResult({
      tests: [
        {
          name: "tx",
          passed: true,
          cost_usd: 0.01,
          duration_ms: 500,
          transcript,
        },
      ],
    });
    const cmp = compareEvalResults(before, after, "before.json", "after.json");
    assert.equal(cmp.tool_count_before, 1);
    assert.equal(cmp.tool_count_after, 1);
  });
});

// --- generateCommentary ---

describe("generateCommentary", () => {
  it("회귀가 있으면 REGRESSION 메시지를 포함한다", () => {
    const c = {
      deltas: [
        {
          name: "broken-test",
          status_change: "regressed",
          before: { passed: true },
          after: { passed: false },
        },
      ],
      improved: 0,
      regressed: 1,
      unchanged: 0,
      total_cost_delta: 0,
      total_duration_delta: 0,
    };
    const notes = generateCommentary(c);
    assert.ok(notes.some((n) => n.includes("REGRESSION")));
    assert.ok(notes.some((n) => n.includes("broken-test")));
  });

  it("개선이 있으면 Fixed 메시지를 포함한다", () => {
    const c = {
      deltas: [
        {
          name: "fixed-test",
          status_change: "improved",
          before: { passed: false },
          after: { passed: true },
        },
      ],
      improved: 1,
      regressed: 0,
      unchanged: 0,
      total_cost_delta: 0,
      total_duration_delta: 0,
    };
    const notes = generateCommentary(c);
    assert.ok(notes.some((n) => n.includes("Fixed")));
    assert.ok(notes.some((n) => n.includes("fixed-test")));
  });

  it("회귀 없이 안정된 실행이면 Stable run 메시지를 반환한다", () => {
    const stableDeltas = Array.from({ length: 3 }, (_, i) => ({
      name: `test-${i}`,
      status_change: "unchanged",
      before: {
        passed: true,
        cost_usd: 0.05,
        turns_used: undefined,
        duration_ms: undefined,
        detection_rate: undefined,
      },
      after: {
        passed: true,
        cost_usd: 0.05,
        turns_used: undefined,
        duration_ms: undefined,
        detection_rate: undefined,
      },
    }));
    const c = {
      deltas: stableDeltas,
      improved: 0,
      regressed: 0,
      unchanged: 3,
      total_cost_delta: 0,
      total_duration_delta: 0,
    };
    const notes = generateCommentary(c);
    assert.ok(notes.some((n) => n.includes("Stable run")));
  });

  it("turns가 20%+ 감소하면 효율성 인사이트를 추가한다", () => {
    const c = {
      deltas: [
        {
          name: "efficient-test",
          status_change: "unchanged",
          before: {
            passed: true,
            cost_usd: 0.05,
            turns_used: 10,
            duration_ms: 10000,
            detection_rate: undefined,
          },
          after: {
            passed: true,
            cost_usd: 0.05,
            turns_used: 6,
            duration_ms: 10000,
            detection_rate: undefined,
          },
        },
      ],
      improved: 0,
      regressed: 0,
      unchanged: 1,
      total_cost_delta: 0,
      total_duration_delta: 0,
    };
    const notes = generateCommentary(c);
    assert.ok(notes.some((n) => n.includes("fewer turns")));
  });
});

// --- EvalCollector basic flow ---

describe("EvalCollector", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-store-test-"));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("addTest → savePartial: _partial-e2e.json이 생성된다", () => {
    const collector = new EvalCollector("e2e", tmpDir);
    collector.addTest({
      name: "sample-test",
      suite: "unit",
      tier: "e2e",
      passed: true,
      duration_ms: 1000,
      cost_usd: 0.05,
    });

    const partialPath = path.join(tmpDir, "_partial-e2e.json");
    assert.ok(
      fs.existsSync(partialPath),
      "_partial-e2e.json should exist after addTest",
    );

    const data = JSON.parse(fs.readFileSync(partialPath, "utf-8"));
    assert.equal(data._partial, true);
    assert.equal(data.total_tests, 1);
    assert.equal(data.passed, 1);
    assert.equal(data.failed, 0);
    assert.equal(data.tests[0].name, "sample-test");
  });

  it("finalize: 결과 파일이 저장되고 경로를 반환한다", async () => {
    const collector = new EvalCollector("e2e", tmpDir);
    collector.addTest({
      name: "finalize-test",
      suite: "unit",
      tier: "e2e",
      passed: false,
      duration_ms: 2000,
      cost_usd: 0.1,
    });

    const filepath = await collector.finalize();
    assert.ok(
      filepath.length > 0,
      "finalize should return a non-empty filepath",
    );
    assert.ok(fs.existsSync(filepath), "finalized file should exist on disk");

    const data = JSON.parse(fs.readFileSync(filepath, "utf-8"));
    assert.equal(data._partial, undefined);
    assert.equal(data.total_tests, 1);
    assert.equal(data.passed, 0);
    assert.equal(data.failed, 1);
    assert.ok(typeof data.wall_clock_ms === "number");
  });

  it("finalize를 두 번 호출해도 빈 문자열을 반환하고 파일을 중복 생성하지 않는다", async () => {
    const collector = new EvalCollector("e2e", tmpDir);
    collector.addTest({
      name: "t",
      suite: "s",
      tier: "e2e",
      passed: true,
      duration_ms: 100,
      cost_usd: 0.01,
    });

    const first = await collector.finalize();
    const second = await collector.finalize();
    assert.ok(first.length > 0);
    assert.equal(second, "");
  });

  it("addTest 없이 finalize해도 오류가 발생하지 않는다", async () => {
    const collector = new EvalCollector("llm-judge", tmpDir);
    const filepath = await collector.finalize();
    assert.ok(filepath.length > 0);

    const data = JSON.parse(fs.readFileSync(filepath, "utf-8"));
    assert.equal(data.total_tests, 0);
    assert.equal(data.tier, "llm-judge");
  });
});

// --- findPreviousRun ---

describe("findPreviousRun", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-find-test-"));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("디렉토리가 없으면 null을 반환한다", () => {
    const result = findPreviousRun(
      "/nonexistent/path",
      "e2e",
      "main",
      "some.json",
    );
    assert.equal(result, null);
  });

  it("같은 tier의 이전 파일을 찾는다", () => {
    const entry = {
      schema_version: 1,
      version: "1.0.0",
      branch: "main",
      git_sha: "abc",
      timestamp: "2024-01-01T00:00:00.000Z",
      hostname: "host",
      tier: "e2e",
      total_tests: 1,
      passed: 1,
      failed: 0,
      total_cost_usd: 0.01,
      total_duration_ms: 1000,
      tests: [],
    };
    const prevFile = path.join(tmpDir, "1.0.0-main-e2e-20240101.json");
    fs.writeFileSync(prevFile, JSON.stringify(entry));

    const result = findPreviousRun(tmpDir, "e2e", "main", "current.json");
    assert.equal(result, prevFile);
  });

  it("excludeFile 자신은 제외한다", () => {
    const subDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-excl-"));
    const entry = {
      tier: "e2e",
      branch: "main",
      timestamp: "2024-02-01T00:00:00.000Z",
    };
    const onlyFile = path.join(subDir, "only.json");
    fs.writeFileSync(onlyFile, JSON.stringify(entry));

    const result = findPreviousRun(subDir, "e2e", "main", onlyFile);
    assert.equal(result, null);

    fs.rmSync(subDir, { recursive: true, force: true });
  });
});
