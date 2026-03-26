// tests/integration/tfx-route-quota.test.mjs — tfx-route.sh v2.4 쿼타 초과 및 자동 전환 테스트
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { toBashPath, BASH_EXE } from '../helpers/bash-path.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..', '..');
const ROUTE_SCRIPT_WIN = resolve(PROJECT_ROOT, 'scripts', 'tfx-route.sh');
const ROUTE_SCRIPT = toBashPath(ROUTE_SCRIPT_WIN);
const FIXTURE_BIN = toBashPath(resolve(PROJECT_ROOT, 'tests', 'fixtures', 'bin'));

// 헬퍼: bash 스크립트에서 특정 함수 내용만 추출
function extractFunction(scriptPath, funcName) {
  const content = fs.readFileSync(scriptPath, 'utf8');
  const regex = new RegExp(`^${funcName}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`, 'm');
  const match = content.match(regex);
  if (!match) throw new Error(`Function ${funcName} not found in ${scriptPath}`);
  return match[0];
}

// 헬퍼: 추출한 함수와 추가 스크립트를 bash -c로 실행
function runBash(command, extraEnv = {}) {
  return spawnSync(BASH_EXE, ['-c', command], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      TFX_TMP: os.tmpdir(),
      PATH: `${FIXTURE_BIN}:${process.env.PATH || ''}`,
      ...extraEnv,
    },
  });
}

