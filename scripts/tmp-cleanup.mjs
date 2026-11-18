#!/usr/bin/env node
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privateTmpRoot } from "../hub/lib/private-tmp.mjs";

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7일
const TRIFLUX_CLI_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1일

// tfx-psmux-check.json은 guard가 TTL을 직접 관리하므로 제외
const SKIP_FILES = new Set(["tfx-psmux-check.json"]);
const TOP_LEVEL_RULES = Object.freeze([
  { prefix: "tfx-", maxAgeMs: MAX_AGE_MS },
  { prefix: "triflux-cli-", maxAgeMs: TRIFLUX_CLI_MAX_AGE_MS },
]);

function normalizeProtectedPath(target) {
  const normalized = resolve(target);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function buildProtectedPathSet(protectPaths = []) {
  const protectedPaths = new Set();
  for (const target of protectPaths) {
    if (!target) continue;
    try {
      protectedPaths.add(normalizeProtectedPath(target));
    } catch {}
  }
  return protectedPaths;
}

export async function cleanupTmpFiles({ protectPaths = [] } = {}) {
  const now = Date.now();
  const protectedPaths = buildProtectedPathSet(protectPaths);
  // 새 버전은 uid 0700 루트에 쓰고, tmpdir() 는 예전 버전이 남긴 항목용이다.
  const roots = new Set([tmpdir()]);
  try {
    roots.add(privateTmpRoot());
  } catch {
    /* 남의 루트면 건너뛴다 */
  }
  let cleaned = 0;
  for (const root of roots) cleaned += cleanupRoot(root, now, protectedPaths);
  return cleaned;
}

function cleanupRoot(tmp, now, protectedPaths) {
  let cleaned = 0;

  let topEntries;
  try {
    topEntries = readdirSync(tmp);
  } catch {
    topEntries = [];
  }

  for (const entry of topEntries) {
    const rule = TOP_LEVEL_RULES.find(({ prefix }) => entry.startsWith(prefix));
    if (!rule) continue;
    if (SKIP_FILES.has(entry)) continue;

    const full = join(tmp, entry);
    if (protectedPaths.has(normalizeProtectedPath(full))) continue;

    try {
      const stat = statSync(full);
      if (now - stat.mtimeMs > rule.maxAgeMs) {
        rmSync(full, { recursive: true, force: true });
        cleaned++;
      }
    } catch {}
  }

  const headlessDir = join(tmp, "tfx-headless");
  if (existsSync(headlessDir)) {
    let entries;
    try {
      entries = readdirSync(headlessDir);
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      if (SKIP_FILES.has(entry)) continue;
      const full = join(headlessDir, entry);
      try {
        const stat = statSync(full);
        if (now - stat.mtimeMs > MAX_AGE_MS) {
          rmSync(full, { recursive: true, force: true });
          cleaned++;
        }
      } catch {
        /* 권한 에러 등 무시 */
      }
    }
  }

  return cleaned;
}

if (process.argv[1]) {
  const { fileURLToPath } = await import("node:url");
  if (fileURLToPath(import.meta.url) === process.argv[1]) {
    const cleaned = await cleanupTmpFiles();
    if (cleaned > 0) {
      process.stdout.write(
        JSON.stringify({ message: `tfx-cleanup: ${cleaned} files removed` }),
      );
    }
  }
}
