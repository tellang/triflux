#!/usr/bin/env node
/**
 * tfx-multi-activate.mjs — PreToolUse(Skill) 훅
 *
 * /tfx-multi 스킬 호출을 감지하여 상태 파일을 설정한다.
 * 상태 파일은 안내(additionalContext) 용도다. 차단 훅 headless-guard 는 2026-09-07 에 제거됐다.
 *
 * 상태 파일: $TMPDIR/tfx-multi-state.json
 * 자동 만료: 30분
 */

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE_FILE = join(tmpdir(), "tfx-multi-state.json");

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

  if (!raw.trim()) {
    process.exit(0);
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const toolName = input.tool_name || "";
  const toolInput = input.tool_input || {};

  if (toolName !== "Skill") {
    process.exit(0);
  }

  const skill = (toolInput.skill || "").toLowerCase();

  // 모든 tfx CLI 라우팅 스킬에 gate 적용
  const TFX_ROUTING_SKILLS = new Set([
    "tfx-multi",
    "tfx-team",
    "tfx-auto",
    "tfx-auto-codex",
    "tfx-codex",
    "tfx-gemini",
    "tfx-autoresearch",
  ]);

  if (TFX_ROUTING_SKILLS.has(skill)) {
    // 활성화: 상태 파일 생성/갱신
    // ppid = Claude Code 세션 PID (훅은 Claude Code의 자식 프로세스)
    const state = {
      active: true,
      activatedAt: Date.now(),
      ownerPid: process.ppid,
      dispatched: false,
      nativeWorkCalls: 0,
      nativeWorkCallsSinceDispatch: 0,
    };
    writeFileSync(STATE_FILE, JSON.stringify(state));

    // additionalContext로 Lead에게 알림
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext:
            "[tfx-auto] gate 활성화됨 (legacy state: tfx-multi). CLI 작업은 tfx multi(auto) dispatch 필수:\n" +
            "  • /tfx-auto --parallel N         (병렬 worker)\n" +
            "  • /tfx-auto --parallel swarm     (worktree 격리, 코드 변경)\n" +
            "레거시 alias: Bash(\"tfx multi --auto-attach --dashboard --assign 'codex:프롬프트:역할' --timeout 1800\", run_in_background=true) — teammate mode 생략은 auto이며, foreground Bash는 하니스가 600s에 강제 종료",
        },
      }),
    );
    process.exit(0);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
