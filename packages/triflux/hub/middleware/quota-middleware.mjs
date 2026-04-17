const FAILURE_STATUSES = new Set(["quota_hit", "error"]);

function buildFailureRecord(result = {}) {
  const failure = {
    id: result.id ?? "unknown",
    status: result.status ?? "unknown",
  };

  if (Number.isFinite(result.http)) {
    failure.http = result.http;
  }

  if (typeof result.message === "string" && result.message.length > 0) {
    failure.message = result.message;
  }

  if (result.headers && Object.keys(result.headers).length > 0) {
    failure.headers = result.headers;
  }

  return failure;
}

export function summarizeQuotaResults(results = []) {
  const metrics = {
    checked: results.length,
    ok: 0,
    quotaHit: 0,
    error: 0,
    failed: 0,
  };
  const failures = [];

  for (const result of results) {
    const status = result?.status ?? "unknown";

    if (status === "ok") {
      metrics.ok += 1;
    } else if (status === "quota_hit") {
      metrics.quotaHit += 1;
    } else if (status === "error") {
      metrics.error += 1;
    }

    if (FAILURE_STATUSES.has(status)) {
      failures.push(buildFailureRecord(result));
    }
  }

  metrics.failed = failures.length;
  return { metrics, failures };
}

export function logQuotaRefreshFailures(logger, results = []) {
  const { metrics, failures } = summarizeQuotaResults(results);
  if (failures.length === 0) {
    return { logged: false, metrics, failures };
  }

  logger.warn(
    {
      tag: "hub-quota",
      metrics,
      failures,
    },
    "broker.quota_refresh_degraded",
  );

  return { logged: true, metrics, failures };
}
