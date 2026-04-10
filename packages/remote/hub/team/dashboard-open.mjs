import { psmuxExec } from "./psmux.mjs";
import {
  detectMultiplexer,
  focusWtPane,
  hasWindowsTerminal,
  resolveAttachCommand,
  tmuxExec,
} from "./session.mjs";
import { createWtManager } from "./wt-manager.mjs";

function sanitizeWindowTitle(value, fallback = "triflux") {
  const text = String(value || "")
    .replace(/[\r\n]+/g, " ")
    .trim();
  return text || fallback;
}

function sanitizeSessionName(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "") || "tfx-session";
}

function sanitizeWorkingDirectory(value) {
  const text = String(value || "")
    .replace(/[\r\n\x00-\x1f]/g, "")
    .trim();
  return text || process.cwd();
}

export function parseWorkerNumber(value) {
  const text = String(value || "").trim();
  const workerMatch = text.match(/^worker-(\d+)$/i);
  if (workerMatch) return Number.parseInt(workerMatch[1], 10);
  const paneMatch = text.match(/:(\d+)$/);
  if (paneMatch) return Number.parseInt(paneMatch[1], 10);
  return null;
}

export function decideDashboardOpenMode({
  openAll = false,
  hasWtSession = !!process.env.WT_SESSION,
} = {}) {
  if (openAll) return hasWtSession ? "tab" : "window";
  return hasWtSession ? "split" : "window";
}

async function spawnWindowsTerminal(spec, opts = {}) {
  if (!hasWindowsTerminal()) return false;

  const wt = createWtManager();
  const {
    mode = "window",
    title = "triflux",
    cwd = process.cwd(),
    split = { orientation: "H", size: 0.5 },
  } = opts;

  const safeTitle = sanitizeWindowTitle(title);
  const safeCwd = sanitizeWorkingDirectory(cwd);

  try {
    if (mode === "split") {
      await wt.splitPane({
        direction: split?.orientation === "V" ? "V" : "H",
        size: (split?.size || 0.5) * 100,
        title: safeTitle,
        cwd: safeCwd,
        command: spec.args ? `${spec.command} ${spec.args.join(" ")}` : spec.command,
        profile: "triflux",
      });
    } else {
      await wt.createTab({
        title: safeTitle,
        cwd: safeCwd,
        command: spec.args ? `${spec.command} ${spec.args.join(" ")}` : spec.command,
        profile: "triflux",
      });
    }
    return true;
  } catch {
    return false;
  }
}

export function focusManagedPane(target, opts = {}) {
  const { teammateMode = "", layout = "1xN" } = opts;
  const paneRef = String(target || "");

  if (teammateMode === "wt" || paneRef.startsWith("wt:")) {
    const paneIndex = parseWorkerNumber(paneRef);
    return paneIndex != null && focusWtPane(paneIndex, { layout });
  }

  if (!paneRef) return false;
  try {
    if (detectMultiplexer() === "psmux")
      psmuxExec(["select-pane", "-t", paneRef]);
    else tmuxExec(`select-pane -t ${paneRef}`);
    return true;
  } catch {
    return false;
  }
}

export function openHeadlessDashboardTarget(sessionName, opts = {}) {
  const { worker = null, openAll = false, cwd = process.cwd(), title } = opts;

  const safeSession = sanitizeSessionName(sessionName);
  const workerNumber = worker == null ? null : parseWorkerNumber(worker);

  // 선택 워커 → pane focus만 (새 창 열지 않음)
  if (!openAll && workerNumber != null) {
    try {
      psmuxExec(["select-pane", "-t", `${safeSession}:0.${workerNumber}`]);
    } catch {}
    return true;
  }

  // 전체 열기 (Shift+Enter) → 새 WT 창으로 세션 attach
  void spawnWindowsTerminal(
    { command: "psmux", args: ["attach-session", "-t", safeSession] },
    {
      mode: decideDashboardOpenMode({ openAll }),
      title: title || `▲ ${safeSession}`,
      cwd,
    },
  );
  return true;
}

export function openDashboardRuntimeTarget(runtime, opts = {}) {
  const {
    teammateMode = "",
    sessionName = "",
    targetPane = "",
    layout = "1xN",
    openAll = false,
    cwd = process.cwd(),
    title = "",
  } = { ...runtime, ...opts };

  if (teammateMode === "headless") {
    return openHeadlessDashboardTarget(sessionName, {
      worker: openAll ? null : targetPane,
      openAll,
      cwd,
      title,
    });
  }

  if (
    (teammateMode === "wt" || String(targetPane).startsWith("wt:")) &&
    !openAll
  ) {
    return focusManagedPane(targetPane, { teammateMode: "wt", layout });
  }

  try {
    if (!openAll && targetPane)
      focusManagedPane(targetPane, { teammateMode, layout });
    void spawnWindowsTerminal(resolveAttachCommand(sessionName), {
      mode: decideDashboardOpenMode({ openAll }),
      title: title || `▲ ${sanitizeSessionName(sessionName)}`,
      cwd,
    });
    return true;
  } catch {
    return false;
  }
}
