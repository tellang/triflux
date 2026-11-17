// 역할군별 3사 모델 우선순위 라우팅 정책 (SSOT, ADR-0054)
// 역할 기본 후보 순서, 교차 리뷰 규칙, 쿼터 하드 제외 및 95% 초과 1칸 후순위 이동,
// Jev 신뢰도 0.85 이상 최대 1칸 인접 교환을 단일 순수 함수로 판정한다.

import { resolveCliPolicy } from "./machine-profile.mjs";
import { evaluateVendorQuota, readQuotaSnapshot } from "./quota-snapshot.mjs";

export const TIER_RANK = Object.freeze({
  top: 4,
  high: 3,
  mid: 2,
  low: 1,
});

export const MODEL_TIERS = Object.freeze({
  claude: Object.freeze({
    fable: "top",
    opus: "top",
    sonnet: "high",
    haiku: "low",
  }),
  codex: Object.freeze({
    astra: "top",
    sol: "high",
    terra: "mid",
    luna: "low",
  }),
  antigravity: Object.freeze({
    carbon: "top",
    hydrogen: "high",
    argon: "mid",
  }),
});

export const JEV_VENDOR_ADJUST_MIN_CONFIDENCE = 0.85;

function cand(cli, familyOrModel, effort, profile = null, subcommand = null) {
  const tier = MODEL_TIERS[cli]?.[familyOrModel] || "high";
  return Object.freeze({
    cli,
    tier,
    familyOrModel,
    effort,
    profile,
    subcommand,
  });
}

const EXPLORATION_CANDIDATES = Object.freeze([
  cand("claude", "haiku", "low", null, null),
  cand("codex", "luna", "low", "luna_low", "exec"),
  cand("antigravity", "hydrogen", "low", "hydrogen_low", null),
]);

const JUDGMENT_CANDIDATES = Object.freeze([
  cand("claude", "opus", "high", null, null),
  cand("codex", "astra", "xhigh", "astra_xhigh", "exec"),
  cand("antigravity", "carbon", "high", "carbon_high", null),
]);

const EXECUTOR_CANDIDATES = Object.freeze([
  cand("codex", "sol", "high", "sol_high", "exec"),
  cand("antigravity", "hydrogen", "medium", "hydrogen", null),
  cand("claude", "sonnet", "medium", null, null),
]);

const TEST_ENGINEER_CANDIDATES = Object.freeze([
  cand("codex", "sol", "high", "sol_high", "exec"),
  cand("antigravity", "hydrogen", "high", "hydrogen_high", null),
  cand("claude", "sonnet", "medium", null, null),
]);

const VERIFIER_CANDIDATES = Object.freeze([
  cand("codex", "sol", "high", "sol_high", "review"),
  cand("antigravity", "hydrogen", "high", "hydrogen_high", null),
  cand("claude", "sonnet", "high", null, null),
]);

const SCIENTIST_CANDIDATES = Object.freeze([
  cand("codex", "sol", "high", "sol_high", "exec"),
  cand("antigravity", "hydrogen", "high", "hydrogen_high", null),
  cand("claude", "sonnet", "high", null, null),
]);

const BUILD_FIXER_CANDIDATES = Object.freeze([
  cand("codex", "sol", "medium", "sol_med", "exec"),
  cand("antigravity", "hydrogen", "low", "hydrogen_low", null),
  cand("claude", "sonnet", "low", null, null),
]);

const GENERAL_REVIEW_CANDIDATES = Object.freeze([
  cand("codex", "sol", "high", "sol_high", "review"),
  cand("claude", "opus", "high", null, null),
  cand("antigravity", "hydrogen", "high", "hydrogen_high", null),
]);

const SECURITY_REVIEW_CANDIDATES = Object.freeze([
  cand("claude", "fable", "high", null, null),
  cand("codex", "astra", "xhigh", "astra_xhigh", "review"),
  cand("antigravity", "carbon", "high", "carbon_high", null),
]);

const DESIGNER_CANDIDATES = Object.freeze([
  cand("claude", "opus", "high", null, null),
  cand("antigravity", "hydrogen", "high", "hydrogen_high", null),
  cand("codex", "sol", "high", "sol_high", "exec"),
]);

const WRITER_CANDIDATES = Object.freeze([
  cand("antigravity", "argon", "medium", "argon", null),
  cand("claude", "opus", "medium", null, null),
  cand("codex", "terra", "high", "terra_high", "exec"),
]);

const DOCUMENT_SPECIALIST_CANDIDATES = Object.freeze([
  cand("antigravity", "argon", "medium", "argon", null),
  cand("claude", "opus", "high", null, null),
  cand("codex", "terra", "high", "terra_high", "exec"),
]);

const LEAD_CANDIDATES = Object.freeze([
  cand("claude", "opus", "high", null, null),
  cand("codex", "astra", "xhigh", "astra_xhigh", "exec"),
  cand("antigravity", "carbon", "high", "carbon_high", null),
]);

