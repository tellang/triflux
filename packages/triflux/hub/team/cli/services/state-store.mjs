import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const PKG_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
export const HUB_PID_DIR = join(homedir(), ".claude", "cache", "tfx-hub");
export const TEAM_PROFILE = (() => {
  const raw = String(process.env.TFX_TEAM_PROFILE || "team").trim().toLowerCase();
  return raw === "codex-team" ? "codex-team" : "team";
})();

export const SESSION_ID = process.env.CLAUDE_SESSION_ID || `s${Date.now()}`;

function getStatePath(sessionId) {
  if (sessionId) return join(HUB_PID_DIR, `team-state-${sessionId}.json`);
  return join(HUB_PID_DIR, TEAM_PROFILE === "codex-team" ? "team-state-codex-team.json" : "team-state.json");
}

export function loadTeamState(sessionId) {
  const resolvedId = sessionId || SESSION_ID;
  const sessionPath = getStatePath(resolvedId);
  try {
    if (existsSync(sessionPath)) return JSON.parse(readFileSync(sessionPath, "utf8"));
  } catch {
    return null;
  }
  // 세션별 파일 없으면 기존 team-state.json fallback
  const legacyPath = getStatePath(null);
  try {
    if (existsSync(legacyPath)) return JSON.parse(readFileSync(legacyPath, "utf8"));
  } catch {
    return null;
  }
  return null;
}

export function saveTeamState(state, sessionId) {
  const path = getStatePath(sessionId || state.sessionId || SESSION_ID);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...state, profile: TEAM_PROFILE }, null, 2) + "\n");
}

export function clearTeamState(sessionId) {
  const path = getStatePath(sessionId || SESSION_ID);
  if (existsSync(path)) unlinkSync(path);
}
