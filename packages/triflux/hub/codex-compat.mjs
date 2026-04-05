// hub/codex-compat.mjs — backward-compatible facade for legacy imports

export {
  CODEX_MCP_EXECUTION_EXIT_CODE,
  CODEX_MCP_TRANSPORT_EXIT_CODE,
  FEATURES,
  buildExecCommand,
  escapePwshSingleQuoted,
  getCodexVersion,
  gte,
} from './cli-adapter-base.mjs';
