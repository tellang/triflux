import { createTerminalOpener } from "./terminal-opener.mjs";

function sanitizeSessionName(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "") || "tfx-session";
}

export function parseWorkerNumber(value) {
  const text = String(value || "").trim();
  const workerMatch = text.match(/^worker-(\d+)$/i);
  if (workerMatch) return Number.parseInt(workerMatch[1], 10);
  const paneMatch = text.match(/:(\d+)$/);
  if (paneMatch) return Number.parseInt(paneMatch[1], 10);
  return null;
}

function ignoreAsyncFailure(value) {
  if (value && typeof value.then === "function") void value.catch(() => {});
}

export async function openHeadlessDashboardTarget(sessionName, opts = {}) {
  const { openAll = false, cwd = process.cwd(), title } = opts;
  const safeSession = sanitizeSessionName(sessionName);
  const workerNumber =
    opts.workerNumber ??
    (opts.worker == null ? null : parseWorkerNumber(opts.worker));

  let opener;
  try {
    const deps = opts._deps ?? {};
    const openerFactory = deps.createTerminalOpener ?? createTerminalOpener;
    opener = openerFactory(deps);
  } catch {
    return !openAll && workerNumber != null;
  }

  // 선택 워커 → pane focus만 (새 창 열지 않음)
  if (!openAll && workerNumber != null) {
    try {
      ignoreAsyncFailure(opener.focusPane(safeSession, workerNumber));
    } catch {}
    return true;
  }

  // 전체 열기 (Shift+Enter) → 새 창으로 세션 attach
  try {
    const opened = opener.openSession(safeSession, {
      title: title || `▲ ${safeSession}`,
      cwd,
      profile: opts.profile ?? "triflux",
    });
    return await opened;
  } catch {
    return false;
  }
}