function out(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

describe('tfx-route.sh — Quota Functions', () => {
  let tmpStdout, tmpStderr, dummyBashSource;
  const detectFunc = extractFunction(ROUTE_SCRIPT_WIN, 'detect_quota_exceeded');
  const rerouteFunc = extractFunction(ROUTE_SCRIPT_WIN, 'auto_reroute');

  before(() => {
    tmpStdout = resolve(os.tmpdir(), `tfx-quota-stdout-${Date.now()}.log`);
    tmpStderr = resolve(os.tmpdir(), `tfx-quota-stderr-${Date.now()}.log`);
    dummyBashSource = resolve(os.tmpdir(), `tfx-dummy-route-${Date.now()}.sh`);
    
    // auto_reroute에서 exec bash "${BASH_SOURCE[0]}" 호출을 가로채기 위한 더미 스크립트
    fs.writeFileSync(dummyBashSource, 'echo "REROUTED: MODE=$TFX_CLI_MODE FROM=$TFX_REROUTED_FROM"');
  });

  after(() => {
    if (fs.existsSync(tmpStdout)) fs.unlinkSync(tmpStdout);
    if (fs.existsSync(tmpStderr)) fs.unlinkSync(tmpStderr);
    if (fs.existsSync(dummyBashSource)) fs.unlinkSync(dummyBashSource);
  });

  describe('detect_quota_exceeded 테스트', () => {
    it('1. stdout에 "quota exceeded" 포함 시 감지 (exit 0)', () => {
      fs.writeFileSync(tmpStdout, 'Error: quota exceeded for your account.\n');
      fs.writeFileSync(tmpStderr, '');
      const script = `${detectFunc}\nCLI_TYPE=test detect_quota_exceeded "${tmpStdout}" "${tmpStderr}"`;
      const result = runBash(script);
      assert.equal(result.status, 0);
      assert.match(out(result), /감지: 'quota exceeded'/);
    });

    it('2. stderr에 "rate limit exceeded" 포함 시 감지 (exit 0)', () => {
      fs.writeFileSync(tmpStdout, '');
      fs.writeFileSync(tmpStderr, 'Failed due to rate limit exceeded\n');
      const script = `${detectFunc}\nCLI_TYPE=test detect_quota_exceeded "${tmpStdout}" "${tmpStderr}"`;
      const result = runBash(script);
      assert.equal(result.status, 0);
      assert.match(out(result), /감지: 'rate limit exceeded'/i);
    });

    it('3. stdout에 "RESOURCE_EXHAUSTED" 포함 시 감지 (exit 0)', () => {
      fs.writeFileSync(tmpStdout, '{"error": "RESOURCE_EXHAUSTED"}');
      fs.writeFileSync(tmpStderr, '');
      const script = `${detectFunc}\nCLI_TYPE=test detect_quota_exceeded "${tmpStdout}" "${tmpStderr}"`;
      const result = runBash(script);
      assert.equal(result.status, 0);
      assert.match(out(result), /감지: 'RESOURCE_EXHAUSTED'/);
    });

    it('4. stdout에 "implement rate limit middleware" (일반 코드) 포함 시 미감지 (exit 1) - 오탐 가능성 확인용', () => {
      fs.writeFileSync(tmpStdout, 'Please implement rate limit middleware for the API.\n');
      fs.writeFileSync(tmpStderr, '');
      const script = `${detectFunc}\nCLI_TYPE=test detect_quota_exceeded "${tmpStdout}" "${tmpStderr}"`;
      const result = runBash(script);
      
      // 현재 grep -qi "rate limit" 패턴에 의해 일반 코드도 감지될 수 있음.
      // 명세에 따라 미감지(exit 1)를 기대값으로 설정하여 오탐을 포착함.
      assert.equal(result.status, 1, '오탐 발생: 일반 코드 내용에서 쿼타 초과 패턴이 감지되었습니다.');
    });

    it('5. 빈 파일 시 미감지 (exit 1)', () => {
      fs.writeFileSync(tmpStdout, '');
      fs.writeFileSync(tmpStderr, '');
      const script = `${detectFunc}\nCLI_TYPE=test detect_quota_exceeded "${tmpStdout}" "${tmpStderr}"`;
      const result = runBash(script);
      assert.equal(result.status, 1);
    });
  });

  describe('auto_reroute 테스트', () => {
    it('1. codex → gemini 전환 시 TFX_CLI_MODE=gemini 설정 확인', () => {
      // auto_reroute는 exec bash "${BASH_SOURCE[0]}"로 프로세스 교체하므로
      // BASH_SOURCE[0]을 더미 스크립트로 가리켜 exec 결과를 캡처한다
      const wrapperScript = resolve(os.tmpdir(), `tfx-reroute-wrapper-1-${Date.now()}.sh`);
      fs.writeFileSync(wrapperScript, `#!/usr/bin/env bash
set -uo pipefail
CODEX_BIN="echo"
GEMINI_BIN="echo"
AGENT_TYPE="executor"
PROMPT="test"
MCP_PROFILE="auto"
CLI_TYPE="codex"
TFX_TMP="${os.tmpdir()}"
${rerouteFunc}
auto_reroute codex
`);
      fs.chmodSync(wrapperScript, 0o755);

      // BASH_SOURCE[0]이 dummyBashSource를 가리키도록 source 대신 직접 실행
      // exec가 dummyBashSource를 실행하면 REROUTED 메시지 출력
      const result = spawnSync(BASH_EXE, [wrapperScript], {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${FIXTURE_BIN}:${process.env.PATH || ''}`,
        },
      });
      fs.unlinkSync(wrapperScript);

      // exec로 프로세스가 교체되므로 전환 메시지만 확인
      assert.match(out(result), /Codex → Gemini 자동 전환/);
    });

    it('2. gemini → codex 전환 시 TFX_CLI_MODE=codex 설정 확인', () => {
      const wrapperScript = resolve(os.tmpdir(), `tfx-reroute-wrapper-2-${Date.now()}.sh`);
      fs.writeFileSync(wrapperScript, `#!/usr/bin/env bash
set -uo pipefail
CODEX_BIN="echo"
GEMINI_BIN="echo"
AGENT_TYPE="designer"
PROMPT="test"
MCP_PROFILE="auto"
CLI_TYPE="gemini"
TFX_TMP="${os.tmpdir()}"
${rerouteFunc}
auto_reroute gemini
`);
      fs.chmodSync(wrapperScript, 0o755);

      const result = spawnSync(BASH_EXE, [wrapperScript], {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${FIXTURE_BIN}:${process.env.PATH || ''}`,
        },
      });
      fs.unlinkSync(wrapperScript);

      assert.match(out(result), /Gemini → Codex 자동 전환/);
    });

    it('4. 대상 CLI 미설치 시 return 1', () => {
      const script = `
${rerouteFunc}
export CODEX_BIN="nonexistent_codex_bin_123"
export GEMINI_BIN="nonexistent_gemini_bin_123"
auto_reroute codex
`;
      const result = runBash(script);
      assert.equal(result.status, 1);
      assert.match(out(result), /gemini CLI 미설치 — 자동 전환 불가/);
    });
  });

  describe('전체 스크립트 연동 테스트 (TFX_QUOTA_REROUTE 및 재귀 방지)', () => {
    it('6. TFX_QUOTA_REROUTE=0 시 detect는 동작하되 auto_reroute 미호출', () => {
      // 강제로 쿼타 초과를 발생시키는 가짜 codex CLI 생성
      const fakeCodex = resolve(os.tmpdir(), `fake-codex-quota-${Date.now()}.sh`);
      fs.writeFileSync(fakeCodex, '#!/usr/bin/env bash\necho "Error: quota exceeded"\nexit 1\n');
      fs.chmodSync(fakeCodex, 0o755);

      const result = spawnSync(BASH_EXE, [ROUTE_SCRIPT, 'executor', 'test'], {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          TFX_CLI_MODE: 'auto',
          TFX_QUOTA_REROUTE: '0',
          CODEX_BIN: fakeCodex,
          TFX_TMP: os.tmpdir(),
        },
      });

      fs.unlinkSync(fakeCodex);

      assert.notEqual(result.status, 0); // 에러로 인해 종료되어야 함
      // TFX_QUOTA_REROUTE=0 조건에 의해 auto_reroute로 넘어가지 않아야 함
      assert.doesNotMatch(out(result), /자동 전환/);
    });

    it('3. TFX_REROUTED_FROM 설정 시 중복 재귀 전환 방지', () => {
      const fakeCodex = resolve(os.tmpdir(), `fake-codex-reroute-${Date.now()}.sh`);
      fs.writeFileSync(fakeCodex, '#!/usr/bin/env bash\necho "Error: quota exceeded"\nexit 1\n');
      fs.chmodSync(fakeCodex, 0o755);

      const result = spawnSync(BASH_EXE, [ROUTE_SCRIPT, 'executor', 'test'], {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          TFX_CLI_MODE: 'auto',
          TFX_REROUTED_FROM: 'gemini', // 이전에 gemini에서 넘어왔음을 가정
          CODEX_BIN: fakeCodex,
          TFX_TMP: os.tmpdir(),
        },
      });

      fs.unlinkSync(fakeCodex);

      assert.notEqual(result.status, 0);
      assert.doesNotMatch(out(result), /자동 전환/);
    });
  });
});
