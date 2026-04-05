// tests/unit/remote-session.test.mjs — remote-session 모듈 단위 테스트 (Lake 3)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateHost,
  shellQuote,
  escapePwshSingleQuoted,
  escapePwshDoubleQuoted,
  resolveRemoteDir,
  resolveRemoteStageDir,
} from '../../hub/team/remote-session.mjs';

const WIN_ENV = Object.freeze({ home: 'C:\\Users\\test', os: 'win32', shell: 'pwsh', claudePath: 'C:\\Users\\test\\.local\\bin\\claude.exe' });
const LINUX_ENV = Object.freeze({ home: '/home/test', os: 'linux', shell: 'bash', claudePath: '/home/test/.local/bin/claude' });
const DARWIN_ENV = Object.freeze({ home: '/Users/test', os: 'darwin', shell: 'zsh', claudePath: '/Users/test/.local/bin/claude' });

describe('remote-session — validateHost', () => {
  it('R-01: 유효한 호스트명 통과', () => {
    assert.equal(validateHost('ultra4'), 'ultra4');
    assert.equal(validateHost('my-server.local'), 'my-server.local');
    assert.equal(validateHost('192.168.1.1'), '192.168.1.1');
  });

  it('R-02: 위험한 호스트명 거부', () => {
    assert.throws(() => validateHost('host;rm -rf'), /invalid host/);
    assert.throws(() => validateHost('host$(cmd)'), /invalid host/);
    assert.throws(() => validateHost(''), /invalid host/);
    assert.throws(() => validateHost(null), /invalid host/);
  });
});

describe('remote-session — shell quoting', () => {
  it('R-03: shellQuote — single quotes escaped', () => {
    assert.equal(shellQuote("hello"), "'hello'");
    assert.equal(shellQuote("it's"), "'it'\\''s'");
  });

  it('R-04: escapePwshSingleQuoted — doubles single quotes', () => {
    assert.equal(escapePwshSingleQuoted("it's"), "it''s");
  });

  it('R-05: escapePwshDoubleQuoted — escapes backticks and double quotes', () => {
    assert.equal(escapePwshDoubleQuoted('say "hello"'), 'say `"hello`"');
    assert.equal(escapePwshDoubleQuoted('`tick`'), '``tick``');
  });
});

describe('remote-session — resolveRemoteDir', () => {
  it('R-06: Linux — ~ 확장, 절대경로, 상대경로', () => {
    assert.equal(resolveRemoteDir('~', LINUX_ENV), '/home/test');
    assert.equal(resolveRemoteDir('~/projects', LINUX_ENV), '/home/test/projects');
    assert.equal(resolveRemoteDir('/opt/app', LINUX_ENV), '/opt/app');
    assert.equal(resolveRemoteDir('projects', LINUX_ENV), '/home/test/projects');
    assert.equal(resolveRemoteDir('', LINUX_ENV), '/home/test');
  });

  it('R-07: macOS — 동일 posix 로직', () => {
    assert.equal(resolveRemoteDir('~/Desktop', DARWIN_ENV), '/Users/test/Desktop');
    assert.equal(resolveRemoteDir('', DARWIN_ENV), '/Users/test');
  });

  it('R-08: Windows — backslash 정규화 + 절대경로', () => {
    assert.equal(resolveRemoteDir('~', WIN_ENV), 'C:\\Users\\test');
    assert.equal(resolveRemoteDir('C:\\Projects', WIN_ENV), 'C:\\Projects');
    assert.equal(resolveRemoteDir('Desktop', WIN_ENV), 'C:\\Users\\test\\Desktop');
  });
});

describe('remote-session — resolveRemoteStageDir', () => {
  it('R-09: Linux staging path 포맷', () => {
    const result = resolveRemoteStageDir(LINUX_ENV, 'swarm-test-123');
    assert.equal(result, '/home/test/tfx-remote/swarm-test-123');
  });

  it('R-10: Windows staging path — forward slash 정규화', () => {
    const result = resolveRemoteStageDir(WIN_ENV, 'swarm-test-456');
    assert.ok(result.includes('tfx-remote/swarm-test-456'));
    assert.ok(!result.includes('\\\\'));
  });
});

describe('remote-session — planner host field', () => {
  it('R-11: parseShards에서 host 필드 파싱', async () => {
    const { parseShards } = await import('../../hub/team/swarm-planner.mjs');

    const shards = parseShards(`
## Shard: local-work
- agent: codex
- files: src/a.mjs
- prompt: local task

## Shard: remote-work
- agent: codex
- host: ultra4
- files: src/b.mjs
- prompt: remote task
`);

    assert.equal(shards.length, 2);
    assert.equal(shards[0].host, '');  // default empty
    assert.equal(shards[1].host, 'ultra4');
  });
});
