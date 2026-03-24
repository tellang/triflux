import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

import { createPipeline } from '../../hub/pipeline/index.mjs';

// 테스트 전용 임시 디렉토리 (CWD를 오염시키지 않기 위해)
const TEST_BASE = resolve(import.meta.dirname, '..', '..', '.test-tmp-pipeline');

describe('pipeline.writePlanFile()', () => {
  let db;
  let origCwd;

  beforeEach(() => {
    // CWD를 임시 디렉토리로 이동
    rmSync(TEST_BASE, { recursive: true, force: true });
    mkdirSync(TEST_BASE, { recursive: true });
    origCwd = process.cwd();
    process.chdir(TEST_BASE);

    // in-memory SQLite
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
    process.chdir(origCwd);
    rmSync(TEST_BASE, { recursive: true, force: true });
  });

  it('T1-01: writePlanFile()은 .tfx/plans/{teamName}-plan.md를 생성한다', () => {
    const pipeline = createPipeline(db, 'alpha');
    const content = '# Plan\n\n- step 1\n- step 2\n';

    const planPath = pipeline.writePlanFile(content);

    const expectedPath = join(resolve(TEST_BASE, '.tfx', 'plans'), 'alpha-plan.md');
    assert.equal(planPath, expectedPath);
    assert.ok(existsSync(planPath), 'plan 파일이 디스크에 존재해야 한다');
    assert.equal(readFileSync(planPath, 'utf8'), content);
  });

  it('T1-02: writePlanFile()은 setArtifact("plan_path")를 동시에 호출한다', () => {
    const pipeline = createPipeline(db, 'bravo');
    const content = '# Bravo Plan\n';

    const planPath = pipeline.writePlanFile(content);
    const state = pipeline.getState();

    assert.equal(state.artifacts.plan_path, planPath);
  });

  it('T1-03: 기존 plan 파일을 덮어쓰기할 수 있다', () => {
    const pipeline = createPipeline(db, 'charlie');

    pipeline.writePlanFile('# v1\n');
    const path2 = pipeline.writePlanFile('# v2 — updated\n');

    assert.equal(readFileSync(path2, 'utf8'), '# v2 — updated\n');
    // artifact도 최신 경로
    assert.equal(pipeline.getState().artifacts.plan_path, path2);
  });

  it('T1-04: teamName의 특수문자(<>:"/\\|?*)가 안전하게 치환된다', () => {
    const pipeline = createPipeline(db, 'team<>:bad|name');
    const content = '# Special\n';

    const planPath = pipeline.writePlanFile(content);

    // 파일명에 위험 문자가 포함되지 않아야 한다
    const basename = planPath.split(/[\\/]/).pop();
    assert.equal(basename, 'team___bad_name-plan.md');
    assert.ok(existsSync(planPath));
    assert.equal(readFileSync(planPath, 'utf8'), content);
  });
});
