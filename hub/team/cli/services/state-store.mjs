import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

const TEAM_STATE_FILE = join(
  HUB_PID_DIR,
  TEAM_PROFILE === "codex-team" ? "team-state-codex-team.json" : "team-state.json",
);

export function loadTeamState() {
  try {
    return JSON.parse(readFileSync(TEAM_STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function saveTeamState(state) {
  mkdirSync(dirname(TEAM_STATE_FILE), { recursive: true });
  writeFileSync(TEAM_STATE_FILE, JSON.stringify({ ...state, profile: TEAM_PROFILE }, null, 2) + "\n");
}

export function clearTeamState() {
  try { unlinkSync(TEAM_STATE_FILE); } catch {}
}
