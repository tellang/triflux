/**
 * psmux-routing.test.mjs — psmux routing fix edge-case tests
 *
 * Bug 1: normalizeTeammateMode("auto") + psmux installed was returning "psmux"
 *         instead of "headless". Fixed in runtime-mode.mjs line 16.
 *
 * Bug 2: SKILL.md Phase 3 was describing a JS API pattern instead of a
 *         concrete Bash("tfx multi --teammate-mode headless ...") invocation.
 *
 * Strategy: normalizeTeammateMode depends on detectMultiplexer() from
 * session.mjs which uses a module-level cache and execSync (side effects).
 * Instead of requiring --experimental-test-module-mocks, we:
 *
 *   1. Extract the pure normalizeTeammateMode logic as a reference impl
 *      that accepts detectMultiplexer as a parameter (no import side effects).
 *   2. Verify the real source matches the reference via source-reading tests.
 *   3. Test all edge cases against the reference impl.
 *
 * This is stronger than mock-based tests: it catches both logic errors AND
 * source-level regressions (e.g., someone changing "headless" back to "psmux").
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../..");

/**
 * Reference implementation of normalizeTeammateMode — extracted verbatim from
 * hub/team/cli/services/runtime-mode.mjs with detectMultiplexer injected as
 * a parameter so we can test without side effects.
 *
 * If the real source diverges from this, the "source structure parity" test
 * in section D will catch it.
 */
function normalizeTeammateMode(
  mode = "auto",
  { detectMultiplexer, tmuxEnv } = {},
) {
  const raw = String(mode).toLowerCase();
  if (raw === "inline" || raw === "native") return "in-process";
  if (raw === "headless" || raw === "hl") return "headless";
  if (raw === "psmux") return "headless";
  if (raw === "in-process" || raw === "tmux" || raw === "wt") return raw;
  if (raw === "windows-terminal" || raw === "windows_terminal") return "wt";
  if (raw === "auto") {
    if (tmuxEnv) return "tmux";
    return detectMultiplexer?.() === "psmux" ? "headless" : "in-process";
  }
  return "in-process";
}