const COMMUNICATION_REPORT_CANDIDATES = Object.freeze([
  cand("claude", "opus", "medium", null, null),
  cand("antigravity", "argon", "medium", "argon", null),
]);

const EXPLICIT_CODEX_COMM_CANDIDATE = cand(
  "codex",
  "terra",
  "high",
  "terra_high",
  "exec",
);

const AGY_PSEUDO_CANDIDATES = Object.freeze([
  cand("antigravity", "hydrogen", "medium", "hydrogen", null),
  cand("codex", "sol", "high", "sol_high", "exec"),
  cand("claude", "sonnet", "medium", null, null),
]);

const CLAUDE_PSEUDO_CANDIDATES = Object.freeze([
  cand("claude", "sonnet", "medium", null, null),
  cand("codex", "sol", "high", "sol_high", "exec"),
  cand("antigravity", "hydrogen", "medium", "hydrogen", null),
]);

export const ROLE_PRIORITY_TABLE = Object.freeze({
  // 1. 탐색 (하 등급)
  explore: Object.freeze({
    group: "exploration",
    tierFloor: "low",
    nativeClaudeEligible: true,
    timeoutSec: 600,
    mcpHint: "analyze",
    candidates: EXPLORATION_CANDIDATES,
  }),
  spark: Object.freeze({
    group: "exploration",
    tierFloor: "low",
    timeoutSec: 180,
    mcpHint: "implement",
    candidates: EXPLORATION_CANDIDATES,
  }),
  summarizer: Object.freeze({
    group: "exploration",
    tierFloor: "low",
    timeoutSec: 180,
    mcpHint: "analyze",
    candidates: EXPLORATION_CANDIDATES,
  }),
  classifier: Object.freeze({
    group: "exploration",
    tierFloor: "low",
    timeoutSec: 180,
    mcpHint: "analyze",
    candidates: EXPLORATION_CANDIDATES,
  }),
  triage: Object.freeze({
    group: "exploration",
    tierFloor: "low",
    timeoutSec: 180,
    mcpHint: "analyze",
    candidates: EXPLORATION_CANDIDATES,
  }),
  translator: Object.freeze({
    group: "exploration",
    tierFloor: "low",
    timeoutSec: 180,
    mcpHint: "analyze",
    candidates: EXPLORATION_CANDIDATES,
  }),
  formatter: Object.freeze({
    group: "exploration",
    tierFloor: "low",
    timeoutSec: 180,
    mcpHint: "implement",
    candidates: EXPLORATION_CANDIDATES,
  }),

  // 2. 판단 (최상 등급)
  architect: Object.freeze({
    group: "judgment",
    tierFloor: "top",
    timeoutSec: 3600,
    mcpHint: "analyze",
    candidates: JUDGMENT_CANDIDATES,
  }),
  planner: Object.freeze({
    group: "judgment",
    tierFloor: "top",
    timeoutSec: 3600,
    mcpHint: "analyze",
    candidates: JUDGMENT_CANDIDATES,
  }),
  critic: Object.freeze({
    group: "judgment",
    tierFloor: "top",
    timeoutSec: 3600,
    mcpHint: "analyze",
    candidates: JUDGMENT_CANDIDATES,
  }),
  analyst: Object.freeze({
    group: "judgment",
    tierFloor: "top",
    timeoutSec: 3600,
    mcpHint: "analyze",
    candidates: JUDGMENT_CANDIDATES,
  }),
  debugger: Object.freeze({
    group: "judgment",
    tierFloor: "top",
    timeoutSec: 900,
    mcpHint: "implement",
    candidates: JUDGMENT_CANDIDATES,
  }),
  "deep-executor": Object.freeze({
    group: "judgment",
    tierFloor: "top",
    ultraEligible: true,
    timeoutSec: 3600,
    mcpHint: "implement",
    candidates: JUDGMENT_CANDIDATES,
  }),
  "scientist-deep": Object.freeze({
    group: "judgment",
    tierFloor: "top",
    ultraEligible: true,
    timeoutSec: 3600,
    mcpHint: "analyze",
    candidates: JUDGMENT_CANDIDATES,
  }),

  // 3. 실행 (상 등급)
  executor: Object.freeze({
    group: "execution",
    tierFloor: "high",
    timeoutSec: 1080,
    mcpHint: "implement",
    candidates: EXECUTOR_CANDIDATES,
  }),
  codex: Object.freeze({
    group: "execution",
    tierFloor: "high",
    timeoutSec: 1080,
    mcpHint: "implement",
    candidates: EXECUTOR_CANDIDATES,
  }),
  "test-engineer": Object.freeze({
    group: "execution",
    tierFloor: "high",
    timeoutSec: 1200,
    mcpHint: "implement",
    candidates: TEST_ENGINEER_CANDIDATES,
  }),
  verifier: Object.freeze({
    group: "execution",
    tierFloor: "high",
    timeoutSec: 1200,
    mcpHint: "review",
    candidates: VERIFIER_CANDIDATES,
  }),
  "qa-tester": Object.freeze({
    group: "execution",
    tierFloor: "high",
    timeoutSec: 1200,
    mcpHint: "review",
    candidates: VERIFIER_CANDIDATES,
  }),
  scientist: Object.freeze({
    group: "execution",
    tierFloor: "high",
    timeoutSec: 1440,
    mcpHint: "analyze",
    candidates: SCIENTIST_CANDIDATES,
  }),
  "build-fixer": Object.freeze({
    group: "execution",
    tierFloor: "high",
    timeoutSec: 540,
    mcpHint: "implement",
    candidates: BUILD_FIXER_CANDIDATES,
  }),
  cleanup: Object.freeze({
    group: "execution",
    tierFloor: "high",
    timeoutSec: 540,
    mcpHint: "implement",
    candidates: BUILD_FIXER_CANDIDATES,
  }),
  deslop: Object.freeze({
    group: "execution",
    tierFloor: "high",
    timeoutSec: 540,
    mcpHint: "implement",
    candidates: BUILD_FIXER_CANDIDATES,
  }),

  // 4. 검증 (리뷰)
  "code-reviewer": Object.freeze({
    group: "verification",
    tierFloor: "high",
    crossVendorDefault: true,
    timeoutSec: 1800,
    mcpHint: "review",
    candidates: GENERAL_REVIEW_CANDIDATES,
  }),
  "quality-reviewer": Object.freeze({
    group: "verification",
    tierFloor: "high",
    crossVendorDefault: true,
    timeoutSec: 1800,
    mcpHint: "review",
    candidates: GENERAL_REVIEW_CANDIDATES,
  }),
  "security-reviewer": Object.freeze({
    group: "verification",
    tierFloor: "top",
    noLower: true,
    crossVendorDefault: false,
    timeoutSec: 1800,
    mcpHint: "review",
    candidates: SECURITY_REVIEW_CANDIDATES,
  }),

  // 5. 문서 및 시각 설계
  designer: Object.freeze({
    group: "writing_design",
    tierFloor: "high",
    timeoutSec: 900,
    mcpHint: "implement",
    candidates: DESIGNER_CANDIDATES,
  }),
  writer: Object.freeze({
    group: "writing_design",
    tierFloor: "mid",
    timeoutSec: 900,
    mcpHint: "implement",
    candidates: WRITER_CANDIDATES,
  }),
  researcher: Object.freeze({
    group: "writing_design",
    tierFloor: "mid",
    timeoutSec: 900,
    mcpHint: "analyze",
    candidates: WRITER_CANDIDATES,
  }),
  "document-specialist": Object.freeze({
    group: "writing_design",
    tierFloor: "mid",
    timeoutSec: 1440,
    mcpHint: "analyze",
    candidates: DOCUMENT_SPECIALIST_CANDIDATES,
  }),

  // 6. 리드 및 소통
  lead: Object.freeze({
    group: "lead_communication",
    tierFloor: "top",
    timeoutSec: 3600,
    mcpHint: "analyze",
    candidates: LEAD_CANDIDATES,
  }),
  "communication-relay": Object.freeze({
    group: "lead_communication",
    tierFloor: "low",
    timeoutSec: 180,
    mcpHint: "none",
    candidates: EXPLORATION_CANDIDATES,
  }),
  "communication-report": Object.freeze({
    group: "lead_communication",
    tierFloor: "mid",
    timeoutSec: 900,
    mcpHint: "writer",
    candidates: COMMUNICATION_REPORT_CANDIDATES,
  }),
  communication: Object.freeze({
    group: "lead_communication",
    tierFloor: "mid",
    timeoutSec: 900,
    mcpHint: "writer",
    candidates: COMMUNICATION_REPORT_CANDIDATES,
  }),

  // CLI 이름 호환 의사 역할
  antigravity: Object.freeze({
    group: "execution",
    tierFloor: "high",
    timeoutSec: 900,
    mcpHint: "implement",
    candidates: AGY_PSEUDO_CANDIDATES,
  }),
  agy: Object.freeze({
    group: "execution",
    tierFloor: "high",
    timeoutSec: 900,
    mcpHint: "implement",
    candidates: AGY_PSEUDO_CANDIDATES,
  }),
  gemini: Object.freeze({
    group: "execution",
    tierFloor: "high",
    timeoutSec: 900,
    mcpHint: "implement",
    candidates: AGY_PSEUDO_CANDIDATES,
  }),
  claude: Object.freeze({
    group: "execution",
    tierFloor: "high",
    nativeClaudeEligible: true,
    timeoutSec: 900,
    mcpHint: "analyze",
    candidates: CLAUDE_PSEUDO_CANDIDATES,
  }),
});

