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

let createWorker = null;

for (const candidate of FACTORY_CANDIDATES) {
  if (!existsSync(candidate)) continue;
  ({ createWorker } = await import(pathToFileURL(candidate).href));
  break;
}

if (!createWorker) {
  throw new Error('worker factory module not found');
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
  const candidate = resolve(cwd, '.mcp.json');
  return existsSync(candidate) ? [candidate] : [];
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
  const result = await worker.run(prompt);
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
