import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { createAdaptiveInjector } from "../../hub/adaptive-inject.mjs";

const tempDirs = [];

function createFixture() {
  const dir = mkdtempSync(join(tmpdir(), "triflux-adaptive-inject-"));
  tempDirs.push(dir);
  return join(dir, "CLAUDE.md");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("hub/adaptive-inject.mjs", () => {
  it("새 CLAUDE.md에 adaptive rule 섹션을 생성하고 규칙을 주입한다", () => {
    const claudeMdPath = createFixture();
    const injector = createAdaptiveInjector({ claudeMdPath });

    const injected = injector.inject({
      id: "codex-sandbox-flag",
      rule: "Codex config.toml에 sandbox 설정이 있으면 --full-auto 금지",
      confidence: 0.95,
      occurrences: 5,
      firstSeen: "2026-04-01",
      lastSeen: "2026-04-03",
    });

    assert.equal(injected, true);
    assert.deepEqual(injector.listInjected(), [
      {
        id: "codex-sandbox-flag",
        rule: "Codex config.toml에 sandbox 설정이 있으면 --full-auto 금지",
        confidence: 0.95,
        occurrences: 5,
        firstSeen: "2026-04-01",
        lastSeen: "2026-04-03",
      },
    ]);

    const saved = readFileSync(claudeMdPath, "utf8");
    assert.match(saved, /## Adaptive Rules \(triflux auto-generated\)/u);
    assert.match(
      saved,
      /rule_id="codex-sandbox-flag" confidence=0.95 occurrences=5/u,
    );
  });

  it("동일 rule_id 재주입 시 텍스트는 유지하고 메타데이터만 갱신한다", () => {
    const claudeMdPath = createFixture();
    const injector = createAdaptiveInjector({ claudeMdPath });

    injector.inject({
      id: "codex-sandbox-flag",
      rule: "원래 규칙 텍스트",
      confidence: 0.81,
      occurrences: 3,
      firstSeen: "2026-04-01",
      lastSeen: "2026-04-02",
    });

    const injected = injector.inject({
      id: "codex-sandbox-flag",
      rule: "바뀌면 안 되는 새 텍스트",
      confidence: 0.97,
      occurrences: 7,
      firstSeen: "2026-04-04",
      lastSeen: "2026-04-04",
    });

    assert.equal(injected, true);
    assert.deepEqual(injector.listInjected(), [
      {
        id: "codex-sandbox-flag",
        rule: "원래 규칙 텍스트",
        confidence: 0.97,
        occurrences: 7,
        firstSeen: "2026-04-01",
        lastSeen: "2026-04-04",
      },
    ]);

    const saved = readFileSync(claudeMdPath, "utf8");
    assert.equal(saved.includes("바뀌면 안 되는 새 텍스트"), false);
  });

  it("remove는 마지막 규칙 제거 시 adaptive 섹션 헤더도 함께 제거한다", () => {
    const claudeMdPath = createFixture();
    const injector = createAdaptiveInjector({ claudeMdPath });

    injector.inject({
      id: "single-rule",
      rule: "단일 규칙",
      confidence: 0.9,
      occurrences: 2,
      firstSeen: "2026-04-01",
      lastSeen: "2026-04-02",
    });

    assert.equal(injector.remove("single-rule"), true);
    assert.deepEqual(injector.listInjected(), []);

    const saved = readFileSync(claudeMdPath, "utf8");
    assert.equal(
      saved.includes("## Adaptive Rules (triflux auto-generated)"),
      false,
    );
    assert.equal(saved.includes("single-rule"), false);
  });

  it("maxRules를 초과하면 confidence 낮은 규칙부터 제거하고 cleanup으로 stale rule을 정리한다", () => {
    const claudeMdPath = createFixture();
    const injector = createAdaptiveInjector({ claudeMdPath, maxRules: 2 });

    injector.inject({
      id: "high",
      rule: "high rule",
      confidence: 0.95,
      occurrences: 5,
      firstSeen: "2026-04-01",
      lastSeen: "2026-04-03",
    });
    injector.inject({
      id: "low",
      rule: "low rule",
      confidence: 0.4,
      occurrences: 2,
      firstSeen: "2026-04-01",
      lastSeen: "2026-04-03",
    });
    injector.inject({
      id: "mid",
      rule: "mid rule",
      confidence: 0.8,
      occurrences: 3,
      firstSeen: "2026-04-01",
      lastSeen: "2026-04-03",
    });

    assert.deepEqual(
      injector.listInjected().map((rule) => rule.id),
      ["high", "mid"],
    );

    assert.equal(injector.cleanup(["mid"]), 1);
    assert.deepEqual(
      injector.listInjected().map((rule) => rule.id),
      ["mid"],
    );
  });
});
