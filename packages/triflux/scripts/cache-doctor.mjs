#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  CACHE_TARGETS,
  checkSearchEngines,
  extractProjectMeta,
  probeTierEnvironment,
  resolveTargetPath,
  scanCodexSkills,
} from "./cache-warmup.mjs";

const TARGET_PAYLOAD_BUILDERS = Object.freeze({
  codexSkills: scanCodexSkills,
  tierEnvironment: probeTierEnvironment,
  projectMeta: extractProjectMeta,
  searchEngines: checkSearchEngines,
});

const VOLATILE_KEYS = new Set([
  "timestamp",
  "scanned_at",
  "probed_at",
  "extracted_at",
  "checked_at",
  "generated_at",
  "built_at",
]);

function normalizeValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }
  if (value && typeof value === "object") {
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      if (VOLATILE_KEYS.has(key)) continue;
      normalized[key] = normalizeValue(value[key]);
    }
    return normalized;
  }
  return value;
}

function inspectTarget(target, options = {}) {
  const filePath = resolveTargetPath(target, options);
  if (!existsSync(filePath)) {
    return { target, status: "missing", file: filePath };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    return {
      target,
      status: "invalid",
      file: filePath,
      error: error.message,
    };
  }

  const expected = TARGET_PAYLOAD_BUILDERS[target](options);
  const currentComparable = JSON.stringify(normalizeValue(parsed));
  const expectedComparable = JSON.stringify(normalizeValue(expected));

  if (currentComparable !== expectedComparable) {
    return {
      target,
      status: "mismatch",
      file: filePath,
    };
  }

  return {
    target,
    status: "ok",
    file: filePath,
  };
}

export function verifyCaches(options = {}) {
  const targets = options.targets?.length ? options.targets : Object.keys(CACHE_TARGETS);
  const results = targets.map((target) => inspectTarget(target, options));
  const issueCount = results.filter((result) => result.status !== "ok").length;

  return {
    ok: issueCount === 0,
    issue_count: issueCount,
    results,
  };
}

export async function fixCaches(options = {}) {
  const verification = options.verification || verifyCaches(options);
  const brokenTargets = verification.results
    .filter((result) => result.status !== "ok")
    .map((result) => result.target);

  if (brokenTargets.length === 0) {
    return {
      ok: true,
      fixed: [],
      summary: { ok: true, built: 0, skipped: 0, failed: 0, results: [] },
    };
  }

  const warmup = await import("./cache-warmup.mjs");
  const summary = warmup.buildAll({
    ...options,
    force: true,
    targets: brokenTargets,
  });

  return {
    ok: summary.ok,
    fixed: brokenTargets,
    summary,
  };
}

function formatVerificationSummary(verification) {
  const label = verification.ok ? "cache-doctor: ok" : "cache-doctor: issues";
  const details = verification.results.map((result) => `${result.target}:${result.status}`);
  return `${label} (${details.join(", ")})`;
}

async function main() {
  const shouldFix = process.argv.includes("--fix");
  const verification = verifyCaches();

  if (!shouldFix) {
    console.log(formatVerificationSummary(verification));
    if (!verification.ok) process.exitCode = 1;
    return;
  }

  const repair = await fixCaches({ verification });
  const repaired = repair.fixed.length > 0 ? `fixed:${repair.fixed.join(",")}` : "fixed:none";
  const suffix = repair.summary.results.map((result) => `${result.target}:${result.status}`).join(", ");
  console.log(`cache-doctor: fix (${repaired}${suffix ? `, ${suffix}` : ""})`);
  if (!repair.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
