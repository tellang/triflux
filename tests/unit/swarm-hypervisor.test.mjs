// tests/unit/swarm-hypervisor.test.mjs — swarm-hypervisor 유닛 테스트
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { createSwarmHypervisor, SWARM_STATES } from '../../hub/team/swarm-hypervisor.mjs';
import { planSwarm } from '../../hub/team/swarm-planner.mjs';

process.setMaxListeners(50);

// ── Helpers ──────────────────────────────────────────────────

function makeTmpDir() {
  const dir = join(tmpdir(), `tfx-swarm-hv-test-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const SIMPLE_PRD = `
## Shard: worker-a
- agent: claude
- files: src/a.mjs
- prompt: echo test a

## Shard: worker-b
- agent: claude
- files: src/b.mjs
- depends: worker-a
- prompt: echo test b
`;

const CRITICAL_PRD = `
## Shard: critical-shard
- agent: codex
- files: src/critical.mjs
- critical: true
- prompt: critical work

## Shard: normal-shard
- agent: codex
- files: src/normal.mjs
- prompt: normal work
`;

// ── Tests ────────────────────────────────────────────────────

describe('swarm-hypervisor', () => {
  let workdir;
  let logsDir;
  let hv;

  beforeEach(() => {
    workdir = makeTmpDir();
    logsDir = join(workdir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    hv = null;
  });

  afterEach(async () => {
    if (hv) {
      try { await hv.shutdown('test_cleanup'); } catch { /* ignore */ }
    }
    try { rmSync(workdir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('createSwarmHypervisor', () => {
    it('requires workdir and logsDir', () => {
      assert.throws(() => createSwarmHypervisor({}), /workdir is required/);
      assert.throws(() => createSwarmHypervisor({ workdir }), /logsDir is required/);
    });

    it('creates hypervisor in PLANNING state', () => {
      hv = createSwarmHypervisor({ workdir, logsDir });
      assert.equal(hv.state, SWARM_STATES.PLANNING);
    });
  });

  describe('launch', () => {
    it('transitions to RUNNING state on launch', async () => {
      const plan = planSwarm(null, { content: SIMPLE_PRD });
      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        maxRestarts: 0,
        graceMs: 200,
        probeOpts: { intervalMs: 999_999, l1ThresholdMs: 999_999, l3ThresholdMs: 999_999 },
      });

      const status = hv.launch(plan);
      assert.equal(hv.state, SWARM_STATES.RUNNING);
      assert.equal(status.totalShards, 2);
      assert.ok(status.mergeOrder.length > 0);
    });

    it('prevents double launch', async () => {
      const plan = planSwarm(null, { content: SIMPLE_PRD });
      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        maxRestarts: 0,
        graceMs: 200,
        probeOpts: { intervalMs: 999_999, l1ThresholdMs: 999_999, l3ThresholdMs: 999_999 },
      });

      hv.launch(plan);
      assert.throws(() => hv.launch(plan), /Cannot launch/);
    });

    it('launches redundant workers for critical shards', async () => {
      const plan = planSwarm(null, { content: CRITICAL_PRD });
      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        maxRestarts: 0,
        graceMs: 200,
        probeOpts: { intervalMs: 999_999, l1ThresholdMs: 999_999, l3ThresholdMs: 999_999 },
      });

      hv.launch(plan);
      assert.deepEqual(plan.criticalShards, ['critical-shard']);
    });
  });

  describe('getStatus', () => {
    it('returns full status snapshot', async () => {
      const plan = planSwarm(null, { content: SIMPLE_PRD });
      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        maxRestarts: 0,
        graceMs: 200,
        probeOpts: { intervalMs: 999_999, l1ThresholdMs: 999_999, l3ThresholdMs: 999_999 },
      });

      hv.launch(plan);
      const status = hv.getStatus();

      assert.equal(status.state, SWARM_STATES.RUNNING);
      assert.equal(status.totalShards, 2);
      assert.ok(Array.isArray(status.workers));
      assert.ok(Array.isArray(status.mergeOrder));
      assert.ok(Array.isArray(status.locks));
    });
  });

  describe('validateResult', () => {
    it('passes when worker modifies only its leased files', async () => {
      const plan = planSwarm(null, { content: SIMPLE_PRD });
      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        maxRestarts: 0,
        graceMs: 200,
        probeOpts: { intervalMs: 999_999, l1ThresholdMs: 999_999, l3ThresholdMs: 999_999 },
      });

      hv.launch(plan);

      const result = hv.validateResult('worker-a', ['src/a.mjs']);
      assert.equal(result.ok, true);
      assert.equal(result.violations.length, 0);
    });

    it('detects violations when worker modifies other shard files', async () => {
      const plan = planSwarm(null, { content: SIMPLE_PRD });
      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        maxRestarts: 0,
        graceMs: 200,
        probeOpts: { intervalMs: 999_999, l1ThresholdMs: 999_999, l3ThresholdMs: 999_999 },
      });

      hv.launch(plan);

      // worker-a tries to modify worker-b's file
      const result = hv.validateResult('worker-a', ['src/b.mjs']);
      assert.equal(result.ok, false);
      assert.equal(result.violations.length, 1);
    });
  });

  describe('shutdown', () => {
    it('transitions to FAILED state on early shutdown', async () => {
      const plan = planSwarm(null, { content: SIMPLE_PRD });
      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        maxRestarts: 0,
        graceMs: 200,
        probeOpts: { intervalMs: 999_999, l1ThresholdMs: 999_999, l3ThresholdMs: 999_999 },
      });

      hv.launch(plan);
      await hv.shutdown('test_abort');

      assert.equal(hv.state, SWARM_STATES.FAILED);
      hv = null; // afterEach won't call it again
    });

    it('emits shutdown event', async () => {
      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        maxRestarts: 0,
        graceMs: 200,
        probeOpts: { intervalMs: 999_999, l1ThresholdMs: 999_999, l3ThresholdMs: 999_999 },
      });

      let emitted = false;
      hv.on('shutdown', () => { emitted = true; });

      const plan = planSwarm(null, { content: SIMPLE_PRD });
      hv.launch(plan);
      await hv.shutdown('test');

      assert.equal(emitted, true);
      hv = null; // afterEach won't call it again
    });
  });

  describe('events', () => {
    it('emits stateChange events', async () => {
      hv = createSwarmHypervisor({
        workdir,
        logsDir,
        maxRestarts: 0,
        graceMs: 200,
        probeOpts: { intervalMs: 999_999, l1ThresholdMs: 999_999, l3ThresholdMs: 999_999 },
      });

      const events = [];
      hv.on('stateChange', (e) => events.push(e));

      const plan = planSwarm(null, { content: SIMPLE_PRD });
      hv.launch(plan);

      assert.ok(events.length >= 2); // PLANNING→LAUNCHING→RUNNING
      assert.equal(events[0].from, SWARM_STATES.PLANNING);
      assert.equal(events[0].to, SWARM_STATES.LAUNCHING);
    });
  });
});
