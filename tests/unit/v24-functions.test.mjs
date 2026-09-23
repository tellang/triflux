import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendCodexResumeHint,
  cleanTuiArtifacts,
  extractCodexSessionId,
} from "../../scripts/tfx-route-post.mjs";

describe("v2.4 신규 JS 함수 테스트", () => {
  describe("cleanTuiArtifacts()", () => {
    it("1. ANSI escape 시퀀스 제거 확인", () => {
      const input = "\x1b[31mRed Text\x1b[0m And \x1b[1mBold\x1b[22m";
      const expected = "Red Text And Bold";
      assert.equal(cleanTuiArtifacts(input, "codex"), expected);
    });

    it("1-1. SS3 cursor escape와 잘린 [O[ 조각 제거 확인", () => {
      const input = "ok\x1bOA\n[O[\nnext [OB";
      const expected = "ok\nnext";
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
      const expected =
        "Hello, this is a normal text.\nIt should remain the same.";
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

  describe("Codex session resume helpers", () => {
    it("7. stderr의 session id를 추출한다", () => {
      const stderr = "OpenAI Codex\nsession id: thr_route_123\nmodel: gpt-5.4";
      assert.equal(extractCodexSessionId("", stderr), "thr_route_123");
    });

    it("8. JSON line의 threadId를 추출한다", () => {
      const rawOutput = '{"type":"completed","threadId":"thr_json_456"}';
      assert.equal(extractCodexSessionId(rawOutput, ""), "thr_json_456");
    });

    it("9. 세션 정보가 없을 때만 resume 힌트를 덧붙인다", () => {
      const stderr = "session id: thr_route_789";
      const output = appendCodexResumeHint("Useful Text", "", stderr);
      assert.equal(
        output,
        "Useful Text\n\nCodex session ID: thr_route_789\nResume in Codex: codex resume thr_route_789",
      );
    });

    it("10. 기존 resume 힌트가 있으면 중복 추가하지 않는다", () => {
      const existing =
        "Done.\n\nCodex session ID: thr_existing\nResume in Codex: codex resume thr_existing";
      assert.equal(
        appendCodexResumeHint(existing, "", "session id: thr_other"),
        existing,
      );
    });
  });
});
