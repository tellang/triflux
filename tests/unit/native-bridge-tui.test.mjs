import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseTeamArgs } from '../../hub/team/cli/commands/start/parse-args.mjs';
import { writeBridgeSession } from '../../hub/team/headless-bridge-session.mjs';

// Setup Mock State Dir
const MOCK_STATE_DIR = path.join(os.tmpdir(), `mock-claude-state-${Date.now()}`);

test('CLI start parser should resolve --native-bridge option correctly', () => {
  const result = parseTeamArgs(['start', '--native-bridge']);
  assert.equal(result.nativeBridge, true, 'nativeBridge should be parsed as true when --native-bridge is passed');
});

test('CLI start parser should resolve -nb option correctly', () => {
  const result = parseTeamArgs(['start', '-nb']);
  assert.equal(result.nativeBridge, true, 'nativeBridge should be parsed as true when -nb is passed');
});

test('CLI start parser should default nativeBridge to false', () => {
  const result = parseTeamArgs(['start']);
  assert.equal(result.nativeBridge, false, 'nativeBridge should default to false');
});

test('Session persistence should write valid JSON to sessions folder', async () => {
  const testSessionId = 'session_hl_test_99';
  const testSocket = '/tmp/claude-test-99.sock';
  
  await fs.mkdir(path.join(MOCK_STATE_DIR, 'sessions'), { recursive: true });
  
  // Call actual implementation
  await writeBridgeSession(testSessionId, testSocket, MOCK_STATE_DIR);
  
  const filePath = path.join(MOCK_STATE_DIR, 'sessions', `${testSessionId}.json`);
  
  const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
  assert.equal(fileExists, true, 'Session file must be written to disk');
  
  const content = await fs.readFile(filePath, 'utf8');
  const data = JSON.parse(content);
  
  assert.equal(data.session_id, testSessionId, 'Session ID must match');
  assert.equal(data.messagingSock, testSocket, 'Socket path must match');
  assert.equal(data.status, 'RUNNING', 'Status must be RUNNING');
  
  // Cleanup mock dir
  await fs.rm(MOCK_STATE_DIR, { recursive: true, force: true });
});

test('runHeadless must bypass psmux loop when nativeBridge option is true', async () => {
  const { runHeadless } = await import('../../hub/team/headless.mjs');
  
  const result = await runHeadless('session_nb_test', [], { nativeBridge: true });
  
  assert.equal(result.bypassed, true, 'Should bypass and return bypassed true');
  assert.equal(result.status, 'ok', 'Should return status ok');
});



