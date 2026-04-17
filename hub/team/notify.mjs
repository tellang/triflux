// hub/team/notify.mjs — team notifier (bell / Windows toast / webhook)

import { execFile } from "node:child_process";
import os from "node:os";

export const NOTIFY_EVENT_TYPES = Object.freeze([
  "completed",
  "failed",
  "inputWait",
]);
export const NOTIFY_CHANNELS = Object.freeze(["bell", "toast", "webhook"]);

function freezeRecord(record) {
  return Object.freeze({ ...record });
}

function escapePowerShellSingleQuoted(value) {
  return String(value ?? "").replaceAll("'", "''");
}

function normalizeTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  if (value == null || value === "") return new Date().toISOString();
  return String(value);
}

function normalizeEvent(event, defaults = {}) {
  if (!event || typeof event !== "object") {
    throw new TypeError("notify(event) requires an event object");
  }

  const type = String(event.type || "").trim();
  if (!NOTIFY_EVENT_TYPES.includes(type)) {
    throw new TypeError(`Unsupported notify event type: ${type || "<empty>"}`);
  }

  return freezeRecord({
    type,
    sessionId: event.sessionId == null ? "" : String(event.sessionId),
    host:
      event.host == null || event.host === ""
        ? String(defaults.host || os.hostname())
        : String(event.host),
    summary: event.summary == null ? "" : String(event.summary),
    timestamp: normalizeTimestamp(event.timestamp),
  });
}

function defaultChannelConfig(name, env) {
  switch (name) {
    case "bell":
      return { enabled: true };
    case "toast":
      return { enabled: true };
    case "webhook": {
      const url = String(env?.TRIFLUX_NOTIFY_WEBHOOK || "");
      return { enabled: Boolean(url), url };
    }
    default:
      throw new TypeError(`Unknown notify channel: ${name}`);
  }
}

function normalizeChannelConfig(name, value, env) {
  const base = defaultChannelConfig(name, env);
  const patch =
    typeof value === "boolean"
      ? { enabled: value }
      : value && typeof value === "object"
        ? value
        : {};

  const next = {
    ...base,
    ...patch,
  };

  if ("enabled" in next) {
    next.enabled = Boolean(next.enabled);
  }

  if (name === "webhook") {
    next.url = String(next.url || env?.TRIFLUX_NOTIFY_WEBHOOK || "");
  }

  if (name === "toast") {
    if (next.command != null) next.command = String(next.command);
    if (next.timeoutMs != null)
      next.timeoutMs = Math.max(
        1,
        Number.parseInt(String(next.timeoutMs), 10) || 5000,
      );
  }

  return freezeRecord(next);
}

function normalizeChannels(channels, env) {
  const source = channels && typeof channels === "object" ? channels : {};
  const normalized = {};
  for (const name of NOTIFY_CHANNELS) {
    normalized[name] = normalizeChannelConfig(name, source[name], env);
  }
  return Object.freeze(normalized);
}

function updateChannelConfig(channels, channel, config, env) {
  if (!NOTIFY_CHANNELS.includes(channel)) {
    throw new TypeError(`Unknown notify channel: ${channel}`);
  }

  return Object.freeze({
    ...channels,
    [channel]: normalizeChannelConfig(
      channel,
      {
        ...channels[channel],
        ...(typeof config === "boolean" ? { enabled: config } : config || {}),
      },
      env,
    ),
  });
}

function formatEventTitle(event) {
  switch (event.type) {
    case "completed":
      return "Triflux completed";
    case "failed":
      return "Triflux failed";
    case "inputWait":
      return "Triflux waiting for input";
    default:
      return "Triflux notification";
  }
}

