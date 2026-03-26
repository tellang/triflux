// tests/integration/hub-restart.test.mjs — try_restart_hub() + team_claim_task() 복구 통합 테스트
//
// 테스트 범위:
//   - Hub 서버 스크립트 미발견 시 에러 반환
//   - Hub 재시작 성공 시 return 0 + 성공 메시지
//   - Hub 재시작 실패 (타임아웃) 시 return 1 + 실패 메시지
//   - TFX_HUB_URL에서 포트 추출 동작
//   - team_claim_task()에서 Hub 미응답 시 try_restart_hub() 호출 + claim 재시도
//   - Hub 재시작 후 claim 재시도 실패 시 경고 후 계속 실행
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { toBashPath, BASH_EXE } from '../helpers/bash-path.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..', '..');
const ROUTE_SCRIPT = toBashPath(resolve(PROJECT_ROOT, 'scripts', 'tfx-route.sh'));
const FIXTURE_BIN = toBashPath(resolve(PROJECT_ROOT, 'tests', 'fixtures', 'bin'));

function output(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

// try_restart_hub() 함수를 단독 테스트하기 위한 bash 래퍼 생성
// hub_server_path: node 스크립트 경로 (실제 또는 fake)
// hub_url: curl 대상 URL
function createHubRestartWrapper(hubServerPath, hubUrl) {
  // Windows 경로를 Unix 스타일로 변환 (Git Bash 호환)
  const unixPath = hubServerPath.replace(/\\/g, '/');
  // hub_url에서 bash 변수 확장 방지를 위해 single-quote 사용
  return `#!/usr/bin/env bash
set -euo pipefail

NODE_BIN="$(command -v node)"
TFX_HUB_URL='${hubUrl}'

try_restart_hub() {
  local hub_server hub_port
  hub_server='${unixPath}'

  if [[ ! -f "$hub_server" ]]; then
    echo "[tfx-route] Hub 서버 스크립트 미발견: $hub_server" >&2
    return 1
  fi

  hub_port="\${TFX_HUB_URL##*:}"
  hub_port="\${hub_port%%/*}"
  [[ -z "$hub_port" || "$hub_port" == "$TFX_HUB_URL" ]] && hub_port=27888

  echo "[tfx-route] Hub 미응답 — 자동 재시작 시도 (port=$hub_port)..." >&2
  TFX_HUB_PORT="$hub_port" "$NODE_BIN" "$hub_server" </dev/null >/dev/null 2>&1 &
  disown 2>/dev/null || true
  local hub_pid=\$!

  local i
  for i in 1 2 3; do
    sleep 0.2
    if curl -sf --connect-timeout 2 --max-time 3 "\${TFX_HUB_URL}/status" >/dev/null 2>&1; then
      echo "[tfx-route] Hub 재시작 성공 (pid=$hub_pid)" >&2
      return 0
    fi
  done

  echo "[tfx-route] Hub 재시작 실패 — claim 없이 계속 실행" >&2
  return 1
}

try_restart_hub
`;
}

function runBashScript(script, env = {}, timeoutMs = 15000) {
  return spawnSync(BASH_EXE, ['-c', script], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, ...env },
  });
}

