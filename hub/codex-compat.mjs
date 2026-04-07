// hub/codex-compat.mjs — backward-compatible facade for legacy imports

/** @experimental 런타임 미연결 — Codex 호환 레이어, 향후 통합 예정 */
export {
  CODEX_MCP_EXECUTION_EXIT_CODE,
  CODEX_MCP_TRANSPORT_EXIT_CODE,
  FEATURES,
  buildExecCommand,
  escapePwshSingleQuoted,
  getCodexVersion,
  gte,
} from './cli-adapter-base.mjs';
