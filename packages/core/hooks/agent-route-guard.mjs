#!/usr/bin/env node
// hooks/agent-route-guard.mjs — PreToolUse:Agent 훅
// 서브에이전트 스폰 시 triflux 컨텍스트를 구조화 JSON으로 주입한다.
// - subagent_type별 최적 라우팅 가이드
// - tfx-multi 활성 상태 시 headless dispatch 강제
// - 프로젝트 컨텍스트 자동 첨부

import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TFX_MULTI_STATE = join(tmpdir(), "tfx-multi-state.json");
const EXPIRE_MS = 30 * 60 * 1000; // 30분

// 서브에이전트 타입별 라우팅 힌트
const AGENT_HINTS = {
  "general-purpose":
    "범용 에이전트. tfx 스킬이 활성이면 스킬 MD의 라우팅을 우선한다.",
  Explore: "탐색 전용. 파일 수정 불가. Glob/Grep/Read만 사용.",
  Plan: "설계 전용. 파일 수정 불가. 구현 계획 반환.",
  "oh-my-claudecode:executor":
    "OMC executor. triflux 프로젝트에서는 tfx-auto 라우팅을 우선.",
  "oh-my-claudecode:code-reviewer":
    "OMC 리뷰어. 교차 리뷰 시 CLAUDE.md 교차 검증 규칙 준수.",
  "oh-my-claudecode:architect": "OMC 아키텍트. READ-ONLY.",
  "oh-my-claudecode:debugger": "OMC 디버거. 근본 원인 분석 집중.",
  "oh-my-claudecode:test-engineer": "OMC 테스트. npm test 실행 후 결과 반환.",
};

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function getTfxMultiState() {
  if (!existsSync(TFX_MULTI_STATE)) return null;
  try {
    const state = JSON.parse(readFileSync(TFX_MULTI_STATE, "utf8"));
    if (Date.now() - state.activatedAt > EXPIRE_MS) return null;
    return state.active ? state : null;
  } catch {
    return null;
  }
}

function buildContext(agentType, prompt) {
  const parts = [];

  // 1. tfx-multi 활성 상태 확인
  const multiState = getTfxMultiState();
  if (multiState) {
    parts.push(
      "[tfx-multi ACTIVE] headless dispatch 모드. " +
        "CLI 작업은 Bash(tfx-route.sh)를 통해 실행하세요.",
    );
  }

  // 2. 에이전트 타입별 힌트
  const hint = AGENT_HINTS[agentType];
  if (hint) {
    parts.push(`[Agent:${agentType}] ${hint}`);
  }

  // 3. 프로젝트 컨텍스트
  parts.push(
    "triflux 프로젝트: subagent_type 미지정 시 'general-purpose' 기본. " +
      "tfx-* 스킬 활성 시 스킬 MD 라우팅 우선.",
  );

  return parts.join("\n");
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

  if (input.tool_name !== "Agent") process.exit(0);

  const toolInput = input.tool_input || {};
  const agentType =
    toolInput.subagent_type || toolInput.agent || "general-purpose";
  const prompt = toolInput.prompt || "";

  const context = buildContext(agentType, prompt);

  // 구조화된 hookSpecificOutput 반환
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      additionalContext: context,
    },
  };

  process.stdout.write(JSON.stringify(output));
}

try {
  main();
} catch {
  // 훅 실패 시 블로킹하지 않음
  process.exit(0);
}
