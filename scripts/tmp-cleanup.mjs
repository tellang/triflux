#!/usr/bin/env node
/**
 * tmp-cleanup.mjs — triflux 임시 파일 자동 정리
 * 7일 이상 된 파일을 삭제한다.
 * SessionStart 훅 또는 독립 실행으로 사용.
 */
import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

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
    } catch {
      // ignore invalid paths
    }
  }
  return protectedPaths;
}

/**
 * 7일 이상 된 임시 파일/디렉터리를 정리한다.
 * triflux-cli-* 테스트 홈 디렉터리는 1일 이상 지난 경우 정리한다.
 * @param {{ protectPaths?: string[] }} [options]
 * @returns {number} 삭제된 항목 수
 */
export async function cleanupTmpFiles({ protectPaths = [] } = {}) {
  const now = Date.now();
  let cleaned = 0;
  const tmp = tmpdir();
  const protectedPaths = buildProtectedPathSet(protectPaths);

  // 1) tmpdir() 직하위의 관리 대상 항목 정리
  let topEntries;
  try { topEntries = readdirSync(tmp); } catch { topEntries = []; }

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
    } catch { /* 권한 에러 등 무시 */ }
  }

  // 2) tfx-headless/ 내 오래된 결과 파일 정리 (디렉터리 자체는 유지)
  const headlessDir = join(tmp, "tfx-headless");
  if (existsSync(headlessDir)) {
    let entries;
    try { entries = readdirSync(headlessDir); } catch { entries = []; }

    for (const entry of entries) {
      if (SKIP_FILES.has(entry)) continue;
      const full = join(headlessDir, entry);
      try {
        const stat = statSync(full);
        if (now - stat.mtimeMs > MAX_AGE_MS) {
          rmSync(full, { recursive: true, force: true });
          cleaned++;
        }
      } catch { /* 권한 에러 등 무시 */ }
    }
  }

  return cleaned;
}

// 독립 실행 시 결과를 stdout으로 출력 (SessionStart 훅 호환)
if (process.argv[1]) {
  const { fileURLToPath } = await import("node:url");
  if (fileURLToPath(import.meta.url) === process.argv[1]) {
    const cleaned = await cleanupTmpFiles();
    if (cleaned > 0) {
      process.stdout.write(JSON.stringify({ message: `tfx-cleanup: ${cleaned} files removed` }));
    }
  }
}
