import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildHybridWrapperPrompt, buildSlimWrapperPrompt } from '../../hub/team/native.mjs';

describe('hub/team/native.mjs — route env prefix', () => {
  it('슬림 래퍼는 agentName 끝 숫자에서 TFX_WORKER_INDEX를 추론해야 한다', () => {
    const prompt = buildSlimWrapperPrompt('codex', {
      subtask: 'quota strategy',
      agentName: 'codex-2',
      mcp_profile: 'analyze',
    });

    assert.match(prompt, /TFX_WORKER_INDEX="2"/);
  });

  it('하이브리드 래퍼는 명시적 workerIndex와 searchTool을 함께 주입해야 한다', () => {
    const prompt = buildHybridWrapperPrompt('codex', {
      subtask: 'quota strategy',
      agentName: 'codex-worker',
      workerIndex: 3,
      searchTool: 'exa',
      mcp_profile: 'analyze',
    });

    assert.match(prompt, /TFX_WORKER_INDEX="3"/);
    assert.match(prompt, /TFX_SEARCH_TOOL="exa"/);
  });
});
