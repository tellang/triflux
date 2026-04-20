import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PKG_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
export const HUB_PID_DIR =
  process.env.TFX_HUB_PID_DIR || join(homedir(), ".claude", "cache", "tfx-hub");
export const TEAM_PROFILE = (() => {
  const raw = String(process.env.TFX_TEAM_PROFILE || "team")
    .trim()
    .toLowerCase();
  return raw === "codex-team" ? "codex-team" : "team";
})();

export const SESSION_ID = process.env.CLAUDE_SESSION_ID || `s${Date.now()}`;

function getStatePath(sessionId) {
  if (sessionId) return join(HUB_PID_DIR, `team-state-${sessionId}.json`);
  return join(
    HUB_PID_DIR,
    TEAM_PROFILE === "codex-team"
      ? "team-state-codex-team.json"
      : "team-state.json",
  );
}

function findLatestMatchingTeamState() {
  try {
    if (!existsSync(HUB_PID_DIR)) return null;
    const entries = readdirSync(HUB_PID_DIR)
      .filter((name) => /^team-state-.+\.json$/.test(name))
      .map((name) => {
        const path = join(HUB_PID_DIR, name);
        try {
          return { path, mtime: statSync(path).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    for (const { path } of entries) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if ((parsed.profile || "team") === TEAM_PROFILE) return parsed;
      } catch {
        // corrupt entry — skip
      }
    }
  } catch {
    // directory walk failure
  }
  return null;
}

export function loadTeamState(sessionId) {
  const explicit = Boolean(sessionId);
  const resolvedId = sessionId || SESSION_ID;
  const sessionPath = getStatePath(resolvedId);
  try {
    if (existsSync(sessionPath))
      return JSON.parse(readFileSync(sessionPath, "utf8"));
  } catch {
    return null;
  }
  // 세션별 파일 없으면 기존 team-state.json fallback
  const legacyPath = getStatePath(null);
  try {
    if (existsSync(legacyPath))
      return JSON.parse(readFileSync(legacyPath, "utf8"));
  } catch {
    return null;
  }
  // Issue #116-B: CLAUDE_SESSION_ID 미설정이거나 bg shell 의 다른 세션이 저장한
  // team-state-*.json 을 tfx multi status 가 못 찾던 false-negative 우회.
  // 명시 sessionId lookup 은 의도적 조회이므로 auto-discover 하지 않는다.
  if (!explicit) {
    const latest = findLatestMatchingTeamState();
    if (latest) return latest;
  }
  return null;
}

export function saveTeamState(state, sessionId) {
  const path = getStatePath(sessionId || state.sessionId || SESSION_ID);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ ...state, profile: TEAM_PROFILE }, null, 2) + "\n",
  );
}

export function clearTeamState(sessionId) {
  const path = getStatePath(sessionId || SESSION_ID);
  if (existsSync(path)) unlinkSync(path);
}