function formatEventBody(event) {
  const parts = [];
  if (event.summary) parts.push(event.summary);

  const meta = [
    event.sessionId ? `session ${event.sessionId}` : "",
    event.host ? `host ${event.host}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  if (meta) parts.push(meta);

  return parts.join("\n") || event.timestamp;
}

function createResult(channel, status, extra = {}) {
  return freezeRecord({ channel, status, ...extra });
}

function execFileAsync(command, args, options, execFileFn) {
  return new Promise((resolve, reject) => {
    execFileFn(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function sendBell(config, deps) {
  if (!config.enabled)
    return createResult("bell", "skipped", { reason: "disabled" });
  const stream = deps.stdout;
  if (!stream || typeof stream.write !== "function") {
    return createResult("bell", "skipped", { reason: "stdout-unavailable" });
  }

  try {
    stream.write("\u0007");
    return createResult("bell", "sent");
  } catch (error) {
    return createResult("bell", "failed", { error: error.message });
  }
}

function buildToastScript(title, body) {
  const safeTitle = escapePowerShellSingleQuoted(title);
  const safeBody = escapePowerShellSingleQuoted(body);
  return [
    "$ErrorActionPreference = 'Stop'",
    `$Title = '${safeTitle}'`,
    `$Body = '${safeBody}'`,
    "if (Get-Command New-BurntToastNotification -ErrorAction SilentlyContinue) {",
    "  New-BurntToastNotification -Text @($Title, $Body) | Out-Null",
    "  return",
    "}",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
    "$escapedTitle = [System.Security.SecurityElement]::Escape($Title)",
    "$escapedBody = [System.Security.SecurityElement]::Escape($Body)",
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    "$xml.LoadXml(\"<toast><visual><binding template='ToastGeneric'><text>$escapedTitle</text><text>$escapedBody</text></binding></visual></toast>\")",
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Triflux').Show($toast)",
  ].join("; ");
}

async function sendToast(event, config, deps) {
  if (!config.enabled)
    return createResult("toast", "skipped", { reason: "disabled" });
  const execFileFn = deps.execFile || execFile;

  // macOS: osascript 네이티브 알림
  if ((deps.platform || process.platform) === "darwin") {
    const title = formatEventTitle(event);
    const body = formatEventBody(event);
    const safeTitle = title.replace(/\\/g, "\\\\").replace(/'/g, "'\"'\"'");
    const safeBody = body.replace(/\\/g, "\\\\").replace(/'/g, "'\"'\"'");
    try {
      await execFileAsync(
        "osascript",
        ["-e", `display notification "${safeBody}" with title "${safeTitle}"`],
        { timeout: config.timeoutMs || 5000 },
        execFileFn,
      );
      return createResult("toast", "sent", { command: "osascript" });
    } catch (error) {
      return createResult("toast", "failed", { error: error.message });
    }
  }

  if ((deps.platform || process.platform) !== "win32") {
    return createResult("toast", "skipped", { reason: "unsupported-platform" });
  }
  const candidates = config.command
    ? [config.command]
    : Array.isArray(deps.powerShellCandidates) &&
        deps.powerShellCandidates.length > 0
      ? deps.powerShellCandidates
      : ["pwsh", "powershell.exe"];

  const title = formatEventTitle(event);
  const body = formatEventBody(event);
  const script = buildToastScript(title, body);
  const failures = [];

  for (const command of candidates) {
    try {
      await execFileAsync(
        command,
        ["-NoLogo", "-NoProfile", "-Command", script],
        {
          windowsHide: true,
          timeout: config.timeoutMs || 5000,
        },
        execFileFn,
      );
      return createResult("toast", "sent", { command });
    } catch (error) {
      failures.push(`${command}: ${error.message}`);
    }
  }

  return createResult("toast", "failed", {
    error: failures.join(" | ") || "toast-send-failed",
  });
}

async function sendWebhook(event, config, deps) {
  if (!config.enabled)
    return createResult("webhook", "skipped", { reason: "disabled" });
  if (!config.url)
    return createResult("webhook", "skipped", { reason: "missing-url" });
  if (typeof deps.fetch !== "function") {
    return createResult("webhook", "failed", { error: "fetch-unavailable" });
  }

  try {
    const response = await deps.fetch(config.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });

    if (!response?.ok) {
      return createResult("webhook", "failed", {
        error: `HTTP ${response?.status ?? "unknown"}`,
      });
    }

    return createResult("webhook", "sent", { statusCode: response.status });
  } catch (error) {
    return createResult("webhook", "failed", { error: error.message });
  }
}

function createNotifierInstance(channels, deps) {
  async function notify(event) {
    const normalizedEvent = normalizeEvent(event, { host: deps.hostname });
    const results = {
      bell: await sendBell(channels.bell, deps),
      toast: await sendToast(normalizedEvent, channels.toast, deps),
      webhook: await sendWebhook(normalizedEvent, channels.webhook, deps),
    };

    return freezeRecord({
      event: normalizedEvent,
      results: Object.freeze(results),
    });
  }

  function setChannel(channel, config) {
    return createNotifierInstance(
      updateChannelConfig(channels, channel, config, deps.env),
      deps,
    );
  }

  return Object.freeze({ notify, setChannel });
}

/**
 * 팀 세션 알림기 팩토리.
 * - bell: 터미널 BEL 문자
 * - toast: Windows PowerShell 기반 toast (BurntToast 우선, WinRT fallback)
 * - webhook: TRIFLUX_NOTIFY_WEBHOOK JSON POST
 *
 * Immutable pattern: setChannel()은 기존 notifier를 수정하지 않고 새 notifier를 반환한다.
 *
 * @param {object} [opts]
 * @param {object} [opts.channels] — 채널별 초기 설정
 * @param {object} [opts.env=process.env] — 환경 변수 소스
 * @param {NodeJS.WriteStream|{write:function}} [opts.stdout=process.stdout] — bell 출력 대상
 * @param {string} [opts.platform=process.platform] — 플랫폼 override (test 용)
 * @param {string} [opts.hostname=os.hostname()] — 기본 host override
 * @param {object} [opts.deps] — 테스트용 의존성 주입
 * @returns {{ notify(event: object): Promise<object>, setChannel(channel: string, config: object|boolean): object }}
 */
export function createNotifier(opts = {}) {
  const env = opts.env || process.env;
  const deps = Object.freeze({
    env,
    stdout: opts.stdout || process.stdout,
    execFile: opts.deps?.execFile || execFile,
    fetch: opts.deps?.fetch || globalThis.fetch?.bind(globalThis),
    platform: opts.platform || process.platform,
    hostname: opts.hostname || os.hostname(),
    powerShellCandidates: Object.freeze(
      opts.deps?.powerShellCandidates || ["pwsh", "powershell.exe"],
    ),
  });

  return createNotifierInstance(normalizeChannels(opts.channels, env), deps);
}
