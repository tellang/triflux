import { normalizeLayout, normalizeTeammateMode } from "../../services/runtime-mode.mjs";

export function parseTeamArgs(args = []) {
  let agents = ["codex", "gemini"];
  let lead = "claude";
  let layout = "2x2";
  let teammateMode = "auto";
  const taskParts = [];

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
    } else if (!current.startsWith("-")) {
      taskParts.push(current);
    }
  }

  return {
    agents,
    lead,
    layout: normalizeLayout(layout),
    teammateMode: normalizeTeammateMode(teammateMode),
    task: taskParts.join(" ").trim(),
  };
}
