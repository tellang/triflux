import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BREADCRUMB_PATH = join(homedir(), ".claude", "scripts", ".tfx-pkg-root");

function normalizeCandidate(candidate) {
  if (typeof candidate !== "string") return null;
  const value = candidate.trim();
  if (!value) return null;
  return value;
}

function isValidPluginRoot(candidate) {
  const root = normalizeCandidate(candidate);
  if (!root) return false;
  return existsSync(join(root, "hooks", "hook-orchestrator.mjs"));
}

function toPluginRootFromUrl(url) {
  if (typeof url !== "string" || !url) return null;
  try {
    const sourceDir = dirname(fileURLToPath(url));
    const hookScoped = sourceDir.match(/^(.*?)[\\/]hooks(?:[\\/].*)?$/);
    if (hookScoped?.[1]) return hookScoped[1];
    return resolve(sourceDir, "..");
  } catch {
    return null;
  }
}

function readBreadcrumbRoot() {
  if (!existsSync(BREADCRUMB_PATH)) return null;
  try {
    return normalizeCandidate(readFileSync(BREADCRUMB_PATH, "utf8"));
  } catch {
    return null;
  }
}

export function resolvePluginRoot(callerUrl) {
  const breadcrumbRoot = readBreadcrumbRoot();
  if (isValidPluginRoot(breadcrumbRoot)) return breadcrumbRoot;

  const envRoot = normalizeCandidate(process.env.CLAUDE_PLUGIN_ROOT);
  if (isValidPluginRoot(envRoot)) return envRoot;

  const callerFallback = toPluginRootFromUrl(callerUrl);
  if (isValidPluginRoot(callerFallback)) return callerFallback;

  const moduleFallback = toPluginRootFromUrl(import.meta.url) || process.cwd();
  process.stderr.write(
    `[resolve-root] warning: failed to resolve plugin root from breadcrumb/env/caller; fallback=${moduleFallback}\n`
  );
  return moduleFallback;
}

export const PLUGIN_ROOT = resolvePluginRoot(import.meta.url);