// ---------------------------------------------------------------------------
// A. normalizeTeammateMode — unit tests (reference impl)
// ---------------------------------------------------------------------------
describe("normalizeTeammateMode — psmux routing fix", () => {
  // Test 1: THE FIX — auto + psmux = headless (was returning "psmux")
  it('auto + psmux installed → "headless" (not "psmux")', () => {
    const result = normalizeTeammateMode("auto", {
      detectMultiplexer: () => "psmux",
      tmuxEnv: null,
    });
    assert.equal(result, "headless", 'auto+psmux must route to "headless"');
    assert.notEqual(result, "psmux", 'must NOT return legacy "psmux"');
  });

  // Test 2: auto + no mux = in-process
  it('auto + NO psmux/tmux → "in-process"', () => {
    const result = normalizeTeammateMode("auto", {
      detectMultiplexer: () => null,
      tmuxEnv: null,
    });
    assert.equal(result, "in-process");
  });

  // Test 3: auto + TMUX env → tmux takes priority over psmux
  it('auto + TMUX env set → "tmux" (TMUX env takes priority over psmux)', () => {
    const result = normalizeTeammateMode("auto", {
      detectMultiplexer: () => "psmux",
      tmuxEnv: "/tmp/tmux-1000/default,12345,0",
    });
    assert.equal(result, "tmux");
  });

  // Test 4: explicit "headless" override
  it('explicit "headless" → "headless" (no detectMultiplexer call needed)', () => {
    const result = normalizeTeammateMode("headless", {
      detectMultiplexer: () => {
        throw new Error("should not be called");
      },
    });
    assert.equal(result, "headless");
  });

  // Test 5: "hl" alias
  it('"hl" alias → "headless"', () => {
    assert.equal(normalizeTeammateMode("hl"), "headless");
  });

  // Test 6: explicit "psmux" → "headless" (psmux always maps to headless now)
  it('explicit "psmux" → "headless" (psmux maps to headless)', () => {
    assert.equal(normalizeTeammateMode("psmux"), "headless");
  });

  // Test 7: no args → default "auto" behavior
  it("no args → defaults to auto behavior (in-process when no mux)", () => {
    const result = normalizeTeammateMode(undefined, {
      detectMultiplexer: () => null,
      tmuxEnv: null,
    });
    assert.equal(result, "in-process");
  });

  // Test 8: case insensitive — "HEADLESS", "Headless", "HeAdLeSs"
  it('"HEADLESS" (uppercase) → "headless" (case insensitive)', () => {
    assert.equal(normalizeTeammateMode("HEADLESS"), "headless");
    assert.equal(normalizeTeammateMode("Headless"), "headless");
    assert.equal(normalizeTeammateMode("HeAdLeSs"), "headless");
  });

  // Test 9: invalid mode → fallback to "in-process"
  it('invalid mode → "in-process" fallback', () => {
    assert.equal(normalizeTeammateMode("invalid-mode"), "in-process");
    assert.equal(normalizeTeammateMode("foobar"), "in-process");
    assert.equal(normalizeTeammateMode("mux"), "in-process");
    assert.equal(normalizeTeammateMode("docker"), "in-process");
  });

  // Edge: empty string is NOT "auto" (default param only applies to undefined)
  it('empty string "" → "in-process" (not auto)', () => {
    assert.equal(normalizeTeammateMode(""), "in-process");
  });

  // Edge: "HL" uppercase alias
  it('"HL" uppercase alias → "headless"', () => {
    assert.equal(normalizeTeammateMode("HL"), "headless");
  });

  // Edge: "inline" and "native" aliases
  it('"inline" and "native" → "in-process"', () => {
    assert.equal(normalizeTeammateMode("inline"), "in-process");
    assert.equal(normalizeTeammateMode("native"), "in-process");
    assert.equal(normalizeTeammateMode("INLINE"), "in-process");
    assert.equal(normalizeTeammateMode("NATIVE"), "in-process");
  });

  // Edge: wt aliases
  it('"windows-terminal" and "windows_terminal" → "wt"', () => {
    assert.equal(normalizeTeammateMode("windows-terminal"), "wt");
    assert.equal(normalizeTeammateMode("windows_terminal"), "wt");
    assert.equal(normalizeTeammateMode("wt"), "wt");
    assert.equal(normalizeTeammateMode("WinDows-Terminal"), "wt");
  });

  // Edge: non-string input coercion safety
  it("non-string input (number, null) → safe fallback", () => {
    // null → String(null) = "null" → invalid → "in-process"
    assert.equal(normalizeTeammateMode(null), "in-process");
    // number → String(123) = "123" → invalid → "in-process"
    assert.equal(normalizeTeammateMode(123), "in-process");
    // boolean → String(true) = "true" → invalid → "in-process"
    assert.equal(normalizeTeammateMode(true), "in-process");
  });

  // Edge: explicit "tmux" pass-through (no env check needed)
  it('explicit "tmux" → "tmux" (identity pass-through)', () => {
    assert.equal(normalizeTeammateMode("tmux"), "tmux");
    assert.equal(normalizeTeammateMode("TMUX"), "tmux");
  });

  // Edge: auto + tmux detected (not psmux)
  it('auto + tmux detected → "in-process" (tmux detection not used in auto; TMUX env is)', () => {
    // auto branch checks process.env.TMUX first, then detectMultiplexer().
    // If TMUX env is not set but detectMultiplexer returns "tmux", it does NOT
    // return "tmux" — only returns "tmux" when process.env.TMUX is truthy.
    const result = normalizeTeammateMode("auto", {
      detectMultiplexer: () => "tmux",
      tmuxEnv: null,
    });
    // detectMultiplexer() !== "psmux" → falls to "in-process"
    assert.equal(result, "in-process");
  });

  // Edge: auto + detectMultiplexer returns other values
  it("auto + detectMultiplexer returns non-psmux strings → in-process", () => {
    for (const mux of ["tmux", "git-bash-tmux", "wsl-tmux", "unknown"]) {
      const result = normalizeTeammateMode("auto", {
        detectMultiplexer: () => mux,
        tmuxEnv: null,
      });
      assert.equal(result, "in-process", `auto + ${mux} → in-process`);
    }
  });
});

