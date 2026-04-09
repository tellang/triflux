#!/usr/bin/env node

import _SysTrayModule from "systray2";

const SysTray = _SysTrayModule.default || _SysTrayModule;

import { exec } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IS_WINDOWS } from "./platform.mjs";

const HUB_PID_FILE = join(homedir(), ".claude", "cache", "tfx-hub", "hub.pid");
const DEFAULT_HUB_PORT = "27888";

function getHubBaseUrl() {
  if (process.env.TFX_HUB_URL)
    return process.env.TFX_HUB_URL.replace(/\/+$/, "");
  try {
    const info = JSON.parse(readFileSync(HUB_PID_FILE, "utf8"));
    if (info.port) return `http://${info.host || "127.0.0.1"}:${info.port}`;
  } catch {}
  const port = process.env.TFX_HUB_PORT || DEFAULT_HUB_PORT;
  return `http://127.0.0.1:${port}`;
}

function getDashboardUrl() {
  return `${getHubBaseUrl()}/dashboard`;
}

function getHubStatusUrl() {
  return `${getHubBaseUrl()}/status`;
}
const POLL_INTERVAL_MS = 10_000;
const HUB_TIMEOUT_MS = 3_000;
const AIMD_INITIAL = 3;
const AIMD_MIN = 1;
const AIMD_MAX = 10;
const AIMD_WINDOW_MS = 30 * 60 * 1000;

const CACHE_DIR = join(homedir(), ".claude", "cache");
const BATCH_EVENTS_FILE = join(CACHE_DIR, "batch-events.jsonl");
const CODEX_RATE_LIMITS_FILE = join(CACHE_DIR, "codex-rate-limits-cache.json");
const GEMINI_QUOTA_FILE = join(CACHE_DIR, "gemini-quota-cache.json");
const CLAUDE_USAGE_FILE = join(CACHE_DIR, "claude-usage-cache.json");

const TRAY_ICON_BASE64 =
  "AAABAAEAICAAAAEAIAADAQAAFgAAAIlQTkcNChoKAAAADUlIRFIAAAAgAAAAIAgGAAAAc3p69AAAAMpJREFUeJzV1UEKgzAQheEcwnXP4a17gl6n6yy7U1IIqDSTeW/m0TYwK8X/E6OW8m9rWW5Pa74SlWLYeBgRDcOQ7V42a+SIGSALkwKIQKDnroJQmy4bAgO8EDnAA4EBkV3do7VWeAOfAO0Cx/EC+vnMG2QCLND12Pp4vUcK+DQ9fBxqI47uDI23oV7F2fNVxF2A64zCTBwCWGE2Pv0WzKKp8ba8wWg4DIiGKUBWdBjP+i+E4z8BUCJccRUCimdC6HAGIiWOYiRR5doBauXshzcEs0UAAAAASUVORK5CYII=";

