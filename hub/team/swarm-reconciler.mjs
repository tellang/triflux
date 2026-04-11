// hub/team/swarm-reconciler.mjs — Redundant execution + result reconciliation
// For critical shards: launches primary + verifier sessions, compares results,
// applies conservative adoption (fewer changes wins) or HITL fallback.
// v2 (Synapse): parses X-Intent trailers to route complementary/contradictory
// commits through intent-aware paths before falling back to conservative logic.

import { execFile } from "node:child_process";

import { classifyIntentPair, parseIntentTrailer } from "./swarm-intent.mjs";

/**
 * Compare two shard results and decide which to accept.
 * Strategy: conservative adoption — the result with fewer changed files wins.
 * If results are identical (same diff), primary is accepted.
 * If they diverge significantly, mark for HITL review.
 *
 * @param {object} primaryResult — { branchName, worktreePath, status }
 * @param {object} verifierResult — { branchName, worktreePath, status }
 * @param {object} [opts]
 * @param {string} [opts.rootDir=process.cwd()]
 * @param {number} [opts.maxDivergenceFiles=5] — beyond this, trigger HITL
 * @returns {Promise<ReconcileDecision>}
 */
export async function reconcile(primaryResult, verifierResult, opts = {}) {
  const { rootDir = process.cwd(), maxDivergenceFiles = 5 } = opts;

  // If either failed, pick the one that succeeded
  if (
    primaryResult.status !== "completed" &&
    verifierResult.status === "completed"
  ) {
    return decision("verifier", "primary_failed", verifierResult);
  }
  if (
    verifierResult.status !== "completed" &&
    primaryResult.status === "completed"
  ) {
    return decision("primary", "verifier_failed", primaryResult);
  }
  if (
    primaryResult.status !== "completed" &&
    verifierResult.status !== "completed"
  ) {
    return decision("none", "both_failed", null);
  }

  // Both completed — compare diffs
  const primaryDiff = await getDiffStat(primaryResult.branchName, rootDir);
  const verifierDiff = await getDiffStat(verifierResult.branchName, rootDir);

  // Identical diffs → accept primary (no divergence)
  if (primaryDiff.hash === verifierDiff.hash) {
    return decision("primary", "identical", primaryResult);
  }

  // Intent-aware classification: parse X-Intent trailers from both commits.
  // When both commits carry an intent, route contradictory pairs to HITL and
  // complementary (non-overlapping) pairs to a merge-friendly path. Missing or
  // malformed trailers fall through to the existing divergence/conservative
  // adoption logic below.
  const [primaryMsg, verifierMsg] = await Promise.all([
    getCommitMessage(primaryResult.branchName, rootDir),
    getCommitMessage(verifierResult.branchName, rootDir),
  ]);

  const primaryIntent = parseIntentTrailer(primaryMsg);
  const verifierIntent = parseIntentTrailer(verifierMsg);

  if (primaryIntent && verifierIntent) {
    const classification = classifyIntentPair(primaryIntent, verifierIntent);

    if (classification.relation === "contradictory") {
      return {
        selected: "hitl",
        reason: `intent_contradictory: ${classification.reason}`,
        result: null,
        requiresManualReview: true,
        intentClassification: classification,
        primaryIntent,
        verifierIntent,
        primary: {
          filesChanged: primaryDiff.filesChanged,
          linesChanged: primaryDiff.linesChanged,
        },
        verifier: {
          filesChanged: verifierDiff.filesChanged,
          linesChanged: verifierDiff.linesChanged,
        },
      };
    }

    if (classification.relation === "complementary") {
      return {
        selected: "complementary",
        reason: `intent_complementary: ${classification.reason}`,
        result: { primary: primaryResult, verifier: verifierResult },
        requiresManualReview: false,
        intentClassification: classification,
        primaryIntent,
        verifierIntent,
        shouldAttemptMerge: true,
        primary: {
          filesChanged: primaryDiff.filesChanged,
          linesChanged: primaryDiff.linesChanged,
        },
        verifier: {
          filesChanged: verifierDiff.filesChanged,
          linesChanged: verifierDiff.linesChanged,
        },
      };
    }

    // complementary-risky / independent → fall through to existing logic.
  }

  // Compute divergence
  const divergence = Math.abs(
    primaryDiff.filesChanged - verifierDiff.filesChanged,
  );

  // High divergence → HITL
  if (divergence > maxDivergenceFiles) {
    return {
      selected: "hitl",
      reason: `divergence_too_high (${divergence} files differ)`,
      result: null,
      requiresManualReview: true,
      primary: {
        filesChanged: primaryDiff.filesChanged,
        linesChanged: primaryDiff.linesChanged,
      },
      verifier: {
        filesChanged: verifierDiff.filesChanged,
        linesChanged: verifierDiff.linesChanged,
      },
    };
  }

  // Conservative adoption: fewer changes wins
  if (primaryDiff.linesChanged <= verifierDiff.linesChanged) {
    return decision("primary", "conservative_adoption", primaryResult);
  }
  return decision("verifier", "conservative_adoption", verifierResult);
}

function decision(selected, reason, result) {
  return {
    selected,
    reason,
    result,
    requiresManualReview: selected === "hitl" || selected === "none",
    primary: null,
    verifier: null,
  };
}

/**
 * Read the HEAD commit message of a branch.
 *
 * @param {string} branch
 * @param {string} cwd
 * @returns {Promise<string>}
 */
async function getCommitMessage(branch, cwd) {
  try {
    const msg = await gitExec(["log", "-1", "--format=%B", branch], cwd);
    return msg;
  } catch {
    return "";
  }
}

/**
 * Get diff statistics for a branch relative to its merge-base.
 *
 * @param {string} branch
 * @param {string} cwd
 * @returns {Promise<{ filesChanged: number, linesChanged: number, hash: string }>}
 */
async function getDiffStat(branch, cwd) {
  try {
    const stat = await gitExec(
      ["diff", "--stat", "--numstat", `${branch}~1..${branch}`],
      cwd,
    );
    const lines = stat.split("\n").filter(Boolean);
    let filesChanged = 0;
    let linesChanged = 0;

    for (const line of lines) {
      const match = line.match(/^(\d+)\s+(\d+)\s+/);
      if (match) {
        filesChanged++;
        linesChanged += Number(match[1]) + Number(match[2]);
      }
    }

    // Get tree hash for identity comparison
    const hash = await gitExec(["rev-parse", `${branch}^{tree}`], cwd);

    return { filesChanged, linesChanged, hash: hash.trim() };
  } catch {
    return { filesChanged: 0, linesChanged: 0, hash: "" };
  }
}

function gitExec(args, cwd) {
  return new Promise((res, rej) => {
    execFile(
      "git",
      args,
      { cwd, windowsHide: true, timeout: 15_000 },
      (err, stdout) => {
        if (err) rej(err);
        else res(stdout);
      },
    );
  });
}

/**
 * Build session configs for redundant execution (primary + verifier).
 *
 * @param {object} shard — from SwarmPlan
 * @param {string} runId
 * @returns {{ primaryId: string, verifierId: string }}
 */
export function buildRedundantIds(shard, runId) {
  return {
    primaryId: `${runId}-${shard.id}-primary`,
    verifierId: `${runId}-${shard.id}-verifier`,
  };
}

/**
 * Check if a shard should use redundant execution.
 * @param {object} shard
 * @returns {boolean}
 */
export function shouldRunRedundant(shard) {
  return shard.critical === true;
}
