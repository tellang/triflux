// hub/workers/factory.mjs — Worker 생성 팩토리
import { ClaudeWorker } from "./claude-worker.mjs";

/**
 * @param {'claude'} type
 * @param {object} [opts]
 * @returns {Promise<import('./interface.mjs').IWorker>}
 */
export async function createWorker(type, opts = {}) {
  switch (type) {
    case "claude":
      return new ClaudeWorker(opts);
    default:
      throw new Error(`Unknown worker type: ${type}`);
  }
}