function clampPercent(value) {
  if (!Number.isFinite(Number(value))) return null;
  return Math.max(0, Math.min(100, Math.round(Number(value))));
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readLines(filePath) {
  try {
    return readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function isSuccessResult(result) {
  return result === "success" || result === "success_with_warnings";
}

function getAimdBatchSize(now = Date.now()) {
  const sinceMs = now - AIMD_WINDOW_MS;
  const events = readLines(BATCH_EVENTS_FILE)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((event) => event && Number(event.ts) >= sinceMs);

  if (events.length === 0) return AIMD_INITIAL;

  let batchSize = AIMD_INITIAL;
  for (const event of events) {
    if (isSuccessResult(event.result)) {
      batchSize = Math.min(AIMD_MAX, batchSize + 1);
    } else {
      batchSize = Math.max(AIMD_MIN, Math.floor(batchSize * 0.5));
    }
  }
  return batchSize;
}

function getCodexPercent() {
  const data = readJson(CODEX_RATE_LIMITS_FILE);
  const buckets =
    data?.buckets && typeof data.buckets === "object" ? data.buckets : null;
  const primaryBucket =
    buckets?.codex ?? Object.values(buckets ?? {})[0] ?? null;
  return clampPercent(primaryBucket?.primary?.used_percent);
}

function pickGeminiBucket(data) {
  const buckets = Array.isArray(data?.buckets) ? data.buckets : [];
  if (buckets.length === 0) return null;

  const preferredModels = [
    "gemini-3-flash-preview",
    "gemini-2.5-flash",
    "gemini-3-flash",
    "gemini-2.5-flash-lite",
  ];

  for (const modelId of preferredModels) {
    const match = buckets.find((bucket) => bucket?.modelId === modelId);
    if (match) return match;
  }

  return (
    buckets.find((bucket) => String(bucket?.modelId ?? "").includes("flash")) ??
    buckets[0]
  );
}

function getGeminiPercent() {
  const data = readJson(GEMINI_QUOTA_FILE);
  const bucket = pickGeminiBucket(data);
  if (!bucket) return null;
  return clampPercent((1 - Number(bucket.remainingFraction ?? 1)) * 100);
}

function getClaudePercent() {
  const data = readJson(CLAUDE_USAGE_FILE);
  return clampPercent(data?.data?.fiveHourPercent);
}

async function getHubStatusLabel() {
  try {
    const response = await fetch(getHubStatusUrl(), {
      signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    const state =
      typeof data?.hub?.state === "string" ? data.hub.state : "connected";
    const sessions = Number.isFinite(Number(data?.sessions))
      ? Number(data.sessions)
      : null;
    return sessions == null ? `Hub: ${state}` : `Hub: ${state} | S:${sessions}`;
  } catch {
    return "Hub 미연결";
  }
}

function formatTooltipPercent(value) {
  return value == null ? "--%" : `${value}%`;
}

function formatMenuPercent(value) {
  return value == null ? "--%" : `${value}%`;
}

function buildTooltip(snapshot) {
  const hubTag = snapshot.hubLabel.startsWith("Hub 미") ? "H:off" : "H:on";
  return `tfx AIMD:${snapshot.aimd}/10 | C:${formatTooltipPercent(snapshot.claude)} X:${formatTooltipPercent(snapshot.codex)} G:${formatTooltipPercent(snapshot.gemini)} ${hubTag}`;
}

function buildUsageTitle(snapshot) {
  return `C: ${formatMenuPercent(snapshot.claude)} | X: ${formatMenuPercent(snapshot.codex)} | G: ${formatMenuPercent(snapshot.gemini)}`;
}

function findChromePath() {
  const candidates = [
    join(
      process.env.ProgramFiles || "",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
    join(
      process.env["ProgramFiles(x86)"] || "",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
    join(
      process.env.LOCALAPPDATA || "",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {}
  }
  return null;
}

function openDashboard() {
  const url = getDashboardUrl();
  const shell = process.env.ComSpec || "cmd.exe";
  const chrome = findChromePath();
  if (chrome) {
    // Chrome --app: 주소바/탭 없는 앱 윈도우로 열기
    exec(
      `start "" "${chrome}" "--app=${url}"`,
      { shell, windowsHide: true },
      (err) => {
        if (err) {
          exec(`start "" "${url}"`, { shell, windowsHide: true }, () => {});
        }
      },
    );
  } else {
    exec(`start "" "${url}"`, { shell, windowsHide: true }, () => {});
  }
}

const openDashboardItem = {
  title: "대시보드 열기",
  tooltip: "브라우저에서 대시보드 열기",
  enabled: true,
  click: openDashboard,
};

const aimdItem = {
  title: "AIMD: 3/10",
  tooltip: "최근 30분 AIMD 동시 워커",
  enabled: true,
  click: openDashboard,
};

const quotaItem = {
  title: "C: --% | X: --% | G: --%",
  tooltip: "Claude | Codex | Gemini 사용률",
  enabled: true,
  click: openDashboard,
};

const hubItem = {
  title: "Hub 미연결",
  tooltip: "Hub 연결 상태",
  enabled: true,
  click: openDashboard,
};

const refreshItem = {
  title: "새로고침",
  tooltip: "캐시 재읽기",
  enabled: true,
  click: () => {
    void scheduleRefresh();
  },
};

const exitItem = {
  title: "종료",
  tooltip: "트레이 종료",
  enabled: true,
  click: () => {
    void shutdown("menu-exit");
  },
};

const menu = {
  icon: TRAY_ICON_BASE64,
  title: "tfx",
  tooltip: "tfx AIMD:3/10 | C:--% X:--% G:--% H:off",
  items: [
    openDashboardItem,
    SysTray.separator,
    aimdItem,
    quotaItem,
    hubItem,
    SysTray.separator,
    refreshItem,
    exitItem,
  ],
};

let systray = null;
let pollTimer = null;
let refreshPromise = null;
let shuttingDown = false;

async function refreshMenu() {
  const snapshot = {
    aimd: getAimdBatchSize(),
    codex: getCodexPercent(),
    gemini: getGeminiPercent(),
    claude: getClaudePercent(),
    hubLabel: await getHubStatusLabel(),
  };

  aimdItem.title = `AIMD: ${snapshot.aimd}/10`;
  quotaItem.title = buildUsageTitle(snapshot);
  hubItem.title = snapshot.hubLabel;

  if (systray) {
    await systray.sendAction({ type: "update-item", item: aimdItem });
    await systray.sendAction({ type: "update-item", item: quotaItem });
    await systray.sendAction({ type: "update-item", item: hubItem });
    await systray.sendAction({
      type: "update-item-and-title",
      item: { title: buildTooltip(snapshot) },
    });
  }
}

function scheduleRefresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = refreshMenu()
    .catch((error) => {
      console.error(`[tfx-tray] refresh failed: ${error.message}`);
    })
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

async function shutdown(reason = "shutdown") {
  if (shuttingDown) return;
  shuttingDown = true;

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  try {
    if (systray && !systray.killed) {
      await systray.kill(false);
    }
  } catch (error) {
    console.error(`[tfx-tray] ${reason} cleanup failed: ${error.message}`);
  } finally {
    systray = null;
    process.exit(0);
  }
}

export async function startTray() {
  if (!IS_WINDOWS) {
    throw new Error("tray command is only supported on Windows.");
  }

  systray = new SysTray({
    menu,
    debug: false,
    copyDir: false,
  });

  await systray.ready();

  systray.onError((error) => {
    console.error(`[tfx-tray] ${error.message}`);
  });

  systray.onExit((code, signal) => {
    if (shuttingDown) return;
    const detail = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    console.error(`[tfx-tray] tray exited unexpectedly (${detail})`);
    process.exit(typeof code === "number" ? code : 1);
  });
  await systray.onClick((action) => {
    if (action.item?.click) {
      action.item.click();
      return;
    }

    if (action.item?.__id === openDashboardItem.__id) {
      openDashboard();
    }
  });

  await scheduleRefresh();

  pollTimer = setInterval(() => {
    void scheduleRefresh();
  }, POLL_INTERVAL_MS);
  pollTimer.unref();

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  return {
    systray,
    stop: shutdown,
  };
}

const selfRun =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (selfRun) {
  startTray().catch((error) => {
    console.error(`[tfx-tray] start failed: ${error.message}`);
    process.exit(1);
  });
}
