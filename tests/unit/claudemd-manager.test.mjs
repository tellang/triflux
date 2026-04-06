import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const {
  ensureTfxSection,
  ensureGlobalClaudeRoutingSection,
} = await import("../../scripts/claudemd-sync.mjs");

const TMP_ROOT = join(tmpdir(), "tfx-claudemd-manager-test");

function resetTmpRoot() {
  rmSync(TMP_ROOT, { recursive: true, force: true });
  mkdirSync(TMP_ROOT, { recursive: true });
}

beforeEach(resetTmpRoot);
after(() => rmSync(TMP_ROOT, { recursive: true, force: true }));

describe("claudemd-manager: ensureTfxSection", () => {
  it("기존 라우팅 섹션이 없는 파일에 라우팅을 추가한다", () => {
    const claudeMdPath = join(TMP_ROOT, "CLAUDE.md");
    writeFileSync(claudeMdPath, "# project\n\n## other\n- keep\n", "utf8");

    const routingTable = "<routing>\n## triflux CLI 라우팅\n- rule A\n</routing>";
    const result = ensureTfxSection(claudeMdPath, routingTable);

    assert.equal(result.action, "created");
    const content = readFileSync(claudeMdPath, "utf8");
    assert.match(content, /<routing>/);
    assert.match(content, /rule A/);
    assert.match(content, /## other/);
  });

  it("기존 라우팅 섹션을 새 버전으로 업데이트한다", () => {
    const claudeMdPath = join(TMP_ROOT, "CLAUDE.md");
    writeFileSync(claudeMdPath, [
      "# project",
      "",
      "<routing>",
      "- old rule",
      "</routing>",
      "",
      "## other",
      "- keep",
      "",
    ].join("\n"), "utf8");

    const routingTable = "<routing>\n- new rule\n</routing>";
    const result = ensureTfxSection(claudeMdPath, routingTable);

    assert.equal(result.action, "updated");
    const content = readFileSync(claudeMdPath, "utf8");
    assert.match(content, /new rule/);
    assert.doesNotMatch(content, /old rule/);
    assert.match(content, /## other/);
  });

  it("동일한 라우팅이면 unchanged를 반환한다", () => {
    const routing = "<routing>\n- rule A\n</routing>\n";
    const claudeMdPath = join(TMP_ROOT, "CLAUDE.md");
    writeFileSync(claudeMdPath, `# project\n\n${routing}\n## other\n`, "utf8");

    const result = ensureTfxSection(claudeMdPath, routing.trim());

    assert.equal(result.action, "unchanged");
  });

  it("파일이 없으면 skipped를 반환한다", () => {
    const result = ensureTfxSection(join(TMP_ROOT, "missing.md"), "<routing></routing>");

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "missing_file");
  });
});

describe("claudemd-manager: ensureGlobalClaudeRoutingSection", () => {
  it("글로벌 CLAUDE.md가 없으면 skipped를 반환한다", () => {
    const claudeDir = join(TMP_ROOT, "home", ".claude");
    mkdirSync(claudeDir, { recursive: true });
    // CLAUDE.md가 없는 디렉토리
    const result = ensureGlobalClaudeRoutingSection(claudeDir);

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "missing_file");
  });
});
