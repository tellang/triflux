import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  ensureGlobalClaudeRoutingSection,
  ensureTfxSection,
  getLatestRoutingTable,
} from "../../scripts/claudemd-sync.mjs";

const tempDirs = [];

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("getLatestRoutingTable()", () => {
  it("현재 프로젝트 CLAUDE.md의 triflux 라우팅 섹션을 반환한다", () => {
    const routingTable = getLatestRoutingTable();

    // XML 태그 또는 legacy heading 둘 다 허용
    const hasXmlTag = routingTable.startsWith("<routing>");
    const hasLegacyHeading = routingTable.startsWith("## triflux CLI 라우팅");
    assert.equal(
      hasXmlTag || hasLegacyHeading,
      true,
      `routing starts with <routing> or ## heading`,
    );
    assert.equal(
      routingTable.includes("Layer 1") || routingTable.includes("CLI 라우팅"),
      true,
    );
  });
});

describe("ensureTfxSection()", () => {
  it("섹션이 없으면 파일 끝에 새 라우팅 섹션을 삽입한다", () => {
    const root = makeTempDir("triflux-claudemd-sync-create-");
    const target = join(root, "CLAUDE.md");
    const routingTable = getLatestRoutingTable();
    writeFileSync(target, "# Intro\n\n## Existing\n- keep\n", "utf8");

    const result = ensureTfxSection(target, routingTable);
    const saved = readFileSync(target, "utf8");

    assert.deepEqual(result, { action: "created", path: target });
    assert.equal(saved, `# Intro\n\n## Existing\n- keep\n\n${routingTable}\n`);
  });

  it("기존 triflux 섹션만 최신 내용으로 교체하고 다른 섹션은 유지한다", () => {
    const root = makeTempDir("triflux-claudemd-sync-update-");
    const target = join(root, "CLAUDE.md");
    const routingTable = getLatestRoutingTable();
    writeFileSync(
      target,
      [
        "# Intro",
        "",
        "## triflux CLI 라우팅",
        "",
        "legacy-body",
        "",
        "### nested",
        "- keep-inside-old-section",
        "",
        "## Preserve",
        "- untouched",
      ].join("\n"),
      "utf8",
    );

    const result = ensureTfxSection(target, routingTable);
    const saved = readFileSync(target, "utf8");

    assert.deepEqual(result, { action: "updated", path: target });
    assert.equal(saved, `# Intro\n\n${routingTable}\n## Preserve\n- untouched`);
  });

  it("이미 최신 섹션이면 파일을 변경하지 않는다", () => {
    const root = makeTempDir("triflux-claudemd-sync-unchanged-");
    const target = join(root, "CLAUDE.md");
    const routingTable = getLatestRoutingTable();
    const original = `# Intro\n\n${routingTable}\n## Preserve\n- untouched`;
    writeFileSync(target, original, "utf8");

    const result = ensureTfxSection(target, routingTable);
    const saved = readFileSync(target, "utf8");

    assert.deepEqual(result, { action: "unchanged", path: target });
    assert.equal(saved, original);
  });

  it("대상 파일이 없으면 생성하지 않고 skip 처리한다", () => {
    const root = makeTempDir("triflux-claudemd-sync-missing-");
    const target = join(root, "missing.md");

    const result = ensureTfxSection(target, getLatestRoutingTable());

    assert.deepEqual(result, {
      action: "unchanged",
      path: target,
      skipped: true,
      reason: "missing_file",
    });
  });

  it("인접 .claude/rules/tfx-routing.md 가 있으면 injection 을 skip 한다 (#113)", () => {
    const root = makeTempDir("triflux-claudemd-sync-rules-guard-");
    const target = join(root, "CLAUDE.md");
    mkdirSync(join(root, ".claude", "rules"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "rules", "tfx-routing.md"),
      "# routing rules\n",
      "utf8",
    );
    writeFileSync(target, "# Intro\n\n## Existing\n- keep\n", "utf8");

    const result = ensureTfxSection(target, getLatestRoutingTable());
    const saved = readFileSync(target, "utf8");

    assert.deepEqual(result, {
      action: "unchanged",
      path: target,
      skipped: true,
      reason: "rules_file_source_of_truth",
    });
    assert.equal(saved, "# Intro\n\n## Existing\n- keep\n");
  });

  it("rules 파일이 있으면 기존 inline <routing> 블록을 제거한다 (#113)", () => {
    const root = makeTempDir("triflux-claudemd-sync-rules-cleanup-");
    const target = join(root, "CLAUDE.md");
    mkdirSync(join(root, ".claude", "rules"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "rules", "tfx-routing.md"),
      "# routing rules\n",
      "utf8",
    );
    const withInline = `# Intro\n\n<routing>\nstale body\n</routing>\n\n## Preserve\n- untouched\n`;
    writeFileSync(target, withInline, "utf8");

    const result = ensureTfxSection(target, getLatestRoutingTable());
    const saved = readFileSync(target, "utf8");

    assert.deepEqual(result, { action: "removed", path: target });
    assert.equal(saved.includes("<routing>"), false);
    assert.equal(saved.includes("## Preserve"), true);
  });
});

describe("ensureGlobalClaudeRoutingSection()", () => {
  it("global routing sync가 비활성화되어 항상 skipped를 반환한다", () => {
    const root = makeTempDir("triflux-claudemd-sync-global-");
    const claudeDir = join(root, ".claude");
    const globalClaudeMdPath = join(claudeDir, "CLAUDE.md");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(globalClaudeMdPath, "# Global\n\n## Notes\n- keep\n", "utf8");

    const result = ensureGlobalClaudeRoutingSection(claudeDir);
    const saved = readFileSync(globalClaudeMdPath, "utf8");

    assert.deepEqual(result, {
      action: "unchanged",
      path: globalClaudeMdPath,
      skipped: true,
      reason: "global_sync_disabled",
    });
    assert.equal(
      saved,
      "# Global\n\n## Notes\n- keep\n",
      "파일이 수정되지 않아야 한다",
    );
  });

  it("글로벌 CLAUDE.md가 없어도 skipped를 반환한다", () => {
    const root = makeTempDir("triflux-claudemd-sync-global-missing-");
    const claudeDir = join(root, ".claude");
    mkdirSync(claudeDir, { recursive: true });

    const result = ensureGlobalClaudeRoutingSection(claudeDir);

    assert.deepEqual(result, {
      action: "unchanged",
      path: join(claudeDir, "CLAUDE.md"),
      skipped: true,
      reason: "global_sync_disabled",
    });
  });
});
