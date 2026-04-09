import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildSlimWrapperPrompt,
  compressScoutReport,
  deduplicateFindings,
  verifySlimWrapperRouteExecution,
  weightedConsensus,
} from "../../hub/team/native.mjs";

describe("deduplicateFindings — 중복 제거 + occurrences 카운트", () => {
  it("동일 description은 하나로 합치고 occurrences를 세야 한다", () => {
    const findings = [
      {
        description: "Null pointer in auth module",
        file: "auth.js",
        line: 10,
        severity: "high",
      },
      {
        description: "Null pointer in auth module",
        file: "auth.js",
        line: 10,
        severity: "high",
      },
      {
        description: "Null pointer in auth module",
        file: "auth.js",
        line: 10,
        severity: "high",
      },
    ];
    const result = deduplicateFindings(findings);
    assert.equal(result.length, 1);
    assert.equal(result[0].occurrences, 3);
    assert.equal(result[0].description, "Null pointer in auth module");
  });

  it("유사도 80% 이상인 description은 중복으로 판정해야 한다", () => {
    // Jaccard: {"missing","null","check","in","auth","handler","function"} vs
    //          {"missing","null","check","in","auth","handler","module"}
    // intersection=6, union=8 → 6/8=0.75 — 아래는 overlap이 더 높은 쌍:
    const findings = [
      {
        description: "Missing null check in auth handler for user login",
        severity: "high",
      },
      {
        description: "Missing null check in auth handler for user session",
        severity: "medium",
      },
    ];
    // intersection=8 (missing,null,check,in,auth,handler,for,user), union=10 → 0.8
    const result = deduplicateFindings(findings);
    assert.equal(result.length, 1);
    assert.equal(result[0].occurrences, 2);
  });

  it("유사도가 낮은 항목은 별도로 유지해야 한다", () => {
    const findings = [
      {
        description: "SQL injection vulnerability in login endpoint",
        severity: "critical",
      },
      {
        description: "Memory leak in background worker process",
        severity: "medium",
      },
    ];
    const result = deduplicateFindings(findings);
    assert.equal(result.length, 2);
    assert.equal(result[0].occurrences, 1);
    assert.equal(result[1].occurrences, 1);
  });

  it("빈 배열을 넣으면 빈 배열을 반환해야 한다", () => {
    assert.deepEqual(deduplicateFindings([]), []);
  });

  it("대소문자/공백 차이는 정규화 후 비교해야 한다", () => {
    const findings = [
      { description: "Missing  Error  Handling  in  API", severity: "high" },
      { description: "missing error handling in api", severity: "low" },
    ];
    const result = deduplicateFindings(findings);
    assert.equal(result.length, 1);
    assert.equal(result[0].occurrences, 2);
  });
});

describe("compressScoutReport — 토큰 제한 준수", () => {
  it("파일:라인 패턴을 findings로 추출해야 한다", () => {
    const raw = `분석 결과:
src/auth.js:42 - null check 누락
hub/router.mjs:100 - timeout 미처리
일반 텍스트 설명`;
    const result = compressScoutReport(raw);
    assert.equal(result.findings.length, 2);
    assert.equal(result.findings[0].file, "src/auth.js");
    assert.equal(result.findings[0].line, "42");
    assert.ok(result.findings[0].summary.length > 0);
  });

  it("tokenEstimate가 500 이하여야 한다 (2000자 기준)", () => {
    const raw = "a".repeat(3000) + "\nsome/file.js:1 - issue";
    const result = compressScoutReport(raw);
    assert.ok(
      result.tokenEstimate <= 500,
      `tokenEstimate ${result.tokenEstimate} exceeds 500`,
    );
  });

  it("summary 길이가 2000자를 초과하지 않아야 한다", () => {
    const longReport = Array(100)
      .fill("This is a very long sentence that should be truncated.")
      .join("\n");
    const result = compressScoutReport(longReport);
    assert.ok(result.summary.length <= 2000);
  });

  it("빈 입력에 대해 빈 결과를 반환해야 한다", () => {
    const result = compressScoutReport("");
    assert.deepEqual(result.findings, []);
    assert.equal(result.summary, "");
  });
});

