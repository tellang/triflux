export const DELEGATOR_MCP_SERVER_INFO = Object.freeze({
  name: 'triflux-delegator',
  version: '0.1.0',
});

export const DELEGATOR_TOOL_NAMES = Object.freeze({
  delegate: 'delegate',
  delegateReply: 'delegate-reply',
  status: 'status',
});

export const DELEGATOR_PIPE_ACTIONS = Object.freeze({
  delegate: 'delegator_delegate',
  delegateReply: 'delegator_reply',
  status: 'delegator_status',
});

export const DELEGATOR_JOB_STATUSES = Object.freeze([
  'queued',
  'running',
  'waiting_reply',
  'completed',
  'failed',
]);

export const DELEGATOR_MODES = Object.freeze([
  'sync',
  'async',
]);

export const DELEGATOR_PROVIDERS = Object.freeze([
  'auto',
  'codex',
  'gemini',
]);

export const DELEGATOR_SCHEMA_URL = new URL('./schema/delegator-tools.schema.json', import.meta.url);
