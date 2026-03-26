import { normalizeLayout, normalizeTeammateMode } from "../../services/runtime-mode.mjs";

export function parseTeamArgs(args = []) {
  let agents = ["codex", "gemini"];
  let lead = "claude";
  let layout = "2x2";
  let teammateMode = "auto";
  const taskParts = [];
  const assigns = []; // --assign "codex:프롬프트:역할" 형식
  let autoAttach = false;
  let progressive = true;
  let timeoutSec = 300;
  let verbose = false;
  let dashboard = false;
  let mcpProfile = "";

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--agents" && args[index + 1]) {
      agents = args[++index].split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    } else if (current === "--lead" && args[index + 1]) {
      lead = args[++index].trim().toLowerCase();
    } else if (current === "--layout" && args[index + 1]) {
      layout = args[++index];
    } else if ((current === "--teammate-mode" || current === "--mode") && args[index + 1]) {
      teammateMode = args[++index];
    } else if (current === "--assign" && args[index + 1]) {
      // "cli:prompt:role" 형식 파싱
      const parts = args[++index].split(":");
      if (parts.length >= 2) {
        assigns.push({ cli: parts[0].trim(), prompt: parts.slice(1, -1).join(":").trim() || parts[1].trim(), role: parts[parts.length - 1]?.trim() || "" });
      }
    } else if (current === "--auto-attach") {
      autoAttach = true;
    } else if (current === "--no-auto-attach") {
      autoAttach = false;
    } else if (current === "--verbose") {
      verbose = true;
    } else if (current === "--dashboard") {
      dashboard = true;
    } else if (current === "--no-progressive") {
      progressive = false;
    } else if (current === "--timeout" && args[index + 1]) {
      timeoutSec = Number(args[++index]) || 300;
    } else if (current === "--mcp-profile" && args[index + 1]) {
      mcpProfile = args[++index].trim();
    } else if (current.startsWith("-")) {
      console.warn(`  ⚠ 미인식 플래그 무시: ${current}`);
    } else {
      taskParts.push(current);
    }
  }

  return {
    agents,
    lead,
    layout: normalizeLayout(layout),
    teammateMode: normalizeTeammateMode(teammateMode),
    task: taskParts.join(" ").trim(),
    assigns,
    autoAttach,
    progressive,
    timeoutSec,
    verbose,
    dashboard,
    mcpProfile,
  };
}
