const AGENT_ENV = [
  ["claude-code", ["CLAUDECODE", "CLAUDE_CODE"]],
  ["codex", ["CODEX_SANDBOX", "CODEX_CI", "CODEX_THREAD_ID"]],
  ["gemini-cli", ["GEMINI_CLI"]],
  ["antigravity", ["ANTIGRAVITY_AGENT"]],
  ["opencode", ["OPENCODE_CLIENT"]],
  ["cursor", ["CURSOR_AGENT"]],
];

const enabled = (value) =>
  Boolean(value) && !/^(0|false|no|off)$/iu.test(value);

export function outputOptions(
  args = [],
  { env = process.env, input = process.stdin, output = process.stdout } = {},
) {
  const agent =
    AGENT_ENV.find(([, keys]) => keys.some((key) => enabled(env[key])))?.[0] ||
    (enabled(env.AI_AGENT)
      ? env.AI_AGENT === "1"
        ? "ai-agent"
        : env.AI_AGENT
      : null);
  const json = args.includes("--json");
  return {
    json,
    quiet: args.includes("--quiet") || args.includes("-q"),
    verbose: args.includes("--verbose"),
    check: args.includes("--check"),
    agent,
    nonInteractive:
      json ||
      Boolean(agent) ||
      !input?.isTTY ||
      !output?.isTTY ||
      enabled(env.CI) ||
      enabled(env.DOCKER) ||
      env.npm_lifecycle_event === "postinstall",
    color:
      Boolean(output?.isTTY) &&
      env.NO_COLOR === undefined &&
      env.TERM !== "dumb" &&
      (env.FORCE_COLOR === undefined ||
        ["", "true", "1", "2", "3"].includes(env.FORCE_COLOR)),
  };
}

export function createCliResult(command, version) {
  return {
    command,
    outcome: "ok",
    message: "",
    alreadyInGoalState: true,
    from: version,
    to: version,
    changed: [],
    unchanged: 0,
    targets: [],
    warnings: [],
    files: [],
    steps: [],
  };
}

export function recordFile(result, path, change) {
  result.files.push({ path, change });
  if (change === "noop") result.unchanged++;
  else {
    result.changed.push(path);
    result.alreadyInGoalState = false;
  }
}

export function addWarning(result, code, message) {
  if (!result.warnings.some((warning) => warning.message === message))
    result.warnings.push({ code, message });
}

export function addStep(result, message) {
  result.steps.push(message);
  result.alreadyInGoalState = false;
}

export function renderCliResult(result, options = {}) {
  const { json, quiet, verbose, check, agent, nonInteractive, color, details } =
    options;
  if (json) {
    const { files, steps, elapsed, ...publicResult } = result;
    return `${JSON.stringify(details ? result : publicResult)}\n`;
  }
  const mark = (symbol) =>
    color
      ? `\x1b[${symbol === "✗" ? 31 : symbol === "!" ? 33 : 32}m${symbol}\x1b[0m`
      : symbol;
  const lines = [];
  if (result.outcome === "failed") {
    lines.push(
      `${mark("✗")} ${result.command === "update" ? "업데이트" : "설정"} 실패: ${result.message}`,
    );
    if (result.command === "update")
      lines.push("직접 실행: npm i -g triflux@latest");
  } else if (!quiet) {
    if (result.command === "update") {
      const versionChanged = result.from !== result.to;
      const version = versionChanged
        ? `${result.from} -> ${result.to}`
        : `${result.to} 최신`;
      if (check)
        lines.push(
          versionChanged
            ? `업데이트 있음: ${result.from} -> ${result.to}`
            : `${mark("✓")} triflux ${version}`,
        );
      else {
        const time = `${(result.elapsed / 1000).toFixed(1)}s`;
        const detail =
          !versionChanged && !result.changed.length
            ? `파일 ${result.unchanged}개 일치, ${time}`
            : time;
        lines.push(`${mark("✓")} triflux ${version} (${detail})`);
        if (versionChanged)
          lines.push(
            `  https://github.com/tellang/triflux/releases/tag/v${result.to}`,
          );
      }
      if (result.changed.length)
        lines.push(
          `파일 ${result.changed.length}개 반영 (${result.unchanged}개 그대로)`,
        );
    } else {
      const context = agent
        ? ` (에이전트: ${agent}, 비대화식)`
        : nonInteractive
          ? " (비대화식)"
          : "";
      lines.push(`triflux ${result.to} setup${context}`);
    }
    if (!check) {
      if (result.command === "update" || verbose) {
        for (const { path, change } of result.files) {
          if (change === "noop" && !verbose) continue;
          lines.push(
            `  ${mark(change === "create" ? "+" : change === "noop" ? "✓" : "~")} ${path}`,
          );
        }
      }
      if (
        result.command === "setup" ||
        !result.alreadyInGoalState ||
        result.warnings.length
      ) {
        for (const { name, status, detail } of result.targets)
          lines.push(
            `  ${mark(status === "ok" ? "✓" : status === "skipped" ? "-" : "✗")} ${name.padEnd(8)} ${detail}`,
          );
      }
      for (const step of result.steps) lines.push(`  ${mark("✓")} ${step}`);
    }
  }
  for (const warning of result.warnings)
    lines.push(`${mark("!")} ${warning.message}`);
  if (!quiet && result.outcome === "ok" && !check) {
    if (result.command === "setup") {
      lines.push(
        `설정 완료${result.warnings.length ? `, 경고 ${result.warnings.length}건` : ""}`,
        "다음: tfx doctor",
      );
    } else if (result.warnings.length || result.from !== result.to) {
      lines.push(
        `${result.warnings.length ? `경고 ${result.warnings.length}건. ` : ""}${result.from !== result.to ? `되돌리기: npm i -g triflux@${result.from}` : ""}`.trim(),
      );
    }
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export function postinstallMessage(version) {
  return `triflux ${version} 설치됨. 설정: tfx setup  (CI 에서는 건너뜀)\n`;
}