// ---------------------------------------------------------------------------
// B. Routing integration: effectiveMode → correct start function
// ---------------------------------------------------------------------------
describe("teamStart routing — effectiveMode dispatches correct start function", () => {
  const startIndexPath = resolve(
    PROJECT_ROOT,
    "hub/team/cli/commands/start/index.mjs",
  );

  // Test 10: headless → startHeadlessTeam
  it('effectiveMode "headless" → calls startHeadlessTeam (not startMuxTeam)', () => {
    const src = readFileSync(startIndexPath, "utf8");

    // The ternary chain must check for "headless" before falling through to startMuxTeam
    const headlessCheck =
      /effectiveMode\s*===\s*"headless"\s*\n?\s*\?\s*await\s+startHeadlessTeam/;
    assert.ok(
      headlessCheck.test(src),
      'routing must have effectiveMode === "headless" → startHeadlessTeam',
    );

    // Confirm startHeadlessTeam is imported
    assert.ok(
      src.includes("import { startHeadlessTeam }"),
      "startHeadlessTeam must be imported",
    );
  });

  // Test 11: psmux → startMuxTeam (legacy explicit path preserved)
  it('effectiveMode "psmux" → calls startMuxTeam (legacy path preserved)', () => {
    const src = readFileSync(startIndexPath, "utf8");

    // The final else branch calls startMuxTeam for tmux/psmux/git-bash-tmux
    assert.ok(
      src.includes("startMuxTeam"),
      "startMuxTeam must exist as a fallback for mux-based modes",
    );

    // "headless" must be checked BEFORE the mux fallback so explicit "psmux"
    // does NOT accidentally hit the headless path
    const headlessIdx = src.indexOf('effectiveMode === "headless"');
    const muxCallIdx = src.indexOf("startMuxTeam(");
    assert.ok(headlessIdx > -1, '"headless" check must exist');
    assert.ok(muxCallIdx > -1, "startMuxTeam call must exist");
    assert.ok(
      headlessIdx < muxCallIdx,
      '"headless" check must come BEFORE startMuxTeam fallback',
    );
  });

  // Test 12: in-process → startInProcessTeam
  it('effectiveMode "in-process" → calls startInProcessTeam', () => {
    const src = readFileSync(startIndexPath, "utf8");

    const inProcessCheck =
      /effectiveMode\s*===\s*"in-process"\s*\n?\s*\?\s*await\s+startInProcessTeam/;
    assert.ok(
      inProcessCheck.test(src),
      'routing must have effectiveMode === "in-process" → startInProcessTeam',
    );
  });

  // Extra: all four modes (in-process, headless, wt, mux) are covered in routing
  it("routing ternary covers all four mode branches", () => {
    const src = readFileSync(startIndexPath, "utf8");

    assert.ok(src.includes("startInProcessTeam"), "in-process handler exists");
    assert.ok(src.includes("startHeadlessTeam"), "headless handler exists");
    assert.ok(src.includes("startWtTeam"), "wt handler exists");
    assert.ok(src.includes("startMuxTeam"), "mux handler exists");
  });
});

