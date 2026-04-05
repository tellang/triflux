#!/usr/bin/env node
// tfx-route-worker.mjs — tfx-route.sh용 subprocess worker 러너

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FACTORY_CANDIDATES = [
  resolve(SCRIPT_DIR, '../hub/workers/factory.mjs'),
  resolve(SCRIPT_DIR, './hub/workers/factory.mjs'),
];

// MCP transport 실패 시 tfx-route.sh가 exec fallback을 수행할 수 있도록
// CODEX_MCP_TRANSPORT_EXIT_CODE(70)으로 종료한다.
const MCP_TRANSPORT_EXIT_CODE = 70;
const GEMINI_RETRY_DELAY_MS = 5000;
const GEMINI_RETRY_PATTERN_SNIPPETS = [
  '429',
  'quota',
  'rate limit',
  'resource_exhausted',
];

let createWorker = null;

for (const candidate of FACTORY_CANDIDATES) {
  if (!existsSync(candidate)) continue;
  try {
    ({ createWorker } = await import(pathToFileURL(candidate).href));
  } catch (err) {
    // 의존성 누락 (예: @modelcontextprotocol/sdk) → fallback 가능하도록 exit 70
    if (err.code === 'ERR_MODULE_NOT_FOUND') {
      process.stderr.write(`[tfx-route-worker] 모듈 로드 실패: ${err.message}\n`);
      process.exit(MCP_TRANSPORT_EXIT_CODE);
    }
    throw err;
  }
  break;
}

if (!createWorker) {
  process.stderr.write('[tfx-route-worker] worker factory를 찾지 못했습니다.\n');
  process.exit(MCP_TRANSPORT_EXIT_CODE);
}

function parseArgs(argv) {
  const args = {
    allowedMcpServerNames: [],
    mcpConfig: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    switch (token) {
      case '--type':
        args.type = next;
        index += 1;
        break;
      case '--command':
        args.command = next;
        index += 1;
        break;
      case '--command-args-json':
        args.commandArgsJson = next;
        index += 1;
        break;
      case '--model':
        args.model = next;
        index += 1;
        break;
      case '--timeout-ms':
        args.timeoutMs = Number(next);
        index += 1;
        break;
      case '--approval-mode':
        args.approvalMode = next;
        index += 1;
        break;
      case '--permission-mode':
        args.permissionMode = next;
        index += 1;
        break;
      case '--allow-dangerously-skip-permissions':
        args.allowDangerouslySkipPermissions = true;
        break;
      case '--allowed-mcp-server-name':
        args.allowedMcpServerNames.push(next);
        index += 1;
        break;
      case '--mcp-config':
        args.mcpConfig.push(next);
        index += 1;
        break;
      case '--cwd':
        args.cwd = next;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  if (!args.type) {
    throw new Error('--type is required');
  }

  return args;
}

function parseJsonArray(raw, label) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON array`);
    }
    return parsed.map((item) => String(item));
  } catch (error) {
    throw new Error(`${label} parse failed: ${error.message}`);
  }
}

function readPromptFromStdin() {
  return readFileSync(0, 'utf8');
}

function resolveDefaultMcpConfig(cwd) {
  const primary = resolve(cwd, '.claude', 'mcp.json');
  if (existsSync(primary)) return [primary];
  const legacy = resolve(cwd, '.mcp.json');
  if (existsSync(legacy)) return [legacy];
  process.stderr.write('[tfx-route-worker] warning: no MCP config found, hub unavailable\n');
  return [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isGeminiQuotaRetrySignal(error) {
  if (Number(error?.result?.exitCode) === 429) {
    return true;
  }

  const fragments = [
    error?.message,
    error?.stderr,
    error?.result?.stderr,
  ]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.toLowerCase());

  if (fragments.length === 0) return false;
  const merged = fragments.join('\n');
  return GEMINI_RETRY_PATTERN_SNIPPETS.some((pattern) => merged.includes(pattern));
}

async function runWorker(worker, type, prompt) {
  const maxAttempts = type === 'gemini' ? 2 : 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await worker.run(prompt);
    } catch (error) {
      lastError = error;
      const shouldRetry = (
        type === 'gemini'
        && attempt < maxAttempts
        && isGeminiQuotaRetrySignal(error)
      );

      if (!shouldRetry) {
        throw error;
      }

      process.stderr.write(
        '[tfx-route-worker] Gemini 429/quota 감지 — 5초 후 1회 재시도합니다.\n',
      );
      await sleep(GEMINI_RETRY_DELAY_MS);
    }
  }

  throw lastError;
}

const args = parseArgs(process.argv.slice(2));
const prompt = readPromptFromStdin();

const worker = createWorker(args.type, {
  command: args.command,
  commandArgs: parseJsonArray(args.commandArgsJson, '--command-args-json'),
  model: args.model,
  timeoutMs: args.timeoutMs,
  approvalMode: args.approvalMode,
  permissionMode: args.permissionMode,
  allowDangerouslySkipPermissions: args.allowDangerouslySkipPermissions,
  allowedMcpServerNames: args.allowedMcpServerNames,
  mcpConfig: args.type === 'claude' && args.mcpConfig.length === 0
    ? resolveDefaultMcpConfig(args.cwd || process.cwd())
    : args.mcpConfig,
  cwd: args.cwd || process.cwd(),
});

try {
  const result = await runWorker(worker, args.type, prompt);
  if (result.response) {
    process.stdout.write(result.response);
    if (!result.response.endsWith('\n')) process.stdout.write('\n');
  }
} catch (error) {
  if (error.stderr) {
    process.stderr.write(String(error.stderr));
    if (!String(error.stderr).endsWith('\n')) process.stderr.write('\n');
  }
  process.stderr.write(`${error.message}\n`);
  process.exitCode = error.code === 'ETIMEDOUT' ? 124 : 1;
} finally {
  try { await worker.stop(); } catch {}
}
