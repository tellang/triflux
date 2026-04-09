// ============================================================================
// HUD Mission Board — .omc/state/sessions/ 기반 에이전트 진행률 집계
// ============================================================================
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSIONS_DIR = join(homedir(), ".omc", "state", "sessions");

/**
 * .omc/state/sessions/ 디렉토리를 읽어 팀 상태를 반환한다.
 * @returns {{ agents: Array<{name: string, status: string, progress: number}>, dagLevel: number, totalProgress: number } | null}
 */
export async function getMissionBoardState(sessionsDir = SESSIONS_DIR) {
  let entries;
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return null;
  }

  const jsonFiles = entries.filter((f) => f.endsWith(".json"));
  if (jsonFiles.length === 0) return null;

  const agents = [];
  for (const file of jsonFiles) {
    let data;
    try {
      const raw = await readFile(join(sessionsDir, file), "utf8");
      data = JSON.parse(raw);
    } catch {
      continue;
    }

    const name = data.name ?? file.replace(/\.json$/, "");
    const status = data.status ?? "idle";
    const progress = typeof data.progress === "number" ? data.progress : 0;
    agents.push({ name, status, progress });
  }

  if (agents.length === 0) return null;

  const totalProgress =
    agents.length > 0
      ? Math.round(
          agents.reduce((sum, a) => sum + a.progress, 0) / agents.length,
        )
      : 0;

  return {
    agents,
    // TODO: derive dagLevel from real mission dependency metadata instead of hardcoding 0.
    dagLevel: 0,
    totalProgress,
  };
}
