#!/usr/bin/env node
/**
 * tfx-multi-activate.mjs — PreToolUse(Skill) 훅
 *
 * /tfx-multi 스킬 호출을 감지하여 상태 파일을 설정한다.
 * headless-guard.mjs가 이 상태를 읽어 A(gate) + B(nudge)를 수행.
 *
 * 상태 파일: $TMPDIR/tfx-multi-state.json
 * 자동 만료: 30분
 */

import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE_FILE = join(tmpdir(), "tfx-multi-state.json");
const EXPIRE_MS = 30 * 60 * 1000; // 30분

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
    "tfx-multi", "tfx-team", "tfx-auto", "tfx-auto-codex",
    "tfx-codex", "tfx-gemini", "tfx-autoresearch",
  ]);

  if (TFX_ROUTING_SKILLS.has(skill)) {
    // 활성화: 상태 파일 생성/갱신
    const state = {
      active: true,
      activatedAt: Date.now(),
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
            "[tfx-multi] gate 활성화됨. CLI 작업은 headless로 dispatch 필수:\n" +
            'Bash("tfx multi --teammate-mode headless --auto-attach --dashboard --assign \'codex:프롬프트:역할\' --timeout 600")',
        },
      }),
    );
    process.exit(0);
  }

  // /tfx-multi 외 스킬 호출 시: 기존 상태 만료 체크만
  if (existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      if (Date.now() - state.activatedAt > EXPIRE_MS) {
        // 만료 → 삭제하지 않고 headless-guard가 처리
      }
    } catch {
      /* ignore */
    }
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
