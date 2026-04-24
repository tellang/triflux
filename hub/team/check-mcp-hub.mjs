// hub/team/check-mcp-hub.mjs — health-probe L2 용 hub /health ping 체커.
// health-probe.mjs 의 checkMcp 로 주입되어 `mcp_initializing` state 판정에 사용.
// hub /health 가 200 이면 OK (MCP transport 인프라 살아있음), 그 외는 fail.

const DEFAULT_HUB_URL = "http://127.0.0.1:27888";
const DEFAULT_TIMEOUT_MS = 3000;

function resolveHubHealthUrl(hubUrl) {
  const base = hubUrl || process.env.TFX_HUB_URL || DEFAULT_HUB_URL;
  return base.replace(/\/+$/, "") + "/health";
}

/**
 * Hub /health 기반 L2 checker factory.
 * @param {object} [opts]
 * @param {string} [opts.hubUrl] — override. 미지정 시 TFX_HUB_URL env 또는 default.
 * @param {number} [opts.timeoutMs=3000] — fetch timeout (ms).
 * @param {typeof fetch} [opts.fetchFn] — fetch 오버라이드 (테스트용).
 * @returns {() => Promise<boolean>} — true = hub healthy, false = degraded/down/timeout.
 */
export function createHubHealthChecker(opts = {}) {
  const url = resolveHubHealthUrl(opts.hubUrl);
  const timeoutMs = Number.isFinite(opts.timeoutMs)
    ? opts.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const fetchFn = opts.fetchFn || globalThis.fetch;

  return async function checkMcpHubHealth() {
    if (typeof fetchFn !== "function") return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, {
        method: "GET",
        signal: controller.signal,
      });
      return res.ok === true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}
