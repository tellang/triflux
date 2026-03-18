// hub/workers/factory.mjs — Worker 생성 팩토리

import { GeminiWorker } from './gemini-worker.mjs';
import { ClaudeWorker } from './claude-worker.mjs';
import { CodexMcpWorker } from './codex-mcp.mjs';
import { DelegatorMcpWorker } from './delegator-mcp.mjs';

export function createWorker(type, opts = {}) {
  switch (type) {
    case 'gemini':
      return new GeminiWorker(opts);
    case 'claude':
      return new ClaudeWorker(opts);
    case 'codex':
      return new CodexMcpWorker(opts);
    case 'delegator':
      return new DelegatorMcpWorker(opts);
    default:
      throw new Error(`Unknown worker type: ${type}`);
  }
}
