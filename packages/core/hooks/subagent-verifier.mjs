#!/usr/bin/env node
// hooks/subagent-verifier.mjs — SubagentStop 훅
//
// 서브에이전트 완료 시 결과 품질을 체크한다:
//   - 빈 결과 감지 → 재시도 제안
//   - 에러 종료 감지 → 원인 분석 컨텍스트 주입
//   - 과도한 토큰 사용 감지 → 효율성 알림

import { readFileSync } from "node:fs";

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) process.exit(0);

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const agentType = input.agent_type || input.subagent_type || "unknown";
  const result = input.tool_output || input.result || "";
  const resultStr =
    typeof result === "string" ? result : JSON.stringify(result);

  const issues = [];

  // 1. 빈 결과 체크
  if (!resultStr.trim() || resultStr.trim().length < 20) {
    issues.push(
      `서브에이전트(${agentType})가 거의 빈 결과를 반환했습니다. ` +
        "프롬프트를 더 구체적으로 작성하거나, 다른 subagent_type을 시도하세요.",
    );
  }

  // 2. 에러 키워드 감지
  const errorPatterns = [
    /error:|exception:|traceback|failed to|fatal:/i,
    /❌|FAILED|ERROR/,
  ];
  const hasError = errorPatterns.some((p) => p.test(resultStr));
  if (hasError && resultStr.length > 50) {
    issues.push(
      `서브에이전트(${agentType}) 결과에 에러 신호가 감지되었습니다. ` +
        "결과를 검토하고, 필요 시 다른 접근 방식을 사용하세요.",
    );
  }

  // 3. 결과가 너무 길면 요약 필요 알림
  if (resultStr.length > 15000) {
    issues.push(
      `서브에이전트(${agentType}) 결과가 ${Math.round(resultStr.length / 1000)}K 자입니다. ` +
        "핵심만 추출하여 컨텍스트 윈도우를 절약하세요.",
    );
  }

  if (issues.length === 0) process.exit(0);

  const output = {
    systemMessage:
      `[subagent-verifier] ${agentType} 완료 — 주의사항:\n` +
      issues.map((i) => `  → ${i}`).join("\n"),
  };

  process.stdout.write(JSON.stringify(output));
}

try {
  main();
} catch {
  process.exit(0);
}
