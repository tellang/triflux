// hub/workers/factory.mjs — Worker 생성 팩토리
//
// Supported worker types:
//   - 'claude'           → ClaudeWorker
//   - 'codex'            → CodexMcpWorker (default) or CodexAppServerWorker when
//                          opts.transport === 'app-server'
//   - 'codex-app-server' → CodexAppServerWorker (explicit alias)
//   - 'delegator'        → DelegatorMcpWorker
//
import { ClaudeWorker } from "./claude-worker.mjs";
import { CodexAppServerWorker } from "./codex-app-server-worker.mjs";

/**
 * 호출자가 지정한 발행 콜백만 연결한다.
 *
 * Issue #95 P1 #4 validation: the app-server transport does not yet implement
 * the server-initiated approval / `tool/requestUserInput` round-trip. Any
 * `approvalPolicy !== 'never'` would cause a codex turn to hang waiting for
 * an approval response the worker cannot produce. Reject such configs at
 * factory time with a clear, actionable message.
 *
 * @param {object} [opts]
 */
async function createCodexWorker(opts = {}) {
  const { transport, requestJsonFn, publishCallback, ...rest } = opts;
  void requestJsonFn;

  if (transport === "app-server") {
    const policy = rest.approvalPolicy;
    if (policy !== undefined && policy !== null && policy !== "never") {
      throw new Error(
        `codex app-server transport currently requires approvalPolicy='never' (got '${policy}'). ` +
          "The server-initiated approval / tool/requestUserInput round-trip is not yet implemented. " +
          "Set approvalPolicy='never' or use transport='mcp'. " +
          "Tracked in follow-up issue.",
      );
    }
    return new CodexAppServerWorker({
      ...rest,
      publishCallback:
        typeof publishCallback === "function" ? publishCallback : null,
    });
  }

  // Default (and transport === 'mcp'): CodexMcpWorker with zero new deps.
  const { CodexMcpWorker } = await import("./codex-mcp.mjs");
  return new CodexMcpWorker(rest);
}

/**
 * @param {'claude'|'codex'|'codex-app-server'|'delegator'} type
 * @param {object} [opts]
 * @returns {Promise<import('./interface.mjs').IWorker>}
 */
export async function createWorker(type, opts = {}) {
  switch (type) {
    case "claude":
      return new ClaudeWorker(opts);
    case "codex":
      return createCodexWorker(opts);
    case "codex-app-server":
      return createCodexWorker({ ...opts, transport: "app-server" });
    case "delegator": {
      const { DelegatorMcpWorker } = await import("./delegator-mcp.mjs");
      return new DelegatorMcpWorker(opts);
    }
    default:
      throw new Error(`Unknown worker type: ${type}`);
  }
}
