const DASHBOARD_ANCHORS = new Set([
  "window",
  "tab",
]);

export function normalizeDashboardAnchor(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "window";
  return DASHBOARD_ANCHORS.has(normalized) ? normalized : "window";
}

export function parseDashboardAnchor(value) {
  return normalizeDashboardAnchor(value);
}
