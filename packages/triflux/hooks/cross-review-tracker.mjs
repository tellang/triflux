#!/usr/bin/env node
// hooks/cross-review-tracker.mjs — PostToolUse:Edit|Write 훅
//
// 파일 수정을 추적하여 교차 리뷰 미검증 파일을 감지한다.
// CLAUDE.md 규칙: "Claude 작성 코드 → Codex 리뷰, Codex 작성 → Claude 리뷰"
//
// 동작:
//   1. Edit/Write 성공 시 수정된 파일 경로를 상태 파일에 누적
//   2. 일정 수(REVIEW_THRESHOLD) 이상 미검증 파일이 쌓이면 nudge 메시지 주입
//   3. git commit 전 미검증 파일 경고

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

const STATE_DIR = join(tmpdir(), "tfx-cross-review");
const STATE_FILE = join(STATE_DIR, "pending-review.json");
const REVIEW_THRESHOLD = 5; // 이 수 이상 미검증 파일 → nudge
const EXPIRE_MS = 60 * 60 * 1000; // 1시간 후 자동 만료

// 코드 파일만 추적 (설정/문서/빌드 산출물 제외)
const CODE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h",
  ".vue", ".svelte", ".sh", ".bash", ".ps1",
]);

function isCodeFile(filePath) {
  if (!filePath) return false;
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

function loadState() {
  if (!existsSync(STATE_FILE)) {
    return { files: {}, startedAt: Date.now() };
  }
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    // 만료 체크
    if (Date.now() - state.startedAt > EXPIRE_MS) {
      return { files: {}, startedAt: Date.now() };
    }
    return state;
  } catch {
    return { files: {}, startedAt: Date.now() };
  }
}

function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

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

  const toolName = input.tool_name || "";
  if (toolName !== "Edit" && toolName !== "Write") process.exit(0);

  const toolInput = input.tool_input || {};
  const filePath = toolInput.file_path || "";

  if (!filePath || !isCodeFile(filePath)) process.exit(0);

  // 프로젝트 루트 기준 상대 경로
  const cwd = input.cwd || process.cwd();
  const relPath = relative(cwd, filePath) || filePath;

  // 상태 갱신: 파일 추가
  const state = loadState();
  state.files[relPath] = {
    tool: toolName,
    modifiedAt: Date.now(),
    reviewed: false,
  };
  saveState(state);

  // 미검증 파일 수 체크
  const unreviewed = Object.entries(state.files).filter(
    ([, v]) => !v.reviewed
  );
  const count = unreviewed.length;

  if (count >= REVIEW_THRESHOLD) {
    // nudge 메시지 주입
    const fileList = unreviewed
      .slice(0, 8)
      .map(([f]) => `  - ${f}`)
      .join("\n");

    const output = {
      systemMessage:
        `[교차 리뷰 nudge] 미검증 코드 파일 ${count}개:\n${fileList}\n` +
        (count > 8 ? `  ... 외 ${count - 8}개\n` : "") +
        `커밋 전 교차 리뷰를 권장합니다. (Claude→Codex 또는 Codex→Claude)`,
    };
    process.stdout.write(JSON.stringify(output));
  }
}

try {
  main();
} catch {
  process.exit(0);
}
