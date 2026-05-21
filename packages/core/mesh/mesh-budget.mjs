/**
 * Warning level thresholds mirroring context-monitor.mjs classifyContextThreshold().
 * Reproduced here to avoid cross-module dependency.
 */
const WARNING_LEVELS = Object.freeze({
  critical: 90,
  warn: 80,
  info: 60,
  ok: 0,
});

/**
 * Clamps a percentage value to [0, 100].
 * @param {number} value
 * @returns {number}
 */
function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/**
 * Classifies a usage percentage into a warning level.
 * Mirrors context-monitor.mjs classifyContextThreshold().
 * @param {number} percent
 * @returns {{ level: string, message: string }}
 */
function classifyLevel(percent) {
  const p = clampPercent(percent);
  if (p >= WARNING_LEVELS.critical)
    return { level: "critical", message: "에이전트 분할 또는 세션 교체 권장" };
  if (p >= WARNING_LEVELS.warn) return { level: "warn", message: "압축 권장" };
  if (p >= WARNING_LEVELS.info)
    return { level: "info", message: "컨텍스트 절반 이상 사용" };
  return { level: "ok", message: "" };
}

/**
 * Creates a per-agent token budget manager.
 * @returns {object} Budget API
 */
export function createMeshBudget() {
  // Map<agentId, { allocated: number, consumed: number }>
  const budgets = new Map();

  /**
   * Allocates a token budget to an agent.
   * @param {string} agentId
   * @param {number} tokenLimit
   */
  function allocate(agentId, tokenLimit) {
    if (!agentId || typeof agentId !== "string") {
      throw new TypeError("agentId must be a non-empty string");
    }
    const limit = Math.max(0, Math.round(Number(tokenLimit) || 0));
    const existing = budgets.get(agentId);
    budgets.set(agentId, {
      allocated: limit,
      consumed: existing?.consumed ?? 0,
    });
  }

  /**
   * Records token consumption for an agent.
   * @param {string} agentId
   * @param {number} tokens
   * @returns {{ remaining: number, percent: number, level: string }}
   */
  function consume(agentId, tokens) {
    const budget = budgets.get(agentId);
    if (!budget) {
      throw new Error(`No budget allocated for agent: ${agentId}`);
    }
    const amount = Math.max(0, Math.round(Number(tokens) || 0));
    const updated = {
      allocated: budget.allocated,
      consumed: budget.consumed + amount,
    };
    budgets.set(agentId, updated);

    const remaining = Math.max(0, updated.allocated - updated.consumed);
    const percent =
      updated.allocated > 0
        ? clampPercent((updated.consumed / updated.allocated) * 100)
        : 100;
    const { level } = classifyLevel(percent);
    return { remaining, percent, level };
  }

  /**
   * Returns the budget status for an agent.
   * @param {string} agentId
   * @returns {{ allocated: number, consumed: number, remaining: number, level: string }}
   */
  function getStatus(agentId) {
    const budget = budgets.get(agentId);
    if (!budget) {
      return { allocated: 0, consumed: 0, remaining: 0, level: "ok" };
    }
    const remaining = Math.max(0, budget.allocated - budget.consumed);
    const percent =
      budget.allocated > 0
        ? clampPercent((budget.consumed / budget.allocated) * 100)
        : 0;
    const { level } = classifyLevel(percent);
    return {
      allocated: budget.allocated,
      consumed: budget.consumed,
      remaining,
      level,
    };
  }

  /**
   * Resets consumed tokens for all agents (keeps allocations).
   */
  function resetAll() {
    for (const [agentId, budget] of budgets) {
      budgets.set(agentId, { allocated: budget.allocated, consumed: 0 });
    }
  }

  /**
   * Returns a snapshot of all current allocations.
   * @returns {Map<string, { allocated: number, consumed: number }>}
   */
  function listAllocations() {
    const snap = new Map();
    for (const [id, b] of budgets) {
      snap.set(id, Object.freeze({ ...b }));
    }
    return snap;
  }

  return { allocate, consume, getStatus, resetAll, listAllocations };
}
