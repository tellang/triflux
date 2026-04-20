// hub/team/worker-completion-validator.mjs — Enforce worker completion schema.
// Issue #115 Lane 1 / F7_worker_did_not_commit.
//
// A shard worker MUST emit a completion JSON with `status: "ok"` + a non-empty
// `commits_made` array. Reporting without committing is the #1 cause of lost
// swarm work — guarded here before integration trusts the worker.

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

  const valid = compiled(payload);
  if (!valid) {
    const firstError = compiled.errors?.[0];
    const reason = formatError(firstError, payload);
    return { ok: false, reason };
  }

  // BUG-G (#130): the schema's if-then only constrains commits_made when
  // status='ok', so status='failed' payloads pass AJV vacuously. Without
  // this guard the hypervisor F7 path treats a worker self-reported failure
  // as a successful completion and integrates phantom shards.
  if (payload.status === "failed") {
    const detail =
      typeof payload.reason === "string" && payload.reason.length > 0
        ? payload.reason
        : "unspecified";
    return { ok: false, reason: `worker_self_reported_failure:${detail}` };
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
