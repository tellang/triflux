// tests/integration/claudemd-sync-injection.test.mjs
// Issue #113 — CLAUDE.md 자동 주입 차단 회귀 가드.
//
// Phase 2 Step A 부터 라우팅 source of truth 는 `.claude/rules/tfx-routing.md` 다.
// setup.runDeferred → syncClaudeRoutingSections 경로가 CLAUDE.md 에 재주입하면 안 된다.
// 테스트는 실제 플러그인 루트 (PLUGIN_ROOT) 의 CLAUDE.md 가 테스트 실행 전후로
// 바이트 단위 동일해야 함을 보장한다.

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { ensureTfxSection } from "../../scripts/claudemd-sync.mjs";

// tests/integration/ 에서 PLUGIN_ROOT 까지 2단계 상위.
const PLUGIN_ROOT = dirname(
  dirname(dirname(fileURLToPath(new URL(import.meta.url)))),
);
const PLUGIN_CLAUDE_MD = join(PLUGIN_ROOT, "CLAUDE.md");

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
  it("setup.runDeferred 가 PLUGIN_ROOT CLAUDE.md 를 건드리지 않아야 한다", async () => {
    // PLUGIN_ROOT 에는 이미 `.claude/rules/tfx-routing.md` 가 존재한다.
    // 따라서 setup.runDeferred 전체 경로를 실행해도 CLAUDE.md 는 바이트 동일해야 한다.
    const before = readFileSync(PLUGIN_CLAUDE_MD, "utf8");

    const setup = await import("../../scripts/setup.mjs");
    await setup.runDeferred({ argv: ["--force"] });

    const after = readFileSync(PLUGIN_CLAUDE_MD, "utf8");
    assert.equal(
      after,
      before,
      "runDeferred 가 PLUGIN_ROOT/CLAUDE.md 를 수정하면 안 된다 (#113)",
    );
  });

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
