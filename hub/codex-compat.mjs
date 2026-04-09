// hub/codex-compat.mjs — backward-compatible facade for legacy imports

/** @experimental 런타임 미연결 — 향후 통합 예정 */
export {
  buildExecCommand,
  CODEX_MCP_EXECUTION_EXIT_CODE,
  CODEX_MCP_TRANSPORT_EXIT_CODE,
  escapePwshSingleQuoted,
  FEATURES,
  getCodexVersion,
  gte,
} from "./cli-adapter-base.mjs";
