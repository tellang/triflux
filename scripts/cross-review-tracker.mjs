#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

const SESSION_TTL_SEC = 30 * 60;
const STATE_REL_PATH = join(".omc", "state", "cross-review.json");
const EXCLUDED_FILE_PATTERN = /\.(md|lock|yml|yaml)$/i;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function readStdin() {
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

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function resolveBaseDir(payload) {
  if (typeof payload?.cwd === "string" && payload.cwd.trim()) return payload.cwd;
  if (typeof payload?.directory === "string" && payload.directory.trim()) return payload.directory;
  return process.cwd();
}

function resolveStatePath(baseDir) {
  return join(baseDir, STATE_REL_PATH);
}

function createEmptyState() {
  return {
    files: {},
    session_start: nowSec(),
  };
}

function loadState(statePath) {
  if (!existsSync(statePath)) return createEmptyState();

  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    const sessionStart = Number(parsed?.session_start || 0);
    const expired = !sessionStart || nowSec() - sessionStart > SESSION_TTL_SEC;
    if (expired) {
      try {
        unlinkSync(statePath);
      } catch {}
      return createEmptyState();
    }

    return {
      files: parsed?.files && typeof parsed.files === "object" ? parsed.files : {},
      session_start: sessionStart,
    };
  } catch {
    return createEmptyState();
  }
}

function saveState(statePath, state) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function normalizePath(filePath, baseDir) {
  if (typeof filePath !== "string" || !filePath.trim()) return "";

  const raw = filePath.trim();
  let normalized = raw;

  if (isAbsolute(raw)) {
    const relPath = relative(baseDir, raw);
    if (relPath.startsWith("..")) return "";
    normalized = relPath;
  }

  return normalized.replace(/\\/g, "/").replace(/^\.\//, "");
}

function shouldTrackPath(filePath) {
  if (!filePath) return false;
  const lower = filePath.toLowerCase();

  if (lower.startsWith(".omc/") || lower.startsWith(".claude/")) return false;
  if (lower === "package-lock.json" || lower.endsWith("/package-lock.json")) return false;
  if (EXCLUDED_FILE_PATTERN.test(lower)) return false;
  return true;
}

function extractFilePath(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  const candidate = toolInput.file_path ?? toolInput.path ?? toolInput.filePath ?? "";
  return typeof candidate === "string" ? candidate : "";
}

function extractCandidatePaths(payload, baseDir) {
  const candidates = new Set();

  const looksLikePath = (value) => {
    if (typeof value !== "string") return false;
    const trimmed = value.trim();
    if (!trimmed || /\s/.test(trimmed)) return false;
    if (trimmed.length > 260) return false;
    if (!trimmed.includes(".") && !trimmed.includes("/") && !trimmed.includes("\\")) return false;
    return /^[./\\A-Za-z0-9_-]/.test(trimmed);
  };

  const addPath = (value) => {
    if (!looksLikePath(value)) return;
    const normalized = normalizePath(value, baseDir);
    if (shouldTrackPath(normalized)) candidates.add(normalized);
  };

  const scanValue = (value, depth = 0) => {
    if (depth > 3 || value == null) return;
    if (typeof value === "string") {
      addPath(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) scanValue(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;

    for (const [key, child] of Object.entries(value)) {
      const keyLower = key.toLowerCase();
      if (keyLower.includes("file") || keyLower.includes("path")) {
        scanValue(child, depth + 1);
      }
    }
  };

  addPath(extractFilePath(payload?.tool_input));

  scanValue(payload?.tool_response);
  scanValue(payload?.tool_output);
  scanValue(payload?.result);
  scanValue(payload?.output);

  return [...candidates];
}

function collectStrings(value, out = [], depth = 0) {
  if (depth > 4) return out;
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return out;
  }

  for (const key of Object.keys(value)) {
    collectStrings(value[key], out, depth + 1);
  }
  return out;
}

function detectCliActor(payload) {
  const lines = collectStrings(payload).join("\n");
  const match = lines.match(/\bcli\s*[:=]\s*(claude|codex|gemini)\b/i);
  return match ? match[1].toLowerCase() : "";
}

function detectAuthor(payload) {
  const actor = detectCliActor(payload);
  if (actor) return actor;
  return "claude";
}

function expectedReviewer(author) {
  if (author === "claude") return "codex";
  if (author === "codex") return "claude";
  if (author === "gemini") return "claude";
  return "";
}

function applyReviewer(state, reviewer, ts) {
  for (const [filePath, meta] of Object.entries(state.files)) {
    if (!meta || typeof meta !== "object") continue;
    if (!shouldTrackPath(filePath)) continue;

    const author = String(meta.author || "").toLowerCase();
    const expected = expectedReviewer(author);

    if (expected && reviewer === expected) {
      meta.reviewed = true;
      meta.reviewer = reviewer;
      meta.reviewed_ts = ts;
      delete meta.self_approved;
      continue;
    }

    if (reviewer === author) {
      meta.reviewed = false;
      meta.reviewer = reviewer;
      meta.reviewed_ts = ts;
      meta.self_approved = true;
    }
  }
}

async function main() {
  if (process.env.TFX_SKIP_CROSS_REVIEW === "1") {
    process.exit(0);
  }

  const raw = await readStdin();
  if (!raw.trim()) {
    process.exit(0);
  }

  const payload = parseJson(raw);
  if (!payload) {
    process.exit(0);
  }

  const baseDir = resolveBaseDir(payload);
  const statePath = resolveStatePath(baseDir);
  const state = loadState(statePath);
  const toolName = payload.tool_name || "";
  const ts = nowSec();
  let changed = false;

  if (toolName === "Edit" || toolName === "Write") {
    const toolInput = payload.tool_input || {};
    const normalizedPath = normalizePath(extractFilePath(toolInput), baseDir);
    if (shouldTrackPath(normalizedPath)) {
      state.files[normalizedPath] = {
        author: detectAuthor(payload),
        ts,
        reviewed: false,
      };
      changed = true;
    }
  } else if (toolName === "Bash") {
    const actor = detectCliActor(payload);
    if (actor) {
      const paths = extractCandidatePaths(payload, baseDir);
      if (paths.length > 0) {
        for (const path of paths) {
          state.files[path] = {
            author: actor,
            ts,
            reviewed: false,
          };
        }
      } else {
        applyReviewer(state, actor, ts);
      }
      changed = true;
    }
  }

  if (changed) {
    saveState(statePath, state);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