describe("weightedConsensus — 신뢰도 계산 정확성", () => {
  it("3명 중 3명이 같은 발견을 보고하면 confidence=1.0이어야 한다", () => {
    const reports = [
      {
        agentName: "scout-1",
        findings: [{ description: "Auth bypass vulnerability" }],
      },
      {
        agentName: "scout-2",
        findings: [{ description: "Auth bypass vulnerability" }],
      },
      {
        agentName: "scout-3",
        findings: [{ description: "Auth bypass vulnerability" }],
      },
    ];
    const result = weightedConsensus(reports);
    assert.equal(result.length, 1);
    assert.equal(result[0].confidence, 1.0);
    assert.deepEqual(result[0].reporters.sort(), [
      "scout-1",
      "scout-2",
      "scout-3",
    ]);
  });

  it("3명 중 1명만 보고하면 confidence~0.33이어야 한다", () => {
    const reports = [
      {
        agentName: "scout-1",
        findings: [{ description: "Unique finding only scout-1 found" }],
      },
      {
        agentName: "scout-2",
        findings: [{ description: "Different finding from scout-2" }],
      },
      {
        agentName: "scout-3",
        findings: [{ description: "Another different finding scout-3" }],
      },
    ];
    const result = weightedConsensus(reports);
    assert.equal(result.length, 3);
    for (const item of result) {
      assert.equal(item.confidence, 0.33);
      assert.equal(item.reporters.length, 1);
    }
  });

  it("유사한 description을 가진 발견은 같은 그룹으로 묶어야 한다", () => {
    const reports = [
      {
        agentName: "scout-1",
        findings: [{ description: "Missing null check in auth handler" }],
      },
      {
        agentName: "scout-2",
        findings: [
          { description: "Missing null check in auth handler function" },
        ],
      },
    ];
    const result = weightedConsensus(reports);
    assert.equal(result.length, 1);
    assert.equal(result[0].confidence, 1.0);
    assert.equal(result[0].reporters.length, 2);
  });

  it("빈 입력에 대해 빈 배열을 반환해야 한다", () => {
    assert.deepEqual(weightedConsensus([]), []);
  });

  it("findings가 없는 scout는 consensus에 영향을 주지 않아야 한다", () => {
    const reports = [
      { agentName: "scout-1", findings: [{ description: "Found issue X" }] },
      { agentName: "scout-2", findings: [] },
    ];
    const result = weightedConsensus(reports);
    assert.equal(result.length, 1);
    assert.equal(result[0].confidence, 0.5);
    assert.deepEqual(result[0].reporters, ["scout-1"]);
  });
});

describe("verifySlimWrapperRouteExecution — slopDetected 플래그", () => {
  it("동일 패턴 3회 이상 반복 시 slopDetected=true여야 한다", () => {
    const repeatedLine =
      "This is a repeated output line that appears many times in the log";
    const stdoutText = Array(5).fill(repeatedLine).join("\n");
    const result = verifySlimWrapperRouteExecution({
      promptText: "plain prompt",
      stdoutText,
    });
    assert.equal(result.slopDetected, true);
  });

  it("반복 없는 출력에서는 slopDetected=false여야 한다", () => {
    const result = verifySlimWrapperRouteExecution({
      promptText: "plain prompt",
      stdoutText: "Line one\nLine two\nLine three\nAll different",
    });
    assert.equal(result.slopDetected, false);
  });

  it("짧은 줄 반복은 slop으로 판정하지 않아야 한다", () => {
    // 15자 이하 줄은 무시됨
    const stdoutText = Array(10).fill("ok done").join("\n");
    const result = verifySlimWrapperRouteExecution({
      promptText: "prompt",
      stdoutText,
    });
    assert.equal(result.slopDetected, false);
  });

  it("기존 반환 필드가 유지되어야 한다", () => {
    const result = verifySlimWrapperRouteExecution({
      promptText: buildSlimWrapperPrompt("codex", { subtask: "test" }),
      stderrText: "[tfx-route] v2.3",
    });
    assert.equal(typeof result.expectedRouteInvocation, "boolean");
    assert.equal(typeof result.usedRoute, "boolean");
    assert.equal(typeof result.abnormal, "boolean");
    assert.equal(typeof result.slopDetected, "boolean");
    assert.ok("reason" in result);
  });
});
