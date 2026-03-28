// tests/unit/tui-viewer.test.mjs — tui-viewer.mjs 내부 로직 단위 테스트
// psmux / 파일시스템 의존성은 순수 함수 추출 패턴으로 테스트
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── 순수 함수 재구현 (tui-viewer.mjs 내부 로직 미러) ──
// 파일을 직접 import할 수 없으므로 (CLI 진입점) 로직을 인라인으로 재현한다.

const INTERNAL_PATTERNS = [
  /\$trifluxExit/,
  /\.err\b/,
  /completion[-_]token/i,
  /^---\s*HANDOFF\s*---$/i,
];

function isInternalLine(line) {
  return INTERNAL_PATTERNS.some((re) => re.test(line));
}

function filterCodeBlocks(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/```[\s\S]*?(?:```|$)/g, "\n")
    .replace(/^\s*```.*$/gm, "")
    .trim();
}

function toFilteredBody(text) {
  return filterCodeBlocks(text)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !isInternalLine(l))
    .filter((l) => !/^(PS\s|>|\$)\s*/.test(l))
    .join("\n");
}

function extractTokenLabel(text) {
  const m = String(text || "").match(
    /(\d+(?:[.,]\d+)?\s*[kKmM]?)(?=\s*tokens?\s+used|\s*tokens?\b)/i,
  );
  return m ? m[1].replace(/\s+/g, "").toLowerCase() : "";
}

function extractFindings(lines, verdict = "") {
  return lines
    .map((l) => l.replace(/^verdict\s*:\s*/i, "").trim())
    .filter(Boolean)
    .filter(
      (l) =>
        !/^(status|lead_action|confidence|files_changed|detail|risk|error_stage|retryable|partial_output)\s*:/i.test(l),
    )
    .filter((l) => l !== verdict)
    .slice(-2);
}

const PHASE_WEIGHTS = { plan: 0.10, research: 0.40, exec: 0.90, verify: 1.00 };

function estimateProgress(lines, context = {}) {
  if (context.done) return 1;
  const text = lines.join("\n").toLowerCase();
  let phase = "plan";
  if (/verify|assert|test|check|confirm/.test(text)) phase = "verify";
  else if (/edit|patch|implement|write|update|fix|refactor/.test(text)) phase = "exec";
  else if (/search|read|inspect|analy|review|research/.test(text)) phase = "research";
  let ratio = PHASE_WEIGHTS[phase];
  if (lines.length < 2) ratio = Math.min(ratio, 0.12);
  if (context.tokens) ratio = Math.max(ratio, 0.88);
  if (context.resultSize > 10 || context.shellReturned) return 1;
  return Math.min(0.97, ratio);
}

function splitHandoff(handoff) {
  if (!handoff) return { status: "pending", lead_action: null };
  return { status: handoff.status || "pending", lead_action: handoff.lead_action || null };
}

// ── filterCodeBlocks / toFilteredBody ──
describe("filterCodeBlocks", () => {
  it("fenced 코드블록 제거", () => {
    const input = "결론 문장\n```js\nconsole.log('secret');\n```\n다음 줄";
    const result = filterCodeBlocks(input);
    assert.ok(!result.includes("console.log"), "코드 내용 누출");
    assert.ok(!result.includes("```"), "백틱 누출");
    assert.ok(result.includes("결론 문장"), "정상 내용 제거됨");
    assert.ok(result.includes("다음 줄"), "후속 내용 제거됨");
  });

  it("닫히지 않은 코드블록 처리 (EOL에서 끝남)", () => {
    const input = "텍스트\n```python\nimport os";
    const result = filterCodeBlocks(input);
    assert.ok(!result.includes("import os"), "미닫힌 블록 내용 누출");
  });

  it("코드블록 없으면 원본 반환 (공백 정규화 제외)", () => {
    const input = "단순 텍스트 줄\n두 번째 줄";
    const result = filterCodeBlocks(input);
    assert.ok(result.includes("단순 텍스트 줄"));
    assert.ok(result.includes("두 번째 줄"));
  });

  it("\\r 제거", () => {
    const input = "line1\r\nline2\r\n";
    const result = filterCodeBlocks(input);
    assert.ok(!result.includes("\r"), "CR 잔존");
  });
});

