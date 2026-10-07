import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// 설치된 Triflux 실행 대상만 식별한다.
const MANAGED_FILENAMES = [
  "hook-orchestrator.mjs",
  "claude-cwd-projection-refresh.mjs",
  "permission-safe-allow.mjs",
  "safety-guard.mjs",
  "pipeline-stop.mjs",
  "agent-route-guard.mjs",
  "cross-review-tracker.mjs",
  "cross-review-gate.mjs",
  "tfx-gate-activate.mjs",
  "subagent-tracker.mjs",
  "subagent-verifier.mjs",
  "error-context.mjs",
  "hook-adaptive-collector.mjs",
  "post-tool-tips.mjs",
  "pre-compact-snapshot.mjs",
  "cto-north-star-brief.mjs",
  "session-start-lake.mjs",
  "session-start-fast.mjs",
  "session-end-cleanup.mjs",
  "mcp-config-watcher.mjs",
  "keyword-detector.mjs",
  "setup.mjs",
  "hub-ensure.mjs",
  "preflight-cache.mjs",
  "mcp-gateway-ensure.mjs",
  "mcp-safety-guard.mjs",
  "session-stale-cleanup.mjs",
];

const targetNames = MANAGED_FILENAMES.join("|").replaceAll(".", "\\.");
const uniqueTargetNames = MANAGED_FILENAMES.filter(
  (name) =>
    ![
      "setup.mjs",
      "hub-ensure.mjs",
      "preflight-cache.mjs",
      "mcp-gateway-ensure.mjs",
      "mcp-safety-guard.mjs",
      "session-stale-cleanup.mjs",
    ].includes(name),
)
  .join("|")
  .replaceAll(".", "\\.");
const packageTarget = new RegExp(
  String.raw`[/\\]triflux(?:[/\\](?:\.worktrees[/\\][^/\\]+|v?\d+\.\d+\.\d+[^/\\]*))?[/\\](?:hooks|scripts)[/\\](?:${targetNames})$`,
);
const pluginRootTarget = new RegExp(
  String.raw`^\$\{(?:CLAUDE_)?PLUGIN_ROOT\}[/\\](?:hooks|scripts)[/\\](?:${uniqueTargetNames})$`,
);
const gateSuffix = ".claude/scripts/tfx-gate-activate.mjs";

function isInstalledGateTarget(target) {
  const normalized = target.replaceAll("\\", "/");
  if (
    ["${HOME}", "$HOME", "~"].some(
      (root) => normalized === `${root}/${gateSuffix}`,
    )
  )
    return true;
  const installedTargets = [join(homedir(), gateSuffix)];
  if (process.env.CLAUDE_CONFIG_DIR)
    installedTargets.push(
      join(process.env.CLAUDE_CONFIG_DIR, "scripts/tfx-gate-activate.mjs"),
    );
  return installedTargets.some(
    (installed) => normalized === installed.replaceAll("\\", "/"),
  );
}

function readCommandToken(command) {
  const match = command.match(/^\s*(?:"([^"]*)"|'([^']*)'|(\S+))(.*)$/s);
  return match
    ? { value: match[1] ?? match[2] ?? match[3], rest: match[4] }
    : null;
}

function matchesTarget(target) {
  const resolvedFallback = target.replace(
    /^\$\{(?:CLAUDE_)?PLUGIN_ROOT:-([^}]+)\}/,
    "$1",
  );
  return (
    packageTarget.test(resolvedFallback) ||
    pluginRootTarget.test(target) ||
    isInstalledGateTarget(target)
  );
}

export function isLegacyTrifluxHook(hook) {
  if (hook?.type !== "command" || typeof hook.command !== "string")
    return false;
  const command = hook.command;
  const executable = readCommandToken(command);
  if (!executable || !/(?:^|[/\\])node(?:\.exe)?$/.test(executable.value))
    return false;
  const target = readCommandToken(executable.rest);
  if (!target) return false;
  // 옛 inline bootstrap만 제거한다.
  if (target.value === "-e" || target.value === "--eval")
    return (
      command.includes(".tfx-pkg-root") &&
      command.includes("hook-orchestrator.mjs") &&
      command.includes("spawnSync") &&
      command.includes("path.join(root")
    );
  if (matchesTarget(target.value)) return true;
  // run.cjs의 keyword-detector 인자를 확인한다.
  if (/[/\\]scripts[/\\]run\.cjs$/.test(target.value)) {
    const script = readCommandToken(target.rest);
    return (
      script?.value.endsWith("/scripts/keyword-detector.mjs") &&
      (matchesTarget(script.value) || pluginRootTarget.test(script.value))
    );
  }
  return false;
}

function removeManagedHooks(settings) {
  let removed = 0;
  const events = settings?.hooks;
  if (!events || typeof events !== "object" || Array.isArray(events))
    return removed;
  for (const [event, entries] of Object.entries(events)) {
    if (!Array.isArray(entries)) continue;
    const kept = [];
    for (const entry of entries) {
      if (!Array.isArray(entry?.hooks)) {
        kept.push(entry);
        continue;
      }
      const hooks = entry.hooks.filter((hook) => {
        if (!isLegacyTrifluxHook(hook)) return true;
        removed++;
        return false;
      });
      if (hooks.length)
        kept.push(
          hooks.length === entry.hooks.length ? entry : { ...entry, hooks },
        );
    }
    if (kept.length) events[event] = kept;
    else delete events[event];
  }
  if (Object.keys(events).length === 0) delete settings.hooks;
  return removed;
}

/** Claude 설정의 이전 Triflux command hook을 정리한다. */
export function cleanupLegacyHooks({
  settingsPath = join(
    process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
    "settings.json",
  ),
  dryRun = false,
} = {}) {
  const result = {
    ok: true,
    changed: false,
    wouldChange: false,
    removed: 0,
    backupPath: null,
    error: null,
  };
  let original;
  let settings;
  try {
    const pathInfo = lstatSync(settingsPath, { throwIfNoEntry: false });
    if (!pathInfo) return result;
    // symlink는 유지하고 실제 파일을 교체한다.
    const targetPath = pathInfo.isSymbolicLink()
      ? realpathSync(settingsPath)
      : settingsPath;
    original = readFileSync(targetPath, "utf8");
    settings = JSON.parse(original);
    if (!settings || typeof settings !== "object" || Array.isArray(settings))
      throw new Error("settings.json must contain an object");
    result.removed = removeManagedHooks(settings);
    result.wouldChange = result.removed > 0;
    if (!result.wouldChange || dryRun) return result;

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let backupPath = `${settingsPath}.tfx-bak-${stamp}`;
    for (let suffix = 1; existsSync(backupPath); suffix++)
      backupPath = `${settingsPath}.tfx-bak-${stamp}-${suffix}`;
    copyFileSync(settingsPath, backupPath, constants.COPYFILE_EXCL);
    result.backupPath = backupPath;

    const temporary = join(
      dirname(targetPath),
      `.settings.json.tfx-${process.pid}-${Date.now()}.tmp`,
    );
    try {
      writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: statSync(targetPath).mode,
      });
      renameSync(temporary, targetPath);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        /* 임시 파일 없음 */
      }
      throw error;
    }
    result.changed = true;
  } catch (error) {
    result.ok = false;
    result.error = error.message;
  }
  return result;
}
