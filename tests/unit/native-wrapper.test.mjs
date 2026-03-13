import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildHybridWrapperPrompt,
  buildSlimWrapperAgent,
  buildSlimWrapperPrompt,
  SLIM_WRAPPER_SUBAGENT_TYPE,
  verifySlimWrapperRouteExecution,
} from '../../hub/team/native.mjs';

describe('hub/team/native.mjs — route env prefix', () => {
  it('슬림 래퍼는 agentName 끝 숫자에서 TFX_WORKER_INDEX를 추론해야 한다', () => {
    const prompt = buildSlimWrapperPrompt('codex', {
      subtask: 'quota strategy',
      agentName: 'codex-2',
      mcp_profile: 'analyze',
    });

    assert.match(prompt, /TFX_WORKER_INDEX="2"/);
    assert.match(prompt, /subagent_type="slim-wrapper"/);
    // v2.3: Bash 완료 후 TaskUpdate + SendMessage로 Claude Code 태스크 동기화
    assert.match(prompt, /TaskUpdate\(taskId:/);
    assert.match(prompt, /SendMessage\(type: "message"/);
    assert.match(prompt, /허용 도구: Bash, TaskUpdate, SendMessage만 사용한다/);
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

  it('슬림 래퍼 agent spec은 slim-wrapper subagent_type을 명시해야 한다', () => {
    const worker = buildSlimWrapperAgent('codex', {
      subtask: 'quota strategy',
      agentName: 'codex-2',
    });

    assert.equal(worker.cli, 'codex');
    assert.equal(worker.name, 'codex-2');
    assert.equal(worker.subagent_type, SLIM_WRAPPER_SUBAGENT_TYPE);
    assert.match(worker.prompt, /subagent_type="slim-wrapper"/);
  });
});

describe('hub/team/native.mjs — slim wrapper route verification', () => {
  it('tfx-route stderr prefix가 있으면 정상 경유로 판정해야 한다', () => {
    const result = verifySlimWrapperRouteExecution({
      promptText: buildSlimWrapperPrompt('codex', { subtask: 'quota strategy' }),
      stderrText: '[tfx-route] v2.3 type=codex agent=executor',
    });

    assert.equal(result.expectedRouteInvocation, true);
    assert.equal(result.usedRoute, true);
    assert.equal(result.abnormal, false);
  });

  it('route prompt인데 로그에 tfx-route 증거가 없으면 비정상 완료로 판정해야 한다', () => {
    const result = verifySlimWrapperRouteExecution({
      promptText: buildSlimWrapperPrompt('codex', { subtask: 'quota strategy' }),
      stdoutText: 'Used Read and Edit directly',
      stderrText: '',
    });

    assert.equal(result.expectedRouteInvocation, true);
    assert.equal(result.usedRoute, false);
    assert.equal(result.abnormal, true);
    assert.equal(result.reason, 'missing_tfx_route_evidence');
  });

  it('route prompt가 아니면 검증을 강제하지 않아야 한다', () => {
    const result = verifySlimWrapperRouteExecution({
      promptText: 'plain worker prompt',
      stdoutText: 'normal output',
    });

    assert.equal(result.expectedRouteInvocation, false);
    assert.equal(result.abnormal, false);
  });
});
