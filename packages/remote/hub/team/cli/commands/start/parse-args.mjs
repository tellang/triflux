import { resolve } from "node:path";
import { normalizeLayout, normalizeTeammateMode } from "../../services/runtime-mode.mjs";
import { parseDashboardLayout } from "../../../dashboard-layout.mjs";
import { parseDashboardAnchor } from "../../../dashboard-anchor.mjs";

// --assign 파싱 시 마지막 콜론 뒤를 role로 인식할 알려진 역할/CLI 이름
const KNOWN_ROLES = new Set([
  "codex", "gemini", "claude",
  "executor", "architect", "planner", "analyst", "critic",
  "debugger", "verifier", "code-reviewer", "security-reviewer",
  "test-engineer", "designer", "writer", "scientist",
]);

/**
 * --assign "cli:prompt:role" 형식을 콜론-안전하게 파싱한다.
 * 프롬프트 내부의 콜론(:)은 구분자로 취급하지 않는다.
 *
 * 규칙:
 *   1. 첫 번째 콜론 앞 = CLI 이름
 *   2. 마지막 콜론 뒤가 KNOWN_ROLES에 있으면 role, 나머지가 prompt
 *   3. 그 외에는 첫 콜론 뒤 전체가 prompt, role은 빈 문자열
 */
function parseAssignValue(raw) {
  const firstColon = raw.indexOf(":");
  if (firstColon < 0) return null;

  const cli = raw.slice(0, firstColon).trim();
  const rest = raw.slice(firstColon + 1);

  const lastColon = rest.lastIndexOf(":");
  if (lastColon > 0) {
    const candidate = rest.slice(lastColon + 1).trim().toLowerCase();
    if (KNOWN_ROLES.has(candidate)) {
      return { cli, prompt: rest.slice(0, lastColon).trim(), role: candidate };
    }
  }

  return { cli, prompt: rest.trim(), role: "" };
}

export function parseTeamArgs(args = []) {
  let agents = ["codex", "gemini"];
  let lead = "claude";
  let layout = "2x2";
  let teammateMode = "auto";
  const taskParts = [];
  const assigns = []; // --assign "codex:프롬프트:역할" 형식
  let autoAttach = true;
  let progressive = true;
  let timeoutSec = 300;
  let verbose = false;
  let dashboard = true;
  let dashboardLayout = "lite";
  let dashboardSize = 0.40;
  let dashboardAnchor = "window";
  let mcpProfile = "";
  let model = "";
  let cwd = "";

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
      const parsed = parseAssignValue(args[++index]);
      if (parsed) assigns.push(parsed);
    } else if (current === "--auto-attach") {
      autoAttach = true;
    } else if (current === "--no-auto-attach") {
      autoAttach = false;
    } else if (current === "--verbose") {
      verbose = true;
    } else if (current === "--dashboard") {
      dashboard = true;
    } else if (current === "--no-dashboard") {
      dashboard = false;
    } else if (current === "--dashboard-layout" && args[index + 1]) {
      dashboardLayout = parseDashboardLayout(args[++index]);
    } else if (current === "--dashboard-size" && args[index + 1]) {
      dashboardSize = Math.min(0.8, Math.max(0.2, parseFloat(args[++index]) || 0.50));
    } else if (current === "--dashboard-anchor" && args[index + 1]) {
      dashboardAnchor = parseDashboardAnchor(args[++index]);
    } else if (current === "--no-progressive") {
      progressive = false;
    } else if (current === "--timeout" && args[index + 1]) {
      timeoutSec = Number(args[++index]) || 300;
    } else if (current === "--mcp-profile" && args[index + 1]) {
      mcpProfile = args[++index].trim();
    } else if ((current === "--model" || current === "-m") && args[index + 1]) {
      model = args[++index].trim();
    } else if (current === "--cwd" && args[index + 1]) {
      let p = args[++index].trim();
      // MSYS/Git Bash 드라이브 문자 변환: /c/... → C:/...
      if (process.platform === "win32" && /^\/[a-zA-Z]\//.test(p)) {
        p = p[1].toUpperCase() + ":" + p.slice(2);
      }
      cwd = resolve(p);
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
    dashboardLayout,
    dashboardSize,
    dashboardAnchor,
    mcpProfile,
    model,
    cwd,
  };
}
