import { join } from "node:path";

export const SESSION_TTL_SEC = 30 * 60;
export const STATE_REL_PATH = join(".omc", "state", "cross-review.json");

export function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("error", () => resolve(""));
  });
}

export function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export function resolveBaseDir(payload) {
  if (typeof payload?.cwd === "string" && payload.cwd.trim()) return payload.cwd;
  if (typeof payload?.directory === "string" && payload.directory.trim()) return payload.directory;
  return process.cwd();
}

export function shouldTrackPath(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) return false;

  const lower = filePath.toLowerCase();
  if (lower.startsWith(".omc/") || lower.startsWith(".claude/")) return false;
  if (lower === "package-lock.json" || lower.endsWith("/package-lock.json")) return false;
  if (/\.(md|lock|yml|yaml)$/i.test(lower)) return false;
  return true;
}

export function expectedReviewer(author) {
  if (author === "claude") return "codex";
  if (author === "codex") return "claude";
  if (author === "gemini") return "claude";
  return "";
}
