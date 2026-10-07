// hub/workers/factory.mjs — Worker 생성 팩토리
//
// Supported worker types:
//   - 'claude' → ClaudeWorker
//   - 'codex'  → CodexMcpWorker
//
import { ClaudeWorker } from "./claude-worker.mjs";

/**
 * @param {'claude'|'codex'} type
 * @param {object} [opts]
 * @returns {Promise<import('./interface.mjs').IWorker>}
 */
export async function createWorker(type, opts = {}) {
  switch (type) {
    case "claude":
      return new ClaudeWorker(opts);
    case "codex": {
      const { CodexMcpWorker } = await import("./codex-mcp.mjs");
      return new CodexMcpWorker(opts);
    }
    default:
      throw new Error(`Unknown worker type: ${type}`);
  }
}
