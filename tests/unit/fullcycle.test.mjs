import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createFullcycleRunId,
  ensureFullcycleRunDir,
  findLatestInterviewPlan,
  readFullcycleArtifact,
  readFullcycleState,
  saveFullcycleArtifact,
  shouldStopQaLoop,
  writeFullcycleState,
} from '../../hub/fullcycle.mjs';

describe('fullcycle runtime helpers', () => {
  const tmpBase = join(
    new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'),
    '../../.tfx-fullcycle-test-tmp',
  );

  before(async () => {
    await mkdir(tmpBase, { recursive: true });
  });

  after(async () => {
    await rm(tmpBase, { recursive: true, force: true });
  });

  it('createFullcycleRunId()는 파일명 안전한 run id를 만든다', () => {
    const runId = createFullcycleRunId(new Date('2026-04-03T00:00:00.123Z'));
    assert.match(runId, /^2026-04-03_00-00-00-123Z$/);
  });

  it('ensureFullcycleRunDir()는 .tfx/fullcycle/{run-id} 디렉토리를 만든다', () => {
    const dir = ensureFullcycleRunDir('run-a', tmpBase);
    assert.ok(dir.includes('.tfx'));
    assert.ok(dir.includes('fullcycle'));
    assert.ok(dir.endsWith(join('fullcycle', 'run-a')));
  });

  it('saveFullcycleArtifact()/readFullcycleArtifact()는 아티팩트를 round-trip 한다', () => {
    const path = saveFullcycleArtifact('run-b', 'expanded-spec.md', '# spec\n', tmpBase);
    const content = readFullcycleArtifact('run-b', 'expanded-spec.md', tmpBase);
    assert.ok(path.endsWith(join('fullcycle', 'run-b', 'expanded-spec.md')));
    assert.equal(content, '# spec\n');
  });

  it('writeFullcycleState()/readFullcycleState()는 state.json을 round-trip 한다', () => {
    writeFullcycleState('run-c', {
      current_phase: 'qa',
      last_successful_phase: 'execution',
      failure_reason: 'same error',
    }, tmpBase);

    const state = readFullcycleState('run-c', tmpBase);
    assert.deepEqual(state, {
      current_phase: 'qa',
      last_successful_phase: 'execution',
      failure_reason: 'same error',
    });
  });

  it('findLatestInterviewPlan()은 최신 interview plan 경로를 반환한다', async () => {
    const plansDir = join(tmpBase, '.tfx', 'plans');
    await mkdir(plansDir, { recursive: true });
    const older = join(plansDir, 'interview-older.md');
    const newer = join(plansDir, 'interview-newer.md');
    await writeFile(older, '# older\n', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(newer, '# newer\n', 'utf8');

    const latest = findLatestInterviewPlan(tmpBase);
    assert.equal(latest, newer);
  });

  it('shouldStopQaLoop()은 동일 실패가 3회 연속이면 true를 반환한다', () => {
    assert.equal(
      shouldStopQaLoop(['lint error', 'lint error', 'lint error']),
      true,
    );
  });

  it('shouldStopQaLoop()은 중간에 다른 실패가 끼면 false를 반환한다', () => {
    assert.equal(
      shouldStopQaLoop(['lint error', 'type error', 'lint error']),
      false,
    );
  });
});
