#!/usr/bin/env node
// hooks/pipeline-stop.mjs — 파이프라인 진행 중 세션 중단 시 지속 프롬프트 주입
//
// Claude Code의 Stop 이벤트에서 실행.
// 비터미널 단계의 파이프라인이 있으면 "작업 계속" 프롬프트를 반환한다.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPipelineStateDbPath } from '../hub/pipeline/state.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const HUB_DB_PATH = getPipelineStateDbPath(PROJECT_ROOT);
const TERMINAL = new Set(['complete', 'failed']);

async function getPipelineStopPrompt() {
  if (!existsSync(HUB_DB_PATH)) return null;

  try {
    const { default: Database } = await import('better-sqlite3');
    const { ensurePipelineTable, listPipelineStates } = await import(
      join(process.env.CLAUDE_PLUGIN_ROOT || '.', 'hub', 'pipeline', 'state.mjs')
    );

    const db = new Database(HUB_DB_PATH, { readonly: true });
    ensurePipelineTable(db);
    const states = listPipelineStates(db);
    db.close();

    // 비터미널 단계의 활성 파이프라인 찾기
    const active = states.filter((s) => !TERMINAL.has(s.phase));
    if (active.length === 0) return null;

    const lines = active.map((s) =>
      `- 팀 ${s.team_name}: ${s.phase} 단계 (fix: ${s.fix_attempt}/${s.fix_max}, ralph: ${s.ralph_iteration}/${s.ralph_max})`
    );

    return `[tfx-multi 파이프라인 진행 중]
활성 파이프라인이 있습니다:
${lines.join('\n')}

파이프라인을 이어서 진행하려면 /tfx-multi status 로 상태를 확인하세요.`;
  } catch {
    return null;
  }
}

try {
  const prompt = await getPipelineStopPrompt();
  if (prompt) {
    // hook 출력으로 지속 프롬프트 전달
    console.log(prompt);
  }
} catch {
  // stop 훅 실패는 무시
}