describe("toFilteredBody", () => {
  it("$trifluxExit 라인 제거", () => {
    const input = "정상 출력\n$trifluxExit 0\n다음 줄";
    const result = toFilteredBody(input);
    assert.ok(!result.includes("trifluxExit"), "$trifluxExit 누출");
    assert.ok(result.includes("정상 출력"), "정상 라인 제거됨");
  });

  it(".err 경로 라인 제거", () => {
    const input = "ok 메시지\nerror.err saved\n완료";
    const result = toFilteredBody(input);
    assert.ok(!result.includes(".err"), ".err 누출");
    assert.ok(result.includes("완료"), "정상 라인 제거됨");
  });

  it("completion-token 라인 제거", () => {
    const input = "작업 완료\ncompletion-token: abc123\n결과";
    const result = toFilteredBody(input);
    assert.ok(!result.includes("completion-token"), "completion-token 누출");
    assert.ok(!result.includes("completion_token"), "completion_token 누출");
  });

  it("--- HANDOFF --- 마커 제거", () => {
    const input = "내용\n--- HANDOFF ---\nstatus: ok";
    const result = toFilteredBody(input);
    assert.ok(!result.includes("--- HANDOFF ---"), "HANDOFF 마커 누출");
  });

  it("PS/PowerShell 프롬프트 라인 제거", () => {
    const input = "출력 내용\nPS C:\\Users> \n$ echo done\n결과";
    const result = toFilteredBody(input);
    assert.ok(!result.includes("PS C:"), "PS 프롬프트 누출");
    assert.ok(!result.includes("$ echo"), "$ 프롬프트 누출");
    assert.ok(result.includes("결과"), "정상 라인 제거됨");
  });

  it("빈 줄 필터링", () => {
    const input = "line1\n\n   \nline2";
    const result = toFilteredBody(input);
    assert.equal(result, "line1\nline2");
  });

  it("코드블록 + 내부패턴 동시 적용", () => {
    const input = "정상\n```\n$trifluxExit\n```\n$trifluxExit outside\n완료";
    const result = toFilteredBody(input);
    assert.ok(!result.includes("trifluxExit"), "trifluxExit 누출");
    assert.ok(result.includes("정상"), "정상 라인 제거됨");
    assert.ok(result.includes("완료"), "완료 라인 제거됨");
  });
});

// ── extractTokenLabel ──
describe("extractTokenLabel", () => {
  it("'1.2k tokens used' → '1.2k'", () => {
    assert.equal(extractTokenLabel("1.2k tokens used"), "1.2k");
  });

  it("'500 tokens' → '500'", () => {
    assert.equal(extractTokenLabel("Used 500 tokens"), "500");
  });

  it("'2M tokens used' → '2m'", () => {
    assert.equal(extractTokenLabel("2M tokens used"), "2m");
  });

  it("토큰 정보 없으면 빈 문자열", () => {
    assert.equal(extractTokenLabel("no token info"), "");
    assert.equal(extractTokenLabel(""), "");
    assert.equal(extractTokenLabel(null), "");
  });

  it("공백 제거", () => {
    assert.equal(extractTokenLabel("1 k tokens used"), "1k");
  });
});

