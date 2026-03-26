// tests/unit/high-fixes.test.mjs — HIGH 수정사항 regression guard
// 소스 파일 읽기 기반 + 런타임 검증 혼합 패턴

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");

// ========================================================================
// 1. staleState: isPidAlive handles EPERM gracefully
// ========================================================================
describe("process-utils: isPidAlive EPERM 처리", () => {
  const src = readFileSync(join(ROOT, "hub/lib/process-utils.mjs"), "utf8");

  it("isPidAlive 함수 내에 EPERM 문자열이 존재해야 함", () => {
    // isPidAlive 함수 블록 추출
    const funcMatch = src.match(/function isPidAlive[\s\S]*?^}/m);
    assert.ok(funcMatch, "isPidAlive 함수가 소스에 존재해야 함");
    assert.ok(
      funcMatch[0].includes("EPERM"),
      `isPidAlive 함수 내에 EPERM 처리가 있어야 함:\n${funcMatch[0]}`,
    );
  });

  it("EPERM일 때 true를 반환해야 함 (프로세스 존재하지만 권한 없음)", () => {
    const funcMatch = src.match(/function isPidAlive[\s\S]*?^}/m);
    // EPERM 분기에서 return true 패턴 확인
    assert.ok(
      /EPERM[^}]*return\s+true/s.test(funcMatch[0]),
      "EPERM 분기에서 return true가 있어야 함",
    );
  });
});

// ========================================================================
// 2. server: 에러 메시지 미노출 (bridge catch 블록)
// ========================================================================
describe("server: bridge catch 블록 에러 메시지 미노출", () => {
  const src = readFileSync(join(ROOT, "hub/server.mjs"), "utf8");

  it("writeJson에 error.message가 직접 전달되지 않아야 함", () => {
    // writeJson 호출에서 error.message를 직접 전달하는 패턴이 없어야 함
    const dangerousPattern = /writeJson\([^)]*error\.message/;
    assert.ok(
      !dangerousPattern.test(src),
      "writeJson에 error.message가 직접 전달되면 안 됨 (정보 노출 위험)",
    );
  });

  it("bridge catch 블록에서 고정 에러 메시지를 사용해야 함", () => {
    // catch 블록 내 writeJson 호출이 'Internal server error' 고정 문자열 사용
    assert.ok(
      src.includes("'Internal server error'"),
      "고정 에러 메시지 'Internal server error'가 존재해야 함",
    );
  });
});

// ========================================================================
// 3. server: 보안 헤더 X-Content-Type-Options
// ========================================================================
describe("server: 보안 헤더 존재 검증", () => {
  const src = readFileSync(join(ROOT, "hub/server.mjs"), "utf8");

  it("X-Content-Type-Options 헤더가 설정되어야 함", () => {
    assert.ok(
      src.includes("X-Content-Type-Options"),
      "X-Content-Type-Options 헤더가 server.mjs에 존재해야 함",
    );
  });

  it("X-Content-Type-Options 값이 nosniff여야 함", () => {
    assert.ok(
      src.includes("nosniff"),
      "X-Content-Type-Options 값이 'nosniff'여야 함",
    );
  });

  it("X-Frame-Options 헤더도 설정되어야 함", () => {
    assert.ok(
      src.includes("X-Frame-Options"),
      "X-Frame-Options 헤더가 server.mjs에 존재해야 함",
    );
  });
});

// ========================================================================
// 4. plugin.json 버전 동기화
// ========================================================================
describe("plugin.json 버전 동기화", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const plugin = JSON.parse(
    readFileSync(join(ROOT, ".claude-plugin/plugin.json"), "utf8"),
  );

  it("package.json과 plugin.json의 version이 일치해야 함", () => {
    assert.equal(
      pkg.version,
      plugin.version,
      `버전 불일치: package.json=${pkg.version}, plugin.json=${plugin.version}`,
    );
  });

  it("package.json과 plugin.json의 name이 일치해야 함", () => {
    assert.equal(
      pkg.name,
      plugin.name,
      `이름 불일치: package.json=${pkg.name}, plugin.json=${plugin.name}`,
    );
  });
});

// ========================================================================
// 5. truncate ANSI 안전
// ========================================================================
describe("truncate: ANSI 색상 문자열 안전 처리", async () => {
  const { truncate, color, FG, stripAnsi } = await import("../../hub/team/ansi.mjs");

  it("ANSI 색상 문자열을 truncate해도 깨진 escape가 없어야 함", () => {
    const colored = color("Hello World Test", FG.red);
    const result = truncate(colored, 5);
    // 결과에 불완전한 ESC 시퀀스가 없어야 함
    // 불완전 = ESC 뒤에 [ 이후 숫자/세미콜론은 있지만 종료 문자(알파벳)가 없는 경우
    const brokenEscape = /\x1b\[[0-9;]*$/;
    assert.ok(
      !brokenEscape.test(result),
      `truncate 결과에 깨진 escape 시퀀스가 없어야 함: ${JSON.stringify(result)}`,
    );
  });

  it("truncate 결과의 가시 길이가 maxLen 이하여야 함", () => {
    const colored = color("abcdefghij", FG.green);
    const result = truncate(colored, 5);
    const visibleLen = stripAnsi(result).length;
    assert.ok(
      visibleLen <= 5,
      `가시 길이가 5 이하여야 함 (got: ${visibleLen}, text: ${JSON.stringify(result)})`,
    );
  });

  it("maxLen보다 짧은 문자열은 그대로 반환", () => {
    const colored = color("Hi", FG.blue);
    const result = truncate(colored, 10);
    assert.equal(result, colored, "짧은 문자열은 변경 없이 반환되어야 함");
  });

  it("순수 텍스트 truncate도 정상 동작", () => {
    const result = truncate("abcdefghij", 5);
    const visible = stripAnsi(result);
    assert.ok(
      visible.length <= 5,
      `순수 텍스트 truncate 가시 길이: ${visible.length}`,
    );
  });
});

// ========================================================================
// 6. token-mode: expand 후 isCompactMode 리셋
// ========================================================================
describe("token-mode: compactify/expand 상태 전환", async () => {
  const { compactify, expand, isCompactMode } = await import("../../hub/token-mode.mjs");

  it("compactify 후 isCompactMode가 true여야 함", () => {
    compactify("test configuration string");
    assert.equal(isCompactMode(), true, "compactify 후 compact 모드여야 함");
  });

  it("expand 후 isCompactMode가 false여야 함", () => {
    compactify("test implementation string");
    assert.equal(isCompactMode(), true, "compactify 직후 true 확인");
    expand("test impl string");
    assert.equal(isCompactMode(), false, "expand 후 compact 모드가 해제되어야 함");
  });

  it("compactify -> expand 순환 후 isCompactMode가 false", () => {
    const original = "The configuration of the environment is complete.";
    compactify(original);
    assert.equal(isCompactMode(), true);
    expand(compactify(original));
    assert.equal(isCompactMode(), false, "순환 후 compact 모드 해제");
  });
});
