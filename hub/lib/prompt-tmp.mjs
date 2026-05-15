// hub/lib/prompt-tmp.mjs
//
// macOS `codex exec` 회귀 fix 보조 helper. codex CLI v0.130.0 의 macOS hook
// lifecycle (oh-my-codex/codex-native-hook.js) 이 매우 긴 argv inline prompt
// (4KB+) 를 받으면 SessionStart Failed 로 즉시 exit. PR #243 의 stdin EAGAIN
// async stream fix 후속 회귀로 추정.
//
// 대안: prompt 를 임시 파일에 쓰고 `< /tmp/...` stdin redirect 로 전달.
// Manual `echo prompt | codex exec ...` (stdin pipe) 가 정상 작동하는 fact 와
// 정합.
//
// cleanup 정책: best-effort. OS `/tmp` 가 자동 cleanup 하고, 이 모듈은
// 매 호출마다 unique path 사용 (timestamp + pid + counter). orphan 파일은
// 추후 doctor 가 prune.

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROMPT_TMP_DIR = join(tmpdir(), "triflux-codex-prompt");
let counter = 0;

export function writePromptToTmpFile(prompt) {
  mkdirSync(PROMPT_TMP_DIR, { recursive: true });
  const id = `${Date.now()}-${process.pid}-${counter++}`;
  const file = join(PROMPT_TMP_DIR, `prompt-${id}.txt`);
  writeFileSync(file, String(prompt ?? ""), "utf8");
  return file;
}

export function getPromptTmpDir() {
  return PROMPT_TMP_DIR;
}