// ── extractFindings ──
describe("extractFindings", () => {
  it("마지막 2개 라인 반환", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const findings = extractFindings(lines);
    assert.equal(findings.length, 2);
    assert.deepEqual(findings, ["d", "e"]);
  });

  it("verdict와 동일한 라인 제외", () => {
    const lines = ["alpha", "beta", "gamma"];
    const findings = extractFindings(lines, "gamma");
    assert.ok(!findings.includes("gamma"), "verdict 라인 포함됨");
  });

  it("메타데이터 키 라인 제외 (status:, confidence: 등)", () => {
    const lines = ["status: ok", "confidence: high", "실제 결과"];
    const findings = extractFindings(lines);
    assert.ok(!findings.includes("status: ok"), "status 라인 포함됨");
    assert.ok(!findings.includes("confidence: high"), "confidence 라인 포함됨");
    assert.ok(findings.includes("실제 결과"), "실제 결과 누락됨");
  });

  it("verdict: 접두사 제거", () => {
    const lines = ["verdict: 작업 완료"];
    const findings = extractFindings(lines);
    assert.equal(findings[0], "작업 완료");
  });

  it("빈 라인 처리", () => {
    const findings = extractFindings([]);
    assert.equal(findings.length, 0);
  });
});

// ── estimateProgress ──
describe("estimateProgress", () => {
  it("done=true → 1", () => {
    assert.equal(estimateProgress(["anything"], { done: true }), 1);
  });

  it("resultSize > 10 → 1", () => {
    assert.equal(estimateProgress(["x"], { resultSize: 100 }), 1);
  });

  it("shellReturned=true → 1", () => {
    assert.equal(estimateProgress(["x", "y"], { shellReturned: true }), 1);
  });

  it("plan 단계 기본값 (~0.10)", () => {
    const ratio = estimateProgress(["시작합니다"]);
    assert.ok(ratio <= 0.12, `plan 단계 초과: ${ratio}`);
  });

  it("research 패턴 → 0.40", () => {
    const ratio = estimateProgress(["reading the file", "analyzing result"]);
    assert.equal(ratio, PHASE_WEIGHTS.research);
  });

  it("exec 패턴 → 0.90", () => {
    const ratio = estimateProgress(["implementing the fix", "edit the file"]);
    assert.equal(ratio, PHASE_WEIGHTS.exec);
  });

  it("verify 패턴 → 1.00 (capped at 0.97)", () => {
    const ratio = estimateProgress(["running tests", "verifying the result"]);
    // verify weight=1.00이지만 done=false이므로 min(0.97, 1.00) = 0.97
    assert.equal(ratio, 0.97);
  });

  it("tokens 있으면 최소 0.88", () => {
    const ratio = estimateProgress(["plan 단계"], { tokens: "1k" });
    assert.ok(ratio >= 0.88, `tokens 있는데 ${ratio} < 0.88`);
  });

  it("라인 수 < 2이면 plan 비율 이하로 cap", () => {
    const ratio = estimateProgress(["단일 라인"]);
    assert.ok(ratio <= 0.12, `단일 라인 ${ratio} > 0.12`);
  });

  it("반환값은 항상 0~0.97 범위 (done=false, resultSize=0)", () => {
    const cases = [
      [],
      ["hello"],
      ["read file", "analyze"],
      ["implement feature", "write tests"],
    ];
    for (const lines of cases) {
      const r = estimateProgress(lines, {});
      assert.ok(r >= 0 && r <= 0.97, `범위 초과: ${r} for lines=${JSON.stringify(lines)}`);
    }
  });
});

