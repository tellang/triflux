import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  autoFixSlop,
  detectSlop,
  scanDirectory,
} from "../../hub/quality/deslop.mjs";

// ── detectSlop 패턴 탐지 ──────────────────────────────────

describe("detectSlop — slop 패턴 탐지", () => {
  it('trivial_comment 탐지: "// Import module"', () => {
    const code = "// Import module\nconst x = 1;";
    const { issues } = detectSlop(code);
    const found = issues.find((i) => i.type === "trivial_comment");
    assert.ok(found, "trivial_comment 이슈가 감지되어야 한다");
    assert.equal(found.line, 1);
    assert.equal(found.severity, "low");
  });

  it("empty_catch 탐지", () => {
    const code = "try {\n  doSomething();\n} catch (e) {\n}";
    const { issues } = detectSlop(code);
    const found = issues.find((i) => i.type === "empty_catch");
    assert.ok(found, "empty_catch 이슈가 감지되어야 한다");
    assert.equal(found.severity, "med");
  });

  it("console.log 탐지", () => {
    const code = 'const x = 1;\nconsole.log("debug value:", x);';
    const { issues } = detectSlop(code);
    const found = issues.find((i) => i.type === "console_debug");
    assert.ok(found, "console_debug 이슈가 감지되어야 한다");
    assert.equal(found.line, 2);
  });

  it("useless_jsdoc 탐지", () => {
    const code = "/**\n *\n */\nfunction foo() {}";
    const { issues } = detectSlop(code);
    const found = issues.find((i) => i.type === "useless_jsdoc");
    assert.ok(found, "useless_jsdoc 이슈가 감지되어야 한다");
    assert.equal(found.line, 1);
  });

  it("rethrow_only 탐지", () => {
    const code = "try {\n  doSomething();\n} catch (e) {\n  throw e;\n}";
    const { issues } = detectSlop(code);
    const found = issues.find((i) => i.type === "rethrow_only");
    assert.ok(found, "rethrow_only 이슈가 감지되어야 한다");
    assert.equal(found.severity, "med");
  });

  it("정상 코드에서 false positive 없음", () => {
    const code = [
      "// Important: this validates the auth token before proceeding",
      "function authenticate(token) {",
      "  try {",
      "    const decoded = verify(token);",
      "    return decoded;",
      "  } catch (err) {",
      '    logger.error("Auth failed:", err);',
      "    return null;",
      "  }",
      "}",
    ].join("\n");
    const { issues, score } = detectSlop(code);
    assert.equal(
      issues.length,
      0,
      `false positive 발생: ${JSON.stringify(issues)}`,
    );
    assert.equal(score, 100);
  });
});

// ── autoFixSlop 자동 수정 ─────────────────────────────────

describe("autoFixSlop — 자동 수정", () => {
  it("trivial_comment 제거", () => {
    const code =
      "// Import the module\nconst x = 1;\n// Define variable\nconst y = 2;";
    const { issues } = detectSlop(code);
    const { fixed, applied } = autoFixSlop(code, issues);
    assert.ok(applied > 0, `applied=${applied}, 최소 1개 수정 필요`);
    assert.ok(
      !fixed.includes("// Import the module"),
      "trivial_comment 제거됨",
    );
    assert.ok(!fixed.includes("// Define variable"), "trivial_comment 제거됨");
    assert.ok(fixed.includes("const x = 1;"), "정상 코드 유지");
    assert.ok(fixed.includes("const y = 2;"), "정상 코드 유지");
  });

  it("안전하지 않은 패턴은 skipped", () => {
    const code = "try {\n  doSomething();\n} catch (e) {\n}";
    const { issues } = detectSlop(code);
    assert.ok(issues.length > 0, "이슈가 감지되어야 한다");
    const { applied, skipped } = autoFixSlop(code, issues);
    assert.ok(skipped > 0, "empty_catch는 unsafe → skipped");
    assert.equal(applied, 0, "unsafe 패턴만 있으면 수정 0건");
  });

  it("useless_jsdoc 자동 제거", () => {
    const code = "/**\n *\n */\nfunction foo() {}";
    const { issues } = detectSlop(code);
    const { fixed, applied } = autoFixSlop(code, issues);
    assert.ok(applied > 0);
    assert.ok(!fixed.includes("/**"), "useless_jsdoc 블록 제거됨");
    assert.ok(fixed.includes("function foo() {}"), "함수 유지");
  });
});

// ── scanDirectory 디렉토리 스캔 ───────────────────────────

describe("scanDirectory — 디렉토리 스캔", () => {
  const tmpDir = join(tmpdir(), "deslop-test-" + Date.now());

  before(async () => {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      join(tmpDir, "clean.mjs"),
      "const x = 1;\nexport default x;\n",
    );
    await writeFile(
      join(tmpDir, "dirty.mjs"),
      '// Import module\nconsole.log("debug");\n',
    );
    await writeFile(
      join(tmpDir, "ignored.txt"),
      '// Import nothing\nconsole.log("ignored");\n',
    );
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("glob 필터링: include 패턴에 맞는 파일만 스캔", async () => {
    const result = await scanDirectory(tmpDir, {
      include: ["**/*.mjs"],
      exclude: [],
    });
    assert.equal(result.files.length, 2, ".mjs 파일 2개만 스캔");
    assert.ok(result.files.every((f) => f.path.endsWith(".mjs")));
    assert.ok(result.summary.totalFiles === 2);
    assert.ok(result.summary.totalIssues > 0, "dirty.mjs에서 이슈 발견");
  });
});

// ── score 계산 ────────────────────────────────────────────

describe("score 계산", () => {
  it("issue 없으면 100", () => {
    const { score } = detectSlop("const x = 1;\n");
    assert.equal(score, 100);
  });

  it("issue 비례 감소", () => {
    const { score: cleanScore } = detectSlop("const x = 1;\n");
    const { score: dirtyScore } = detectSlop(
      'console.log("a");\nconsole.log("b");\n',
    );
    assert.ok(
      dirtyScore < cleanScore,
      `dirty(${dirtyScore}) < clean(${cleanScore})`,
    );
    assert.ok(dirtyScore >= 0, "score >= 0");
  });
});
