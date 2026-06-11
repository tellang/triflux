import { execFile } from "node:child_process";

export const FOCUS_SCRIPT_TIMEOUT_MS = 5_000;

const DEFAULT_FOCUS_CANDIDATES = [
  "iTerm2",
  "Terminal",
  "Codex",
  "Claude",
  "Antigravity",
  "Code",
];

function normalizeAgentId(value) {
  const id = String(value || "")
    .trim()
    .toLowerCase();
  if (id === "agy" || id === "anti") return "antigravity";
  return id;
}

export function getFocusCandidates({ agentId } = {}) {
  switch (normalizeAgentId(agentId)) {
    case "codex":
      return ["Codex", "iTerm2", "Terminal", "Code"];
    case "claude":
      return ["Claude", "iTerm2", "Terminal"];
    case "antigravity":
      return ["Antigravity", "iTerm2", "Terminal"];
    default:
      return [...DEFAULT_FOCUS_CANDIDATES];
  }
}

function appleScriptList(values) {
  return `{${values.map((value) => JSON.stringify(String(value))).join(", ")}}`;
}

export function buildFocusScript({ agentId, appCandidates } = {}) {
  const candidates = Array.isArray(appCandidates)
    ? appCandidates.map(String).filter(Boolean)
    : getFocusCandidates({ agentId });
  return `
set appCandidates to ${appleScriptList(candidates)}
tell application "System Events"
  set runningNames to name of every process
end tell
repeat with appName in appCandidates
  set appText to appName as text
  if runningNames contains appText then
    tell application appText to activate
    return "activated " & appText
  end if
end repeat
return "no focus candidate running"
`;
}

export function focusSessionOnMac(target = {}, maybeUdsId = null) {
  const normalizedTarget =
    target && typeof target === "object"
      ? target
      : { sessionId: target, udsId: maybeUdsId };
  const script = buildFocusScript({ agentId: normalizedTarget.agentId });
  return new Promise((resolve) => {
    execFile(
      "osascript",
      ["-e", script],
      { timeout: FOCUS_SCRIPT_TIMEOUT_MS },
      (err, stdout = "", stderr = "") => {
        const output = String(stdout || stderr || "").trim();
        if (err) {
          console.error("mac-focus error:", err?.message || err);
          resolve({
            ok: false,
            sessionId: normalizedTarget.sessionId || null,
            pid: Number(normalizedTarget.pid) || null,
            agentId: normalizedTarget.agentId || null,
            error: err?.message || String(err),
            output,
          });
          return;
        }
        resolve({
          ok: true,
          sessionId: normalizedTarget.sessionId || null,
          pid: Number(normalizedTarget.pid) || null,
          agentId: normalizedTarget.agentId || null,
          output,
        });
      },
    );
  });
}
