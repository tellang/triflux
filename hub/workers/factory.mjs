// hub/workers/factory.mjs — Worker 생성 팩토리
//
// Supported worker types:
//   - 'gemini'           → GeminiWorker
//   - 'claude'           → ClaudeWorker
//   - 'codex'            → CodexMcpWorker (default) or CodexAppServerWorker when
//                          opts.transport === 'app-server'
//   - 'codex-app-server' → CodexAppServerWorker (explicit alias)
//   - 'delegator'        → DelegatorMcpWorker
//
// For the codex app-server transport the factory injects a default
// `publishCallback` that forwards each envelope to `/bridge/publish` via the
// existing `requestJson` helper. Callers can override by passing their own
// `publishCallback` or swap the transport with `requestJsonFn`.

import { requestJson } from "../bridge.mjs";
import { ClaudeWorker } from "./claude-worker.mjs";
import { CodexAppServerWorker } from "./codex-app-server-worker.mjs";
import { CodexMcpWorker } from "./codex-mcp.mjs";
import { DelegatorMcpWorker } from "./delegator-mcp.mjs";
import { GeminiWorker } from "./gemini-worker.mjs";

/**
 * Build a best-effort publishCallback that posts the envelope to
 * `/bridge/publish`. Failures are swallowed so publish pressure never crashes
 * a running worker turn.
 * @param {(path: string, opts?: object) => Promise<unknown>} [requestJsonFn]
 * @returns {(publishMessage: object) => Promise<void>}
 */
function defaultPublishCallback(requestJsonFn = requestJson) {
  return async (publishMessage) => {
    try {
      await requestJsonFn("/bridge/publish", { body: publishMessage });
    } catch {
      // best-effort; publish failures must not crash the worker
    }
  };
}

/**
 * Construct a CodexAppServerWorker with a default publishCallback wired to
 * `requestJson('/bridge/publish', ...)` unless the caller supplied one.
 * @param {object} [opts]
 */
function createCodexWorker(opts = {}) {
  const { transport, requestJsonFn, publishCallback, ...rest } = opts;

  if (transport === "app-server") {
    return new CodexAppServerWorker({
      ...rest,
      publishCallback:
        typeof publishCallback === "function"
          ? publishCallback
          : defaultPublishCallback(requestJsonFn),
    });
  }

  // Default (and transport === 'mcp'): CodexMcpWorker with zero new deps.
  return new CodexMcpWorker(rest);
}

/**
 * @param {'gemini'|'claude'|'codex'|'codex-app-server'|'delegator'} type
 * @param {object} [opts]
 * @returns {import('./interface.mjs').IWorker}
 */
export function createWorker(type, opts = {}) {
  switch (type) {
    case "gemini":
      return new GeminiWorker(opts);
    case "claude":
      return new ClaudeWorker(opts);
    case "codex":
      return createCodexWorker(opts);
    case "codex-app-server":
      return createCodexWorker({ ...opts, transport: "app-server" });
    case "delegator":
      return new DelegatorMcpWorker(opts);
    default:
      throw new Error(`Unknown worker type: ${type}`);
  }
}
