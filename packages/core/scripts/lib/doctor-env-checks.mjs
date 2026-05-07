import { execFileSync } from "node:child_process";

export function commandExists(name) {
  try {
    execFileSync("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", name], {
      stdio: "ignore",
      timeout: 2000,
    });
    return true;
  } catch {
    return false;
  }
}

export function inspectMacTimeoutDependency({
  platform = process.platform,
  commandExists: exists = commandExists,
} = {}) {
  if (platform !== "darwin") {
    return { ok: true, status: "skipped", platform };
  }

  if (exists("gtimeout")) {
    return { ok: true, status: "ok", platform, provider: "gtimeout" };
  }
  if (exists("timeout")) {
    return { ok: true, status: "ok", platform, provider: "timeout" };
  }

  return {
    ok: false,
    status: "missing",
    platform,
    fix: "brew install coreutils",
  };
}

export function addPluginRootFallbackToCommand(command, pluginRoot) {
  if (typeof command !== "string") return command;
  const fallbackRoot = String(pluginRoot || "").replace(/\\/g, "/");
  if (!fallbackRoot) return command;
  return command
    .replaceAll("${PLUGIN_ROOT}", `\${PLUGIN_ROOT:-${fallbackRoot}}`)
    .replaceAll(
      "${CLAUDE_PLUGIN_ROOT}",
      `\${CLAUDE_PLUGIN_ROOT:-${fallbackRoot}}`,
    )
    .replace(
      /(^|[\s"'])\/(hooks|scripts)\//g,
      `$1\${PLUGIN_ROOT:-${fallbackRoot}}/$2/`,
    );
}

function hasBarePluginRootReference(command) {
  if (typeof command !== "string") return false;
  return (
    command.includes("${PLUGIN_ROOT}/") ||
    command.includes("${CLAUDE_PLUGIN_ROOT}/")
  );
}

function hasCollapsedRootHookPath(command) {
  if (typeof command !== "string") return false;
  return /(^|[\s"'])\/(?:hooks|scripts)\//.test(command);
}

export function findPluginRootHookIssues(settings) {
  const hooksByEvent =
    settings?.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  const issues = [];

  for (const [event, entries] of Object.entries(hooksByEvent)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      for (const hook of hooks) {
        const command = hook?.command;
        if (
          !hasBarePluginRootReference(command) &&
          !hasCollapsedRootHookPath(command)
        ) {
          continue;
        }
        issues.push({
          event,
          matcher: entry?.matcher || "*",
          command,
          reason: hasCollapsedRootHookPath(command)
            ? "collapsed-root-path"
            : "missing-plugin-root-fallback",
        });
      }
    }
  }

  return issues;
}

export function applyPluginRootHookFallbacks(settings, { pluginRoot } = {}) {
  if (!settings?.hooks || typeof settings.hooks !== "object") {
    return { changed: false, count: 0, settings };
  }

  let count = 0;
  for (const entries of Object.values(settings.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      for (const hook of hooks) {
        if (typeof hook?.command !== "string") continue;
        const next = addPluginRootFallbackToCommand(hook.command, pluginRoot);
        if (next !== hook.command) {
          hook.command = next;
          count++;
        }
      }
    }
  }

  return { changed: count > 0, count, settings };
}
