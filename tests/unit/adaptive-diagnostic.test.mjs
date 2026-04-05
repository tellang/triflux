import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_KNOWN_ERRORS_PATH,
  createDiagnosticPipeline,
  loadKnownErrors,
  matchKnownError,
} from '../../hub/adaptive-diagnostic.mjs';
import { createMemoryStore } from '../../hub/store-adapter.mjs';
import { normalizeError } from '../../hub/reflexion.mjs';

describe('hub/adaptive-diagnostic.mjs', () => {
  it('known-errors 시드 데이터를 로드한다', () => {
    const catalog = loadKnownErrors(DEFAULT_KNOWN_ERRORS_PATH);

    assert.equal(catalog.version, 1);
    assert.ok(catalog.signatures.length >= 1);
    assert.ok(catalog.signatures.some((signature) => signature.id === 'ssh-powershell-devnull'));
  });

  it('시드된 알려진 에러를 매칭하고 rule template를 렌더링한다', () => {
    const catalog = loadKnownErrors(DEFAULT_KNOWN_ERRORS_PATH);
    const diagnosis = matchKnownError(catalog, {
      error: "Could not find a part of the path 'C:\\dev.null'",
      tool: 'Bash',
      context: 'SSH 명령 실행',
      host: 'win-host',
      dna: {
        remote: {
          os: 'powershell',
        },
      },
    });

    assert.equal(diagnosis?.matched, true);
    assert.equal(diagnosis?.source, 'known');
    assert.equal(diagnosis?.signature_id, 'ssh-powershell-devnull');
    assert.match(diagnosis?.rule || '', /win-host/);
    assert.match(diagnosis?.fix || '', /suppressStderr/);
    assert.ok(diagnosis?.confidence >= 0.95);
  });

  it('알 수 없는 에러를 adaptive rule로 기록하고 재발 시 adaptive 진단으로 승격한다', () => {
    const store = createMemoryStore();
    const pipeline = createDiagnosticPipeline({ store });
    const error = 'TimeoutError: worker stalled on remote pane 12';
    const projectSlug = 'project-alpha';
    const pattern = normalizeError(error);

    const first = pipeline.diagnose({
      error,
      projectSlug,
      tool: 'Bash',
      context: 'remote exec',
    });

    assert.equal(first.matched, false);
    assert.equal(first.source, 'novel');
    assert.equal(store.findAdaptiveRule(projectSlug, pattern)?.hit_count, 1);

    const second = pipeline.diagnose({
      error,
      projectSlug,
      tool: 'Bash',
      context: 'remote exec',
    });

    assert.equal(second.matched, true);
    assert.equal(second.source, 'adaptive');
    assert.equal(second.adaptive_rule?.hit_count, 2);
    assert.ok(second.confidence > first.confidence);
  });

  it('known errors 파일을 읽지 못하면 health를 degraded로 표시한다', () => {
    const pipeline = createDiagnosticPipeline({
      knownErrorsPath: 'hub/lib/missing-known-errors.json',
    });

    const diagnosis = pipeline.diagnose({
      error: 'CompletelyUnknownError: no seed exists',
      projectSlug: 'project-beta',
    });

    assert.equal(diagnosis.source, 'novel');
    assert.equal(pipeline.getHealth().state, 'degraded');
    assert.match(pipeline.getHealth().last_error?.message || '', /missing-known-errors/);
  });

  it('listKnownErrors는 외부 변경으로부터 안전한 복사본을 반환한다', () => {
    const pipeline = createDiagnosticPipeline();
    const signatures = pipeline.listKnownErrors();

    signatures[0].tool = 'mutated';

    const reloaded = pipeline.listKnownErrors();
    assert.notEqual(reloaded[0].tool, 'mutated');
  });
});
