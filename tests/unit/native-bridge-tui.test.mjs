import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTeamArgs } from '../../hub/team/cli/commands/start/parse-args.mjs';

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
