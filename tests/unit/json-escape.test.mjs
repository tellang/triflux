// tests/unit/json-escape.test.mjs — json_escape 로직 단위 테스트
//
// tfx-route.sh의 json_escape(node 경로) 보안 스펙:
//   1) `\` / `"` / 제어문자(U+0000..U+001F) 이스케이프
//   2) 비ASCII 문자는 \uXXXX (또는 surrogate pair)로 강제
//
// 이 테스트는 동일한 로직을 순수 JS로 재현하여:
//   1) 이스케이프 결과가 JSON.parse로 복원 가능한지
//   2) 제어문자/유니코드가 기대 포맷으로 이스케이프되는지
//   3) 실제 node 프로세스 실행 결과와 일치하는지
// 를 검증한다.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const NODE_JSON_ESCAPE_SNIPPET = String.raw`
  const input = process.argv[1] ?? "";
  const base = JSON.stringify(input).slice(1, -1);
  const out = base.replace(/[\u0080-\u{10ffff}]/gu, (ch) => {
    const cp = ch.codePointAt(0);
    if (cp <= 0xffff) {
      return "\\u" + cp.toString(16).padStart(4, "0");
    }
    const v = cp - 0x10000;
    const hi = 0xd800 + (v >> 10);
    const lo = 0xdc00 + (v & 0x3ff);
    return (
      "\\u" +
      hi.toString(16).padStart(4, "0") +
      "\\u" +
      lo.toString(16).padStart(4, "0")
    );
  });
  process.stdout.write(out);