// ── splitHandoff ──
describe("splitHandoff", () => {
  it("null → { status: 'pending', lead_action: null }", () => {
    const result = splitHandoff(null);
    assert.equal(result.status, "pending");
    assert.equal(result.lead_action, null);
  });

  it("undefined → { status: 'pending', lead_action: null }", () => {
    const result = splitHandoff(undefined);
    assert.equal(result.status, "pending");
    assert.equal(result.lead_action, null);
  });

  it("status/lead_action 분리", () => {
    const handoff = { status: "ok", lead_action: "accept", verdict: "done" };
    const result = splitHandoff(handoff);
    assert.equal(result.status, "ok");
    assert.equal(result.lead_action, "accept");
  });

  it("status 누락 시 'pending' 기본값", () => {
    const result = splitHandoff({ lead_action: "retry" });
    assert.equal(result.status, "pending");
    assert.equal(result.lead_action, "retry");
  });

  it("lead_action 누락 시 null", () => {
    const result = splitHandoff({ status: "failed" });
    assert.equal(result.lead_action, null);
  });

  it("failed status → lead_action 분리 유지", () => {
    const handoff = { status: "failed", lead_action: "retry" };
    const result = splitHandoff(handoff);
    assert.equal(result.status, "failed");
    assert.equal(result.lead_action, "retry");
  });
});

// ── 메모리 최적화: 10KB 초과 시 마지막 10KB로 truncate ──
const MAX_BODY_BYTES = 10240;

function truncateBody(text) {
  return text.length > MAX_BODY_BYTES ? text.slice(-MAX_BODY_BYTES) : text;
}

describe("raw_body / filtered_body 10KB 제한", () => {
  it("raw_body: 10KB 이하는 그대로 유지", () => {
    const body = "x".repeat(1000);
    const result = truncateBody(body);
    assert.equal(result.length, 1000);
    assert.equal(result, body);
  });

  it("raw_body: 10KB 초과 시 마지막 10KB만 유지", () => {
    const prefix = "A".repeat(5000);
    const suffix = "B".repeat(MAX_BODY_BYTES);
    const body = prefix + suffix;
    const result = truncateBody(body);
    assert.equal(result.length, MAX_BODY_BYTES);
    assert.ok(result.startsWith("B"), "마지막 10KB의 첫 문자는 B여야 함");
    assert.ok(!result.includes("A"), "prefix(A)는 제거되어야 함");
  });

  it("filtered_body: 10KB 초과 시 마지막 10KB만 유지", () => {
    const oldPart = "old line\n".repeat(2000);
    const newPart = "new line\n".repeat(200);
    const body = oldPart + newPart;
    assert.ok(body.length > MAX_BODY_BYTES, "테스트 입력이 10KB 초과여야 함");
    const result = truncateBody(body);
    assert.equal(result.length, MAX_BODY_BYTES);
    // 마지막 부분이 보존되어야 함
    assert.ok(result.includes("new line"), "최신 내용(new line)이 보존되어야 함");
  });

  it("정확히 10KB는 truncate 없음", () => {
    const body = "z".repeat(MAX_BODY_BYTES);
    const result = truncateBody(body);
    assert.equal(result.length, MAX_BODY_BYTES);
    assert.equal(result, body);
  });

  it("빈 문자열은 그대로 반환", () => {
    assert.equal(truncateBody(""), "");
  });
});

// ── isInternalLine ──
describe("isInternalLine (내부 데이터 누출 방지)", () => {
  it("$trifluxExit → true", () => {
    assert.ok(isInternalLine("$trifluxExit 0"));
    assert.ok(isInternalLine("if $trifluxExit"));
  });

  it(".err 경로 → true", () => {
    assert.ok(isInternalLine("error.err"));
    assert.ok(isInternalLine("saved to output.err file"));
  });

  it("completion-token → true (대소문자 무관)", () => {
    assert.ok(isInternalLine("completion-token: xyz"));
    assert.ok(isInternalLine("Completion_Token: abc"));
    assert.ok(isInternalLine("completion_token"));
  });

  it("--- HANDOFF --- 마커 → true", () => {
    assert.ok(isInternalLine("--- HANDOFF ---"));
    assert.ok(isInternalLine("--- handoff ---"));
  });

  it("정상 라인 → false", () => {
    assert.ok(!isInternalLine("작업 완료"));
    assert.ok(!isInternalLine("status: ok"));
    assert.ok(!isInternalLine("verdict: tests pass"));
    assert.ok(!isInternalLine(""));
  });
});
