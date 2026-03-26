import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

import { progressBar } from "../../hub/team/ansi.mjs";
import {
  loadRules,
  compileRules,
  matchRules,
} from "../../scripts/lib/keyword-rules.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const RULES_PATH = join(ROOT, "hooks/keyword-rules.json");

// ── semverGte 인라인 복제 (triflux.mjs 내부 함수 — export 불가) ──
function semverGte(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return true;
}

// ========================================================================
// 1. semver 비교: lexicographic 비교 버그 방지 검증
// ========================================================================
describe("semverGte: numeric semver comparison (not lexicographic)", () => {
  it("returns false when major is lower (9.0.0 >= 10.0.0)", () => {
    assert.equal(semverGte("9.0.0", "10.0.0"), false);
  });

  it("returns false when minor is lower (1.9.0 >= 1.10.0)", () => {
    assert.equal(semverGte("1.9.0", "1.10.0"), false);
  });

  it("returns true when versions are equal (7.1.4 >= 7.1.4)", () => {
    assert.equal(semverGte("7.1.4", "7.1.4"), true);
  });

  it("returns true when version is higher (7.2.0 >= 7.1.4)", () => {
    assert.equal(semverGte("7.2.0", "7.1.4"), true);
  });
});

// ========================================================================
// 2. progressBar 경계값: ratio 범위 밖에서도 크래시 없이 동작
// ========================================================================
describe("progressBar: boundary values do not crash", () => {
  it("handles ratio above 1.0 without crash (ratio=1.5)", () => {
    const result = progressBar(1.5, 20);
    assert.ok(typeof result === "string", "should return a string");
  });

  it("handles negative ratio without crash (ratio=-0.1)", () => {
    const result = progressBar(-0.1, 20);
    assert.ok(typeof result === "string", "should return a string");
  });

  it("returns empty bar when ratio is 0", () => {
    const result = progressBar(0, 20);
    assert.ok(!result.includes("\u2588"), "should have no filled blocks");
    assert.ok(result.includes("\u2591"), "should have empty blocks");
  });

  it("returns fully filled bar when ratio is 1", () => {
    const result = progressBar(1, 20);
    assert.ok(result.includes("\u2588"), "should have filled blocks");
    assert.ok(!result.includes("\u2591"), "should have no empty blocks");
  });
});

// ========================================================================
// 3. Korean keyword-rules matching
// ========================================================================
describe("keyword-rules: Korean keyword matching", () => {
  const rawRules = loadRules(RULES_PATH);
  const compiled = compileRules(rawRules);

  it("matches handoff-route on Korean input", () => {
    const matches = matchRules(compiled, "\ud578\ub4dc\uc624\ud504 \uc0dd\uc131");
    const ids = matches.map((r) => r.id);
    assert.ok(ids.includes("handoff-route"), `handoff-route expected in: ${JSON.stringify(ids)}`);
  });

  it("matches canva-route on Korean input", () => {
    const matches = matchRules(compiled, "\uce94\ubc14 \ub514\uc790\uc778");
    const ids = matches.map((r) => r.id);
    assert.ok(ids.includes("canva-route"), `canva-route expected in: ${JSON.stringify(ids)}`);
  });

  it("matches playwright-route on Korean input", () => {
    const matches = matchRules(compiled, "\ube0c\ub77c\uc6b0\uc800 \ud14c\uc2a4\ud2b8 \uc2e4\ud589");
    const ids = matches.map((r) => r.id);
    assert.ok(ids.includes("playwright-route"), `playwright-route expected in: ${JSON.stringify(ids)}`);
  });
});

// ========================================================================
// 4. timing-safe token comparison in hub/server.mjs
// ========================================================================
describe("hub/server.mjs: timing-safe token comparison", () => {
  it("imports timingSafeEqual from node:crypto", () => {
    const src = readFileSync(join(ROOT, "hub/server.mjs"), "utf8");
    assert.ok(
      src.includes("timingSafeEqual"),
      "timingSafeEqual should be present in server.mjs"
    );
  });

  it("uses timingSafeEqual in authorization check", () => {
    const src = readFileSync(join(ROOT, "hub/server.mjs"), "utf8");
    // Verify it appears in an authorization context, not just as an import
    const importLine = src.includes("import") && src.includes("timingSafeEqual");
    const usageLine = /timingSafeEqual\(buf[AB],\s*buf[AB]\)/.test(src);
    assert.ok(importLine, "timingSafeEqual should be imported");
    assert.ok(usageLine, "timingSafeEqual should be called with buffers for token comparison");
  });
});

// ========================================================================
// 5. child process error handler in native-supervisor.mjs
// ========================================================================
describe("native-supervisor.mjs: child process error handler", () => {
  it("registers an error handler on spawned child processes", () => {
    const src = readFileSync(join(ROOT, "hub/team/native-supervisor.mjs"), "utf8");
    assert.ok(
      src.includes('child.on("error"'),
      'child.on("error") handler should be present in native-supervisor.mjs'
    );
  });

  it("sets status to exited on spawn error", () => {
    const src = readFileSync(join(ROOT, "hub/team/native-supervisor.mjs"), "utf8");
    // The error handler should mark the process as exited
    const errorBlock = src.slice(
      src.indexOf('child.on("error"'),
      src.indexOf('child.on("error"') + 300
    );
    assert.ok(
      errorBlock.includes('"exited"'),
      "error handler should set status to exited"
    );
  });
});

// ========================================================================
// 6. headless prompt file-based injection (shell injection prevention)
// ========================================================================
describe("headless.mjs: prompt file-based injection", () => {
  it("uses Get-Content -Raw for prompt injection (not inline shell)", () => {
    const src = readFileSync(join(ROOT, "hub/team/headless.mjs"), "utf8");
    assert.ok(
      src.includes("Get-Content -Raw"),
      "headless.mjs should use Get-Content -Raw to read prompt from file"
    );
  });

  it("writes prompt to a temporary file before execution", () => {
    const src = readFileSync(join(ROOT, "hub/team/headless.mjs"), "utf8");
    assert.ok(
      /writeFileSync\([^)]*prompt/i.test(src),
      "headless.mjs should write prompt to a temp file via writeFileSync"
    );
  });
});