const PLAN_REVIEW_GATE_ROLES = new Set([
  "planner",
  "architect",
  "critic",
  "code-reviewer",
  "quality-reviewer",
  "security-reviewer",
]);

function normalizeCliMode(raw) {
  const value = String(raw ?? "auto")
    .trim()
    .toLowerCase();
  if (!value || value === "auto") return "auto";
  if (value === "agy" || value === "gemini" || value === "antigravity") {
    return "antigravity";
  }
  if (value === "codex" || value === "claude") return value;
  return "auto";
}

function parseVisitedClis(visitedClis, env) {
  if (Array.isArray(visitedClis)) {
    return visitedClis
      .map((item) => normalizeCliMode(item))
      .filter((item) => item !== "auto");
  }
  const raw =
    typeof visitedClis === "string"
      ? visitedClis
      : String(env?.TFX_REROUTED_FROM ?? "");
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((item) => normalizeCliMode(item))
    .filter((item) => item !== "auto");
}

function resolveAvailability(env, explicitAvailable) {
  const avail = {
    codex: true,
    claude: true,
    antigravity: true,
  };
  if (env?.TFX_CODEX_OK === "0") avail.codex = false;
  if (env?.TFX_ANTIGRAVITY_OK === "0") avail.antigravity = false;
  if (env?.TFX_CLAUDE_OK === "0") avail.claude = false;
  if (explicitAvailable && typeof explicitAvailable === "object") {
    for (const cli of ["codex", "claude", "antigravity"]) {
      if (typeof explicitAvailable[cli] === "boolean") {
        avail[cli] = explicitAvailable[cli];
      }
    }
  }
  return avail;
}

