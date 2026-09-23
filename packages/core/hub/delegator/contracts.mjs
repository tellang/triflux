export const DELEGATOR_JOB_STATUSES = Object.freeze([
  "queued",
  "running",
  "waiting_reply",
  "completed",
  "failed",
]);

export const DELEGATOR_MODES = Object.freeze(["sync", "async"]);

export const DELEGATOR_PROVIDERS = Object.freeze([
  "auto",
  "codex",
  "antigravity",
  "gemini",
]);

export const DELEGATOR_SCHEMA_URL = new URL(
  "./schema/delegator-tools.schema.json",
  import.meta.url,
);
