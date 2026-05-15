// tests/unit/multiplexer-resolution.test.mjs
//
// hub/team/psmux.mjs 의 PSMUX_BIN resolution 이 OS 별 primary multiplexer 로
// 명시 분기되는지 (silent fallback 아님) 검증. mac/Linux 의 codex worker 가
// tmux 환경에서 silent fallback path 로 흘러가던 회귀 가드.
//
// 그리고 execution-mode.mjs 의 dead buildCommandForMode 가 제거됐는지 가드.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const ROOT = pathFromHere("../..");

function pathFromHere(rel) {
  const here = new URL(import.meta.url).pathname;
  const dir = here.substring(0, here.lastIndexOf("/"));
  return join(dir, rel);
}

describe("psmux.mjs: OS primary multiplexer 명시 분기", () => {
  const src = readFileSync(join(ROOT, "hub/team/psmux.mjs"), "utf8");

  it("Windows primary 로 psmux 를 명시 분기한다", () => {
    assert.ok(
      /if \(IS_WINDOWS\)\s*\{[\s\S]*?"psmux"/.test(src),
      "Windows 분기 안에서 psmux primary 결정이 있어야 함",
    );
  });

  it("mac/Linux primary 로 tmux 를 명시 분기한다 (silent fallback 아님)", () => {
    assert.ok(
      /mac\/Linux primary: tmux/.test(src),
      "tmux 는 mac/Linux primary 로 명시되어야 함 (fallback 표현 금지)",
    );
    assert.ok(
      !/silent fallback/i.test(src) ||
        /silent fallback 은 두지 않는다/.test(src),
      "silent fallback 패턴이 도입되면 안 됨 (의도 명시화 정책)",
    );
  });

  it("hasMultiplexer 와 hasPsmux 가 둘 다 export 된다 (alias)", async () => {
    const mod = await import("../../hub/team/psmux.mjs");
    assert.equal(typeof mod.hasMultiplexer, "function");
    assert.equal(typeof mod.hasPsmux, "function");
    assert.equal(
      mod.hasPsmux,
      mod.hasMultiplexer,
      "hasPsmux 는 hasMultiplexer 의 alias 여야 함",
    );
  });

  it("getMultiplexerType 가 export 되어 primary type 을 반환한다", async () => {
    const mod = await import("../../hub/team/psmux.mjs");
    assert.equal(typeof mod.getMultiplexerType, "function");
    const type = mod.getMultiplexerType();
    assert.ok(
      typeof type === "string" && type.length > 0,
      `getMultiplexerType() 는 non-empty string 을 반환해야 함, got: ${type}`,
    );
  });

  it("isTmuxFallback 은 더 이상 export 안 됨 (의미 부정확)", async () => {
    const mod = await import("../../hub/team/psmux.mjs");
    assert.equal(
      mod.isTmuxFallback,
      undefined,
      "isTmuxFallback 은 제거됐어야 함 — getMultiplexerType 로 대체",
    );
  });
});

describe("execution-mode.mjs: dead buildCommandForMode 제거", () => {
  it("buildCommandForMode 는 더 이상 export 안 됨 (PR #252 stdin redirect 와 정합 안 됨)", async () => {
    const mod = await import("../../hub/team/execution-mode.mjs");
    assert.equal(
      mod.buildCommandForMode,
      undefined,
      "buildCommandForMode 는 caller 없는 dead code 였고 argv-inline + -s flag 가 PR #252 와 충돌해서 제거됨",
    );
  });

  it("buildSpawnSpecForMode 는 유지된다 (conductor.mjs:544 의 활성 caller)", async () => {
    const mod = await import("../../hub/team/execution-mode.mjs");
    assert.equal(typeof mod.buildSpawnSpecForMode, "function");
  });
});
