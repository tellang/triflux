#!/usr/bin/env node
// hooks/pipeline-stop.mjs — Stop 훅: 활성 파이프라인 감지 시 구조화 decision 반환
//
// Claude Code Stop 이벤트에서 실행.
// 비터미널 단계의 파이프라인이 있으면 decision:"block" + reason으로 중단을 방지한다.
// 파이프라인이 없으면 정상 종료를 허용한다.

import { existsSync } from "node:fs";
import { PLUGIN_ROOT } from "./lib/resolve-root.mjs";

let getPipelineStateDbPath;
let ensurePipelineTable;
let listPipelineStates;
try {
  ({
    getPipelineStateDbPath,
    ensurePipelineTable,
    listPipelineStates,
  } = await import("../hub/pipeline/state.mjs"));
} catch {
  // hub/pipeline 모듈 없으면 훅 무동작
  process.exit(0);
}

const HUB_DB_PATH = getPipelineStateDbPath(PLUGIN_ROOT);
const TERMINAL = new Set(["complete", "failed"]);

async function checkActivePipelines() {
  if (!existsSync(HUB_DB_PATH)) return [];

  try {
    const { default: Database } = await import("better-sqlite3");

    const db = new Database(HUB_DB_PATH, { readonly: true });
    ensurePipelineTable(db);
    const states = listPipelineStates(db);
    db.close();

    return states.filter((s) => !TERMINAL.has(s.phase));
  } catch {
    return [];
  }
}

try {
  const active = await checkActivePipelines();

  if (active.length === 0) {
    // 활성 파이프라인 없음 → 정상 종료 허용
    process.exit(0);
  }

  // 활성 파이프라인 발견 → 구조화 decision으로 block
  const lines = active.map(
    (s) =>
      `  - 팀 ${s.team_name}: ${s.phase} 단계 (fix: ${s.fix_attempt}/${s.fix_max}, ralph: ${s.ralph_iteration}/${s.ralph_max})`
  );

  const reason =
    `[tfx-multi 파이프라인 진행 중]\n` +
    `활성 파이프라인 ${active.length}개가 아직 완료되지 않았습니다:\n` +
    `${lines.join("\n")}\n\n` +
    `파이프라인을 이어서 진행하려면 /tfx-multi status 로 상태를 확인하세요.\n` +
    `강제 종료하려면 /tfx-multi cancel 을 먼저 실행하세요.`;

  // 구조화된 Stop hook 출력: decision + reason
  const output = {
    decision: "block",
    reason,
  };

  process.stdout.write(JSON.stringify(output));
} catch {
  // 훅 실패 시 종료 허용
  process.exit(0);
}