// fake hub 스크립트 생성
function createFakeHubScript(tempDir, opts = {}) {
  const scriptPath = join(tempDir, 'fake-server.mjs');
  if (opts.serve) {
    // TFX_HUB_PORT 환경변수로 받은 포트에서 /status 응답하는 미니 서버
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env node
import { createServer } from 'node:http';
const port = parseInt(process.env.TFX_HUB_PORT || '27888', 10);
const s = createServer((req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hub: 'fake', port, pid: process.pid }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
s.listen(port, '127.0.0.1');
setTimeout(() => { s.close(); process.exit(0); }, 10000);
`,
    );
  } else {
    // 서버 없이 조용히 종료 — curl이 실패하도록
    writeFileSync(scriptPath, '#!/usr/bin/env node\n// no-op\n');
  }
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

// ── try_restart_hub() 단위 테스트 ──

describe('try_restart_hub() — Hub 서버 스크립트 미발견', () => {
  it('hub/server.mjs가 없으면 return 1과 에러 메시지를 출력해야 한다', () => {
    const script = createHubRestartWrapper(
      '/nonexistent/path/hub/server.mjs',
      'http://127.0.0.1:29999',
    );
    const result = runBashScript(script);

    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /Hub 서버 스크립트 미발견/);
  });
});

describe('try_restart_hub() — Hub 재시작 성공', () => {
  it('Hub /status가 응답 가능해지면 재시작 성공을 반환해야 한다', () => {
    // fake hub가 TFX_HUB_PORT에서 /status를 서빙 → try_restart_hub가 시작 후 curl 성공
    const testPort = 27950 + Math.floor(Math.random() * 40);
    const tempDir = mkdtempSync(join(tmpdir(), 'tfx-hub-ok-'));
    try {
      const fakeHub = createFakeHubScript(tempDir, { serve: true });
      const script = createHubRestartWrapper(
        fakeHub,
        `http://127.0.0.1:${testPort}`,
      );
      const result = runBashScript(script, {}, 15000);

      assert.equal(result.status, 0, output(result));
      assert.match(output(result), /Hub 재시작 성공/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('try_restart_hub() — Hub 재시작 실패 (타임아웃)', () => {
  it('curl이 계속 실패하면 return 1과 실패 메시지를 출력해야 한다', () => {
    // fake hub (no-op → 서버 미시작) + port 0 → curl이 항상 실패
    const tempDir = mkdtempSync(join(tmpdir(), 'tfx-hub-fail-'));
    try {
      const fakeHub = createFakeHubScript(tempDir);
      const script = createHubRestartWrapper(
        fakeHub,
        'http://127.0.0.1:0',
      );
      const result = runBashScript(script);

      assert.notEqual(result.status, 0, output(result));
      assert.match(output(result), /Hub 재시작 실패/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('try_restart_hub() — TFX_HUB_URL 포트 추출', () => {
  it('TFX_HUB_URL에서 포트를 올바르게 추출하여 curl 체크에 사용해야 한다', () => {
    const testPort = 27850 + Math.floor(Math.random() * 40);
    const tempDir = mkdtempSync(join(tmpdir(), 'tfx-hub-port-'));
    try {
      // serve: true → fake hub가 추출된 포트에서 서버 시작
      const fakeHub = createFakeHubScript(tempDir, { serve: true });
      const script = createHubRestartWrapper(
        fakeHub,
        `http://127.0.0.1:${testPort}`,
      );
      const result = runBashScript(script, {}, 15000);

      assert.match(output(result), new RegExp(`port=${testPort}`));
      assert.match(output(result), /Hub 미응답 — 자동 재시작 시도/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TFX_HUB_URL이 비어있으면 기본 포트 27888을 사용해야 한다', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tfx-hub-default-port-'));
    try {
      const fakeHub = createFakeHubScript(tempDir);
      const script = createHubRestartWrapper(fakeHub, '');
      const result = runBashScript(script);

      assert.match(output(result), /port=27888/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ── team_claim_task() + try_restart_hub() 통합 테스트 ──
// 전체 tfx-route.sh 경로를 통해 team_claim_task 복구 흐름을 검증
// try_restart_hub()는 실제 hub/server.mjs를 시작하므로 Hub가 실제 기동됨

describe('team_claim_task() — Hub 미응답 시 try_restart_hub() 복구 경로', () => {
  it('bridge_cli가 빈 응답을 반환하면 Hub 자동 재시작 시도 메시지를 출력해야 한다', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tfx-hub-claim-retry-'));
    const logPath = join(tempDir, 'bridge.log');
    const callCountFile = join(tempDir, 'call-count');
    writeFileSync(callCountFile, '0');

    // 첫 claim은 exit 1 (Hub 다운), 이후 claim은 성공
    const customBridge = join(tempDir, 'retry-bridge.mjs');
    writeFileSync(
      customBridge,
      `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const logPath = process.env.FAKE_BRIDGE_LOG;
if (logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n', 'utf8');
}

const countFile = process.env.BRIDGE_CALL_COUNT_FILE;
const cmd = process.argv[2];

if (cmd === 'team-task-update' && process.argv.includes('--claim')) {
  let count = parseInt(readFileSync(countFile, 'utf8'), 10);
  count++;
  writeFileSync(countFile, String(count));

  if (count === 1) {
    process.exit(1);
  } else {
    console.log(JSON.stringify({ ok: true, data: { claimed: true, updated: true } }));
  }
} else if (cmd === 'team-task-update') {
  console.log(JSON.stringify({ ok: true, data: { updated: true } }));
} else if (cmd === 'team-send-message') {
  console.log(JSON.stringify({ ok: true, data: { message_id: 'msg-retry' } }));
} else if (cmd === 'result') {
  console.log(JSON.stringify({ ok: true, data: { message_id: 'result-retry' } }));
} else {
  console.log(JSON.stringify({ ok: true, data: {} }));
}
`,
    );
    chmodSync(customBridge, 0o755);

    try {
      // 임의 포트 사용 — 실제 Hub가 해당 포트에서 시작됨
      const testPort = 28800 + Math.floor(Math.random() * 100);
      const result = spawnSync(
        BASH_EXE,
        ['-c', `bash "${ROUTE_SCRIPT}" executor 'hub-claim-retry-test' minimal 5`],
        {
          cwd: PROJECT_ROOT,
          encoding: 'utf8',
          timeout: 45000,
          env: {
            ...process.env,
            PATH: `${FIXTURE_BIN}:${process.env.PATH || ''}`,
            FAKE_CODEX_MODE: 'exec',
            TFX_CODEX_TRANSPORT: 'exec',
            TFX_TEAM_NAME: 'hub-restart-team',
            TFX_TEAM_TASK_ID: 'task-restart-001',
            TFX_TEAM_AGENT_NAME: 'executor-restart-test',
            TFX_TEAM_LEAD_NAME: 'team-lead',
            TFX_BRIDGE_SCRIPT: customBridge,
            FAKE_BRIDGE_LOG: logPath,
            BRIDGE_CALL_COUNT_FILE: callCountFile,
            TFX_HUB_URL: `http://127.0.0.1:${testPort}`,
            TFX_CLI_MODE: 'auto',
            TFX_NO_CLAUDE_NATIVE: '0',
            TFX_WORKER_INDEX: '',
            TFX_SEARCH_TOOL: '',
          },
        },
      );

      const out = output(result);
      // Hub 자동 재시작 시도 확인
      assert.match(out, /Hub 미응답 — 자동 재시작 시도/);
      // Hub 재시작 후 claim 성공 또는 claim 없이 계속 (환경에 따라)
      assert.match(out, /Hub 재시작 후 claim 성공|claim 없이 계속 실행/);

      // bridge 호출 로그에서 claim이 최소 1번 이상 발생했는지 확인
      const calls = readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line).argv);
      const claimCalls = calls.filter(
        (argv) => argv[0] === 'team-task-update' && argv.includes('--claim'),
      );
      assert.ok(claimCalls.length >= 1, `claim 호출이 최소 1번이어야 함: ${JSON.stringify(claimCalls)}`);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('Hub 재시작 실패 시에도 실행을 계속해야 한다', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tfx-hub-claim-nohub-'));
    const logPath = join(tempDir, 'bridge.log');

    // claim만 항상 exit 1 반환하는 bridge
    const failBridge = join(tempDir, 'fail-bridge.mjs');
    writeFileSync(
      failBridge,
      `#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const logPath = process.env.FAKE_BRIDGE_LOG;
if (logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n', 'utf8');
}

const cmd = process.argv[2];

if (cmd === 'team-task-update' && process.argv.includes('--claim')) {
  process.exit(1);
} else if (cmd === 'team-task-update') {
  console.log(JSON.stringify({ ok: true, data: { updated: true } }));
} else if (cmd === 'team-send-message') {
  console.log(JSON.stringify({ ok: true, data: { message_id: 'msg-fail' } }));
} else if (cmd === 'result') {
  console.log(JSON.stringify({ ok: true, data: { message_id: 'result-fail' } }));
} else {
  console.log(JSON.stringify({ ok: true, data: {} }));
}
`,
    );
    chmodSync(failBridge, 0o755);

    try {
      // 실제 Hub가 시작될 수 있는 포트 사용
      const testPort = 28900 + Math.floor(Math.random() * 100);
      const result = spawnSync(
        BASH_EXE,
        ['-c', `bash "${ROUTE_SCRIPT}" executor 'hub-fail-test' minimal 5`],
        {
          cwd: PROJECT_ROOT,
          encoding: 'utf8',
          timeout: 45000,
          env: {
            ...process.env,
            PATH: `${FIXTURE_BIN}:${process.env.PATH || ''}`,
            FAKE_CODEX_MODE: 'exec',
            TFX_CODEX_TRANSPORT: 'exec',
            TFX_TEAM_NAME: 'hub-fail-team',
            TFX_TEAM_TASK_ID: 'task-fail-001',
            TFX_TEAM_AGENT_NAME: 'executor-fail-test',
            TFX_TEAM_LEAD_NAME: 'team-lead',
            TFX_BRIDGE_SCRIPT: failBridge,
            FAKE_BRIDGE_LOG: logPath,
            TFX_HUB_URL: `http://127.0.0.1:${testPort}`,
            TFX_CLI_MODE: 'auto',
            TFX_NO_CLAUDE_NATIVE: '0',
            TFX_WORKER_INDEX: '',
            TFX_SEARCH_TOOL: '',
          },
        },
      );

      const out = output(result);
      // Hub 재시작 시도 메시지 확인
      assert.match(out, /Hub 미응답 — 자동 재시작 시도/);
      // claim 없이 계속 실행 (Hub 재시작 성공/실패 무관하게 claim은 항상 실패)
      assert.match(out, /claim 없이 계속 실행/);
      // 전체 실행은 성공적으로 완료 (codex exec 경로 진행)
      assert.equal(result.status, 0, output(result));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('team_send_message() / team_complete_task() — Hub 미응답 시 재시도 복구', () => {
  it('시작 메시지 전송 실패 시 Hub 재시작 후 team_send_message를 재시도해야 한다', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tfx-hub-message-retry-'));
    const logPath = join(tempDir, 'bridge.log');
    const callCountFile = join(tempDir, 'message-count');
    writeFileSync(callCountFile, '0');

    const customBridge = join(tempDir, 'message-retry-bridge.mjs');
    writeFileSync(
      customBridge,
      `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const logPath = process.env.FAKE_BRIDGE_LOG;
if (logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n', 'utf8');
}

const countFile = process.env.MESSAGE_CALL_COUNT_FILE;
const cmd = process.argv[2];

if (cmd === 'team-task-update') {
  console.log(JSON.stringify({ ok: true, data: { claimed: process.argv.includes('--claim'), updated: true } }));
} else if (cmd === 'team-send-message') {
  let count = parseInt(readFileSync(countFile, 'utf8'), 10);
  count++;
  writeFileSync(countFile, String(count));

  if (count === 1) {
    process.exit(1);
  }

  console.log(JSON.stringify({ ok: true, data: { message_id: 'msg-retry' } }));
} else if (cmd === 'result') {
  console.log(JSON.stringify({ ok: true, data: { message_id: 'result-ok' } }));
} else {
  console.log(JSON.stringify({ ok: true, data: {} }));
}
`,
    );
    chmodSync(customBridge, 0o755);

    try {
      const testPort = 29000 + Math.floor(Math.random() * 100);
      const result = spawnSync(
        BASH_EXE,
        ['-c', `bash "${ROUTE_SCRIPT}" executor 'hub-message-retry-test' minimal 5`],
        {
          cwd: PROJECT_ROOT,
          encoding: 'utf8',
          timeout: 45000,
          env: {
            ...process.env,
            PATH: `${FIXTURE_BIN}:${process.env.PATH || ''}`,
            FAKE_CODEX_MODE: 'exec',
            TFX_CODEX_TRANSPORT: 'exec',
            TFX_TEAM_NAME: 'hub-message-team',
            TFX_TEAM_TASK_ID: 'task-message-001',
            TFX_TEAM_AGENT_NAME: 'executor-message-test',
            TFX_TEAM_LEAD_NAME: 'team-lead',
            TFX_BRIDGE_SCRIPT: customBridge,
            FAKE_BRIDGE_LOG: logPath,
            MESSAGE_CALL_COUNT_FILE: callCountFile,
            TFX_HUB_URL: `http://127.0.0.1:${testPort}`,
            TFX_CLI_MODE: 'auto',
            TFX_NO_CLAUDE_NATIVE: '0',
            TFX_WORKER_INDEX: '',
            TFX_SEARCH_TOOL: '',
          },
        },
      );

      assert.equal(result.status, 0, output(result));
      assert.match(output(result), /Hub 미응답 — 자동 재시작 시도/);
      assert.match(output(result), /Hub 재시작 후 팀 메시지 전송 성공/);

      const calls = readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line).argv);
      const messageCalls = calls.filter((argv) => argv[0] === 'team-send-message');
      assert.ok(messageCalls.length >= 2, `team-send-message 재시도가 기록되어야 함: ${JSON.stringify(messageCalls)}`);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('result 발행 실패 시 Hub 재시작 후 재시도하고 완료는 backup 파일로 남겨야 한다', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tfx-hub-complete-retry-'));
    const logPath = join(tempDir, 'bridge.log');
    const resultCountFile = join(tempDir, 'complete-result-count');
    const resultDir = join(tempDir, 'results');
    writeFileSync(resultCountFile, '0');

    const customBridge = join(tempDir, 'complete-retry-bridge.mjs');
    writeFileSync(
      customBridge,
      `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const logPath = process.env.FAKE_BRIDGE_LOG;
if (logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n', 'utf8');
}

const resultCountFile = process.env.COMPLETE_RESULT_COUNT_FILE;
const cmd = process.argv[2];
const isClaim = process.argv.includes('--claim');

if (cmd === 'team-task-update' && isClaim) {
  console.log(JSON.stringify({ ok: true, data: { claimed: true, updated: true } }));
} else if (cmd === 'team-send-message') {
  console.log(JSON.stringify({ ok: true, data: { message_id: 'msg-complete' } }));
} else if (cmd === 'result') {
  let count = parseInt(readFileSync(resultCountFile, 'utf8'), 10);
  count++;
  writeFileSync(resultCountFile, String(count));

  if (count === 1) {
    process.exit(1);
  }

  console.log(JSON.stringify({ ok: true, data: { message_id: 'result-complete' } }));
} else {
  console.log(JSON.stringify({ ok: true, data: {} }));
}
`,
    );
    chmodSync(customBridge, 0o755);

    try {
      const testPort = 29100 + Math.floor(Math.random() * 100);
      const result = spawnSync(
        BASH_EXE,
        ['-c', `bash "${ROUTE_SCRIPT}" executor 'hub-complete-retry-test' minimal 5`],
        {
          cwd: PROJECT_ROOT,
          encoding: 'utf8',
          timeout: 45000,
          env: {
            ...process.env,
            PATH: `${FIXTURE_BIN}:${process.env.PATH || ''}`,
            FAKE_CODEX_MODE: 'exec',
            TFX_CODEX_TRANSPORT: 'exec',
            TFX_TEAM_NAME: 'hub-complete-team',
            TFX_TEAM_TASK_ID: 'task-complete-001',
            TFX_TEAM_AGENT_NAME: 'executor-complete-test',
            TFX_TEAM_LEAD_NAME: 'team-lead',
            TFX_BRIDGE_SCRIPT: customBridge,
            FAKE_BRIDGE_LOG: logPath,
            COMPLETE_RESULT_COUNT_FILE: resultCountFile,
            TFX_RESULT_DIR: resultDir,
            TFX_HUB_URL: `http://127.0.0.1:${testPort}`,
            TFX_CLI_MODE: 'auto',
            TFX_NO_CLAUDE_NATIVE: '0',
            TFX_WORKER_INDEX: '',
            TFX_SEARCH_TOOL: '',
          },
        },
      );

      assert.equal(result.status, 0, output(result));
      assert.match(output(result), /Hub 재시작 후 Hub result 발행 성공/);

      const calls = readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line).argv);
      const completeUpdateCalls = calls.filter(
        (argv) => argv[0] === 'team-task-update' && !argv.includes('--claim'),
      );
      const resultCalls = calls.filter((argv) => argv[0] === 'result');
      assert.equal(completeUpdateCalls.length, 0, `완료 보고 bridge 호출은 제거되어야 함: ${JSON.stringify(completeUpdateCalls)}`);
      assert.ok(resultCalls.length >= 2, `result 발행 재시도가 기록되어야 함: ${JSON.stringify(resultCalls)}`);

      const backup = JSON.parse(readFileSync(join(resultDir, 'task-complete-001.json'), 'utf8'));
      assert.equal(backup.result, 'success');
      assert.match(backup.summary, /^EXEC:hub-complete-retry-test/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
