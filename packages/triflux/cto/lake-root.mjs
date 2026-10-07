import { execFileSync as defaultExecFileSync } from "node:child_process";
import {
  existsSync as defaultExistsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse } from "node:path";

const MAX_DEPTH = 64;

function execGit(cwd, args, execFileSync) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  }).trim();
}

function resolveViaGitCommonDir(cwd, execFileSync) {
  try {
    const commonDir = execGit(
      cwd,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      execFileSync,
    );
    if (commonDir && basename(commonDir) === ".git") {
      return dirname(commonDir);
    }

    // Bare repos and submodules can have non-`.git` common dirs. In that case,
    // `--show-toplevel` is the safest project root signal.
    const topLevel = execGit(
      cwd,
      ["rev-parse", "--path-format=absolute", "--show-toplevel"],
      execFileSync,
    );
    return topLevel || null;
  } catch {
    return null;
  }
}

/**
 * cwd 에서 가장 가까운 git toplevel(`.git` 디렉토리 또는 파일이 있는 폴더)을
 * 찾아 반환한다. linked worktree 에서는 worktree 루트가 아니라 git common dir 의
 * project root 를 반환해 프로젝트당 CTO lake 하나를 유지한다. 못 찾으면 cwd 를
 * 그대로 돌려준다(기존 동작 보존).
 *
 * @param {string} cwd 시작 디렉토리(보통 process.cwd())
 * @param {object} [opts]
 * @param {(path: string) => boolean} [opts.existsSync] 테스트용 주입 seam
 * @param {typeof defaultExecFileSync} [opts.execFileSync] 테스트용 git seam
 * @returns {string}
 */
export function resolveLakeRootDir(cwd, opts = {}) {
  const exists = opts?.existsSync || defaultExistsSync;
  const execFileSync = opts?.execFileSync || defaultExecFileSync;
  // 비문자열(객체/숫자 등 truthy 포함) 또는 빈 문자열이면 항상 "" 를 반환해
  // @returns {string} 계약을 지킨다. truthy 비문자열을 그대로 누설하지 않는다.
  if (typeof cwd !== "string" || !cwd) return "";

  const gitRoot = resolveViaGitCommonDir(cwd, execFileSync);
  if (gitRoot) return gitRoot;

  let dir = cwd;
  const { root } = parse(dir);
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (exists(join(dir, ".git"))) return dir;
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}

export function firstExisting(paths) {
  return paths.filter(Boolean).find((path) => defaultExistsSync(path)) || null;
}

export function toIsoTime(value) {
  if (typeof value === "string" && value.trim()) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return null;
}

export function shortHash(value) {
  const str = String(value ?? "");
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (h * 33) ^ str.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

export function pathLabel(value) {
  const str = String(value ?? "").replace(/[/\\]+$/u, "");
  if (!str) return "";
  const segments = str.split(/[/\\]+/u);
  return segments[segments.length - 1] || "";
}

export function normalizeLiveSession(session) {
  return {
    sessionId: String(session?.sessionId || session?.session_id || ""),
    agent_id:
      typeof session?.agent_id === "string"
        ? session.agent_id
        : typeof session?.agentId === "string"
          ? session.agentId
          : null,
    phase:
      typeof session?.phase === "string"
        ? session.phase
        : typeof session?.status === "string"
          ? session.status
          : "active",
    started_at: toIsoTime(
      session?.started_at ?? session?.startedAt ?? session?.lastHeartbeat,
    ),
  };
}

export async function readSynapseSnapshot(opts = {}) {
  const rootDir = opts.rootDir || process.cwd();
  const persistPath = firstExisting([
    opts.synapsePersistPath,
    join(rootDir, ".triflux", "synapse-registry.json"),
    join(rootDir, ".triflux", "synapse", "registry.json"),
    join(homedir(), ".claude", "cache", "tfx-hub", "synapse-sessions.json"),
    join(homedir(), ".claude", "cache", "tfx-hub", "synapse-registry.json"),
  ]);
  if (!persistPath) return { sessions: [], active_shards: [] };
  const data = JSON.parse(readFileSync(persistPath, "utf8"));
  // 상태 전이는 hub 소유이며 조회는 저장된 live 상태만 읽는다.
  const sessions = Object.entries(data).flatMap(([key, session]) => {
    const sessionId = String(session?.sessionId ?? key).trim();
    if (!sessionId || ["stale", "expired"].includes(session?.status)) return [];
    return [
      {
        ...session,
        sessionId,
        status: session?.status === "idle" ? "idle" : "active",
        lastHeartbeat:
          typeof session?.lastHeartbeat === "number"
            ? session.lastHeartbeat
            : Date.now(),
      },
    ];
  });
  return { sessions, active_shards: [] };
}

export function readJsonLines(filePath, limit = Infinity) {
  if (!defaultExistsSync(filePath)) return [];
  const lines = readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-limit).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

export function writeAtomic(filePath, body) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  writeFileSync(tmpPath, body, "utf8");
  renameSync(tmpPath, filePath);
}
