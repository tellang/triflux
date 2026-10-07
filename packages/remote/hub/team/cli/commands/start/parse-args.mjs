import { createRequire } from "node:module";
import { resolve } from "node:path";
import { parseDashboardAnchor } from "../../../dashboard-anchor.mjs";
import { parseDashboardLayout } from "../../../dashboard-layout.mjs";
import {
  normalizeLayout,
  normalizeTeammateMode,
} from "../../services/runtime-mode.mjs";

const AGENT_TO_CLI = createRequire(import.meta.url)("../../../agent-map.json");

/**
 * --assign "cli:prompt:role" 형식을 콜론-안전하게 파싱한다.
 * 프롬프트 내부의 콜론(:)은 구분자로 취급하지 않는다.
 *
 * 규칙:
 *   1. 첫 번째 콜론 앞 = CLI 이름
 *   2. 마지막 콜론 뒤가 agent-map.json에 있으면 role, 나머지가 prompt
 *   3. 그 외에는 첫 콜론 뒤 전체가 prompt, role은 빈 문자열
 */
function parseAssignValue(raw) {
  const firstColon = raw.indexOf(":");
  if (firstColon < 0) return null;

  const cli = raw.slice(0, firstColon).trim();
  const rest = raw.slice(firstColon + 1);

  const lastColon = rest.lastIndexOf(":");
  if (lastColon > 0) {
    const candidate = rest
      .slice(lastColon + 1)
      .trim()
      .toLowerCase();
    if (Object.hasOwn(AGENT_TO_CLI, candidate)) {
      return { cli, prompt: rest.slice(0, lastColon).trim(), role: candidate };
    }
  }

  return { cli, prompt: rest.trim(), role: "" };
}

export function parseTeamArgs(args = []) {
  let agents = ["codex", "antigravity"];
  let lead = "claude";
  let layout = "2x2";
  let teammateMode = "auto";
  const taskParts = [];
  const assigns = [];
  let autoAttach = true;
  let progressive = true;
  let timeoutSec = 0;
  let verbose = false;
  let dashboard = true;
  let dashboardLayout = "lite";
  let dashboardSize = 0.4;
  let dashboardAnchor = "window";
  let mcpProfile = "";
  let model = "";
  let cwd = "";
  let nativeBridge = false;
  let nativeBridgeMode = "agents";
  let nativeBridgeExplicit = false;
  let nativeBridgeUiRequested = false;
  let nativeBridgeUiOptOut = false;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--agents" && args[index + 1]) {
      agents = args[++index]
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
    } else if (current === "--lead" && args[index + 1]) {
      lead = args[++index].trim().toLowerCase();
    } else if (current === "--layout" && args[index + 1]) {
      layout = args[++index];
    } else if (
      (current === "--teammate-mode" || current === "--mode") &&
      args[index + 1]
    ) {
      teammateMode = args[++index];
    } else if (current === "--assign" && args[index + 1]) {
      const parsed = parseAssignValue(args[++index]);
      if (parsed) assigns.push(parsed);
    } else if (current === "--no-auto-attach") {
      autoAttach = false;
    } else if (current === "--verbose") {
      verbose = true;
    } else if (current === "--no-dashboard") {
      dashboard = false;
    } else if (current === "--dashboard-layout" && args[index + 1]) {
      dashboardLayout = parseDashboardLayout(args[++index]);
    } else if (current === "--dashboard-size" && args[index + 1]) {
      dashboardSize = Math.min(
        0.8,
        Math.max(0.2, parseFloat(args[++index]) || 0.5),
      );
    } else if (current === "--dashboard-anchor" && args[index + 1]) {
      dashboardAnchor = parseDashboardAnchor(args[++index]);
    } else if (current === "--no-progressive") {
      progressive = false;
    } else if (current === "--timeout" && args[index + 1]) {
      timeoutSec = Number(args[++index]) || 0;
    } else if (current === "--mcp-profile" && args[index + 1]) {
      mcpProfile = args[++index].trim();
    } else if ((current === "--model" || current === "-m") && args[index + 1]) {
      model = args[++index].trim();
    } else if (current === "--native-bridge" || current === "-nb") {
      nativeBridge = true;
      nativeBridgeExplicit = true;
    } else if (current === "--native-bridge-ui") {
      if (nativeBridgeUiOptOut) {
        throw new Error(
          "cannot combine --native-bridge-ui and --no-native-bridge-ui",
        );
      }
      nativeBridge = true;
      nativeBridgeMode = "agents";
      nativeBridgeExplicit = true;
      nativeBridgeUiRequested = true;
    } else if (current === "--no-native-bridge-ui") {
      if (nativeBridgeUiRequested) {
        throw new Error(
          "cannot combine --native-bridge-ui and --no-native-bridge-ui",
        );
      }
      nativeBridge = false;
      nativeBridgeUiOptOut = true;
    } else if (current === "--native-bridge-mode") {
      const mode = args[++index];
      if (mode !== "agents") {
        throw new Error(
          `unknown native bridge mode: ${mode || ""}; expected agents`,
        );
      }
      nativeBridge = true;
      nativeBridgeMode = mode;
      nativeBridgeExplicit = true;
    } else if (current === "--cwd" && args[index + 1]) {
      let p = args[++index].trim();
      // MSYS/Git Bash 드라이브 문자 변환: /c/... → C:/...
      if (process.platform === "win32" && /^\/[a-zA-Z]\//.test(p)) {
        p = p[1].toUpperCase() + ":" + p.slice(2);
      }
      cwd = resolve(p);
    } else if (current === "--auto-attach" || current === "--dashboard") {
      // 이전 설치 스킬이 넘기는 기본값 플래그는 무시한다.
    } else if (current.startsWith("-")) {
      console.warn(`  ⚠ 미인식 플래그 무시: ${current}`);
    } else {
      taskParts.push(current);
    }
  }

  const task = taskParts.join(" ").trim();
  const normalizedTeammateMode =
    task || assigns.length > 0
      ? normalizeTeammateMode(teammateMode)
      : teammateMode;
  if (
    !nativeBridgeExplicit &&
    !nativeBridgeUiOptOut &&
    normalizedTeammateMode === "headless"
  ) {
    nativeBridge = true;
  }

  return {
    agents,
    lead,
    layout: normalizeLayout(layout),
    teammateMode: normalizedTeammateMode,
    task,
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
    nativeBridge,
    nativeBridgeMode,
    nativeBridgeUiOptOut,
  };
}
