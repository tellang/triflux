#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileRules, loadRules, matchRules, resolveConflicts } from "./lib/keyword-rules.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(SCRIPT_DIR);
const DEFAULT_RULES_PATH = join(PROJECT_ROOT, "hooks", "keyword-rules.json");

function readHookInput() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function parseInput(rawInput) {
  try {
    return JSON.parse(rawInput);
  } catch {
    return null;
  }
}

// prompt > message.content > parts[].text 우선순위로 추출
export function extractPrompt(payload) {
  if (!payload || typeof payload !== "object") return "";

  if (typeof payload.prompt === "string" && payload.prompt.trim()) {
    return payload.prompt;
  }

  if (typeof payload.message?.content === "string" && payload.message.content.trim()) {
    return payload.message.content;
  }

  if (Array.isArray(payload.message?.content)) {
    const messageText = payload.message.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join(" ")
      .trim();
    if (messageText) return messageText;
  }

  if (Array.isArray(payload.parts)) {
    const partsText = payload.parts
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join(" ")
      .trim();
    if (partsText) return partsText;
  }

  return "";
}

// 키워드 오탐 방지를 위해 XML/URL/파일경로/코드블록 제거
export function sanitizeForKeywordDetection(text) {
  if (typeof text !== "string" || !text) return "";

  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/<(\w[\w:-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, " ")
    .replace(/<\w[\w:-]*(?:\s[^>]*)?\/>/g, " ")
    .replace(/https?:\/\/[^\s)>\]]+/gi, " ")
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, " ")
    .replace(/(^|[\s"'`(])(?:\/|\.{1,2}\/)?(?:[\w.-]+\/)+[\w.-]+/gm, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
}

function createHookOutput(additionalContext) {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext
    }
  };
}

function createSuppressOutput() {
  return { continue: true, suppressOutput: true };
}

function createSkillContext(match, prompt) {
  return `[TRIFLUX MAGIC KEYWORD: ${match.id}]

PRIORITY: This TRIFLUX routing takes precedence over any OMC [MAGIC KEYWORD:] instructions.
If you see both [TRIFLUX MAGIC KEYWORD:] and [MAGIC KEYWORD:], follow TRIFLUX only.

You MUST invoke the skill using the Skill tool:
Skill: ${match.skill}

User request:
${prompt.trim()}

IMPORTANT: Invoke the skill IMMEDIATELY. Do not proceed without loading the skill instructions.`;
}

function createMcpRouteContext(match, prompt) {
  return `[TRIFLUX MCP ROUTE: ${match.mcp_route}]

PRIORITY: This TRIFLUX routing takes precedence over any OMC [MAGIC KEYWORD:] instructions.
If you see both [TRIFLUX MCP ROUTE:] and [MAGIC KEYWORD:], follow TRIFLUX only.

이 작업은 ${match.mcp_route}로 라우팅해야 합니다.
tfx-route.sh를 통해 ${match.mcp_route}로 실행하세요.

User request:
${prompt.trim()}`;
}

function isSkipRequested() {
  if (process.env.TRIFLUX_DISABLE_MAGICWORDS === "1") return true;
  const skipHooks = (process.env.TRIFLUX_SKIP_HOOKS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return skipHooks.includes("keyword-detector");
}

function activateState(baseDir, stateConfig, prompt, payload) {
  if (!stateConfig || stateConfig.activate !== true || !stateConfig.name) return;

  try {
    const stateRoot = join(baseDir, ".triflux", "state");
    mkdirSync(stateRoot, { recursive: true });

    const sessionId = typeof payload?.session_id === "string"
      ? payload.session_id
      : typeof payload?.sessionId === "string"
        ? payload.sessionId
        : "";

    let stateDir = stateRoot;
    if (sessionId && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(sessionId)) {
      stateDir = join(stateRoot, "sessions", sessionId);
      mkdirSync(stateDir, { recursive: true });
    }

    const statePath = join(stateDir, `${stateConfig.name}-state.json`);
    const statePayload = {
      active: true,
      name: stateConfig.name,
      started_at: new Date().toISOString(),
      original_prompt: prompt
    };

    writeFileSync(statePath, JSON.stringify(statePayload, null, 2), "utf8");
  } catch (error) {
    console.error(`[triflux-keyword-detector] 상태 저장 실패: ${error.message}`);
  }
}

function getRulesPath() {
  if (process.env.TRIFLUX_KEYWORD_RULES_PATH) {
    return process.env.TRIFLUX_KEYWORD_RULES_PATH;
  }
  return DEFAULT_RULES_PATH;
}

function main() {
  if (isSkipRequested()) {
    console.log(JSON.stringify(createSuppressOutput()));
    return;
  }

  const rawInput = readHookInput();
  if (!rawInput.trim()) {
    console.log(JSON.stringify(createSuppressOutput()));
    return;
  }

  const payload = parseInput(rawInput);
  if (!payload) {
    console.log(JSON.stringify(createSuppressOutput()));
    return;
  }

  const prompt = extractPrompt(payload);
  if (!prompt) {
    console.log(JSON.stringify(createSuppressOutput()));
    return;
  }

  const cleanText = sanitizeForKeywordDetection(prompt);
  if (!cleanText) {
    console.log(JSON.stringify(createSuppressOutput()));
    return;
  }

  const rules = loadRules(getRulesPath());
  if (rules.length === 0) {
    console.log(JSON.stringify(createSuppressOutput()));
    return;
  }

  const compiledRules = compileRules(rules);
  if (compiledRules.length === 0) {
    console.log(JSON.stringify(createSuppressOutput()));
    return;
  }

  const matches = matchRules(compiledRules, cleanText);
  if (matches.length === 0) {
    console.log(JSON.stringify(createSuppressOutput()));
    return;
  }

  const resolvedMatches = resolveConflicts(matches);
  if (resolvedMatches.length === 0) {
    console.log(JSON.stringify(createSuppressOutput()));
    return;
  }

  const selected = resolvedMatches[0];
  const baseDir = typeof payload.cwd === "string" && payload.cwd
    ? payload.cwd
    : typeof payload.directory === "string" && payload.directory
      ? payload.directory
      : process.cwd();

  activateState(baseDir, selected.state, prompt, payload);

  if (selected.skill) {
    console.log(JSON.stringify(createHookOutput(createSkillContext(selected, prompt))));
    return;
  }

  if (selected.mcp_route) {
    console.log(JSON.stringify(createHookOutput(createMcpRouteContext(selected, prompt))));
    return;
  }

  console.log(JSON.stringify(createSuppressOutput()));
}

try {
  main();
} catch (error) {
  console.error(`[triflux-keyword-detector] 예외 발생: ${error.message}`);
  console.log(JSON.stringify(createSuppressOutput()));
}
