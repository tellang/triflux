import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import hookAdaptiveCollector, {
  __resetAdaptiveCollectorForTests,
  __setAdaptiveCollectorFactoryForTests,
} from '../../hooks/hook-adaptive-collector.mjs';

afterEach(() => {
  __resetAdaptiveCollectorForTests();
  mock.restoreAll();
});

describe('hooks/hook-adaptive-collector.mjs', () => {
  it('성공 이벤트와 Read 실패는 무시한다', () => {
    let created = 0;
    __setAdaptiveCollectorFactoryForTests(() => {
      created += 1;
      return { startSession() {}, handleError() { return null; } };
    });

    assert.equal(hookAdaptiveCollector({ exitCode: 0, tool: 'Bash' }), null);
    assert.equal(hookAdaptiveCollector({ exitCode: 1, tool: 'Read' }), null);
    assert.equal(created, 0);
  });

  it('실패 이벤트를 trim하여 adaptive 엔진으로 전달하고 승격 로그를 남긴다', () => {
    const handleCalls = [];
    const errors = [];
    mock.method(console, 'error', (message) => errors.push(String(message)));

    __setAdaptiveCollectorFactoryForTests(() => ({
      startSession() {},
      handleError(errorContext) {
        handleCalls.push(errorContext);
        return {
          diagnosed: true,
          promoted: true,
          rule: { id: 'rule-1', tier: 3 },
        };
      },
    }));

    const result = hookAdaptiveCollector({
      exitCode: 1,
      tool: 'Bash',
      stderr: 'x'.repeat(600),
      command: 'y'.repeat(260),
    });

    assert.equal(result.diagnosed, true);
    assert.equal(handleCalls.length, 1);
    assert.equal(handleCalls[0].stderr.length, 500);
    assert.equal(handleCalls[0].command.length, 200);
    assert.equal(errors.length, 2);
    assert.match(errors[0], /rule-1/);
    assert.match(errors[1], /Tier 3/);
  });
});
