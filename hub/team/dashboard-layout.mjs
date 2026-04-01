const USER_DASHBOARD_LAYOUTS = new Set([
  "single",
  "split-2col",
  "split-3col",
  "auto",
  "lite",
]);

const DASHBOARD_LAYOUTS = new Set([
  ...USER_DASHBOARD_LAYOUTS,
  "summary+detail",
]);

export function normalizeDashboardLayout(value, { allowAuto = true } = {}) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "single";
  if (normalized === "auto" && !allowAuto) return "single";
  return DASHBOARD_LAYOUTS.has(normalized) ? normalized : "single";
}

export function parseDashboardLayout(value) {
  return normalizeDashboardLayout(value, { allowAuto: true });
}

export function resolveDashboardLayout(value, workerCount = 0) {
  const normalized = normalizeDashboardLayout(value, { allowAuto: true });
  if (normalized === "lite") return "lite";
  if (normalized !== "auto") return normalized;
  if (workerCount >= 4) return "summary+detail";
  if (workerCount === 3) return "split-3col";
  if (workerCount === 2) return "split-2col";
  return "single";
}