function resolveDisabledMap(env, cliPolicy, explicitDisabled) {
  const policy = cliPolicy ?? resolveCliPolicy(env);
  const disabled = {
    codex: Boolean(policy?.codexDisabled),
    antigravity: Boolean(policy?.antigravityDisabled),
    claude: Boolean(policy?.claudeDisabled),
  };
  if (explicitDisabled && typeof explicitDisabled === "object") {
    for (const cli of ["codex", "claude", "antigravity"]) {
      if (typeof explicitDisabled[cli] === "boolean") {
        disabled[cli] = explicitDisabled[cli];
      }
    }
  }
  return disabled;
}

function buildRoleBaseCandidates(
  agent,
  entry,
  { nested, planReviewGate, authorTier, noClaudeNative, cliMode },
) {
  let rawCandidates = [...entry.candidates];
  if (
    (agent === "communication" || agent === "communication-report") &&
    cliMode === "codex"
  ) {
    rawCandidates = [EXPLICIT_CODEX_COMM_CANDIDATE, ...rawCandidates];
  }

  return rawCandidates.map((item) => {
    let next = {
      ...item,
      executionMode:
        entry.nativeClaudeEligible && item.cli === "claude" && !noClaudeNative
          ? "claude-native"
          : "cli-worker",
      noLower: Boolean(entry.noLower),
      freshSessionRequired: false,
      selectionReason: "role_default",
    };

    if (entry.ultraEligible && next.cli === "codex") {
      next = {
        ...next,
        tier: "top",
        familyOrModel: "astra",
        effort: nested ? "max" : "ultra",
        profile: nested ? "astra_max" : "astra_ultra",
        subcommand: next.subcommand || "exec",
      };
    } else if (next.effort === "ultra") {
      next = {
        ...next,
        effort: "max",
        profile:
          next.cli === "codex" && next.profile === "astra_ultra"
            ? "astra_max"
            : next.profile,
      };
    }

    if (
      planReviewGate &&
      PLAN_REVIEW_GATE_ROLES.has(agent) &&
      next.cli === "claude" &&
      agent !== "lead"
    ) {
      next = {
        ...next,
        tier: "top",
        familyOrModel: "fable",
        effort: "high",
      };
    }

    if (
      TIER_RANK[authorTier] === TIER_RANK.top &&
      (agent === "code-reviewer" || agent === "quality-reviewer")
    ) {
      if (next.cli === "codex") {
        next = {
          ...next,
          tier: "top",
          familyOrModel: "astra",
          effort: "xhigh",
          profile: "astra_xhigh",
        };
      } else if (next.cli === "antigravity") {
        next = {
          ...next,
          tier: "top",
          familyOrModel: "carbon",
          effort: "high",
          profile: "carbon_high",
        };
      }
    }

    return next;
  });
}

