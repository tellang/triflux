// hub/promote-penalties.mjs — pending-penalties.jsonl → store adaptive_rules 승격
//
// 흐름:
//   1. safety-guard BLOCK → error-context.mjs → pending-penalties.jsonl 기록
//   2. 이 스크립트가 penalties를 읽어 store.addAdaptiveRule()로 승격
//   3. 승격 완료된 penalty는 파일에서 제거
//
// 호출 시점:
//   - Hub 시작 시 (server.mjs에서 import)
//   - 수동: node hub/promote-penalties.mjs

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { adaptiveRuleFromError } from "./reflexion.mjs";

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const PENALTY_DIR = join(HOME, ".triflux", "reflexion");
const PENALTY_FILE = join(PENALTY_DIR, "pending-penalties.jsonl");

function loadPenalties() {
  if (!existsSync(PENALTY_FILE)) return [];
  try {
    return readFileSync(PENALTY_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch { return []; }
}

function clearPenalties() {
  try { writeFileSync(PENALTY_FILE, "", "utf8"); } catch { /* ignore */ }
}

/**
 * pending penalties를 adaptive rules로 승격한다.
 *
 * @param {object} store — store-adapter 인스턴스 (addAdaptiveRule 필요)
 * @param {object} [options]
 * @param {string} [options.projectSlug] — 프로젝트 식별자
 * @param {number} [options.sessionCount] — 현재 세션 번호
 * @returns {{ promoted: number, skipped: number, total: number }}
 */
export function promotePenalties(store, options = {}) {
  const penalties = loadPenalties();
  if (penalties.length === 0) return { promoted: 0, skipped: 0, total: 0 };

  const projectSlug = options.projectSlug || "triflux";
  const sessionCount = options.sessionCount || 1;
  let promoted = 0;
  let skipped = 0;

  for (const penalty of penalties) {
    const errorContext = {
      errorText: penalty.error_pattern || "",
      errorMessage: `[${penalty.source}] ${penalty.error_pattern || "guard block"}`,
      command: penalty.command_preview || "",
      projectSlug,
      sessionCount,
      tool: penalty.tool || "Bash",
    };

    const rule = adaptiveRuleFromError(errorContext);
    if (!rule) {
      skipped++;
      continue;
    }

    try {
      if (store.addAdaptiveRule) {
        store.addAdaptiveRule({
          project_slug: projectSlug,
          pattern: rule.error_pattern,
          error_message: rule.error_message,
          solution: rule.solution,
          context: typeof rule.context === "string" ? rule.context : JSON.stringify(rule.context),
          confidence: rule.confidence,
          hit_count: rule.hit_count,
          last_seen_ms: Date.now(),
        });
        promoted++;
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }

  // 승격 완료된 penalties 제거
  if (promoted > 0) clearPenalties();

  return { promoted, skipped, total: penalties.length };
}

/**
 * store 없이 standalone 실행 — penalties 요약만 출력
 */
export function dryRun() {
  const penalties = loadPenalties();
  console.log(`[promote-penalties] ${penalties.length} pending penalties`);
  for (const p of penalties) {
    console.log(`  ${p.ts?.slice(0, 19)} [${p.source}] ${p.error_pattern?.slice(0, 80)}`);
  }
  return penalties;
}

// CLI 직접 실행
if (process.argv[1]?.endsWith("promote-penalties.mjs")) {
  dryRun();
}
