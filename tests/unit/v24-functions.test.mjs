import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { cleanTuiArtifacts } from "../../scripts/tfx-route-post.mjs";
import { replaceProfileSection, hasProfileSection } from "../../scripts/setup.mjs";

describe("v2.4 신규 JS 함수 테스트", () => {

  describe("cleanTuiArtifacts()", () => {
    it("1. ANSI escape 시퀀스 제거 확인", () => {
      const input = "\x1b[31mRed Text\x1b[0m And \x1b[1mBold\x1b[22m";
      const expected = "Red Text And Bold";
      assert.equal(cleanTuiArtifacts(input, "codex"), expected);
    });

    it("2. box drawing 문자(─│┌┐└┘├┤) 제거 확인", () => {
      const input = "┌──────────┐\n│ Content  │\n└──────────┘\nValid Text";
      // codex 모드일 때 줄 시작이 box 문자면 전체 줄 제거
      const expected = "Valid Text";
      assert.equal(cleanTuiArtifacts(input, "codex"), expected);
    });

    it("3. 프롬프트 마커 제거 확인", () => {
      // codex 모드 프롬프트 마커 테스트
      const codexInput = "❯ \n❯ Applied patch\nUseful Text";
      assert.equal(cleanTuiArtifacts(codexInput, "codex"), "Useful Text");
    });

    it("4. 연속 빈줄 → 단일 빈줄(정확히는 두 개 빈줄) 정규화 확인", () => {
      // 실제 코드는 \n\n\n 이상을 \n\n으로 변경 (시작과 끝은 trim 됨)
      const input = "Line1\n\n\n\n\nLine2\n\n\nLine3";
      const expected = "Line1\n\nLine2\n\nLine3";
      assert.equal(cleanTuiArtifacts(input, "codex"), expected);
    });

    it("5. 일반 텍스트는 변경하지 않음 확인", () => {
      const input = "Hello, this is a normal text.\nIt should remain the same.";
      const expected = "Hello, this is a normal text.\nIt should remain the same.";
      assert.equal(cleanTuiArtifacts(input, "codex"), expected);
    });

    it("6. codex/gemini/claude별 분기 동작", () => {
      // codex
      const codexText = "│ codex\n❯ Applied fix";
      assert.equal(cleanTuiArtifacts(codexText, "codex"), "");

      // gemini
      const geminiText = "╭─ Gemini\n> \nReal Output";
      assert.equal(cleanTuiArtifacts(geminiText, "gemini"), "Real Output");

      // claude
      const claudeText = "━━━━━━━\nClaude response";
      assert.equal(cleanTuiArtifacts(claudeText, "claude"), "Claude response");
    });
  });

  describe("replaceProfileSection()", () => {
    const tomlContent = `
[profiles.high]
model = "gpt-4"
effort = "high"

[profiles.low]
model = "gpt-3.5"
`;

    it("1. 기존 프로필 교체 확인", () => {
      const newLines = ['model = "gpt-5"', 'effort = "max"'];
      const updated = replaceProfileSection(tomlContent, "high", newLines);
      
      assert.ok(updated.includes('[profiles.high]\nmodel = "gpt-5"\neffort = "max"'));
      assert.ok(!updated.includes('model = "gpt-4"'));
      // low 프로필은 유지되어야 함
      assert.ok(updated.includes('[profiles.low]'));
    });

    it("2. 프로필 없을 때 원본 유지 확인 (replace는 match 실패 시 원본 반환)", () => {
      const newLines = ['model = "gpt-5"'];
      const updated = replaceProfileSection(tomlContent, "missing", newLines);
      
      // 변경이 없어야 함
      assert.equal(updated, tomlContent);
    });

    it("3. 여러 프로필 중 특정 하나만 교체 확인", () => {
      const newLines = ['model = "gpt-4o-mini"'];
      const updated = replaceProfileSection(tomlContent, "low", newLines);
      
      // high 프로필은 유지
      assert.ok(updated.includes('[profiles.high]\nmodel = "gpt-4"'));
      // low 프로필은 변경
      assert.ok(updated.includes('[profiles.low]\nmodel = "gpt-4o-mini"'));
      assert.ok(!updated.includes('model = "gpt-3.5"'));
    });
  });
});
