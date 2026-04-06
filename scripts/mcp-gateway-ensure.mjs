#!/usr/bin/env node
// mcp-gateway-ensure.mjs — SessionStart 훅에서 supergateway MCP 서비스 보장
// hub-ensure.mjs 패턴을 따름. 가볍게 헬스체크만 수행하고 필요시 기동.

import { existsSync, } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PID_FILE = join(tmpdir(), 'tfx-gateway-pids.json');
const PROBE_PORT = 8100; // context7 — 첫 번째 게이트웨이 포트로 alive 프로브
const PROBE_TIMEOUT_MS = 1500;
const STARTUP_WAIT_MS = 4000;
const POLL_INTERVAL_MS = 500;

/**
 * 단일 포트 /healthz 프로브로 게이트웨이 클러스터 alive 판정.
 * 모든 포트를 체크하면 hook timeout(8s)에 걸리므로 대표 포트 1개만 확인.
 */
async function isGatewayAlive() {
  try {
    const res = await fetch(`http://127.0.0.1:${PROBE_PORT}/healthz`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 매니페스트 파일 존재 여부로 gateway 설치 판정 (빠른 경로) */
function hasManifest() {
  return existsSync(PID_FILE);
}

/** mcp-gateway-start.mjs를 독립 프로세스로 기동 */
function startGateway() {
  const scriptPath = join(PLUGIN_ROOT, 'scripts', 'mcp-gateway-start.mjs');
  if (!existsSync(scriptPath)) return false;

  try {
    // PowerShell Start-Process: Windows Job Object에서 벗어나 부모 종료 후 생존
    execSync(
      `powershell -NoProfile -Command "Start-Process -WindowStyle Hidden -FilePath '${process.execPath}' -ArgumentList '${scriptPath.replaceAll("'", "''")}'"`
    , { stdio: 'ignore', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

/** 게이트웨이 기동 후 프로브 포트 ready 대기 */
async function waitForGatewayReady(maxWaitMs = STARTUP_WAIT_MS) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await isGatewayAlive()) return true;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

// ── main ──

// 빠른 경로: 매니페스트 존재 + 프로브 포트 살아있으면 즉시 OK
if (hasManifest() && await isGatewayAlive()) {
  process.stdout.write('gateway: ok');
  process.exit(0);
}

// 매니페스트 없으면 gateway가 설정되지 않은 상태 — 조용히 스킵
if (!hasManifest()) {
  process.stdout.write('gateway: not configured');
  process.exit(0);
}

// 느린 경로: 게이트웨이 기동 시도
const started = startGateway();
if (started) {
  const ready = await waitForGatewayReady();
  process.stdout.write(ready ? 'gateway: ok' : 'gateway: starting');
} else {
  process.stderr.write('[gateway-ensure] start failed');
}
