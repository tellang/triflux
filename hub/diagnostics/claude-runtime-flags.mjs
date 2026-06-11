export function readBooleanRuntimeFlag(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "on";
}

function countStringArray(value) {
  return Array.isArray(value)
    ? value.filter((entry) => String(entry ?? "").trim()).length
    : 0;
}

export function inspectClaudeRuntimeFlags({
  env = process.env,
  settings = {},
} = {}) {
  const safeMode = readBooleanRuntimeFlag(env.CLAUDE_CODE_SAFE_MODE);
  const disableBundledSkills =
    readBooleanRuntimeFlag(env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS) ||
    settings?.disableBundledSkills === true;
  const allowedCount = countStringArray(settings?.allowedMcpServers);
  const deniedCount = countStringArray(settings?.deniedMcpServers);
  const managedMcpPolicy = {
    active: allowedCount > 0 || deniedCount > 0,
    allowedCount,
    deniedCount,
  };

  const messages = [];
  if (safeMode) {
    messages.push(
      "Claude Code safe mode is enabled; CLAUDE.md, plugins, skills, hooks, and MCP servers may be disabled.",
    );
  }
  if (disableBundledSkills) {
    messages.push(
      "Claude bundled skills/workflows are disabled; slash-command and skill discovery may differ from normal sessions.",
    );
  }
  if (managedMcpPolicy.active) {
    messages.push(
      `Claude managed MCP policy detected; allowed=${allowedCount}, denied=${deniedCount}.`,
    );
  }

  return {
    status: messages.length > 0 ? "warning" : "ok",
    safeMode,
    disableBundledSkills,
    managedMcpPolicy,
    summary:
      messages.length > 0
        ? messages.join(" ")
        : "Claude Code runtime flags look normal.",
    fix: safeMode
      ? "Unset CLAUDE_CODE_SAFE_MODE or restart Claude Code without --safe-mode for normal Triflux hooks/skills/MCP behavior."
      : disableBundledSkills
        ? "Unset CLAUDE_CODE_DISABLE_BUNDLED_SKILLS or set disableBundledSkills=false if bundled skills are expected."
        : managedMcpPolicy.active
          ? "Review allowedMcpServers/deniedMcpServers in Claude managed settings if MCP tools are missing."
          : undefined,
  };
}