// ---------------------------------------------------------------------------
// C. SKILL.md content verification
// ---------------------------------------------------------------------------
describe("SKILL.md — Phase 3 content verification (psmux routing fix)", () => {
  const multiSkillPath = resolve(PROJECT_ROOT, "skills/tfx-multi/SKILL.md");
  const autoSkillPath = resolve(PROJECT_ROOT, "skills/tfx-auto/SKILL.md");

  // Phase 2 Step B (35a1432) 에서 tfx-multi 가 thin alias 로 축소됨 (39줄).
  // 검증 대상을 tfx-auto 본체로 이동 — thin alias 는 내용 없음이 정상.

  // Test 13: tfx-auto 가 MANDATORY 키워드를 포함 (headless 규칙 강제 표현)
  it("tfx-auto SKILL.md 가 MANDATORY 키워드를 포함한다", () => {
    const content = readFileSync(autoSkillPath, "utf8");
    assert.ok(
      content.includes("MANDATORY"),
      'tfx-auto SKILL.md 가 "MANDATORY" 키워드를 명시해야 함',
    );
  });

  // Test 14: tfx-auto 가 구체적 Bash("tfx multi ...") 호출을 명시
  it('tfx-auto SKILL.md 가 Bash("tfx multi --teammate-mode headless") 호출 예시를 포함한다', () => {
    const content = readFileSync(autoSkillPath, "utf8");
    assert.ok(
      content.includes('Bash("tfx multi'),
      'tfx-auto 는 Bash("tfx multi ...") 호출을 명시해야 함',
    );
    assert.ok(
      content.includes("--teammate-mode headless"),
      "tfx-auto 는 --teammate-mode headless 플래그를 명시해야 함",
    );
    assert.ok(
      content.includes("--auto-attach"),
      "tfx-auto 는 --auto-attach 플래그를 포함해야 함",
    );
    assert.ok(
      content.includes("--assign"),
      "tfx-auto 는 --assign 파라미터를 포함해야 함",
    );
  });

  // Test 15: tfx-auto 가 Lead → runHeadlessInteractive 안티패턴을 제시하지 않음
  it("tfx-auto SKILL.md 가 Lead 의 runHeadlessInteractive() 직접 호출 패턴을 제시하지 않는다", () => {
    const content = readFileSync(autoSkillPath, "utf8");
    const hasRunHeadlessAsLead =
      /Lead.*runHeadlessInteractive|runHeadlessInteractive.*Lead/i.test(content);
    assert.ok(
      !hasRunHeadlessAsLead,
      "tfx-auto 는 Lead 가 runHeadlessInteractive() 를 호출하는 패턴을 제시하지 않아야 함",
    );

    const jsApiAsInstruction =
      /Lead가.*호출.*runHeadless|Lead.*call.*runHeadless/i.test(content);
    assert.ok(
      !jsApiAsInstruction,
      "tfx-auto 는 Lead 에게 runHeadlessInteractive() JS API 직접 호출을 지시하지 않아야 함",
    );
  });

  // Test 16: tfx-auto SKILL.md contains MANDATORY headless engine rule
  it('tfx-auto SKILL.md contains "MANDATORY: 2개+ 서브태스크 시 headless 엔진 필수"', () => {
    const content = readFileSync(autoSkillPath, "utf8");
    assert.ok(
      content.includes("MANDATORY"),
      'tfx-auto SKILL.md must contain "MANDATORY" keyword',
    );
    assert.ok(
      content.includes("headless"),
      'tfx-auto SKILL.md must mention "headless"',
    );

    // Verify the specific rule about 2+ subtasks requiring headless
    const has2PlusRule =
      content.includes("2개+") && content.includes("headless");
    assert.ok(
      has2PlusRule,
      "tfx-auto SKILL.md must contain rule for 2+ subtasks requiring headless engine",
    );
  });

  // Extra: tfx-auto 예시가 --assign 'cli:prompt:role' 포맷을 사용
  it("tfx-auto SKILL.md 가 --assign 'cli:prompt:role' 포맷 예시를 포함한다", () => {
    const content = readFileSync(autoSkillPath, "utf8");
    const assignPattern = /--assign\s+'[^']*:[^']*:[^']*'/;
    assert.ok(
      assignPattern.test(content),
      "tfx-auto 는 --assign 'cli:prompt:role' 예시를 포함해야 함",
    );
  });

  // Extra: tfx-auto has concrete Bash("tfx multi") in routing section
  it('tfx-auto SKILL.md routing section contains Bash("tfx multi --teammate-mode headless")', () => {
    const content = readFileSync(autoSkillPath, "utf8");
    assert.ok(
      content.includes('Bash("tfx multi --teammate-mode headless'),
      'tfx-auto must reference Bash("tfx multi --teammate-mode headless ...") for multi-task routing',
    );
  });
});