function shouldSwapForTrait(taskTrait, decomposable, left, right) {
  if (!taskTrait || !left || !right) return false;
  if (taskTrait === "visual_frontend" || taskTrait === "ui_visual") {
    return (
      left.cli === "codex" &&
      (right.cli === "claude" || right.cli === "antigravity")
    );
  }
  if (taskTrait === "long_context" || taskTrait === "long_doc") {
    return (
      left.cli === "codex" &&
      (right.cli === "antigravity" || right.cli === "claude")
    );
  }
  if (taskTrait === "deep_architecture" || taskTrait === "security_sensitive") {
    return right.cli === "claude" && left.cli !== "claude";
  }
  if (taskTrait === "fast_parallel_slice") {
    if (decomposable === false) return false;
    return (
      left.cli === "claude" &&
      (right.cli === "codex" || right.cli === "antigravity")
    );
  }
  if (taskTrait === "terminal_heavy") {
    return right.cli === "codex" && left.cli !== "codex";
  }
  return false;
}

function applyRightToLeftQuotaDemotion(list) {
  let firstDemoted = false;
  for (let i = list.length - 2; i >= 0; i -= 1) {
    if (
      list[i].selectionReason !== "explicit_fallback" &&
      list[i].quotaStatus === "over_95" &&
      list[i + 1].quotaStatus !== "over_95"
    ) {
      const demoted = {
        ...list[i],
        demotedByQuota: true,
        selectionReason: "quota_demoted",
      };
      list[i] = list[i + 1];
      list[i + 1] = demoted;
      if (i === 0) firstDemoted = true;
    }
  }
  return firstDemoted;
}

/**
 * Jev 고신뢰(>= 0.85) 판단 결과를 받아 가용 후보 배열 안에서 최대 1칸 인접 교환만 수행한다.
 * 하드 제외된 벤더를 되살리지 않으며, 교환 후에도 over_95 후순위 규칙을 보존한다.
 */
export function reconcileCandidatesWithJev(
  candidates,
  jevDecision,
  {
    explicitCliMode = false,
    minConfidence = JEV_VENDOR_ADJUST_MIN_CONFIDENCE,
  } = {},
) {
  const list = Array.isArray(candidates)
    ? candidates.map((c, idx) => ({
        ...c,
        _baseIndex: typeof c._baseIndex === "number" ? c._baseIndex : idx,
      }))
    : [];
  const stripInternal = (arr) => arr.map(({ _baseIndex, ...rest }) => rest);

  const decomposable =
    typeof jevDecision?.decomposable === "boolean"
      ? jevDecision.decomposable
      : null;

  const pinnedTopReason =
    list[0]?.selectionReason === "explicit_cli_mode" ||
    list[0]?.selectionReason === "explicit_profile" ||
    list[0]?.selectionReason === "verifier_override"
      ? list[0].selectionReason
      : "";
  if (list.length <= 1 || explicitCliMode || pinnedTopReason || !jevDecision) {
    return {
      candidates: stripInternal(list),
      adjusted: false,
      reason: explicitCliMode
        ? "explicit_cli_mode"
        : pinnedTopReason || "unchanged",
      decomposable,
    };
  }

  const confidence = jevDecision.confidence;
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < minConfidence
  ) {
    return {
      candidates: stripInternal(list),
      adjusted: false,
      reason: "low_confidence",
      decomposable,
    };
  }

  let adjusted = false;
  let reason = "unchanged";

  const rawRec = jevDecision.recommendedCli
    ? normalizeCliMode(jevDecision.recommendedCli)
    : "";
  if (rawRec && rawRec !== "auto") {
    const idx = list.findIndex((c) => c.cli === rawRec);
    if (idx === 1 && !list[0]?.noLower && list[1].quotaStatus !== "over_95") {
      const moved = { ...list[1], selectionReason: "jev_shifted" };
      list[1] = list[0];
      list[0] = moved;
      adjusted = true;
      reason = `recommended_cli_${rawRec}`;
    } else if (idx === 2 && list[2].quotaStatus !== "over_95") {
      const moved = { ...list[2], selectionReason: "jev_shifted" };
      list[2] = list[1];
      list[1] = moved;
      adjusted = true;
      reason = `recommended_cli_${rawRec}_step1`;
    } else {
      reason = idx === 0 ? "already_first" : "excluded_vendor_ignored";
    }
  } else {
    const taskTrait = jevDecision.taskTrait || "none";
    if (taskTrait !== "none" && taskTrait !== "general") {
      for (let i = 0; i < list.length - 1; i += 1) {
        if (
          !(i === 0 && list[0]?.noLower) &&
          list[i + 1].quotaStatus !== "over_95" &&
          shouldSwapForTrait(taskTrait, decomposable, list[i], list[i + 1]) &&
          Math.abs(i - list[i + 1]._baseIndex) <= 1 &&
          Math.abs(i + 1 - list[i]._baseIndex) <= 1
        ) {
          const moved = { ...list[i + 1], selectionReason: "jev_shifted" };
          list[i + 1] = list[i];
          list[i] = moved;
          adjusted = true;
          reason = `task_trait_${taskTrait}`;
          break;
        }
      }
    }
  }

  return {
    candidates: stripInternal(list),
    adjusted,
    reason,
    decomposable,
  };
}

