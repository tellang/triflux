import { existsSync, readFileSync, statSync } from "fs";
import { basename, dirname, isAbsolute, resolve } from "path";

const URL_LIKE_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u;
const WINDOWS_ABS_RE = /^[a-zA-Z]:[\\/]/u;

function normalizeMarkdownTarget(raw) {
  const trimmed = String(raw || "").trim();
  const match = /^<?([^>\s]+)>?(?:\s+["'][^"']*["'])?$/u.exec(trimmed);
  return match ? match[1] : trimmed;
}

function sanitizeToken(raw) {
  let token = String(raw || "").trim();
  if (!token) return "";
  token = token
    .replace(/^[<(]+/u, "")
    .replace(/[)>.,;:!?]+$/u, "")
    .trim();
  return token;
}

function isLikelyPathToken(token) {
  if (!token || URL_LIKE_RE.test(token)) return false;
  if (
    token.startsWith("app://") ||
    token.startsWith("plugin://") ||
    token.startsWith("mention://")
  )
    return false;
  if (token === "~") return false;

  const hasPathSeparator = token.includes("/") || token.includes("\\");
  const hasDotPrefix =
    token.startsWith("./") || token.startsWith("../") || token.startsWith(".");
  const isHomeRelative = token.startsWith("~/") || token.startsWith("~\\");
  const isWindowsAbs = WINDOWS_ABS_RE.test(token);
  const hasFileLikeSuffix = /\.[a-zA-Z0-9]{1,16}$/u.test(token);

  return (
    hasPathSeparator ||
    hasDotPrefix ||
    isHomeRelative ||
    isWindowsAbs ||
    hasFileLikeSuffix
  );
}

export function extractExplicitFileTokens(text) {
  const content = String(text || "");
  const candidates = [];

  for (const match of content.matchAll(/\[[^\]]+\]\(([^)\n]+)\)/gu)) {
    candidates.push(normalizeMarkdownTarget(match[1]));
  }
  for (const match of content.matchAll(/`([^`\n]+)`/gu)) {
    candidates.push(match[1]);
  }
  for (const match of content.matchAll(/"([^"\n]+)"/gu)) {
    candidates.push(match[1]);
  }
  for (const match of content.matchAll(/'([^'\n]+)'/gu)) {
    candidates.push(match[1]);
  }

  const unique = new Set();
  for (const raw of candidates) {
    const token = sanitizeToken(raw);
    if (!isLikelyPathToken(token)) continue;
    unique.add(token);
  }

  return Array.from(unique);
}

function validateTransferFile(filePath, maxBytes) {
  if (!existsSync(filePath)) {
    throw new Error(`referenced file not found: ${filePath}`);
  }
  const stats = statSync(filePath);
  if (!stats.isFile()) {
    throw new Error(`referenced path is not a file: ${filePath}`);
  }
  if (stats.size > maxBytes) {
    throw new Error(
      `referenced file too large: ${stats.size} bytes (max ${maxBytes}) for ${filePath}`,
    );
  }
  return stats.size;
}

function resolveReferencePath(token, handoffAbsPath, cwd) {
  if (WINDOWS_ABS_RE.test(token) || isAbsolute(token)) {
    return resolve(token);
  }

  if (token.startsWith("~/") || token.startsWith("~\\")) {
    if (!process.env.HOME && !process.env.USERPROFILE) {
      return null;
    }
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    return resolve(homeDir, token.slice(2));
  }

  const handoffDir = dirname(handoffAbsPath);
  const primary = resolve(handoffDir, token);
  if (existsSync(primary)) {
    return primary;
  }

  const fallback = resolve(cwd, token);
  return existsSync(fallback) ? fallback : primary;
}

function toRemotePath(stageRoot, relativePath) {
  const root = String(stageRoot).replace(/\\/gu, "/").replace(/\/+$/u, "");
  const rel = String(relativePath).replace(/\\/gu, "/").replace(/^\/+/, "");
  return `${root}/${rel}`;
}

export function buildRemoteTransferPlan(options = {}) {
  const {
    cwd = process.cwd(),
    handoffPath = null,
    maxBytes,
    remoteStageRoot,
    userPrompt = null,
    maxReferenceFiles = 32,
  } = options;

  if (!handoffPath) {
    return {
      prompt: userPrompt || "",
      replacements: [],
      stagedHandoffPath: null,
      transfers: [],
    };
  }

  if (!remoteStageRoot) {
    throw new Error("remoteStageRoot is required when handoffPath is provided");
  }

  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive number");
  }

  const absoluteHandoffPath = resolve(cwd, handoffPath);
  validateTransferFile(absoluteHandoffPath, maxBytes);
  const handoffContent = readFileSync(absoluteHandoffPath, "utf8").trim();

  const stagedHandoffPath = toRemotePath(
    remoteStageRoot,
    `handoff/${basename(absoluteHandoffPath)}`,
  );
  const transfers = [
    {
      localPath: absoluteHandoffPath,
      remotePath: stagedHandoffPath,
      type: "handoff",
    },
  ];

  const tokens = extractExplicitFileTokens(handoffContent);
  if (tokens.length > maxReferenceFiles) {
    throw new Error(
      `too many referenced files: ${tokens.length} (max ${maxReferenceFiles})`,
    );
  }

  const stagedByLocalPath = new Map();
  const replacements = [];
  let fileIndex = 0;

  for (const token of tokens) {
    const resolvedPath = resolveReferencePath(token, absoluteHandoffPath, cwd);
    validateTransferFile(resolvedPath, maxBytes);

    if (!stagedByLocalPath.has(resolvedPath)) {
      fileIndex += 1;
      const stagedPath = toRemotePath(
        remoteStageRoot,
        `refs/${String(fileIndex).padStart(2, "0")}-${basename(resolvedPath)}`,
      );
      stagedByLocalPath.set(resolvedPath, stagedPath);
      transfers.push({
        localPath: resolvedPath,
        remotePath: stagedPath,
        type: "reference",
      });
    }

    replacements.push({
      token,
      stagedPath: stagedByLocalPath.get(resolvedPath),
    });
  }

  const replacementEntries = Array.from(
    replacements
      .reduce((map, entry) => map.set(entry.token, entry.stagedPath), new Map())
      .entries(),
  ).sort((a, b) => b[0].length - a[0].length);

  let rewrittenHandoff = handoffContent;
  for (const [token, stagedPath] of replacementEntries) {
    rewrittenHandoff = rewrittenHandoff.split(token).join(stagedPath);
  }

  const prefix = `Staged handoff file: ${stagedHandoffPath}`;
  let prompt = rewrittenHandoff ? `${prefix}\n\n${rewrittenHandoff}` : prefix;

  if (userPrompt) {
    prompt = `${prompt}\n\n---\n\n${userPrompt}`;
  }

  return {
    prompt,
    replacements: replacementEntries.map(([token, stagedPath]) => ({
      stagedPath,
      token,
    })),
    stagedHandoffPath,
    transfers,
  };
}
