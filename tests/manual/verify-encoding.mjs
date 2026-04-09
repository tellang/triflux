/**
 * psmux CP949 인코딩 수정 검증 스크립트
 *
 * 검증 흐름:
 * 1. psmux 세션 생성 (인코딩 초기화가 자동 주입됨)
 * 2. Gemini CLI로 non-ASCII 출력 유도
 * 3. capture log에서 UTF-8 정상 여부 확인
 * 4. 세션 정리
 */

import { readFileSync } from "node:fs";
import {
  createPsmuxSession,
  dispatchCommand,
  killPsmuxSession,
  waitForCompletion,
} from "../../hub/team/psmux.mjs";

const SESSION_NAME = "tfx-encoding-test";
const TIMEOUT_SEC = 60;

async function main() {
  console.log("=== psmux CP949 인코딩 검증 시작 ===\n");

  // 1. 세션 생성 (1 pane)
  console.log("[1/4] psmux 세션 생성...");
  let session;
  try {
    session = createPsmuxSession(SESSION_NAME, { paneCount: 1, layout: "1xN" });
    console.log(
      `  세션: ${session.sessionName}, panes: ${session.panes.length}`,
    );
  } catch (err) {
    console.error("  세션 생성 실패:", err.message);
    process.exit(1);
  }

  // 2초 대기 — 인코딩 초기화 명령이 pane에서 실행될 시간
  await new Promise((r) => setTimeout(r, 2000));

  // 2. Gemini로 non-ASCII 출력 유도
  const prompt = "다음 문장을 그대로 출력해: 한글 테스트 成功 emoji 🎉 done";
  console.log(`[2/4] Gemini 명령 전송: "${prompt.slice(0, 40)}..."`);

  let dispatch;
  try {
    dispatch = dispatchCommand(
      SESSION_NAME,
      session.panes[0],
      `gemini -y -p "${prompt}"`,
    );
    console.log(`  token: ${dispatch.token}`);
    console.log(`  logPath: ${dispatch.logPath}`);
  } catch (err) {
    console.error("  명령 전송 실패:", err.message);
    killPsmuxSession(SESSION_NAME);
    process.exit(1);
  }

  // 3. 완료 대기 + 결과 확인
  console.log(`[3/4] 완료 대기 (최대 ${TIMEOUT_SEC}초)...`);
  try {
    const result = await waitForCompletion(
      SESSION_NAME,
      session.panes[0],
      dispatch.token,
      TIMEOUT_SEC,
    );
    console.log(`  exit code: ${result.exitCode}`);
  } catch (err) {
    console.error(`  타임아웃 또는 실패: ${err.message}`);
  }

  // 캡처 로그 읽기
  console.log("\n[4/4] 캡처 로그 검증...");
  try {
    const log = readFileSync(dispatch.logPath, "utf8");

    // UTF-16LE 패턴 탐지: letter+null 바이트
    const rawBytes = readFileSync(dispatch.logPath);
    const hasNullBytes = rawBytes.includes(0x00);

    // 한글 포함 여부
    const hasKorean = /[가-힣]/.test(log);
    // 한자 포함 여부
    const hasChinese = /[成功]/.test(log);
    // Gemini 텍스트 포함 여부
    const hasGeminiOutput = /done|emoji|테스트/.test(log);

    console.log(`  로그 크기: ${rawBytes.length} bytes`);
    console.log(
      `  null 바이트 (UTF-16LE 징후): ${hasNullBytes ? "❌ 발견 — 인코딩 깨짐!" : "✅ 없음"}`,
    );
    console.log(`  한글 포함: ${hasKorean ? "✅" : "⚠️  미포함"}`);
    console.log(`  한자 포함: ${hasChinese ? "✅" : "⚠️  미포함"}`);
    console.log(`  Gemini 출력 감지: ${hasGeminiOutput ? "✅" : "⚠️  미감지"}`);

    if (hasNullBytes) {
      console.log("\n  ⚠️  UTF-16LE 바이트 샘플:");
      const sample = rawBytes.slice(0, 100);
      console.log(
        `  ${Array.from(sample)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(" ")}`,
      );
    }

    // 최종 판정
    console.log("\n" + "=".repeat(50));
    if (!hasNullBytes && hasGeminiOutput) {
      console.log("✅ PASS — 인코딩 수정 정상 작동");
    } else if (hasNullBytes) {
      console.log("❌ FAIL — UTF-16LE 패턴 여전히 발생");
    } else {
      console.log("⚠️  INCONCLUSIVE — Gemini 출력 감지 실패 (타임아웃?)");
    }
    console.log("=".repeat(50));

    // 로그 일부 출력
    console.log("\n--- 캡처 로그 (처음 500자) ---");
    console.log(log.slice(0, 500));
    console.log("--- 끝 ---");
  } catch (err) {
    console.error("  로그 읽기 실패:", err.message);
  }

  // 4. 정리
  console.log("\n세션 정리...");
  try {
    killPsmuxSession(SESSION_NAME);
    console.log("  완료.");
  } catch (err) {
    console.error("  정리 실패:", err.message);
  }
}

main().catch(console.error);
