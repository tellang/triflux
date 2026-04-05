import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const {
  TFX_SECTION_HEADING,
  TFX_GLOBAL_SUMMARY_LINES,
  TFX_GLOBAL_SUMMARY_SECTION,
  extractMarkdownSection,
  ensureTfxSection,
  ensureGlobalClaudeRoutingSection,
} = await import("../../scripts/setup.mjs");

const TMP_ROOT = join(tmpdir(), "tfx-claudemd-manager-test");

function resetTmpRoot() {
  rmSync(TMP_ROOT, { recursive: true, force: true });
  mkdirSync(TMP_ROOT, { recursive: true });
}

beforeEach(resetTmpRoot);
after(() => rmSync(TMP_ROOT, { recursive: true, force: true }));

describe("claudemd-manager: section parsing", () => {
  it("프로젝트 CLAUDE.md에서 triflux 라우팅 섹션만 추출한다", () => {
    const projectContent = [
      "# triflux",
      "",
      "## 다른 섹션",
      "- keep",
      "",
      TFX_SECTION_HEADING,
      "- full rule A",
      "- full rule B",
      "",
      "## 교차 검증 규칙",
      "- review",
      "",
    ].join("\n");

    const section = extractMarkdownSection(projectContent, TFX_SECTION_HEADING);
    assert.equal(section, [TFX_SECTION_HEADING, "- full rule A", "- full rule B"].join("\n"));
  });
});

describe("claudemd-manager: ensureTfxSection", () => {
  it("전역 scope는 긴 triflux 라우팅 섹션을 요약본으로 축소한다", () => {
    const fullSection = [
      TFX_SECTION_HEADING,
      "- long 1",
      "- long 2",
      "- long 3",
      "- long 4",
      "- long 5",
      "- long 6",
    ].join("\n");
    const globalContent = ["# global", "", fullSection, "", "## other", "- keep"].join("\n");

    const result = ensureTfxSection(globalContent, { scope: "global", projectSection: fullSection });

    assert.equal(result.changed, true);
    assert.match(result.content, new RegExp(TFX_SECTION_HEADING));
    assert.match(result.content, /상세는 프로젝트 CLAUDE\.md 참조\./u);
    assert.equal(extractMarkdownSection(result.content, TFX_SECTION_HEADING), TFX_GLOBAL_SUMMARY_SECTION);
    assert.equal(TFX_GLOBAL_SUMMARY_LINES.length, 5);
  });

  it("project scope는 기존 풀 버전 섹션을 그대로 둔다", () => {
    const projectSection = [TFX_SECTION_HEADING, "- full rule A", "- full rule B"].join("\n");
    const projectContent = ["# project", "", projectSection, "", "## other", "- keep"].join("\n");

    const result = ensureTfxSection(projectContent, { scope: "project", projectSection });

    assert.equal(result.changed, false);
    assert.equal(result.content, projectContent);
    assert.equal(result.section, projectSection);
  });
});

describe("claudemd-manager: ensureGlobalClaudeRoutingSection", () => {
  it("프로젝트 풀 버전이 있으면 전역 CLAUDE.md를 요약형으로 정규화한다", () => {
    const projectClaudePath = join(TMP_ROOT, "project", "CLAUDE.md");
    const globalClaudePath = join(TMP_ROOT, "home", ".claude", "CLAUDE.md");

    mkdirSync(join(TMP_ROOT, "project"), { recursive: true });
    mkdirSync(join(TMP_ROOT, "home", ".claude"), { recursive: true });

    writeFileSync(projectClaudePath, [
      "# project",
      "",
      TFX_SECTION_HEADING,
      "- full rule A",
      "- full rule B",
      "",
      "## 교차 검증 규칙",
      "- review",
      "",
    ].join("\n"), "utf8");
    writeFileSync(globalClaudePath, [
      "# global",
      "",
      TFX_SECTION_HEADING,
      "- stale full rule",
      "- stale full rule 2",
      "",
    ].join("\n"), "utf8");

    const result = ensureGlobalClaudeRoutingSection({ globalClaudePath, projectClaudePath });

    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.ok(existsSync(globalClaudePath));
    const normalized = readFileSync(globalClaudePath, "utf8");
    assert.equal(extractMarkdownSection(normalized, TFX_SECTION_HEADING), TFX_GLOBAL_SUMMARY_SECTION);
  });
});
