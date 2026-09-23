// tests/unit/skill-template.test.mjs — skill-template.mjs 단위 테스트
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseFrontmatter } from "../../scripts/lib/skill-template.mjs";

// ── parseFrontmatter ──

describe("parseFrontmatter", () => {
  it("frontmatter 블록을 파싱하고 body를 분리한다", () => {
    const source = [
      "---",
      "name: tfx-auto",
      "description: orchestrator",
      "---",
      "# Title",
      "Body content here.",
    ].join("\n");

    const { data, body } = parseFrontmatter(source);
    assert.equal(data.name, "tfx-auto");
    assert.equal(data.description, "orchestrator");
    assert.ok(body.includes("# Title"));
    assert.ok(body.includes("Body content here."));
    assert.ok(!body.includes("---"));
  });

  it("frontmatter가 없으면 data={}, body=원본을 반환한다", () => {
    const source = "# No frontmatter\nJust content.";
    const { data, body } = parseFrontmatter(source);
    assert.deepEqual(data, {});
    assert.equal(body, source);
  });

  it("빈 frontmatter 블록을 처리한다", () => {
    const source = "---\n---\nContent after empty frontmatter.";
    const { data, body } = parseFrontmatter(source);
    assert.deepEqual(data, {});
    assert.ok(body.includes("Content after empty frontmatter."));
  });

  it("quoted 문자열 값을 언래핑한다", () => {
    const source = "---\nname: \"tfx-find\"\ntag: 'single'\n---\nbody";
    const { data } = parseFrontmatter(source);
    assert.equal(data.name, "tfx-find");
    assert.equal(data.tag, "single");
  });

  it("boolean 값을 파싱한다", () => {
    const source = "---\ndeep: true\nenabled: false\n---\nbody";
    const { data } = parseFrontmatter(source);
    assert.equal(data.deep, true);
    assert.equal(data.enabled, false);
  });

  it("list 값을 배열로 파싱한다", () => {
    const source = [
      "---",
      "triggers:",
      "  - 코드 검색",
      "  - find in code",
      "---",
      "body",
    ].join("\n");

    const { data } = parseFrontmatter(source);
    assert.deepEqual(data.triggers, ["코드 검색", "find in code"]);
  });

  it("multiline fold (>) 값을 한 줄로 합친다", () => {
    const source = [
      "---",
      "description: >",
      "  first line",
      "  second line",
      "---",
      "body",
    ].join("\n");

    const { data } = parseFrontmatter(source);
    assert.equal(data.description, "first line second line");
  });

  it("multiline literal (|) 값을 줄바꿈으로 유지한다", () => {
    const source = [
      "---",
      "notes: |",
      "  line one",
      "  line two",
      "---",
      "body",
    ].join("\n");

    const { data } = parseFrontmatter(source);
    assert.equal(data.notes, "line one\nline two");
  });
});

describe("edge cases — PRD lake4d 잔여", () => {
  it("frontmatter 중복 키는 마지막 값이 우선한다", () => {
    const src = "---\nname: first\nname: second\n---\nbody";
    const { data, body } = parseFrontmatter(src);
    assert.equal(data.name, "second");
    assert.equal(body, "body");
  });
});
