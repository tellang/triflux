import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import { basename, join, relative } from "node:path";

const NETWORK_TIMEOUT_MS = 3_000;

function toIssuePath(cacheDir, filePath) {
  const relPath = relative(cacheDir, filePath);
  return (relPath && relPath.length > 0 ? relPath : basename(filePath)).replace(
    /\\/g,
    "/",
  );
}

function collectCacheFiles(cacheDir) {
  return readdirSync(cacheDir, { withFileTypes: true }).flatMap((entry) => {
    const filePath = join(cacheDir, entry.name);
    if (entry.isDirectory()) return collectCacheFiles(filePath);
    return entry.isFile() ? [filePath] : [];
  });
}

function validateCacheFile(cacheDir, filePath) {
  try {
    accessSync(filePath, constants.R_OK);
    if (filePath.endsWith(".json")) {
      JSON.parse(readFileSync(filePath, "utf8"));
    }
    return null;
  } catch (error) {
    return {
      file: toIssuePath(cacheDir, filePath),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function probeUrl(url) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve({ url, ok });
    };

    try {
      const parsed = new URL(url);
      const transport =
        parsed.protocol === "https:"
          ? https
          : parsed.protocol === "http:"
            ? http
            : null;
      if (!transport) {
        finish(false);
        return;
      }

      const request = transport.request(
        parsed,
        {
          method: "HEAD",
          headers: { "user-agent": "triflux-cache-guard" },
        },
        (response) => {
          response.resume();
          finish(true);
        },
      );

      request.setTimeout(NETWORK_TIMEOUT_MS, () => {
        request.destroy(new Error("timeout"));
      });
      request.on("error", () => finish(false));
      request.end();
    } catch {
      finish(false);
    }
  });
}

export function validateRuntimeCachePaths(cacheDir) {
  if (!cacheDir || !existsSync(cacheDir)) {
    return { ok: true, issues: [] };
  }

  try {
    const files = collectCacheFiles(cacheDir);
    const issues = files
      .map((filePath) => validateCacheFile(cacheDir, filePath))
      .filter((issue) => issue !== null);

    return {
      ok: issues.length === 0,
      issues,
    };
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          file: ".",
          error: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

export async function checkNetworkAvailability(urls) {
  const targets = [
    ...new Set((Array.isArray(urls) ? urls : []).filter(Boolean)),
  ];
  if (targets.length === 0) {
    return { online: true, reachable: [], unreachable: [] };
  }

  const results = await Promise.all(targets.map((url) => probeUrl(url)));
  const reachable = results
    .filter((result) => result.ok)
    .map((result) => result.url);
  const unreachable = results
    .filter((result) => !result.ok)
    .map((result) => result.url);

  return {
    online: unreachable.length === 0,
    reachable,
    unreachable,
  };
}
