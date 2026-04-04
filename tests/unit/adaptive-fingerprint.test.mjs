import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildAdaptiveFingerprint,
  createAdaptiveFingerprintService,
  loadAdaptiveFingerprint,
  saveAdaptiveFingerprint,
} from '../../hub/adaptive-fingerprint.mjs';
import { createMemoryStore } from '../../hub/store-adapter.mjs';

describe('hub/adaptive-fingerprint.mjs', () => {
  it('세션 컨텍스트에서 경로/작업유형/시간대 기반 fingerprint를 계산한다', () => {
    const context = {
      scope: 'project-alpha',
      cwd: '/workspace/triflux',
      files: [
        '/workspace/triflux/hub/server.mjs',
        '/workspace/triflux/hub/store-adapter.mjs',
      ],
      workType: 'bug fix',
      timezone: 'Asia/Seoul',
      activityTimestamps: [
        1_775_196_000_000,
        1_775_199_600_000,
        1_775_203_200_000,
      ],
    };

    const first = buildAdaptiveFingerprint(context, { now: () => 1_775_210_000_000 });
    const second = buildAdaptiveFingerprint(context, { now: () => 1_775_220_000_000 });

    assert.equal(first.scope, 'project-alpha');
    assert.equal(first.path_pattern.count, 2);
    assert.deepEqual(first.path_pattern.sample_paths, [
      'hub/server.mjs',
      'hub/store-adapter.mjs',
    ]);
    assert.equal(first.work_type.normalized, 'bug-fix');
    assert.equal(first.timezone_pattern.timezone, 'Asia/Seoul');
    assert.equal(first.timezone_pattern.sample_count, 3);
    assert.equal(first.fingerprint_id, second.fingerprint_id);
  });

  it('store-adapter(memory)와 연동해 fingerprint를 저장/조회한다', async () => {
    const store = createMemoryStore();
    const scope = 'session-42';

    const record = buildAdaptiveFingerprint({
      scope,
      filePath: '/repo/hub/adaptive-fingerprint.mjs',
      work_type: 'analysis',
      timezone: 'UTC',
    }, { now: () => 1_775_230_000_000 });

    await saveAdaptiveFingerprint(store, scope, record, {
      retryOptions: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    });

    const loaded = await loadAdaptiveFingerprint(store, scope);
    assert.equal(loaded.fingerprint_id, record.fingerprint_id);

    loaded.path_pattern.sample_paths[0] = 'mutated';
    const reloaded = await loadAdaptiveFingerprint(store, scope);
    assert.notEqual(reloaded.path_pattern.sample_paths[0], 'mutated');
  });

  it('retry/backoff 옵션으로 저장 재시도 후 health를 healthy로 유지한다', async () => {
    let attempts = 0;
    const store = {
      saveAdaptiveFingerprint() {
        attempts += 1;
        if (attempts < 3) throw new Error('temporary write failure');
        return { ok: true };
      },
    };

    const service = createAdaptiveFingerprintService({
      store,
      retryOptions: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
      now: () => 1_775_240_000_000,
    });

    await service.captureFingerprint({ filePath: '/repo/a.mjs', workType: 'plan' });

    assert.equal(attempts, 3);
    assert.equal(service.getHealth().state, 'healthy');
  });

  it('저장 실패가 누적되면 health를 degraded로 표시한다', async () => {
    const service = createAdaptiveFingerprintService({
      store: {
        saveAdaptiveFingerprint() {
          throw new Error('persistent failure');
        },
      },
      retryOptions: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      now: () => 1_775_250_000_000,
    });

    await assert.rejects(
      service.captureFingerprint({ filePath: '/repo/b.mjs', workType: 'fix' }),
      /persistent failure/,
    );

    const health = service.getHealth();
    assert.equal(health.state, 'degraded');
    assert.equal(health.last_error?.message, 'persistent failure');
  });
});
