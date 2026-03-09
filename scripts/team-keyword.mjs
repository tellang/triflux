#!/usr/bin/env node
// scripts/team-keyword.mjs — "team" 매직 키워드 → /tfx-team 라우팅
// UserPromptSubmit 훅에서 실행. stdin으로 프롬프트 수신.
import { readFileSync } from "node:fs";

// stdin에서 프롬프트 읽기
let prompt = "";
try {
  prompt = readFileSync(0, "utf8");
} catch {
  process.exit(0);
}

// 코드 블록 제거 (오탐 방지)
const cleaned = prompt
  .replace(/```[\s\S]*?```/g, "")
  .replace(/`[^`]+`/g, "")
  .replace(/https?:\/\/\S+/g, "");

// "team" 키워드 감지 (소유격/관사 뒤는 제외)
const hasTeam =
  /(?<!\b(?:my|the|our|a|his|her|their|its|omc|oh-my-claudecode)\s)\bteam\b/i.test(cleaned) ||
  /\btfx[\s-]?team\b/i.test(cleaned);

if (hasTeam) {
  console.log("[MAGIC KEYWORD: tfx-team]");
  console.log("");
  console.log("You MUST invoke the skill using the Skill tool:");
  console.log("");
  console.log("Skill: tfx-team");
  console.log("");
  console.log(`User request:\n${prompt.trim()}`);
  console.log("");
  console.log("IMPORTANT: Invoke the skill IMMEDIATELY. Do not proceed without loading the skill instructions.");
}