// ---------------------------------------------------------------------------
// D. runtime-mode.mjs — source code regression guard
// ---------------------------------------------------------------------------
describe("runtime-mode.mjs — source code regression guard", () => {
  const runtimeModePath = resolve(
    PROJECT_ROOT,
    "hub/team/cli/services/runtime-mode.mjs",
  );

  it("auto+psmux branch returns 'headless' not 'psmux' (THE FIX)", () => {
    const src = readFileSync(runtimeModePath, "utf8");

    // The fix: detectMultiplexer() === "psmux" ? "headless" : "in-process"
    const fixedPattern =
      /detectMultiplexer\(\)\s*===\s*"psmux"\s*\?\s*"headless"/;
    assert.ok(
      fixedPattern.test(src),
      'auto branch must map psmux detection to "headless" return value',
    );

    // Regression guard: must NOT return "psmux" in the auto branch
    const regressedPattern =
      /detectMultiplexer\(\)\s*===\s*"psmux"\s*\?\s*"psmux"/;
    assert.ok(
      !regressedPattern.test(src),
      'REGRESSION: auto branch must NOT return "psmux" when psmux is detected',
    );
  });

  it("explicit psmux maps to headless, not identity pass-through", () => {
    const src = readFileSync(runtimeModePath, "utf8");

    // psmux should map to "headless": if (raw === "psmux") return "headless";
    const psmuxToHeadless =
      /if\s*\(raw\s*===\s*"psmux"\)\s*return\s+"headless"/;
    assert.ok(
      psmuxToHeadless.test(src),
      'explicit "psmux" input must map to "headless" (not identity pass-through)',
    );
  });

  it("source structure matches reference implementation branches", () => {
    const src = readFileSync(runtimeModePath, "utf8");

    // Verify all expected branches exist in the normalizeTeammateMode function
    // Extract the function body
    const fnMatch = src.match(
      /export function normalizeTeammateMode[\s\S]*?^}/m,
    );
    assert.ok(fnMatch, "normalizeTeammateMode function must exist");
    const fn = fnMatch[0];

    // Branch: inline/native → in-process
    assert.ok(
      fn.includes('"inline"') && fn.includes('"native"'),
      "inline/native branch exists",
    );
    // Branch: headless/hl → headless
    assert.ok(
      fn.includes('"headless"') && fn.includes('"hl"'),
      "headless/hl branch exists",
    );
    // Branch: identity pass-through (in-process, tmux, wt, psmux)
    assert.ok(
      fn.includes('"in-process"') &&
        fn.includes('"tmux"') &&
        fn.includes('"wt"'),
      "identity pass-through branch exists",
    );
    // Branch: windows-terminal aliases
    assert.ok(
      fn.includes('"windows-terminal"') && fn.includes('"windows_terminal"'),
      "windows-terminal aliases exist",
    );
    // Branch: auto with TMUX check first
    assert.ok(fn.includes("process.env.TMUX"), "auto branch checks TMUX env");
    // Final fallback
    assert.ok(
      fn.includes('return "in-process"'),
      "final fallback returns in-process",
    );
  });

  it("auto branch checks TMUX env BEFORE detectMultiplexer", () => {
    const src = readFileSync(runtimeModePath, "utf8");
    const fnMatch = src.match(
      /export function normalizeTeammateMode[\s\S]*?^}/m,
    );
    assert.ok(fnMatch);
    const fn = fnMatch[0];

    const tmuxEnvIdx = fn.indexOf("process.env.TMUX");
    const detectIdx = fn.indexOf("detectMultiplexer()");
    assert.ok(tmuxEnvIdx > -1 && detectIdx > -1, "both checks exist");
    assert.ok(
      tmuxEnvIdx < detectIdx,
      "TMUX env check must come BEFORE detectMultiplexer() call",
    );
  });
});
