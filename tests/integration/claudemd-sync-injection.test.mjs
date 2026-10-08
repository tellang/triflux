// tests/integration/claudemd-sync-injection.test.mjs
// Issue #113 — CLAUDE.md 자동 주입 차단 회귀 가드.
//
// Phase 2 Step A 부터 라우팅 source of truth 는 `.claude/rules/tfx-routing.md` 다.
// setup 은 더 이상 CLAUDE.md 를 동기화하지 않아, 실제 홈에 쓰던 runDeferred 전체 실행 케이스는
// 지우고(#529) ensureTfxSection 의 skip 과 정리 동작만 검사한다.

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

import { ensureTfxSection } from "../../scripts/claudemd-sync.mjs";

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

describe("#113 — CLAUDE.md 자동 주입 회귀 가드", () => {
  it("인접 .claude/rules/tfx-routing.md 존재 시 ensureTfxSection 은 injection 을 skip 한다", () => {
    const root = makeTempDir("triflux-113-skip-");
    const target = join(root, "CLAUDE.md");
    mkdirSync(join(root, ".claude", "rules"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "rules", "tfx-routing.md"),
      "# routing source of truth\n",
      "utf8",
    );
    const original = "# Project\n\n## Notes\n- keep me\n";
    writeFileSync(target, original, "utf8");

    const routingTable = "<routing>\n74줄 블록\n</routing>";
    const result = ensureTfxSection(target, routingTable);

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "rules_file_source_of_truth");
    assert.equal(
      readFileSync(target, "utf8"),
      original,
      "rules 파일이 있으면 CLAUDE.md 는 변경되지 않아야 한다",
    );
  });

  it("인접 rules 파일 + inline <routing> 블록이 모두 있으면 블록을 제거한다", () => {
    const root = makeTempDir("triflux-113-cleanup-");
    const target = join(root, "CLAUDE.md");
    mkdirSync(join(root, ".claude", "rules"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "rules", "tfx-routing.md"),
      "# routing source of truth\n",
      "utf8",
    );
    writeFileSync(
      target,
      "# Project\n\n<routing>\nstale body\n</routing>\n\n## Preserve\n- keep\n",
      "utf8",
    );

    const result = ensureTfxSection(target, "<routing>new</routing>");

    assert.equal(result.action, "removed");
    const saved = readFileSync(target, "utf8");
    assert.equal(saved.includes("<routing>"), false);
    assert.equal(saved.includes("## Preserve"), true);
  });
});
