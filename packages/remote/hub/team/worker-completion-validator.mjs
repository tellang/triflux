// hub/team/worker-completion-validator.mjs — Enforce worker completion schema.
// Issue #115 Lane 1 / F7_worker_did_not_commit.
//
// A shard worker that reports `status: "ok"` MUST include a non-empty
// `commits_made` array. Non-ok statuses are valid terminal reports, but they
// are not allowed to masquerade as successful completion.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";

const schemaPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "schemas",
  "worker-completion.json",
);
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

const ajv = new Ajv({ allErrors: true, strict: false });
const compiled = ajv.compile(schema);

/**
 * Validate a worker completion payload against worker-completion.json.
 * Returns `{ ok: true }` when the payload satisfies the schema, otherwise
 * `{ ok: false, reason }` with a short human-readable reason string.
 *
 * @param {unknown} payload
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validateWorkerCompletion(payload) {
  if (payload === null || typeof payload !== "object") {
    return { ok: false, reason: "payload_not_object" };
  }

  const status = payload.status;
  if (!["ok", "failed", "blocked"].includes(status)) {
    return { ok: false, reason: `invalid_status:${status ?? "undefined"}` };
  }

  const schemaPayload =
    status === "blocked" ? { ...payload, status: "failed" } : payload;
  const valid = compiled(schemaPayload);
  if (!valid) {
    const firstError = compiled.errors?.[0];
    const reason = formatError(firstError, payload);
    return { ok: false, reason };
  }

  return { ok: true };
}

function formatError(err, payload) {
  if (!err) return "schema_validation_failed";

  // Map Ajv keywords to short, actionable reasons.
  if (
    err.keyword === "required" &&
    err.params?.missingProperty === "commits_made"
  ) {
    return "missing_commits_made";
  }
  if (err.keyword === "minItems" && err.instancePath === "/commits_made") {
    return "empty_commits_made";
  }
  if (err.keyword === "enum" && err.instancePath === "/status") {
    return `invalid_status:${payload?.status ?? "undefined"}`;
  }
  if (err.keyword === "type" && err.instancePath === "/commits_made") {
    return "commits_made_not_array";
  }
  if (err.keyword === "required" && err.params?.missingProperty === "status") {
    return "missing_status";
  }

  const path = err.instancePath || "(root)";
  return `${err.keyword}@${path}:${err.message}`;
}
