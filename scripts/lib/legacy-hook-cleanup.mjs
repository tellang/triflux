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
import { writeRotatedBackup } from "./backup-rotation.mjs";

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
// 옛 setup 이 ~/.claude/scripts 에 복사하고 직접 등록한 스크립트.
function isInstalledScript(target, name) {
  const normalized = target.replaceAll("\\", "/");
  const suffix = `.claude/scripts/${name}`;
  if (
    ["${HOME}", "$HOME", "~"].some((root) => normalized === `${root}/${suffix}`)
  )
    return true;
  const installedTargets = [join(homedir(), suffix)];
  if (process.env.CLAUDE_CONFIG_DIR)
    installedTargets.push(join(process.env.CLAUDE_CONFIG_DIR, "scripts", name));
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
    isInstalledScript(target, "tfx-gate-activate.mjs")
  );
}

export function isLegacyTrifluxHook(hook) {
  if (hook?.type !== "command" || typeof hook.command !== "string")
    return false;
  const command = hook.command;
  const executable = readCommandToken(command);
  if (!executable) return false;
  // headless-guard 는 2026-09-07 에 제거됐지만 옛 setup 이 bash 로 등록한 항목이 남는다.
  if (/(?:^|[/\\])bash(?:\.exe)?$/.test(executable.value)) {
    const script = readCommandToken(executable.rest);
    return (
      !!script &&
      !script.rest.trim() &&
      isInstalledScript(script.value, "headless-guard-fast.sh")
    );
  }
  if (!/(?:^|[/\\])node(?:\.exe)?$/.test(executable.value)) return false;
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

const AGY_HOOK_GROUP = "triflux-session";

// 옛 ensure-agy-hooks 의 quoteCommandPath 와 같은 인용.
function quoteAgyCommandPath(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unquoteAgyCommandPath(quoted) {
  return quoted.slice(1, -1).replace(/\\(["\\])/g, "$1");
}

function lastSegments(path, count) {
  return path.split(/[/\\]+/u).slice(-count);
}

// 옛 설치기가 만든 명령을 풀어 같은 공식으로 다시 만들었을 때 똑같아야 한다.
// 첫 버전은 node 경로를 따옴표 없이, 이후 버전은 따옴표로 감쌌다.
function isInstallerAgyCommand(command) {
  const match = /^(?:("(?:[^"\\]|\\.)*")|([^"]+)) ("(?:[^"\\]|\\.)*")$/u.exec(
    command,
  );
  if (!match) return false;
  // 따옴표 없는 node 경로(첫 버전의 process.execPath)는 줄바꿈이나 셸 기호 없는 절대 경로여야 한다.
  if (match[2] && !/^(?:\/|[A-Za-z]:\\)[^\r\n"';&|`$<>]*$/u.test(match[2]))
    return false;
  const nodeBin = match[1] ? unquoteAgyCommandPath(match[1]) : match[2];
  const script = unquoteAgyCommandPath(match[3]);
  if (/[\r\n]/u.test(nodeBin + script)) return false;
  const [dir, file] = lastSegments(script, 2);
  if (dir !== "hooks" || file !== "agy-session-hook.mjs") return false;
  if (!/^node(?:js)?(?:\.exe)?$/iu.test(lastSegments(nodeBin, 1)[0]))
    return false;
  const rebuilt = `${match[1] ? quoteAgyCommandPath(nodeBin) : nodeBin} ${quoteAgyCommandPath(script)}`;
  return rebuilt === command;
}

// 모든 버전의 옛 설치기가 쓴 그룹 모양과 정확히 같을 때만 우리 것이다.
function isInstallerAgyGroup(group) {
  if (!group || typeof group !== "object" || Array.isArray(group)) return false;
  const keys = Object.keys(group).sort().join(",");
  if (keys !== "PreInvocation,enabled" || group.enabled !== true) return false;
  const entries = group.PreInvocation;
  if (!Array.isArray(entries) || entries.length !== 1) return false;
  const [entry] = entries;
  return (
    Object.keys(entry || {})
      .sort()
      .join(",") === "command,timeout,type" &&
    entry.type === "command" &&
    entry.timeout === 15 &&
    typeof entry.command === "string" &&
    isInstallerAgyCommand(entry.command)
  );
}

// 자동으로 지우지 않은 그룹 중 훅 스크립트를 언급하는 것. doctor 가 경고만 한다.
function agyHookMentions(hooks) {
  return Object.entries(hooks)
    .filter(([, group]) =>
      JSON.stringify(group ?? null).includes("agy-session-hook.mjs"),
    )
    .map(([name]) => name);
}

/** agy hooks.json 에서 옛 setup 이 등록한 triflux-session 훅을 지운다. */
export function cleanupAgyHooks({ geminiConfigHome, dryRun = false } = {}) {
  const hooksPath = join(
    geminiConfigHome || join(homedir(), ".gemini", "config"),
    "hooks.json",
  );
  const result = {
    ok: true,
    changed: false,
    wouldChange: false,
    removed: 0,
    leftover: [],
    hooksPath,
    backupPath: null,
    error: null,
  };
  // 테스트 실행 중에는 명시 경로 없이 실제 HOME 을 고치지 않는다.
  if (!geminiConfigHome && process.env.TEST_LOCK_PID) return result;
  try {
    if (!existsSync(hooksPath)) return result;
    const targetPath = realpathSync(hooksPath);
    const original = readFileSync(targetPath, "utf8");
    const hooks = JSON.parse(original);
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks))
      return result;
    const ours = isInstallerAgyGroup(hooks[AGY_HOOK_GROUP]);
    if (ours) {
      result.removed = 1;
      result.wouldChange = true;
    }
    result.leftover = agyHookMentions(hooks).filter(
      (name) => !(ours && name === AGY_HOOK_GROUP),
    );
    if (!ours || dryRun) return result;

    delete hooks[AGY_HOOK_GROUP];
    const mode = statSync(targetPath).mode & 0o777;
    const stamp = new Date()
      .toISOString()
      .replace(/[-:.TZ]/g, "")
      .slice(0, 14);
    result.backupPath = writeRotatedBackup(targetPath, original, {
      label: "bak-tfx-agy-hooks",
      suffix: stamp,
      mode,
    });
    const temporary = `${targetPath}.tfx-${process.pid}-${Date.now()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(hooks, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode,
    });
    renameSync(temporary, targetPath);
    result.changed = true;
  } catch (error) {
    result.ok = false;
    result.error = error.message;
  }
  return result;
}