`.trim();

// tfx-route.sh 내 json_escape(node 경로)와 동일한 로직
function jsonEscape(s) {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === 0x22) {
      out += '\\"';
      continue;
    }
    if (cp === 0x5c) {
      out += "\\\\";
      continue;
    }
    if (cp <= 0x1f) {
      const named = {
        8: "\\b",
        9: "\\t",
        10: "\\n",
        12: "\\f",
        13: "\\r",
      };
      out += named[cp] ?? `\\u${cp.toString(16).padStart(4, "0")}`;
      continue;
    }
    if (cp >= 0x20 && cp <= 0x7e) {
      out += ch;
      continue;
    }
    if (cp <= 0xffff) {
      out += `\\u${cp.toString(16).padStart(4, "0")}`;
      continue;
    }
    const v = cp - 0x10000;
    const hi = 0xd800 + (v >> 10);
    const lo = 0xdc00 + (v & 0x3ff);
    out += `\\u${hi.toString(16).padStart(4, "0")}\\u${lo.toString(16).padStart(4, "0")}`;
  }
  return out;
}

// node 프로세스를 직접 실행하여 실제 셸 명령과 동일한 결과인지 검증
function nodeJsonEscape(s) {
  const result = spawnSync(
    process.execPath,
    ["-e", NODE_JSON_ESCAPE_SNIPPET, "--", s],
    { encoding: "utf8" },
  );
  return result.stdout;
}

describe("json_escape — 기본 이스케이프", () => {
  it("빈 문자열은 빈 문자열을 반환해야 한다", () => {
    assert.equal(jsonEscape(""), "");
  });

  it("ASCII 일반 문자는 변경 없이 반환해야 한다", () => {
    assert.equal(jsonEscape("hello world"), "hello world");
  });

  it('쌍따옴표를 \\" 로 이스케이프해야 한다', () => {
    assert.equal(jsonEscape('"quoted"'), '\\"quoted\\"');
  });

  it("백슬래시를 \\\\ 로 이스케이프해야 한다", () => {
    assert.equal(jsonEscape("a\\b"), "a\\\\b");
  });

  it("개행(\\n)을 \\\\n 으로 이스케이프해야 한다", () => {
    assert.equal(jsonEscape("line1\nline2"), "line1\\nline2");
  });

  it("탭(\\t)을 \\\\t 로 이스케이프해야 한다", () => {
    assert.equal(jsonEscape("col1\tcol2"), "col1\\tcol2");
  });

  it("캐리지 리턴(\\r)을 \\\\r 로 이스케이프해야 한다", () => {
    assert.equal(jsonEscape("line\r\n"), "line\\r\\n");
  });

  it("제어문자 U+0001을 \\\\u0001 로 이스케이프해야 한다", () => {
    assert.equal(jsonEscape("a\u0001b"), "a\\u0001b");
  });

  it("한글을 \\\\uXXXX 로 완전 이스케이프해야 한다", () => {
    assert.equal(jsonEscape("안"), "\\uc548");
  });

  it("이모지를 surrogate pair로 이스케이프해야 한다", () => {
    assert.equal(jsonEscape("😀"), "\\ud83d\\ude00");
  });
});

describe("json_escape — 복원 가능성 검증", () => {
  it("이스케이프 후 JSON 값으로 조립하면 원본 복원이 가능해야 한다", () => {
    const original = 'He said "hello" and ran away';
    const escaped = jsonEscape(original);
    const restored = JSON.parse(`"${escaped}"`);
    assert.equal(restored, original);
  });

  it("개행+탭+따옴표 혼합 문자열이 복원 가능해야 한다", () => {
    const original = 'line1\n\t"quoted"\r\nline2';
    const escaped = jsonEscape(original);
    const restored = JSON.parse(`"${escaped}"`);
    assert.equal(restored, original);
  });

  it("백슬래시+쌍따옴표 혼합이 복원 가능해야 한다", () => {
    const original = 'path: C:\\Users\\SSAFY\\"name"';
    const escaped = jsonEscape(original);
    const restored = JSON.parse(`"${escaped}"`);
    assert.equal(restored, original);
  });

  it("한국어 멀티바이트 문자열이 복원 가능해야 한다", () => {
    const original = "안녕하세요 triflux! 테스트 중입니다.";
    const escaped = jsonEscape(original);
    const restored = JSON.parse(`"${escaped}"`);
    assert.equal(restored, original);
  });

  it("이모지(4바이트 UTF-8)가 복원 가능해야 한다", () => {
    const original = "완료 ✅ 오류 ❌ 경고 ⚠️";
    const escaped = jsonEscape(original);
    const restored = JSON.parse(`"${escaped}"`);
    assert.equal(restored, original);
  });
});

describe("json_escape — JSON 객체 조립 검증", () => {
  it("이스케이프된 값을 포함한 JSON 객체가 파싱 가능해야 한다", () => {
    const teamName = 'my-team "alpha"';
    const taskId = "task\n001";
    const summary = "line1\nline2\ttab\\slash";

    const json = `{"team_name":"${jsonEscape(teamName)}","task_id":"${jsonEscape(taskId)}","summary":"${jsonEscape(summary)}"}`;
    const parsed = JSON.parse(json);

    assert.equal(parsed.team_name, teamName);
    assert.equal(parsed.task_id, taskId);
    assert.equal(parsed.summary, summary);
  });

  it("빈 문자열 값을 포함한 JSON 객체가 파싱 가능해야 한다", () => {
    const json = `{"key":"${jsonEscape("")}"}`;
    const parsed = JSON.parse(json);
    assert.equal(parsed.key, "");
  });
});

describe("json_escape — node 프로세스 실행 결과 일치 검증", () => {
  it("순수 JS 구현이 실제 node 프로세스 실행 결과와 동일해야 한다 (일반 문자열)", () => {
    const input = 'hello "world" test';
    assert.equal(jsonEscape(input), nodeJsonEscape(input));
  });

  it("순수 JS 구현이 실제 node 프로세스 실행 결과와 동일해야 한다 (특수문자)", () => {
    const input = 'line1\nline2\t"tab-quote"\\backslash';
    assert.equal(jsonEscape(input), nodeJsonEscape(input));
  });

  it("순수 JS 구현이 실제 node 프로세스 실행 결과와 동일해야 한다 (한국어)", () => {
    const input = '팀 이름: "alpha 팀"';
    assert.equal(jsonEscape(input), nodeJsonEscape(input));
  });
});