/**
 * 역할, 쿼터 스냅샷, 머신 프로파일, 작성 벤더 제약을 결합해 우선순위 후보 배열을 만든다.
 */
export function resolveRoleCandidates({
  agent = "executor",
  env = process.env,
  quotaSnapshot,
  cliMode,
  antigravityFallback,
  verifierOverride,
  reviewAuthor,
  reviewAuthorTier,
  authorTier,
  planReviewGate,
  nested = false,
  noClaudeNative,
  visitedClis,
  disabled,
  available,
  cliPolicy,
  jevAdjustment = null,
  strictAgent = false,
} = {}) {
  const normalizedAgent = String(agent ?? "").trim();
  if (!/^[A-Za-z0-9_.-]+$/u.test(normalizedAgent)) {
    throw new Error(`invalid agent: ${agent}`);
  }
  if (strictAgent && !Object.hasOwn(ROLE_PRIORITY_TABLE, normalizedAgent)) {
    throw new Error(
      `알 수 없는 에이전트 타입: ${normalizedAgent}; available: ${Object.keys(ROLE_PRIORITY_TABLE).join(", ")}`,
    );
  }

  const entry =
    ROLE_PRIORITY_TABLE[normalizedAgent] || ROLE_PRIORITY_TABLE.executor;
  const resolvedCliMode = normalizeCliMode(cliMode ?? env?.TFX_CLI_MODE);
  const resolvedNested = Boolean(nested);
  const resolvedPlanGate =
    planReviewGate !== undefined
      ? Boolean(planReviewGate)
      : env?.TFX_PLAN_REVIEW_GATE === "1";
  const resolvedAuthorTier =
    reviewAuthorTier ?? authorTier ?? env?.TFX_REVIEW_AUTHOR_TIER ?? "high";
  const resolvedNoClaudeNative =
    noClaudeNative !== undefined
      ? Boolean(noClaudeNative)
      : env?.TFX_NO_CLAUDE_NATIVE === "1";
  const resolvedVerifierOverride = String(
    verifierOverride ?? env?.TFX_VERIFIER_OVERRIDE ?? "auto",
  )
    .trim()
    .toLowerCase();
  const visitedSet = new Set(parseVisitedClis(visitedClis, env));

  const rawFallback =
    antigravityFallback !== undefined
      ? antigravityFallback
      : (env?.TFX_ANTIGRAVITY_FALLBACK ?? "");
  if (
    rawFallback !== "" &&
    rawFallback !== "codex" &&
    rawFallback !== "claude"
  ) {
    throw new Error(
      `TFX_ANTIGRAVITY_FALLBACK 값은 codex 또는 claude여야 합니다: ${rawFallback}`,
    );
  }

  // 2. 일반 리뷰어 및 보안 리뷰어 작성 벤더 검증
  let effectiveReviewAuthor = "";
  const hasEnvReviewAuthor =
    env != null &&
    Object.hasOwn(env, "TFX_REVIEW_AUTHOR") &&
    env.TFX_REVIEW_AUTHOR !== undefined;
  if (entry.crossVendorDefault) {
    effectiveReviewAuthor =
      reviewAuthor !== undefined
        ? String(reviewAuthor)
        : hasEnvReviewAuthor
          ? String(env.TFX_REVIEW_AUTHOR)
          : "codex";
    if (!["codex", "claude", "antigravity"].includes(effectiveReviewAuthor)) {
      throw new Error(
        `TFX_REVIEW_AUTHOR 값이 유효하지 않습니다: ${effectiveReviewAuthor}`,
      );
    }
  } else if (
    normalizedAgent === "security-reviewer" &&
    (reviewAuthor !== undefined || hasEnvReviewAuthor)
  ) {
    const rawSecAuthor =
      reviewAuthor !== undefined
        ? String(reviewAuthor)
        : String(env.TFX_REVIEW_AUTHOR);
    if (rawSecAuthor !== "") {
      if (!["codex", "claude", "antigravity"].includes(rawSecAuthor)) {
        throw new Error(
          `TFX_REVIEW_AUTHOR 값이 유효하지 않습니다: ${rawSecAuthor}`,
        );
      }
      effectiveReviewAuthor = rawSecAuthor;
    }
  }

  // 1. 기본 후보 로드 및 역할별 보정
  let baseList = buildRoleBaseCandidates(normalizedAgent, entry, {
    nested: resolvedNested,
    planReviewGate: resolvedPlanGate,
    authorTier: resolvedAuthorTier,
    noClaudeNative: resolvedNoClaudeNative,
    cliMode: resolvedCliMode,
  });

  if (resolvedVerifierOverride === "claude" && normalizedAgent === "verifier") {
    const claudeCand = baseList.find((c) => c.cli === "claude");
    if (claudeCand) {
      const promoted = {
        ...claudeCand,
        executionMode: resolvedNoClaudeNative ? "cli-worker" : "claude-native",
        selectionReason: "verifier_override",
      };
      baseList = [promoted, ...baseList.filter((c) => c.cli !== "claude")];
    }
  }

  // 3. TFX_NO_CLAUDE_NATIVE=1 처리 (explore: codex/agy 우선, 둘 다 불가 시 외부 claude 워커 최후 예비)
  let deferredExploreClaudeWorker = null;
  if (normalizedAgent === "explore" && resolvedNoClaudeNative) {
    const exploreClaude = baseList.find((c) => c.cli === "claude");
    if (exploreClaude && resolvedCliMode !== "claude") {
      deferredExploreClaudeWorker = {
        ...exploreClaude,
        executionMode: "cli-worker",
      };
      baseList = baseList.filter((c) => c.cli !== "claude");
    }
  }

  const byCli = new Map(baseList.map((c) => [c.cli, c]));
  let ordered = [...baseList];
  let sameAuthorCandidate = null;
  const crossVendorActive =
    Boolean(effectiveReviewAuthor) && resolvedCliMode === "auto";

  if (crossVendorActive) {
    sameAuthorCandidate = byCli.get(effectiveReviewAuthor) || null;
    ordered = baseList.filter((c) => c.cli !== effectiveReviewAuthor);
  }

  // 4. 명시 TFX_CLI_MODE 또는 명시 벤더 프로필(TFX_CODEX_PROFILE / TFX_GEMINI_PROFILE) 우선순위 결합
  const keepClaudeNative =
    Boolean(entry.nativeClaudeEligible) &&
    !resolvedNoClaudeNative &&
    resolvedCliMode !== "claude";
  if (resolvedCliMode !== "auto" && !keepClaudeNative) {
    const preferred =
      byCli.get(resolvedCliMode) ||
      (resolvedCliMode === "claude" ? deferredExploreClaudeWorker : null);
    if (preferred) {
      const promoted = { ...preferred, selectionReason: "explicit_cli_mode" };
      ordered = [promoted, ...ordered.filter((c) => c.cli !== resolvedCliMode)];
      if (effectiveReviewAuthor && resolvedCliMode !== effectiveReviewAuthor) {
        sameAuthorCandidate = byCli.get(effectiveReviewAuthor) || null;
        ordered = ordered.filter((c) => c.cli !== effectiveReviewAuthor);
      }
    }
  } else if (!crossVendorActive && !keepClaudeNative) {
    const rawCodexProfile = String(env?.TFX_CODEX_PROFILE ?? "").trim();
    const rawGeminiProfile = String(
      env?.TFX_GEMINI_PROFILE || env?.GEMINI_PROFILE || "",
    ).trim();
    const explicitCodexProfile =
      rawCodexProfile !== "" && rawCodexProfile.toLowerCase() !== "auto";
    const explicitGeminiProfile =
      rawGeminiProfile !== "" && rawGeminiProfile.toLowerCase() !== "auto";
    const implicitPreferredCli =
      explicitCodexProfile && !explicitGeminiProfile
        ? "codex"
        : explicitGeminiProfile && !explicitCodexProfile
          ? "antigravity"
          : "";
    if (implicitPreferredCli && byCli.has(implicitPreferredCli)) {
      const promoted = {
        ...byCli.get(implicitPreferredCli),
        selectionReason: "explicit_profile",
      };
      ordered = [
        promoted,
        ...ordered.filter((c) => c.cli !== implicitPreferredCli),
      ];
    }
  }

  // 명시 TFX_ANTIGRAVITY_FALLBACK 호환: antigravity 뒤 대안 순서 지정
  if (rawFallback && !crossVendorActive && ordered[0]?.cli === "antigravity") {
    const rest = ordered.slice(1);
    const fb = rest.find((c) => c.cli === rawFallback);
    if (fb) {
      ordered = [
        ordered[0],
        { ...fb, selectionReason: "explicit_fallback" },
        ...rest.filter((c) => c.cli !== rawFallback),
      ];
    }
  }

  // 5. 하드 제외 필터 (금지, 미설치, 재라우팅 방문 이력, 소진 >= 100%, 쿨다운)
  const disabledMap = resolveDisabledMap(env, cliPolicy, disabled);
  const availMap = resolveAvailability(env, available);
  const quota = quotaSnapshot ?? readQuotaSnapshot({ env });
  const excluded = [];

  const evaluateCandidateGate = (candidate) => {
    const cli = candidate.cli;
    if (disabledMap[cli]) {
      return {
        excluded: {
          cli,
          reason: "disabled",
          detail: `TFX_DISABLE_${cli.toUpperCase()}=1`,
          resetsAtMs: null,
        },
      };
    }
    if (availMap[cli] === false) {
      return {
        excluded: {
          cli,
          reason: "unavailable",
          detail: `${cli}_unavailable`,
          resetsAtMs: null,
        },
      };
    }
    if (visitedSet.has(cli)) {
      return {
        excluded: {
          cli,
          reason: "visited_reroute",
          detail: `rerouted_from_${cli}`,
          resetsAtMs: null,
        },
      };
    }
    const qEval = evaluateVendorQuota(quota, candidate, { env });
    if (qEval.status === "cooldown") {
      return {
        excluded: {
          cli,
          reason: "cooldown",
          detail: qEval.cooldownResetIso || "runtime_cooldown",
          resetsAtMs: qEval.resetsAtMs ?? null,
        },
      };
    }
    if (qEval.status === "exhausted") {
      return {
        excluded: {
          cli,
          reason: "quota_exhausted",
          detail: `${qEval.usedPercent ?? 100}%`,
          resetsAtMs: qEval.resetsAtMs ?? null,
        },
      };
    }
    return {
      candidate: {
        ...candidate,
        timeoutSec: candidate.timeoutSec ?? entry.timeoutSec,
        mcpHint: candidate.mcpHint ?? entry.mcpHint,
        quotaStatus:
          qEval.status === "over_95"
            ? "over_95"
            : qEval.status === "ok"
              ? "ok"
              : "unknown",
        quotaPercent: qEval.usedPercent ?? null,
      },
    };
  };

  let active = [];
  for (const candidate of ordered) {
    const res = evaluateCandidateGate(candidate);
    if (res.excluded) {
      const skippedBeforeWinner =
        active.length === 0 ||
        (active.length === 1 && active[0].quotaStatus === "over_95");
      excluded.push({ ...res.excluded, skippedBeforeWinner });
    } else {
      active.push(res.candidate);
    }
  }

  // explore + noClaudeNative에서 codex와 antigravity가 모두 막혔을 때만 외부 claude 워커 복원
  if (active.length === 0 && deferredExploreClaudeWorker) {
    const res = evaluateCandidateGate(deferredExploreClaudeWorker);
    if (res.excluded) {
      excluded.push(res.excluded);
    } else {
      active.push(res.candidate);
    }
  }

  // 타 벤더 전멸 시 동일 벤더 새 세션 리뷰 최후 폴백
  let sameVendorFallbackUsed = false;
  if (active.length === 0 && sameAuthorCandidate) {
    const res = evaluateCandidateGate(sameAuthorCandidate);
    if (res.excluded) {
      excluded.push(res.excluded);
    } else {
      active.push({
        ...res.candidate,
        freshSessionRequired: true,
        sameVendorFallback: true,
        selectionReason: "same_vendor_fresh_session",
      });
      sameVendorFallbackUsed = true;
    }
  }

  const preDemoteFirstCli = active[0]?.cli || null;

  // 6. Jev 고신뢰(>= 0.85) 최대 1칸 인접 교환 (cliMode === "auto" 전용)
  if (resolvedCliMode === "auto" && jevAdjustment && active.length > 1) {
    const reconciled = reconcileCandidatesWithJev(active, jevAdjustment, {
      explicitCliMode: false,
    });
    active = reconciled.candidates;
  }

  // 7. 쿼터 95% 초과 1칸 후순위 이동 (cliMode === "auto" 전용, 단일 우측 역순 패스)
  let usageSwitch = false;
  if (resolvedCliMode === "auto" && active.length > 1) {
    const demotedFirst = applyRightToLeftQuotaDemotion(active);
    if (demotedFirst && active[0]?.cli !== preDemoteFirstCli) {
      usageSwitch = true;
    }
  }

  // 원래 1순위 후보가 쿼터 소진/쿨다운으로 제외되어 2순위로 넘어간 경우도 usageSwitch로 기록
  if (
    !usageSwitch &&
    ordered.length > 0 &&
    active.length > 0 &&
    ordered[0].cli !== active[0].cli
  ) {
    const firstExcluded = excluded.find((e) => e.cli === ordered[0].cli);
    if (
      firstExcluded?.reason === "quota_exhausted" ||
      firstExcluded?.reason === "cooldown"
    ) {
      usageSwitch = true;
    }
  }

  const allowClaudeNative = Boolean(
    entry.nativeClaudeEligible && !resolvedNoClaudeNative,
  );

  return {
    agent: normalizedAgent,
    roleGroup: entry.group,
    group: entry.group,
    orderedFirstCli: ordered[0]?.cli || null,
    candidates: active,
    excluded,
    reviewAuthor: effectiveReviewAuthor,
    usageSwitch,
    sameVendorFallbackUsed,
    allowClaudeNative,
  };
}
